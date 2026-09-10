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
import { SUBSCRIPTION_MODULE } from "../../src/modules/subscription"
import type SubscriptionModuleService from "../../src/modules/subscription/service"
import { SubscriptionStatus } from "../../src/modules/subscription/types"
import { markDunningRecoveredWorkflow } from "../../src/workflows/mark-dunning-recovered"
import { markDunningUnrecoveredWorkflow } from "../../src/workflows/mark-dunning-unrecovered"
import { runDunningRetryWorkflow } from "../../src/workflows/run-dunning-retry"
import { startDunningWorkflow } from "../../src/workflows/start-dunning"
import { updateDunningRetryScheduleWorkflow } from "../../src/workflows/update-dunning-retry-schedule"
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
              data: [{ id: "ord_dun_success", total: 129, currency_code: "usd" }],
            }
          }

          return originalGraph(input)
        })
        jest
          .spyOn(paymentModule, "authorizePaymentSession")
          .mockResolvedValue({ id: "pay_1", amount: 129 } as any)
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
        expect(updatedCycle.status).toEqual(RenewalCycleStatus.FAILED)
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
              data: [{ id: "ord_dun_retry", total: 129, currency_code: "usd" }],
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
        const paymentModule =
          container.resolve<IPaymentModuleService>(Modules.PAYMENT)
        const query = container.resolve<any>(ContainerRegistrationKeys.QUERY)
        const originalGraph = query.graph.bind(query)

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
                { id: "ord_dun_unrecovered", total: 129, currency_code: "usd" },
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
    })
  },
})

jest.setTimeout(60 * 1000)
