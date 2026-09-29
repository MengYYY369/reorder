import { medusaIntegrationTestRunner } from "@medusajs/test-utils"
import path from "path"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { IPaymentModuleService } from "@medusajs/framework/types"
import {
  getAdminDunningDetail,
  listAdminDunningCases,
} from "../../src/modules/dunning/utils/admin-query"
import { DUNNING_MODULE } from "../../src/modules/dunning"
import type DunningModuleService from "../../src/modules/dunning/service"
import {
  DunningAttemptStatus,
  DunningCaseStatus,
} from "../../src/modules/dunning/types"
import { RENEWAL_MODULE } from "../../src/modules/renewal"
import type RenewalModuleService from "../../src/modules/renewal/service"
import { RenewalCycleStatus } from "../../src/modules/renewal/types"
import { ACTIVITY_LOG_MODULE } from "../../src/modules/activity-log"
import type ActivityLogModuleService from "../../src/modules/activity-log/service"
import {
  ActivityLogActorType,
  ActivityLogEventType,
} from "../../src/modules/activity-log/types"
import { SUBSCRIPTION_MODULE } from "../../src/modules/subscription"
import type SubscriptionModuleService from "../../src/modules/subscription/service"
import { SubscriptionStatus } from "../../src/modules/subscription/types"
import { markDunningRecoveredWorkflow } from "../../src/workflows/mark-dunning-recovered"
import { markDunningUnrecoveredWorkflow } from "../../src/workflows/mark-dunning-unrecovered"
import { runDunningRetryWorkflow } from "../../src/workflows/run-dunning-retry"
import { startDunningWorkflow } from "../../src/workflows/start-dunning"
import { updateDunningRetryScheduleWorkflow } from "../../src/workflows/update-dunning-retry-schedule"
import processDunningRetriesJob from "../../src/jobs/process-dunning-retries"
import { listDueDunningCasesForProcessing } from "../../src/modules/dunning/utils/scheduler-query"
// Namespace imports so the no-cancellation assertions below can spy on the
// plugin's cancellation workflow exports: if the dunning exhaustion path ever
// grows a cancellation side effect, these spies fail the suite.
import * as cancelSubscriptionModule from "../../src/workflows/cancel-subscription"
import * as finalizeCancellationModule from "../../src/workflows/finalize-cancellation"
import {
  createDunningAttemptSeed,
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

medusaIntegrationTestRunner({
  medusaConfigFile: path.resolve(process.cwd(), "integration-tests"),
  env: {
    JWT_SECRET: "supersecret",
    COOKIE_SECRET: "supersecret",
  },
  testSuite: ({ getContainer }) => {
    describe("dunning query and workflows", () => {
      beforeEach(() => {
        jest.restoreAllMocks()
        jest.clearAllMocks()
      })

      it("starts dunning successfully and marks subscription as past due", async () => {
        const container = getContainer()
        const dunningModule =
          container.resolve<DunningModuleService>(DUNNING_MODULE)
        const subscriptionModule =
          container.resolve<SubscriptionModuleService>(SUBSCRIPTION_MODULE)

        const subscription = await createSubscriptionSeed(container, {
          reference: "SUB-DUN-WF-001",
          status: SubscriptionStatus.ACTIVE,
        })
        const cycle = await createRenewalCycleSeed(container, {
          subscription_id: subscription.id,
          status: RenewalCycleStatus.FAILED,
        })

        const { result } = await startDunningWorkflow(container).run({
          input: {
            subscription_id: subscription.id,
            renewal_cycle_id: cycle.id,
            payment_failure_source: "payment_provider",
            payment_error_code: "card_declined",
            payment_error_message: "Issuer declined the charge",
            failed_at: "2026-03-30T10:00:00.000Z",
            triggered_by: "admin_user",
          },
        })

        const dunningCases = await dunningModule.listDunningCases({
          subscription_id: subscription.id,
        } as any)
        const updatedSubscription = await subscriptionModule.retrieveSubscription(
          subscription.id
        )

        expect(result).toMatchObject({
          action: "created",
          subscription_id: subscription.id,
          subscription_status: SubscriptionStatus.PAST_DUE,
        })
        expect(dunningCases).toHaveLength(1)
        expect(dunningCases[0]).toMatchObject({
          subscription_id: subscription.id,
          renewal_cycle_id: cycle.id,
          status: DunningCaseStatus.RETRY_SCHEDULED,
          attempt_count: 0,
          max_attempts: 3,
          last_payment_error_code: "card_declined",
          last_payment_error_message: "Issuer declined the charge",
        })
        expect(updatedSubscription.status).toEqual(SubscriptionStatus.PAST_DUE)
      })

      it("updates an existing active case idempotently for the same renewal cycle", async () => {
        const container = getContainer()
        const dunningModule =
          container.resolve<DunningModuleService>(DUNNING_MODULE)
        const subscription = await createSubscriptionSeed(container, {
          reference: "SUB-DUN-WF-002",
          status: SubscriptionStatus.PAST_DUE,
        })
        const cycle = await createRenewalCycleSeed(container, {
          subscription_id: subscription.id,
          status: RenewalCycleStatus.FAILED,
        })
        const existingCase = await createDunningCaseSeed(container, {
          subscription_id: subscription.id,
          renewal_cycle_id: cycle.id,
          status: DunningCaseStatus.OPEN,
          next_retry_at: null,
          last_payment_error_message: "old error",
        })

        const { result } = await startDunningWorkflow(container).run({
          input: {
            subscription_id: subscription.id,
            renewal_cycle_id: cycle.id,
            payment_failure_source: "payment_session",
            payment_error_code: "authentication_required",
            payment_error_message: "Authentication required",
          },
        })

        const dunningCases = await dunningModule.listDunningCases({
          subscription_id: subscription.id,
        } as any)

        expect(result).toMatchObject({
          action: "updated",
          dunning_case_id: existingCase.id,
        })
        expect(dunningCases).toHaveLength(1)
        expect(dunningCases[0]).toMatchObject({
          id: existingCase.id,
          status: DunningCaseStatus.RETRY_SCHEDULED,
          last_payment_error_code: "authentication_required",
          last_payment_error_message: "Authentication required",
        })
        expect(dunningCases[0].next_retry_at).toBeTruthy()
      })

      it("blocks duplicate active dunning cases for the same subscription", async () => {
        const container = getContainer()
        const dunningModule =
          container.resolve<DunningModuleService>(DUNNING_MODULE)
        const subscription = await createSubscriptionSeed(container, {
          reference: "SUB-DUN-WF-003",
          status: SubscriptionStatus.PAST_DUE,
        })
        const activeCycle = await createRenewalCycleSeed(container, {
          subscription_id: subscription.id,
          status: RenewalCycleStatus.FAILED,
        })
        const incomingCycle = await createRenewalCycleSeed(container, {
          subscription_id: subscription.id,
          status: RenewalCycleStatus.FAILED,
        })

        await createDunningCaseSeed(container, {
          subscription_id: subscription.id,
          renewal_cycle_id: activeCycle.id,
          status: DunningCaseStatus.RETRY_SCHEDULED,
        })

        const visibleCases = await dunningModule.listDunningCases({
          subscription_id: subscription.id,
        } as any)

        expect(visibleCases).toHaveLength(1)
        expect(visibleCases[0]).toMatchObject({
          subscription_id: subscription.id,
          renewal_cycle_id: activeCycle.id,
          status: DunningCaseStatus.RETRY_SCHEDULED,
        })

        const response = await startDunningWorkflow(container).run({
          input: {
            subscription_id: subscription.id,
            renewal_cycle_id: incomingCycle.id,
            payment_failure_source: "payment_capture",
            payment_error_message: "Capture failed",
          },
          throwOnError: false,
        })

        const errorMessages = (response.errors ?? []).map((error) =>
          error?.error instanceof Error
            ? error.error.message
            : typeof error?.error === "object" && error?.error && "message" in error.error
              ? String((error.error as { message?: unknown }).message)
              : JSON.stringify(error?.error)
        )
        const dunningCasesAfterAttempt = await dunningModule.listDunningCases({
          subscription_id: subscription.id,
        } as any)

        expect(errorMessages).toEqual(
          expect.arrayContaining([
            expect.stringMatching(/Duplicate active dunning case blocked/),
          ])
        )
        expect(dunningCasesAfterAttempt).toHaveLength(1)
      })

      it("recovers a dunning case after a successful retry", async () => {
        const container = getContainer()
        const dunningModule =
          container.resolve<DunningModuleService>(DUNNING_MODULE)
        const subscriptionModule =
          container.resolve<SubscriptionModuleService>(SUBSCRIPTION_MODULE)
        const renewalModule =
          container.resolve<RenewalModuleService>(RENEWAL_MODULE)
        const paymentModule =
          container.resolve<IPaymentModuleService>(Modules.PAYMENT)
        const query = container.resolve<any>(ContainerRegistrationKeys.QUERY)
        const originalGraph = query.graph.bind(query)

        const subscription = await createSubscriptionSeed(container, {
          reference: "SUB-DUN-WF-004",
          status: SubscriptionStatus.PAST_DUE,
        })
        const cycle = await createRenewalCycleSeed(container, {
          subscription_id: subscription.id,
          status: RenewalCycleStatus.FAILED,
          generated_order_id: "ord_dun_success",
        })
        const dunningCase = await createDunningCaseSeed(container, {
          subscription_id: subscription.id,
          renewal_cycle_id: cycle.id,
          renewal_order_id: "ord_dun_success",
          status: DunningCaseStatus.RETRY_SCHEDULED,
          attempt_count: 0,
          max_attempts: 3,
          retry_schedule: defaultRetrySchedule,
          next_retry_at: new Date("2026-03-30T10:00:00.000Z"),
          last_payment_error_code: "card_declined",
          last_payment_error_message: "Declined",
        })

        mockCreatePaymentSessionsRun.mockResolvedValue({
          result: { id: "payses_1", context: {}, status: "pending" },
        })

        jest.spyOn(query, "graph").mockImplementation(async (input: any) => {
          if (input.entity === "order") {
            return {
              data: [{ id: "ord_dun_success", total: 1.29, currency_code: "usd" }],
            }
          }

          return originalGraph(input)
        })
        const authorizeSpy = jest
          .spyOn(paymentModule, "authorizePaymentSession")
          .mockResolvedValue({ id: "pay_1", amount: 1.29 } as any)
        jest
          .spyOn(paymentModule, "capturePayment")
          .mockResolvedValue({ id: "pay_1" } as any)

        const { result } = await runDunningRetryWorkflow(container).run({
          input: {
            dunning_case_id: dunningCase.id,
            now: "2026-03-30T10:00:00.000Z",
          },
        })

        const updatedCase = await dunningModule.retrieveDunningCase(dunningCase.id)
        const attempts = await dunningModule.listDunningAttempts({
          dunning_case_id: dunningCase.id,
        } as any)
        const updatedSubscription = await subscriptionModule.retrieveSubscription(
          subscription.id
        )
        const updatedCycle = await renewalModule.retrieveRenewalCycle(cycle.id)

        expect(result).toMatchObject({
          dunning_case_id: dunningCase.id,
          outcome: "recovered",
          subscription_status: SubscriptionStatus.ACTIVE,
        })
        expect(updatedCase).toMatchObject({
          status: DunningCaseStatus.RECOVERED,
          attempt_count: 1,
          recovery_reason: "payment_recovered",
          last_payment_error_code: null,
        })
        expect(updatedCase.closed_at).toBeTruthy()
        expect(updatedCase.recovered_at).toBeTruthy()
        expect(attempts).toHaveLength(1)
        expect(attempts[0]).toMatchObject({
          attempt_no: 1,
          status: DunningAttemptStatus.SUCCEEDED,
          payment_reference: "pay_1",
        })
        expect(updatedSubscription.status).toEqual(SubscriptionStatus.ACTIVE)

        // Recovery settles the period: the cycle is finalized through the
        // shared period-finalization step with the order that was actually
        // paid, and the period is charged exactly once — one authorization
        // against one payment collection on the case's own renewal order.
        expect(updatedCycle.status).toEqual(RenewalCycleStatus.SUCCEEDED)
        expect(updatedCycle.generated_order_id).toEqual("ord_dun_success")
        expect(updatedCycle.processed_at).toBeTruthy()
        expect(authorizeSpy).toHaveBeenCalledTimes(1)

        const { data: links } = (await query.graph({
          entity: "order_payment_collection",
          fields: ["payment_collection_id"],
          filters: { order_id: "ord_dun_success" },
        })) as { data: Array<{ payment_collection_id: string }> }
        expect(links).toHaveLength(1)
      })

      it("closes a retry against an already-succeeded cycle as recovered without charging", async () => {
        // The R2 crash window: recovery finalizes the period before it closes
        // the case, so a crash in between leaves a `succeeded` cycle behind an
        // open case. The retry must close the case without a second charge.
        const container = getContainer()
        const dunningModule =
          container.resolve<DunningModuleService>(DUNNING_MODULE)
        const renewalModule =
          container.resolve<RenewalModuleService>(RENEWAL_MODULE)
        const paymentModule =
          container.resolve<IPaymentModuleService>(Modules.PAYMENT)

        const subscription = await createSubscriptionSeed(container, {
          reference: "SUB-DUN-WF-009",
          status: SubscriptionStatus.PAST_DUE,
        })
        const cycle = await createRenewalCycleSeed(container, {
          subscription_id: subscription.id,
          status: RenewalCycleStatus.SUCCEEDED,
          scheduled_for: new Date("2026-03-16T10:00:00.000Z"),
          generated_order_id: "ord_dun_settled",
        })
        const dunningCase = await createDunningCaseSeed(container, {
          subscription_id: subscription.id,
          renewal_cycle_id: cycle.id,
          renewal_order_id: "ord_dun_settled",
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

        const updatedCase = await dunningModule.retrieveDunningCase(dunningCase.id)
        const updatedCycle = await renewalModule.retrieveRenewalCycle(cycle.id)
        const attempts = await dunningModule.listDunningAttempts({
          dunning_case_id: dunningCase.id,
        } as any)

        expect(result.outcome).toEqual("recovered")
        expect(updatedCase).toMatchObject({
          status: DunningCaseStatus.RECOVERED,
          recovery_reason: "cycle_already_succeeded",
        })
        expect(updatedCase.closed_at).toBeTruthy()
        expect(updatedCase.recovered_at).toBeTruthy()
        expect(updatedCycle.status).toEqual(RenewalCycleStatus.SUCCEEDED)
        // Nothing ran: no attempt row and no charge for the settled period.
        expect(attempts).toHaveLength(0)
        expect(authorizeSpy).not.toHaveBeenCalled()
      })

      it("closes a retry against an abandoned cycle as unrecovered without charging", async () => {
        const container = getContainer()
        const dunningModule =
          container.resolve<DunningModuleService>(DUNNING_MODULE)
        const renewalModule =
          container.resolve<RenewalModuleService>(RENEWAL_MODULE)
        const subscriptionModule =
          container.resolve<SubscriptionModuleService>(SUBSCRIPTION_MODULE)
        const paymentModule =
          container.resolve<IPaymentModuleService>(Modules.PAYMENT)

        const subscription = await createSubscriptionSeed(container, {
          reference: "SUB-DUN-WF-010",
          status: SubscriptionStatus.PAST_DUE,
        })
        const cycle = await createRenewalCycleSeed(container, {
          subscription_id: subscription.id,
          status: RenewalCycleStatus.ABANDONED,
          scheduled_for: new Date("2026-03-16T10:00:00.000Z"),
          generated_order_id: "ord_dun_abandoned",
        })
        const dunningCase = await createDunningCaseSeed(container, {
          subscription_id: subscription.id,
          renewal_cycle_id: cycle.id,
          renewal_order_id: "ord_dun_abandoned",
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

        const updatedCase = await dunningModule.retrieveDunningCase(dunningCase.id)
        const updatedCycle = await renewalModule.retrieveRenewalCycle(cycle.id)
        const updatedSubscription = await subscriptionModule.retrieveSubscription(
          subscription.id
        )
        const attempts = await dunningModule.listDunningAttempts({
          dunning_case_id: dunningCase.id,
        } as any)

        expect(result.outcome).toEqual("unrecovered")
        expect(updatedCase).toMatchObject({
          status: DunningCaseStatus.UNRECOVERED,
          recovery_reason: "cycle_abandoned",
        })
        expect(updatedCase.closed_at).toBeTruthy()
        expect(updatedCase.recovered_at).toBeFalsy()
        expect(updatedCycle.status).toEqual(RenewalCycleStatus.ABANDONED)
        // The period was written off: no charge, and the subscription is left
        // past_due for the host to decide about.
        expect(attempts).toHaveLength(0)
        expect(authorizeSpy).not.toHaveBeenCalled()
        expect(updatedSubscription.status).toEqual(SubscriptionStatus.PAST_DUE)
      })

      it("finalizes a recovered period with the same core semantics as the automatic success path", async () => {
        const container = getContainer()
        const dunningModule =
          container.resolve<DunningModuleService>(DUNNING_MODULE)
        const subscriptionModule =
          container.resolve<SubscriptionModuleService>(SUBSCRIPTION_MODULE)
        const renewalModule =
          container.resolve<RenewalModuleService>(RENEWAL_MODULE)
        const activityLogModule = container.resolve<ActivityLogModuleService>(
          ACTIVITY_LOG_MODULE
        )
        const paymentModule =
          container.resolve<IPaymentModuleService>(Modules.PAYMENT)
        const query = container.resolve<any>(ContainerRegistrationKeys.QUERY)
        const originalGraph = query.graph.bind(query)

        const subscription = await createSubscriptionSeed(container, {
          reference: "SUB-DUN-WF-PARITY",
          status: SubscriptionStatus.PAST_DUE,
        })
        // The period's anchor sits in the past — parity with the automatic
        // path means the cadence advances from `scheduled_for` (R6), not from
        // the recovery time.
        const scheduledFor = new Date("2026-03-16T10:00:00.000Z")
        const cycle = await createRenewalCycleSeed(container, {
          subscription_id: subscription.id,
          status: RenewalCycleStatus.FAILED,
          scheduled_for: scheduledFor,
          generated_order_id: "ord_dun_parity",
          last_error: "card declined",
        })
        await renewalModule.updateRenewalCycles({
          id: cycle.id,
          structural_attempt_count: 2,
          last_failure_kind: "order_creation_failed",
        })
        const dunningCase = await createDunningCaseSeed(container, {
          subscription_id: subscription.id,
          renewal_cycle_id: cycle.id,
          renewal_order_id: "ord_dun_parity",
          status: DunningCaseStatus.RETRY_SCHEDULED,
          attempt_count: 1,
          max_attempts: 3,
          retry_schedule: defaultRetrySchedule,
          next_retry_at: new Date("2026-03-30T10:00:00.000Z"),
        })

        mockCreatePaymentSessionsRun.mockResolvedValue({
          result: { id: "payses_parity", context: {}, status: "pending" },
        })

        jest.spyOn(query, "graph").mockImplementation(async (input: any) => {
          if (input.entity === "order") {
            return {
              data: [{ id: "ord_dun_parity", total: 129, currency_code: "usd" }],
            }
          }

          return originalGraph(input)
        })
        jest
          .spyOn(paymentModule, "authorizePaymentSession")
          .mockResolvedValue({ id: "pay_parity", amount: 129 } as any)
        jest
          .spyOn(paymentModule, "capturePayment")
          .mockResolvedValue({ id: "pay_parity" } as any)

        await runDunningRetryWorkflow(container).run({
          input: {
            dunning_case_id: dunningCase.id,
            now: "2026-03-30T10:00:00.000Z",
          },
        })

        const updatedCase = await dunningModule.retrieveDunningCase(dunningCase.id)
        const updatedCycle = await renewalModule.retrieveRenewalCycle(cycle.id)
        const updatedSubscription = await subscriptionModule.retrieveSubscription(
          subscription.id
        )
        const cycles = await renewalModule.listRenewalCycles({
          subscription_id: subscription.id,
        } as any)
        const nextCycle = cycles.find((record) => record.id !== cycle.id)
        const renewalSucceededLogs = await activityLogModule.listSubscriptionLogs({
          subscription_id: subscription.id,
          event_type: ActivityLogEventType.RENEWAL_SUCCEEDED,
        } as any)

        // The case still closes as recovered by the payment itself.
        expect(updatedCase).toMatchObject({
          status: DunningCaseStatus.RECOVERED,
          recovery_reason: "payment_recovered",
        })

        // Core semantics shared with the automatic success path: the cycle
        // settles with the order that paid it, the structural slate resets,
        // the subscription reactivates on the cadence advanced from the
        // period's own scheduled_for, the next cycle is ensured on that same
        // anchor, and renewal.succeeded is persisted from the dunning rail.
        expect(updatedCycle.status).toEqual(RenewalCycleStatus.SUCCEEDED)
        expect(updatedCycle.generated_order_id).toEqual("ord_dun_parity")
        expect(updatedCycle.processed_at).toBeTruthy()
        expect(updatedCycle.structural_attempt_count).toEqual(0)
        expect(updatedSubscription.status).toEqual(SubscriptionStatus.ACTIVE)
        expect(updatedSubscription.last_renewal_at).toBeTruthy()

        const expectedNext = new Date(scheduledFor)
        expectedNext.setUTCMonth(expectedNext.getUTCMonth() + 1)
        expect(updatedSubscription.next_renewal_at!.toISOString()).toEqual(
          expectedNext.toISOString()
        )
        expect(nextCycle).toBeDefined()
        expect(nextCycle?.status).toEqual(RenewalCycleStatus.SCHEDULED)
        expect(new Date(nextCycle!.scheduled_for).toISOString()).toEqual(
          expectedNext.toISOString()
        )

        expect(renewalSucceededLogs).toHaveLength(1)
        expect(renewalSucceededLogs[0]).toMatchObject({
          event_type: ActivityLogEventType.RENEWAL_SUCCEEDED,
          actor_type: ActivityLogActorType.SYSTEM,
        })
        expect(renewalSucceededLogs[0].metadata).toMatchObject({
          source: "dunning",
          trigger_type: "dunning_recovery",
          order_id: "ord_dun_parity",
        })
      })

      it("recovers a 0.01 epsilon-boundary retry reusing one payment collection", async () => {
        const container = getContainer()
        const dunningModule =
          container.resolve<DunningModuleService>(DUNNING_MODULE)
        const paymentModule =
          container.resolve<IPaymentModuleService>(Modules.PAYMENT)
        const query = container.resolve<any>(ContainerRegistrationKeys.QUERY)
        const originalGraph = query.graph.bind(query)

        // Medusa 2.20 zeroes a freshly computed pending_difference that is at
        // or below the currency epsilon, which used to make the core
        // create-or-update workflow throw "Amount cannot be greater than".
        const subscription = await createSubscriptionSeed(container, {
          reference: "SUB-DUN-WF-EPSILON",
          status: SubscriptionStatus.PAST_DUE,
        })
        const cycle = await createRenewalCycleSeed(container, {
          subscription_id: subscription.id,
          status: RenewalCycleStatus.FAILED,
          generated_order_id: "ord_dun_epsilon",
        })
        const dunningCase = await createDunningCaseSeed(container, {
          subscription_id: subscription.id,
          renewal_cycle_id: cycle.id,
          renewal_order_id: "ord_dun_epsilon",
          status: DunningCaseStatus.RETRY_SCHEDULED,
          attempt_count: 0,
          max_attempts: 3,
          retry_schedule: defaultRetrySchedule,
          next_retry_at: new Date("2026-03-30T10:00:00.000Z"),
          last_payment_error_code: "card_declined",
          last_payment_error_message: "Declined",
        })

        mockCreatePaymentSessionsRun.mockResolvedValue({
          result: { id: "payses_epsilon", context: {}, status: "pending" },
        })

        jest.spyOn(query, "graph").mockImplementation(async (input: any) => {
          if (input.entity === "order") {
            return {
              data: [
                { id: "ord_dun_epsilon", total: 0.01, currency_code: "usd" },
              ],
            }
          }

          return originalGraph(input)
        })
        const authorizeSpy = jest
          .spyOn(paymentModule, "authorizePaymentSession")
          .mockRejectedValueOnce(new Error("Insufficient funds"))
          .mockResolvedValueOnce({ id: "pay_epsilon", amount: 0.01 } as any)
        jest
          .spyOn(paymentModule, "capturePayment")
          .mockResolvedValue({ id: "pay_epsilon" } as any)
        jest.spyOn(paymentModule, "listPaymentSessions").mockResolvedValue([
          { id: "payses_epsilon", status: "pending" },
        ] as any)

        const firstAttempt = await runDunningRetryWorkflow(container).run({
          input: {
            dunning_case_id: dunningCase.id,
            now: "2026-03-30T10:00:00.000Z",
            ignore_schedule: true,
          },
        })
        expect(firstAttempt.result.outcome).toEqual("retry_scheduled")

        const secondAttempt = await runDunningRetryWorkflow(container).run({
          input: {
            dunning_case_id: dunningCase.id,
            now: "2026-03-30T12:00:00.000Z",
            ignore_schedule: true,
          },
        })
        expect(secondAttempt.result.outcome).toEqual("recovered")

        const updatedCase = await dunningModule.retrieveDunningCase(dunningCase.id)
        expect(updatedCase).toMatchObject({
          status: DunningCaseStatus.RECOVERED,
          attempt_count: 2,
          recovery_reason: "payment_recovered",
        })

        const attempts = await dunningModule.listDunningAttempts({
          dunning_case_id: dunningCase.id,
        } as any)
        expect(attempts).toHaveLength(2)
        expect(attempts[0]).toMatchObject({
          status: DunningAttemptStatus.FAILED,
          payment_reference: "payses_epsilon",
        })
        expect(attempts[1]).toMatchObject({
          status: DunningAttemptStatus.SUCCEEDED,
          payment_reference: "pay_epsilon",
        })

        // Both retry attempts charged against the same collection — the first
        // created it, the second reused it instead of minting a duplicate.
        const { data: links } = (await query.graph({
          entity: "order_payment_collection",
          fields: ["payment_collection_id"],
          filters: { order_id: "ord_dun_epsilon" },
        })) as { data: Array<{ payment_collection_id: string }> }
        expect(links).toHaveLength(1)

        const collections = (await paymentModule.listPaymentCollections({
          id: links.map((link) => link.payment_collection_id),
        })) as unknown as Array<{ id: string; amount: number }>
        expect(collections).toHaveLength(1)
        expect(collections[0].amount).toEqual(0.01)

        expect(authorizeSpy).toHaveBeenCalledTimes(2)
      })

      it("reschedules retry after a temporary payment failure", async () => {
        const container = getContainer()
        const dunningModule =
          container.resolve<DunningModuleService>(DUNNING_MODULE)
        const paymentModule =
          container.resolve<IPaymentModuleService>(Modules.PAYMENT)
        const query = container.resolve<any>(ContainerRegistrationKeys.QUERY)
        const originalGraph = query.graph.bind(query)

        const subscription = await createSubscriptionSeed(container, {
          reference: "SUB-DUN-WF-005",
          status: SubscriptionStatus.PAST_DUE,
        })
        const cycle = await createRenewalCycleSeed(container, {
          subscription_id: subscription.id,
          status: RenewalCycleStatus.FAILED,
          generated_order_id: "ord_dun_retry",
        })
        const dunningCase = await createDunningCaseSeed(container, {
          subscription_id: subscription.id,
          renewal_cycle_id: cycle.id,
          renewal_order_id: "ord_dun_retry",
          status: DunningCaseStatus.RETRY_SCHEDULED,
          attempt_count: 0,
          max_attempts: 3,
          retry_schedule: defaultRetrySchedule,
          next_retry_at: new Date("2026-03-30T10:00:00.000Z"),
        })

        mockCreatePaymentSessionsRun.mockResolvedValue({
          result: { id: "payses_2", context: {}, status: "pending" },
        })

        jest.spyOn(query, "graph").mockImplementation(async (input: any) => {
          if (input.entity === "order") {
            return {
              data: [{ id: "ord_dun_retry", total: 1.29, currency_code: "usd" }],
            }
          }

          return originalGraph(input)
        })
        jest
          .spyOn(paymentModule, "authorizePaymentSession")
          .mockRejectedValue(new Error("Temporary network timeout"))
        jest.spyOn(paymentModule, "listPaymentSessions").mockResolvedValue([
          { id: "payses_2", status: "pending" },
        ] as any)

        const { result } = await runDunningRetryWorkflow(container).run({
          input: {
            dunning_case_id: dunningCase.id,
            now: "2026-03-30T10:00:00.000Z",
          },
        })

        const updatedCase = await dunningModule.retrieveDunningCase(dunningCase.id)
        const attempts = await dunningModule.listDunningAttempts({
          dunning_case_id: dunningCase.id,
        } as any)

        expect(result.outcome).toEqual("retry_scheduled")
        expect(updatedCase).toMatchObject({
          status: DunningCaseStatus.RETRY_SCHEDULED,
          attempt_count: 1,
          last_payment_error_code: "pending",
        })
        expect(updatedCase.next_retry_at).toBeTruthy()
        expect(attempts).toHaveLength(1)
        expect(attempts[0]).toMatchObject({
          status: DunningAttemptStatus.FAILED,
          payment_reference: "payses_2",
        })
      })

      it("closes the case as unrecovered when max attempts are exhausted", async () => {
        const container = getContainer()
        const dunningModule =
          container.resolve<DunningModuleService>(DUNNING_MODULE)
        const subscriptionModule =
          container.resolve<SubscriptionModuleService>(SUBSCRIPTION_MODULE)
        const renewalModule =
          container.resolve<RenewalModuleService>(RENEWAL_MODULE)
        const paymentModule =
          container.resolve<IPaymentModuleService>(Modules.PAYMENT)
        const query = container.resolve<any>(ContainerRegistrationKeys.QUERY)
        const originalGraph = query.graph.bind(query)

        // Decision R3: a background job must never cancel the customer
        // relationship as a side effect of writing off a period. The spies on
        // the plugin's cancellation workflows' run methods fail this suite if
        // the exhaustion path ever grows that side effect. (The spies sit on
        // the workflow function's own `run` property — the module namespace
        // exports themselves are non-configurable under the ESM jest
        // environment and cannot be spied directly.)
        const cancelSubscriptionRunSpy = jest.spyOn(
          cancelSubscriptionModule.cancelSubscriptionWorkflow,
          "run"
        )
        const finalizeCancellationRunSpy = jest.spyOn(
          finalizeCancellationModule.finalizeCancellationWorkflow,
          "run"
        )

        const subscription = await createSubscriptionSeed(container, {
          reference: "SUB-DUN-WF-006",
          status: SubscriptionStatus.PAST_DUE,
        })
        const cycle = await createRenewalCycleSeed(container, {
          subscription_id: subscription.id,
          status: RenewalCycleStatus.FAILED,
          generated_order_id: "ord_dun_unrecovered",
        })
        const dunningCase = await createDunningCaseSeed(container, {
          subscription_id: subscription.id,
          renewal_cycle_id: cycle.id,
          renewal_order_id: "ord_dun_unrecovered",
          status: DunningCaseStatus.RETRY_SCHEDULED,
          attempt_count: 2,
          max_attempts: 3,
          retry_schedule: defaultRetrySchedule,
          next_retry_at: new Date("2026-03-30T10:00:00.000Z"),
        })

        mockCreatePaymentSessionsRun.mockResolvedValue({
          result: { id: "payses_3", context: {}, status: "pending" },
        })

        jest.spyOn(query, "graph").mockImplementation(async (input: any) => {
          if (input.entity === "order") {
            return {
              data: [
                { id: "ord_dun_unrecovered", total: 1.29, currency_code: "usd" },
              ],
            }
          }

          return originalGraph(input)
        })
        jest
          .spyOn(paymentModule, "authorizePaymentSession")
          .mockRejectedValue(new Error("Temporary network timeout"))
        jest.spyOn(paymentModule, "listPaymentSessions").mockResolvedValue([
          { id: "payses_3", status: "pending" },
        ] as any)

        // Spied before the run so the exhaustion emission below is observable;
        // created inside this test, so it only records this run's calls.
        const eventBus = container.resolve("event_bus") as unknown as {
          emit: (data: unknown) => Promise<void>
        }
        const emitSpy = jest.spyOn(eventBus, "emit")

        const { result } = await runDunningRetryWorkflow(container).run({
          input: {
            dunning_case_id: dunningCase.id,
            now: "2026-03-30T10:00:00.000Z",
          },
        })

        const updatedCase = await dunningModule.retrieveDunningCase(dunningCase.id)

        expect(result.outcome).toEqual("unrecovered")
        expect(updatedCase).toMatchObject({
          status: DunningCaseStatus.UNRECOVERED,
          attempt_count: 3,
          recovery_reason: "retry_limit_exhausted",
        })
        expect(updatedCase.closed_at).toBeTruthy()

        // Exhaustion abandons the originating cycle (R3): the period is
        // written off into the terminal status, carrying the exhaustion
        // reason, so the due query stops selecting it.
        const updatedCycle = await renewalModule.retrieveRenewalCycle(cycle.id)
        expect(updatedCycle.status).toEqual(RenewalCycleStatus.ABANDONED)
        expect(updatedCycle.last_error).toContain("retry_limit_exhausted")

        // The subscription is left past_due — not cancelled, and carrying no
        // cancellation timestamp.
        const updatedSubscription = await subscriptionModule.retrieveSubscription(
          subscription.id
        )
        expect(updatedSubscription.status).toEqual(SubscriptionStatus.PAST_DUE)
        expect(updatedSubscription.cancelled_at).toBeFalsy()
        expect(updatedSubscription.cancel_effective_at).toBeFalsy()

        // Task 12: post-payment exhaustion emits the alertable write-off the
        // host's R3 decision hangs on, exactly once — the settlement helper
        // (`abandonCycleOnDunningExhaustion`) persists AND emits where the
        // cycle write lands.
        const abandonedEvents = emitSpy.mock.calls
          .flatMap((call) => {
            const payload = call[0] as unknown
            return Array.isArray(payload) ? payload : [payload]
          })
          .filter(
            (event) => (event as { name?: string })?.name === "renewal.abandoned"
          )
        expect(abandonedEvents).toHaveLength(1)

        expect(cancelSubscriptionRunSpy).not.toHaveBeenCalled()
        expect(finalizeCancellationRunSpy).not.toHaveBeenCalled()
      })

      it("supports manual actions, retry schedule override, and dunning read models", async () => {
        const container = getContainer()
        const dunningModule =
          container.resolve<DunningModuleService>(DUNNING_MODULE)
        const subscriptionModule =
          container.resolve<SubscriptionModuleService>(SUBSCRIPTION_MODULE)

        const subscription = await createSubscriptionSeed(container, {
          reference: "SUB-DUN-WF-007",
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
          metadata: {
            source: "workflow-test",
          },
        })

        await createDunningAttemptSeed(container, {
          dunning_case_id: dunningCase.id,
          attempt_no: 1,
          status: DunningAttemptStatus.FAILED,
          finished_at: new Date("2026-03-29T10:00:00.000Z"),
          error_code: "card_declined",
          error_message: "Issuer declined",
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

        const updatedScheduleCase = await dunningModule.retrieveDunningCase(
          dunningCase.id
        )

        expect(updatedScheduleCase).toMatchObject({
          status: DunningCaseStatus.RETRY_SCHEDULED,
          max_attempts: 2,
          retry_schedule: expect.objectContaining({
            intervals: [60, 120],
            source: "manual_override",
          }),
        })
        expect(updatedScheduleCase.next_retry_at).toBeTruthy()

        await markDunningRecoveredWorkflow(container).run({
          input: {
            dunning_case_id: dunningCase.id,
            triggered_by: "admin_user",
            reason: "customer paid offline",
          },
        })

        const recoveredCase = await dunningModule.retrieveDunningCase(dunningCase.id)
        const activeSubscription = await subscriptionModule.retrieveSubscription(
          subscription.id
        )

        expect(recoveredCase).toMatchObject({
          status: DunningCaseStatus.RECOVERED,
          recovery_reason: "marked_recovered_by_admin",
        })
        expect(activeSubscription.status).toEqual(SubscriptionStatus.ACTIVE)

        const anotherSubscription = await createSubscriptionSeed(container, {
          reference: "SUB-DUN-WF-008",
          status: SubscriptionStatus.PAST_DUE,
        })
        const anotherCycle = await createRenewalCycleSeed(container, {
          subscription_id: anotherSubscription.id,
          status: RenewalCycleStatus.FAILED,
        })
        const unrecoveredCase = await createDunningCaseSeed(container, {
          subscription_id: anotherSubscription.id,
          renewal_cycle_id: anotherCycle.id,
          status: DunningCaseStatus.AWAITING_MANUAL_RESOLUTION,
          next_retry_at: null,
        })

        await markDunningUnrecoveredWorkflow(container).run({
          input: {
            dunning_case_id: unrecoveredCase.id,
            triggered_by: "admin_user",
            reason: "customer did not update card",
          },
        })

        const finalCase = await dunningModule.retrieveDunningCase(unrecoveredCase.id)
        expect(finalCase).toMatchObject({
          status: DunningCaseStatus.UNRECOVERED,
          recovery_reason: "marked_unrecovered_by_admin",
        })

        // The admin closure abandons the originating cycle too (R3): the
        // operator's write-off of the case is the write-off of the period,
        // while the subscription itself stays past_due.
        const workflowRenewalModule =
          container.resolve<RenewalModuleService>(RENEWAL_MODULE)
        const abandonedCycle = await workflowRenewalModule.retrieveRenewalCycle(
          anotherCycle.id
        )
        expect(abandonedCycle.status).toEqual(RenewalCycleStatus.ABANDONED)
        expect(abandonedCycle.last_error).toContain(
          "marked unrecovered by admin"
        )
        const unrecoveredSubscriptionRow =
          await subscriptionModule.retrieveSubscription(anotherSubscription.id)
        expect(unrecoveredSubscriptionRow.status).toEqual(
          SubscriptionStatus.PAST_DUE
        )

        const listResponse = await listAdminDunningCases(container, {
          limit: 20,
          offset: 0,
          subscription_id: subscription.id,
        })
        const detailResponse = await getAdminDunningDetail(container, dunningCase.id)

        expect(listResponse.dunning_cases.some((item) => item.id === dunningCase.id)).toBe(
          true
        )
        expect(detailResponse.dunning_case).toMatchObject({
          id: dunningCase.id,
          subscription: expect.objectContaining({
            reference: "SUB-DUN-WF-007",
          }),
        })
        expect(detailResponse.dunning_case.attempts).toHaveLength(1)
      })

      it("parks a case whose subscription is no longer chargeable and still processes the rest of the batch", async () => {
        // Task 10 Step 1 wedge: the subscription was cancelled while its
        // dunning case was due. The retry used to throw before the RETRYING
        // transition, leaving the stale past `next_retry_at` in the due set —
        // re-selected and re-thrown by every scheduler run forever. The step
        // must park the case (it leaves the due set, stays open for manual
        // resolution) and the run must carry on with the remaining cases.
        const container = getContainer()
        const dunningModule =
          container.resolve<DunningModuleService>(DUNNING_MODULE)
        const subscriptionModule =
          container.resolve<SubscriptionModuleService>(SUBSCRIPTION_MODULE)
        const renewalModule =
          container.resolve<RenewalModuleService>(RENEWAL_MODULE)
        const paymentModule =
          container.resolve<IPaymentModuleService>(Modules.PAYMENT)
        const query = container.resolve<any>(ContainerRegistrationKeys.QUERY)
        const originalGraph = query.graph.bind(query)

        const cancelledSubscription = await createSubscriptionSeed(container, {
          reference: "SUB-DUN-WF-WEDGE",
          status: SubscriptionStatus.CANCELLED,
        })
        const wedgedCycle = await createRenewalCycleSeed(container, {
          subscription_id: cancelledSubscription.id,
          status: RenewalCycleStatus.FAILED,
          generated_order_id: "ord_dun_wedge",
        })
        const wedgedCase = await createDunningCaseSeed(container, {
          subscription_id: cancelledSubscription.id,
          renewal_cycle_id: wedgedCycle.id,
          renewal_order_id: "ord_dun_wedge",
          status: DunningCaseStatus.RETRY_SCHEDULED,
          attempt_count: 1,
          max_attempts: 3,
          retry_schedule: defaultRetrySchedule,
          next_retry_at: new Date("2026-03-30T10:00:00.000Z"),
        })

        // A healthy due case in the same batch: the wedged one must not take
        // the whole run down with it.
        const healthySubscription = await createSubscriptionSeed(container, {
          reference: "SUB-DUN-WF-WEDGE-OK",
          status: SubscriptionStatus.PAST_DUE,
        })
        const healthyCycle = await createRenewalCycleSeed(container, {
          subscription_id: healthySubscription.id,
          status: RenewalCycleStatus.FAILED,
          generated_order_id: "ord_dun_wedge_ok",
        })
        const healthyCase = await createDunningCaseSeed(container, {
          subscription_id: healthySubscription.id,
          renewal_cycle_id: healthyCycle.id,
          renewal_order_id: "ord_dun_wedge_ok",
          status: DunningCaseStatus.RETRY_SCHEDULED,
          attempt_count: 0,
          max_attempts: 3,
          retry_schedule: defaultRetrySchedule,
          next_retry_at: new Date("2026-03-30T10:00:00.000Z"),
        })

        mockCreatePaymentSessionsRun.mockResolvedValue({
          result: { id: "payses_wedge_ok", context: {}, status: "pending" },
        })

        jest.spyOn(query, "graph").mockImplementation(async (input: any) => {
          if (input.entity === "order") {
            const ids = (input.filters?.id ?? []) as string[]
            return {
              data: ids.map((id) => ({
                id,
                total: 1.29,
                currency_code: "usd",
              })),
            }
          }

          return originalGraph(input)
        })
        jest
          .spyOn(paymentModule, "authorizePaymentSession")
          .mockResolvedValue({ id: "pay_wedge_ok", amount: 1.29 } as any)
        jest
          .spyOn(paymentModule, "capturePayment")
          .mockResolvedValue({ id: "pay_wedge_ok" } as any)

        // Terminates: the wedged case parks instead of throwing, so the
        // fixed-page re-query drains the due set.
        await processDunningRetriesJob(container)

        const parkedCase = await dunningModule.retrieveDunningCase(wedgedCase.id)
        expect(parkedCase).toMatchObject({
          status: DunningCaseStatus.AWAITING_MANUAL_RESOLUTION,
          recovery_reason: "subscription_not_chargeable",
        })
        expect(parkedCase.next_retry_at).toBeNull()
        expect(parkedCase.closed_at).toBeFalsy()

        // Nothing ran against the wedged case: no attempt, no charge, and the
        // period is neither paid nor written off — parking is not exhaustion.
        const wedgedAttempts = await dunningModule.listDunningAttempts({
          dunning_case_id: wedgedCase.id,
        } as any)
        expect(wedgedAttempts).toHaveLength(0)
        const untouchedCycle = await renewalModule.retrieveRenewalCycle(
          wedgedCycle.id
        )
        expect(untouchedCycle.status).toEqual(RenewalCycleStatus.FAILED)

        // The case left the due set...
        const due = await listDueDunningCasesForProcessing(container, {
          limit: 20,
        })
        expect(due.cases.some((item) => item.id === wedgedCase.id)).toBe(false)
        expect(due.count).toEqual(0)
        // ...while staying resolvable: retry-now accepts the status through
        // the step's own guards, and both mark-* workflows close it.
        await markDunningUnrecoveredWorkflow(container).run({
          input: {
            dunning_case_id: wedgedCase.id,
            triggered_by: "admin_user",
            reason: "subscription cancelled",
          },
        })
        const closedCase = await dunningModule.retrieveDunningCase(wedgedCase.id)
        expect(closedCase.status).toEqual(DunningCaseStatus.UNRECOVERED)

        // The healthy case still ran to recovery.
        const recoveredCase = await dunningModule.retrieveDunningCase(healthyCase.id)
        expect(recoveredCase.status).toEqual(DunningCaseStatus.RECOVERED)
        const recoveredSubscription = await subscriptionModule.retrieveSubscription(
          healthySubscription.id
        )
        expect(recoveredSubscription.status).toEqual(SubscriptionStatus.ACTIVE)
        const recoveredCycle = await renewalModule.retrieveRenewalCycle(
          healthyCycle.id
        )
        expect(recoveredCycle.status).toEqual(RenewalCycleStatus.SUCCEEDED)
      })

      it("terminates the scheduler run through the iteration cap when a case can never leave the due set", async () => {
        // Task 10 Step 2 safety net: the case's renewal cycle row is gone — an
        // integrity fault the step's dispositions do not know about, so every
        // retry still throws before any transition (not_found, alertable).
        // Step 1 cannot make progress here; the cap is what ends the run and
        // releases the job lock instead of looping forever.
        const container = getContainer()
        const dunningModule =
          container.resolve<DunningModuleService>(DUNNING_MODULE)
        const logger = container.resolve<{ warn: (...args: unknown[]) => void }>(
          "logger"
        )
        const warnSpy = jest.spyOn(logger, "warn")

        const subscription = await createSubscriptionSeed(container, {
          reference: "SUB-DUN-WF-CAP",
          status: SubscriptionStatus.PAST_DUE,
        })
        const wedgedCase = await createDunningCaseSeed(container, {
          subscription_id: subscription.id,
          renewal_cycle_id: "cyc_missing_cap",
          renewal_order_id: "ord_dun_cap",
          status: DunningCaseStatus.RETRY_SCHEDULED,
          attempt_count: 0,
          max_attempts: 3,
          retry_schedule: defaultRetrySchedule,
          next_retry_at: new Date("2026-03-30T10:00:00.000Z"),
        })

        await processDunningRetriesJob(container)

        // The case is untouched and still due — the wedge is real; the cap,
        // not progress, ended the run.
        const unchangedCase = await dunningModule.retrieveDunningCase(wedgedCase.id)
        expect(unchangedCase.status).toEqual(DunningCaseStatus.RETRY_SCHEDULED)
        expect(unchangedCase.closed_at).toBeFalsy()
        expect(unchangedCase.next_retry_at).toBeTruthy()

        const due = await listDueDunningCasesForProcessing(container, {
          limit: 20,
        })
        expect(due.cases.some((item) => item.id === wedgedCase.id)).toBe(true)

        const capReached = warnSpy.mock.calls.some((call) =>
          call.some((line) => String(line).includes("hit the iteration cap"))
        )
        expect(capReached).toBe(true)
      })
    })
  },
})

jest.setTimeout(60 * 1000)
