import path from "path"
import { medusaIntegrationTestRunner } from "@medusajs/test-utils"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import type {
  IPaymentModuleService,
  IWorkflowEngineService,
  MedusaContainer,
} from "@medusajs/framework/types"
import { ACTIVITY_LOG_MODULE } from "../../src/modules/activity-log"
import type ActivityLogModuleService from "../../src/modules/activity-log/service"
import { ActivityLogEventType } from "../../src/modules/activity-log/types"
import { SUBSCRIPTION_MODULE } from "../../src/modules/subscription"
import type SubscriptionModuleService from "../../src/modules/subscription/service"
import { SubscriptionStatus } from "../../src/modules/subscription/types"
import { RENEWAL_MODULE } from "../../src/modules/renewal"
import type RenewalModuleService from "../../src/modules/renewal/service"
import { RenewalCycleStatus } from "../../src/modules/renewal/types"
import { DUNNING_MODULE } from "../../src/modules/dunning"
import type DunningModuleService from "../../src/modules/dunning/service"
import { DunningCaseStatus } from "../../src/modules/dunning/types"
import { processRenewalCycleWorkflow } from "../../src/workflows"
import { startDunningWorkflow } from "../../src/workflows/start-dunning"
import { runDunningRetryWorkflow } from "../../src/workflows/run-dunning-retry"
import { markDunningRecoveredWorkflow } from "../../src/workflows/mark-dunning-recovered"
import { markDunningUnrecoveredWorkflow } from "../../src/workflows/mark-dunning-unrecovered"
import { updateDunningRetryScheduleWorkflow } from "../../src/workflows/update-dunning-retry-schedule"
import {
  createDunningCaseSeed,
  createRenewalCycleSeed,
  createSubscriptionSeed,
  defaultRetrySchedule,
} from "../helpers/dunning-fixtures"

const mockCreatePaymentSessionsRun = jest.fn()

jest.mock("@medusajs/medusa/core-flows", () => {
  const actual = jest.requireActual("@medusajs/medusa/core-flows")

  return {
    ...actual,
    createPaymentSessionsWorkflow: () => ({
      run: mockCreatePaymentSessionsRun,
    }),
  }
})

type EmittedBusEvent = { name?: string; data?: Record<string, unknown> }

/**
 * The plugin's emission seam is `eventBusModuleService.emit` (resolved through
 * the shared `emitSubscriptionBusEvent` helper). A call carries one event
 * object or an array of them, so flatten both shapes before counting.
 */
function busEventsWithName(
  emitSpy: jest.SpyInstance,
  eventName: string
): EmittedBusEvent[] {
  return emitSpy.mock.calls
    .flatMap((call) => {
      const first = call[0] as EmittedBusEvent | EmittedBusEvent[] | undefined

      return Array.isArray(first) ? first : first ? [first] : []
    })
    .filter((event) => event?.name === eventName)
}

function expectEmittedOnce(
  emitSpy: jest.SpyInstance,
  eventName: string
): EmittedBusEvent[] {
  const events = busEventsWithName(emitSpy, eventName)

  expect(events).toHaveLength(1)

  return events
}

medusaIntegrationTestRunner({
  medusaConfigFile: path.resolve(process.cwd(), "integration-tests"),
  env: {
    JWT_SECRET: "supersecret",
    COOKIE_SECRET: "supersecret",
  },
  testSuite: ({ getContainer }) => {
    describe("lifecycle bus events (persist + emit exactly once)", () => {
      let runId: string

      beforeEach(() => {
        jest.restoreAllMocks()
        jest.clearAllMocks()
        runId = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`
      })

      function resolveEventBusSpy(container: MedusaContainer) {
        const eventBus = container.resolve("event_bus") as unknown as {
          emit: (data: unknown) => Promise<void>
        }

        return jest.spyOn(eventBus, "emit")
      }

      it("emits renewal.failed exactly once when a renewal fails", async () => {
        const container = getContainer()
        const emitSpy = resolveEventBusSpy(container)

        // No cart: the failure ("missing 'cart_id'") is structural and
        // reproducible, and it never hands off to dunning, so renewal.failed
        // is the only lifecycle event this run can produce.
        const subscription = await createSubscriptionSeed(container, {
          reference: `SUB-LBE-FAILED-${runId}`,
          status: SubscriptionStatus.ACTIVE,
          cart_id: null,
          skip_next_cycle: false,
        })
        const cycle = await createRenewalCycleSeed(container, {
          subscription_id: subscription.id,
          status: RenewalCycleStatus.SCHEDULED,
          scheduled_for: new Date(Date.now() - 5 * 60_000),
        })

        await expect(
          processRenewalCycleWorkflow(container).run({
            input: { renewal_cycle_id: cycle.id, trigger_type: "scheduler" },
          })
        ).rejects.toMatchObject({
          message: expect.stringContaining("cart_id"),
        })

        const failedEvents = expectEmittedOnce(emitSpy, "renewal.failed")

        expect(failedEvents[0].data).toMatchObject({
          subscription_id: subscription.id,
          event_type: "renewal.failed",
        })

        // Exactly once per occurrence also means the audit row exists: one
        // persisted record behind the one emission.
        const activityLogModule = container.resolve<ActivityLogModuleService>(
          ACTIVITY_LOG_MODULE
        )
        const failedLogs = await activityLogModule.listSubscriptionLogs({
          subscription_id: subscription.id,
          event_type: ActivityLogEventType.RENEWAL_FAILED,
        } as any)
        expect(failedLogs).toHaveLength(1)
      })

      it("emits subscription.expired exactly once on the trial clean-finish path", async () => {
        const container = getContainer()
        const subscriptionModule =
          container.resolve<SubscriptionModuleService>(SUBSCRIPTION_MODULE)
        const emitSpy = resolveEventBusSpy(container)

        const subscription = await createSubscriptionSeed(container, {
          reference: `SUB-LBE-TRIAL-${runId}`,
          status: SubscriptionStatus.ACTIVE,
        })
        const trialEndsAt = new Date(Date.now() - 5 * 60_000)

        await subscriptionModule.updateSubscriptions({
          id: subscription.id,
          is_trial: true,
          trial_ends_at: trialEndsAt,
        } as never)

        // The eligibility gate rejects cycles still inside the trial, so the
        // cycle sits at/after trial_ends_at — the clean-finish branch.
        const cycle = await createRenewalCycleSeed(container, {
          subscription_id: subscription.id,
          status: RenewalCycleStatus.SCHEDULED,
          scheduled_for: new Date(),
        })

        await processRenewalCycleWorkflow(container).run({
          input: { renewal_cycle_id: cycle.id, trigger_type: "scheduler" },
        })

        const expiredEvents = expectEmittedOnce(emitSpy, "subscription.expired")

        expect(expiredEvents[0].data).toMatchObject({
          subscription_id: subscription.id,
          event_type: "subscription.expired",
        })

        // The trial path ends the subscription without billing: neither a
        // failure nor a success event may leak from it.
        expect(busEventsWithName(emitSpy, "renewal.failed")).toHaveLength(0)
        expect(busEventsWithName(emitSpy, "renewal.succeeded")).toHaveLength(0)

        const updatedSubscription = await subscriptionModule.retrieveSubscription(
          subscription.id
        )
        expect(updatedSubscription.status).toEqual(SubscriptionStatus.CANCELLED)
      })

      it("emits dunning.started exactly once when a case opens, and not again on a case refresh", async () => {
        const container = getContainer()
        const dunningModule =
          container.resolve<DunningModuleService>(DUNNING_MODULE)
        const activityLogModule = container.resolve<ActivityLogModuleService>(
          ACTIVITY_LOG_MODULE
        )
        const emitSpy = resolveEventBusSpy(container)

        const subscription = await createSubscriptionSeed(container, {
          reference: `SUB-LBE-START-${runId}`,
          status: SubscriptionStatus.ACTIVE,
        })
        const cycle = await createRenewalCycleSeed(container, {
          subscription_id: subscription.id,
          status: RenewalCycleStatus.FAILED,
        })

        const started = await startDunningWorkflow(container).run({
          input: {
            subscription_id: subscription.id,
            renewal_cycle_id: cycle.id,
            payment_failure_source: "payment_provider",
            payment_error_code: "card_declined",
            payment_error_message: "Issuer declined the charge",
            triggered_by: "admin_user",
          },
        })
        expect(started.result.action).toEqual("created")

        expectEmittedOnce(emitSpy, "dunning.started")

        // A second failure on the same cycle re-arms the existing case
        // ("updated"): dunning did not start again, so no second event.
        const refreshed = await startDunningWorkflow(container).run({
          input: {
            subscription_id: subscription.id,
            renewal_cycle_id: cycle.id,
            payment_failure_source: "payment_provider",
            payment_error_code: "card_declined",
            payment_error_message: "Issuer declined the charge again",
          },
        })
        expect(refreshed.result.action).toEqual("updated")

        expect(busEventsWithName(emitSpy, "dunning.started")).toHaveLength(1)

        const startedLogs = await activityLogModule.listSubscriptionLogs({
          subscription_id: subscription.id,
          event_type: ActivityLogEventType.DUNNING_STARTED,
        } as any)
        expect(startedLogs).toHaveLength(1)
        expect(startedLogs[0].metadata).toMatchObject({
          dunning_case_id: started.result.dunning_case_id,
          renewal_cycle_id: cycle.id,
        })
      })

      it("emits dunning.retry_executed and dunning.recovered exactly once on a successful retry", async () => {
        const container = getContainer()
        const dunningModule =
          container.resolve<DunningModuleService>(DUNNING_MODULE)
        const paymentModule = container.resolve<IPaymentModuleService>(
          Modules.PAYMENT
        )
        const query = container.resolve<any>(ContainerRegistrationKeys.QUERY)
        const originalGraph = query.graph.bind(query)
        const emitSpy = resolveEventBusSpy(container)

        const subscription = await createSubscriptionSeed(container, {
          reference: `SUB-LBE-RECOVER-${runId}`,
          status: SubscriptionStatus.PAST_DUE,
        })
        const cycle = await createRenewalCycleSeed(container, {
          subscription_id: subscription.id,
          status: RenewalCycleStatus.FAILED,
          generated_order_id: `ord_lbe_recover_${runId}`,
        })
        const dunningCase = await createDunningCaseSeed(container, {
          subscription_id: subscription.id,
          renewal_cycle_id: cycle.id,
          renewal_order_id: `ord_lbe_recover_${runId}`,
          status: DunningCaseStatus.RETRY_SCHEDULED,
          attempt_count: 0,
          max_attempts: 3,
          retry_schedule: defaultRetrySchedule,
          next_retry_at: new Date("2026-03-30T10:00:00.000Z"),
        })

        mockCreatePaymentSessionsRun.mockResolvedValue({
          result: { id: "payses_lbe_recover", context: {}, status: "pending" },
        })
        jest.spyOn(query, "graph").mockImplementation(async (input: any) => {
          if (input.entity === "order") {
            return {
              data: [
                {
                  id: `ord_lbe_recover_${runId}`,
                  total: 1.29,
                  currency_code: "usd",
                },
              ],
            }
          }

          return originalGraph(input)
        })
        jest
          .spyOn(paymentModule, "authorizePaymentSession")
          .mockResolvedValue({ id: "pay_lbe_recover", amount: 1.29 } as any)
        jest
          .spyOn(paymentModule, "capturePayment")
          .mockResolvedValue({ id: "pay_lbe_recover" } as any)

        const { result } = await runDunningRetryWorkflow(container).run({
          input: {
            dunning_case_id: dunningCase.id,
            now: "2026-03-30T10:00:00.000Z",
          },
        })
        expect(result.outcome).toEqual("recovered")

        expectEmittedOnce(emitSpy, "dunning.retry_executed")
        expectEmittedOnce(emitSpy, "dunning.recovered")
        expect(busEventsWithName(emitSpy, "dunning.unrecovered")).toHaveLength(0)

        const updatedCase = await dunningModule.retrieveDunningCase(
          dunningCase.id
        )
        expect(updatedCase.status).toEqual(DunningCaseStatus.RECOVERED)
      })

      it("does not emit dunning.retry_executed when a settled cycle closes the case without charging", async () => {
        // The R2 guard: the cycle is already written off, so the retry closes
        // the case unrecovered without a payment attempt — the closure is a
        // dunning.unrecovered occurrence, but no retry was executed.
        const container = getContainer()
        const paymentModule = container.resolve<IPaymentModuleService>(
          Modules.PAYMENT
        )
        const emitSpy = resolveEventBusSpy(container)

        const subscription = await createSubscriptionSeed(container, {
          reference: `SUB-LBE-R2-${runId}`,
          status: SubscriptionStatus.PAST_DUE,
        })
        const cycle = await createRenewalCycleSeed(container, {
          subscription_id: subscription.id,
          status: RenewalCycleStatus.ABANDONED,
          scheduled_for: new Date("2026-03-16T10:00:00.000Z"),
          generated_order_id: `ord_lbe_r2_${runId}`,
        })
        const dunningCase = await createDunningCaseSeed(container, {
          subscription_id: subscription.id,
          renewal_cycle_id: cycle.id,
          renewal_order_id: `ord_lbe_r2_${runId}`,
          status: DunningCaseStatus.RETRY_SCHEDULED,
          attempt_count: 1,
          max_attempts: 3,
          retry_schedule: defaultRetrySchedule,
          next_retry_at: new Date("2026-03-30T10:00:00.000Z"),
        })

        const authorizeSpy = jest.spyOn(paymentModule, "authorizePaymentSession")

        const { result } = await runDunningRetryWorkflow(container).run({
          input: {
            dunning_case_id: dunningCase.id,
            now: "2026-03-30T10:00:00.000Z",
          },
        })
        expect(result.outcome).toEqual("unrecovered")

        expectEmittedOnce(emitSpy, "dunning.unrecovered")
        expect(busEventsWithName(emitSpy, "dunning.retry_executed")).toHaveLength(
          0
        )
        expect(authorizeSpy).not.toHaveBeenCalled()
      })

      it("emits dunning.recovered exactly once through mark-dunning-recovered", async () => {
        const container = getContainer()
        const subscriptionModule =
          container.resolve<SubscriptionModuleService>(SUBSCRIPTION_MODULE)
        const emitSpy = resolveEventBusSpy(container)

        const subscription = await createSubscriptionSeed(container, {
          reference: `SUB-LBE-MARKREC-${runId}`,
          status: SubscriptionStatus.PAST_DUE,
        })
        const cycle = await createRenewalCycleSeed(container, {
          subscription_id: subscription.id,
          status: RenewalCycleStatus.FAILED,
        })
        const dunningCase = await createDunningCaseSeed(container, {
          subscription_id: subscription.id,
          renewal_cycle_id: cycle.id,
          status: DunningCaseStatus.OPEN,
        })

        await markDunningRecoveredWorkflow(container).run({
          input: {
            dunning_case_id: dunningCase.id,
            triggered_by: "admin_user",
            reason: "customer paid offline",
          },
        })

        const recoveredEvents = expectEmittedOnce(emitSpy, "dunning.recovered")

        expect(recoveredEvents[0].data).toMatchObject({
          subscription_id: subscription.id,
          event_type: "dunning.recovered",
        })

        const updatedSubscription = await subscriptionModule.retrieveSubscription(
          subscription.id
        )
        expect(updatedSubscription.status).toEqual(SubscriptionStatus.ACTIVE)
      })

      it("emits dunning.unrecovered exactly once through mark-dunning-unrecovered", async () => {
        const container = getContainer()
        const renewalModule =
          container.resolve<RenewalModuleService>(RENEWAL_MODULE)
        const emitSpy = resolveEventBusSpy(container)

        const subscription = await createSubscriptionSeed(container, {
          reference: `SUB-LBE-MARKUNREC-${runId}`,
          status: SubscriptionStatus.PAST_DUE,
        })
        const cycle = await createRenewalCycleSeed(container, {
          subscription_id: subscription.id,
          status: RenewalCycleStatus.FAILED,
        })
        const dunningCase = await createDunningCaseSeed(container, {
          subscription_id: subscription.id,
          renewal_cycle_id: cycle.id,
          status: DunningCaseStatus.AWAITING_MANUAL_RESOLUTION,
          next_retry_at: null,
        })

        await markDunningUnrecoveredWorkflow(container).run({
          input: {
            dunning_case_id: dunningCase.id,
            triggered_by: "admin_user",
            reason: "customer did not update card",
          },
        })

        expectEmittedOnce(emitSpy, "dunning.unrecovered")

        // Task 12: the operator write-off also emits the operational renewal
        // event the host's R3 decision hangs on, exactly where the cycle write
        // lands — one case closure, one abandonment.
        const abandonedEvents = expectEmittedOnce(emitSpy, "renewal.abandoned")

        expect(abandonedEvents[0].data).toMatchObject({
          subscription_id: subscription.id,
          event_type: "renewal.abandoned",
          metadata: expect.objectContaining({
            source: "admin",
            dunning_case_id: dunningCase.id,
            renewal_cycle_id: cycle.id,
          }),
        })

        // The admin write-off abandons the originating cycle (R3), as before.
        const abandonedCycle = await renewalModule.retrieveRenewalCycle(cycle.id)
        expect(abandonedCycle.status).toEqual(RenewalCycleStatus.ABANDONED)
      })

      it("emits renewal.abandoned exactly once when dunning exhausts before the first retry", async () => {
        const container = getContainer()
        const renewalModule =
          container.resolve<RenewalModuleService>(RENEWAL_MODULE)
        const emitSpy = resolveEventBusSpy(container)

        const subscription = await createSubscriptionSeed(container, {
          reference: `SUB-LBE-EXHAUST-${runId}`,
          status: SubscriptionStatus.PAST_DUE,
        })
        const cycle = await createRenewalCycleSeed(container, {
          subscription_id: subscription.id,
          status: RenewalCycleStatus.FAILED,
        })
        // A case whose budget was spent before this run: the retry step's
        // pre-transition exhaust disposition settles the cycle `abandoned`
        // (R3) without executing a payment attempt, so this scenario needs no
        // payment mocks — and it drives the same
        // `abandonCycleOnDunningExhaustion` write the post-payment exhaustion
        // paths go through.
        const dunningCase = await createDunningCaseSeed(container, {
          subscription_id: subscription.id,
          renewal_cycle_id: cycle.id,
          renewal_order_id: "ord_lbe_exhausted",
          status: DunningCaseStatus.RETRY_SCHEDULED,
          attempt_count: 3,
          max_attempts: 3,
          retry_schedule: defaultRetrySchedule,
          next_retry_at: new Date(Date.now() - 60_000),
        })

        await runDunningRetryWorkflow(container).run({
          input: {
            dunning_case_id: dunningCase.id,
          },
        })

        const abandonedEvents = expectEmittedOnce(emitSpy, "renewal.abandoned")

        expect(abandonedEvents[0].data).toMatchObject({
          subscription_id: subscription.id,
          event_type: "renewal.abandoned",
          metadata: expect.objectContaining({
            source: "dunning",
            dunning_case_id: dunningCase.id,
            renewal_cycle_id: cycle.id,
          }),
        })

        // The write-off reached the terminal status, so a replayed run takes
        // the helper's terminal guard and cannot emit a second event.
        const abandonedCycle = await renewalModule.retrieveRenewalCycle(cycle.id)
        expect(abandonedCycle.status).toEqual(RenewalCycleStatus.ABANDONED)
      })

      it("emits dunning.retry_schedule_updated exactly once on a schedule override", async () => {
        const container = getContainer()
        const dunningModule =
          container.resolve<DunningModuleService>(DUNNING_MODULE)
        const emitSpy = resolveEventBusSpy(container)

        const subscription = await createSubscriptionSeed(container, {
          reference: `SUB-LBE-SCHEDULE-${runId}`,
          status: SubscriptionStatus.PAST_DUE,
        })
        const cycle = await createRenewalCycleSeed(container, {
          subscription_id: subscription.id,
          status: RenewalCycleStatus.FAILED,
        })
        const dunningCase = await createDunningCaseSeed(container, {
          subscription_id: subscription.id,
          renewal_cycle_id: cycle.id,
          status: DunningCaseStatus.OPEN,
          attempt_count: 0,
          max_attempts: 3,
          retry_schedule: defaultRetrySchedule,
          next_retry_at: null,
        })

        await updateDunningRetryScheduleWorkflow(container).run({
          input: {
            dunning_case_id: dunningCase.id,
            intervals: [60, 120],
            max_attempts: 2,
            triggered_by: "admin_user",
            reason: "shorter retry cadence",
          },
        })

        const scheduleEvents = expectEmittedOnce(
          emitSpy,
          "dunning.retry_schedule_updated"
        )

        expect(scheduleEvents[0].data).toMatchObject({
          subscription_id: subscription.id,
          event_type: "dunning.retry_schedule_updated",
        })

        const updatedCase = await dunningModule.retrieveDunningCase(
          dunningCase.id
        )
        expect(updatedCase).toMatchObject({
          status: DunningCaseStatus.RETRY_SCHEDULED,
          max_attempts: 2,
        })
      })
    })
  },
})

jest.setTimeout(120 * 1000)
