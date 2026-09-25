import { medusaIntegrationTestRunner } from "@medusajs/test-utils"
import path from "path"
import { MedusaError, Modules } from "@medusajs/framework/utils"
import {
  createAdminAuthHeaders,
  createCustomer,
  createProductWithVariant,
  createStoreCustomerAuthHeaders,
} from "../helpers/subscription-fixtures"
import { createPlanOfferSeed } from "../helpers/plan-offer-fixtures"
import { createRedemptionBatch } from "../helpers/redemption-fixtures"
import { REDEMPTION_MODULE } from "../../src/modules/redemption"
import type RedemptionModuleService from "../../src/modules/redemption/service"
import { SUBSCRIPTION_MODULE } from "../../src/modules/subscription"
import type SubscriptionModuleService from "../../src/modules/subscription/service"
import { RENEWAL_MODULE } from "../../src/modules/renewal"
import type RenewalModuleService from "../../src/modules/renewal/service"
import { RenewalCycleStatus } from "../../src/modules/renewal/types"
import { ACTIVITY_LOG_MODULE } from "../../src/modules/activity-log"
import type ActivityLogModuleService from "../../src/modules/activity-log/service"
import { processRenewalCycleWorkflow } from "../../src/workflows/process-renewal-cycle"
import { createRenewalCycleSeed } from "../helpers/renewal-fixtures"


async function createStoreHeadersWithPublishableKey(
  container: any,
  customer: { id: string }
): Promise<Record<string, string>> {
  const apiKeyModule = container.resolve<any>(Modules.API_KEY)
  const pk = await apiKeyModule.createApiKeys({
    title: `redemption-test-${Date.now()}`,
    type: "publishable",
    created_by: "test",
  })
  return {
    ...(await createStoreCustomerAuthHeaders(container, customer)),
    "x-publishable-api-key": pk.token,
  }
}

medusaIntegrationTestRunner({
  medusaConfigFile: path.resolve(process.cwd(), "integration-tests"),
  env: {
    JWT_SECRET: "supersecret",
    COOKIE_SECRET: "supersecret",
  },
  testSuite: ({ api, getContainer }) => {
    describe("store redemption endpoints — create path", () => {
      it("previews and redeems a code into a payment-free subscription", async () => {
        const container = getContainer()
        const adminHeaders = await createAdminAuthHeaders(container)
        const customer = await createCustomer(container)
        const customerHeaders = await createStoreHeadersWithPublishableKey(
          container,
          customer
        )
        const { variant } = await createProductWithVariant(container)

        await createPlanOfferSeed(container, {
          name: "RDM-STORE-OFFER-001",
          scope: "variant",
          variant_id: variant.id,
          allowed_frequencies: [{ interval: "month", value: 1 }],
        })

        const batch = await createRedemptionBatch(container, {
          name: "RDM-STORE-BATCH-001",
          variant_id: variant.id,
          free_cycles: 3,
          max_redemptions_per_code: 2,
          generated_code_count: 2,
        })
        const code = batch.codes[0].code

        const preview = await api.post(
          "/store/customers/me/redemptions/preview",
          { code },
          { headers: customerHeaders }
        )
        expect(preview.status).toEqual(200)
        expect(preview.data.kind).toEqual("create")
        expect(preview.data.grant.variant_id).toEqual(variant.id)
        expect(preview.data.grant.free_cycles).toEqual(3)
        expect(preview.data.target_subscription_id).toBeNull()

        const redeem = await api.post(
          "/store/customers/me/redemptions",
          { code },
          { headers: customerHeaders }
        )
        expect(redeem.status).toEqual(200)
        expect(redeem.data.subscription_id).toBeTruthy()

        const subscriptionModule = container.resolve<SubscriptionModuleService>(
          SUBSCRIPTION_MODULE
        )
        const subscription = await subscriptionModule.retrieveSubscription(
          redeem.data.subscription_id
        )

        expect(subscription.reference).toMatch(/^SUB-RDM-/)
        expect(subscription.status).toEqual("active")
        expect(subscription.free_cycles_remaining).toEqual(3)
        expect(subscription.is_trial).toEqual(false)
        expect(subscription.cart_id).toBeNull()
        expect(
          (subscription.metadata as Record<string, unknown>).source
        ).toEqual("redemption")
        expect(subscription.cancel_effective_at).toBeTruthy()
        expect(subscription.next_renewal_at).toBeTruthy()

        // Timing semantics: first free cycle due immediately; the boundary
        // lands N cadences out.
        expect(
          new Date(subscription.next_renewal_at as unknown as string).getTime()
        ).toBeLessThanOrEqual(Date.now())
        expect(
          new Date(
            subscription.cancel_effective_at as unknown as string
          ).getTime()
        ).toBeGreaterThan(Date.now())

        // Initial cycle scheduled and due.
        const renewalModule = container.resolve<RenewalModuleService>(
          RENEWAL_MODULE
        )
        const cycles = await renewalModule.listRenewalCycles({
          subscription_id: subscription.id,
        } as any)
        expect(cycles).toHaveLength(1)
        expect(cycles[0].status).toEqual(RenewalCycleStatus.SCHEDULED)

        // Redemption record written and history lists it.
        const redemptionModule = container.resolve<RedemptionModuleService>(
          REDEMPTION_MODULE
        )
        const records = await redemptionModule.listCustomerRecords(
          customer.id
        )
        expect(records).toHaveLength(1)
        expect(records[0].outcome).toEqual("subscription_created")
        expect(records[0].free_cycles_applied).toEqual(3)

        const history = await api.get(
          "/store/customers/me/redemptions",
          { headers: customerHeaders }
        )
        expect(history.status).toEqual(200)
        expect(history.data.redemptions).toHaveLength(1)
        expect(history.data.redemptions[0].outcome).toEqual(
          "subscription_created"
        )

        // Activity log has the redemption event.
        const activityLogModule = container.resolve<ActivityLogModuleService>(
          ACTIVITY_LOG_MODULE
        )
        const logs = await activityLogModule.listSubscriptionLogs({
          subscription_id: subscription.id,
        } as any)
        expect(
          logs.some(
            (log: { event_type: string }) =>
              log.event_type === "redemption.redeemed"
          )
        ).toBe(true)
      })

      it("consumes free cycles through the renewal engine without orders or payment", async () => {
        const container = getContainer()
        const customer = await createCustomer(container)
        const customerHeaders = await createStoreHeadersWithPublishableKey(
          container,
          customer
        )
        const { variant } = await createProductWithVariant(container)

        await createPlanOfferSeed(container, {
          name: "RDM-STORE-OFFER-002",
          scope: "variant",
          variant_id: variant.id,
          allowed_frequencies: [{ interval: "month", value: 1 }],
        })

        const batch = await createRedemptionBatch(container, {
          name: "RDM-STORE-BATCH-002",
          variant_id: variant.id,
          free_cycles: 2,
          generated_code_count: 1,
        })

        const redeem = await api.post(
          "/store/customers/me/redemptions",
          { code: batch.codes[0].code },
          { headers: customerHeaders }
        )
        const subscriptionId = redeem.data.subscription_id

        const renewalModule = container.resolve<RenewalModuleService>(
          RENEWAL_MODULE
        )
        const subscriptionModule = container.resolve<SubscriptionModuleService>(
          SUBSCRIPTION_MODULE
        )

        // Cycle 1 — free.
        let cycles = await renewalModule.listRenewalCycles({
          subscription_id: subscriptionId,
        } as any)
        const { result } = await processRenewalCycleWorkflow(container).run({
          input: { renewal_cycle_id: cycles[0].id, trigger_type: "scheduler" },
        })

        expect(result.renewal_cycle.status).toEqual(RenewalCycleStatus.SUCCEEDED)
        expect(result.renewal_cycle.generated_order_id).toBeNull()

        let subscription = await subscriptionModule.retrieveSubscription(
          subscriptionId
        )
        expect(subscription.free_cycles_remaining).toEqual(1)
        expect(subscription.status).toEqual("active")

        // Next cycle pre-created, still within the free window. The list
        // holds the succeeded cycle plus exactly one SCHEDULED one.
        cycles = await renewalModule.listRenewalCycles({
          subscription_id: subscriptionId,
        } as any)
        const scheduled = cycles.filter(
          (cycle: { status: string }) =>
            cycle.status === RenewalCycleStatus.SCHEDULED
        )
        expect(scheduled).toHaveLength(1)

        // Cycle 2 — last free cycle; boundary cycle beyond it is excluded.
        await processRenewalCycleWorkflow(container).run({
          input: { renewal_cycle_id: scheduled[0].id, trigger_type: "scheduler" },
        })

        subscription = await subscriptionModule.retrieveSubscription(
          subscriptionId
        )
        expect(subscription.free_cycles_remaining).toEqual(0)
        expect(subscription.status).toEqual("active")

        cycles = await renewalModule.listRenewalCycles({
          subscription_id: subscriptionId,
        } as any)
        // No cycle beyond the cancel boundary is pre-created.
        const remainingScheduled = cycles.filter(
          (cycle: { status: string }) =>
            cycle.status === RenewalCycleStatus.SCHEDULED
        )
        expect(remainingScheduled).toHaveLength(0)
      })

      it("enforces per-customer limit, window, disabled state and exhaustion", async () => {
        const container = getContainer()
        const customer = await createCustomer(container)
        const customerHeaders = await createStoreHeadersWithPublishableKey(
          container,
          customer
        )
        const { variant } = await createProductWithVariant(container)

        await createPlanOfferSeed(container, {
          name: "RDM-STORE-OFFER-003",
          scope: "variant",
          variant_id: variant.id,
          allowed_frequencies: [{ interval: "month", value: 1 }],
        })

        // Window not started.
        const futureBatch = await createRedemptionBatch(container, {
          name: "RDM-STORE-BATCH-WINDOW",
          variant_id: variant.id,
          free_cycles: 1,
          generated_code_count: 1,
          starts_at: new Date(Date.now() + 24 * 60 * 60 * 1000),
        })
        await expect(
          api.post(
            "/store/customers/me/redemptions",
            { code: futureBatch.codes[0].code },
            { headers: customerHeaders }
          )
        ).rejects.toMatchObject({ response: { status: 400 } })

        // Disabled batch.
        const disabledBatch = await createRedemptionBatch(container, {
          name: "RDM-STORE-BATCH-DISABLED",
          variant_id: variant.id,
          free_cycles: 1,
          generated_code_count: 1,
        })
        const redemptionModule = container.resolve<RedemptionModuleService>(
          REDEMPTION_MODULE
        )
        await redemptionModule.disableBatch(disabledBatch.batch.id)
        await expect(
          api.post(
            "/store/customers/me/redemptions",
            { code: disabledBatch.codes[0].code },
            { headers: customerHeaders }
          )
        ).rejects.toMatchObject({ response: { status: 400 } })

        // Exhausted + per-customer limit (max_redemptions = 1).
        const singleBatch = await createRedemptionBatch(container, {
          name: "RDM-STORE-BATCH-SINGLE",
          variant_id: variant.id,
          free_cycles: 1,
          max_redemptions_per_code: 1,
          generated_code_count: 1,
        })
        const firstRedeem = await api.post(
          "/store/customers/me/redemptions",
          { code: singleBatch.codes[0].code },
          { headers: customerHeaders }
        )
        expect(firstRedeem.status).toEqual(200)

        // Second redemption by the same customer — per-customer rule.
        await expect(
          api.post(
            "/store/customers/me/redemptions",
            { code: singleBatch.codes[0].code },
            { headers: customerHeaders }
          )
        ).rejects.toMatchObject({ response: { status: 400 } })

        // Exhausted check via a second customer.
        const secondCustomer = await createCustomer(container)
        const secondHeaders = await createStoreHeadersWithPublishableKey(
          container,
          secondCustomer
        )
        await expect(
          api.post(
            "/store/customers/me/redemptions",
            { code: singleBatch.codes[0].code },
            { headers: secondHeaders }
          )
        ).rejects.toMatchObject({ response: { status: 400 } })
      })

      it("extends an existing ACTIVE subscription instead of duplicating it", async () => {
        const container = getContainer()
        const customer = await createCustomer(container)
        const customerHeaders = await createStoreHeadersWithPublishableKey(
          container,
          customer
        )
        const { variant } = await createProductWithVariant(container)

        await createPlanOfferSeed(container, {
          name: "RDM-STORE-OFFER-004",
          scope: "variant",
          variant_id: variant.id,
          allowed_frequencies: [{ interval: "month", value: 1 }],
        })

        const batch = await createRedemptionBatch(container, {
          name: "RDM-STORE-BATCH-EXT",
          variant_id: variant.id,
          free_cycles: 2,
          generated_code_count: 2,
        })

        const preview = await api.post(
          "/store/customers/me/redemptions/preview",
          { code: batch.codes[0].code },
          { headers: customerHeaders }
        )
        expect(preview.data.kind).toEqual("create")

        const first = await api.post(
          "/store/customers/me/redemptions",
          { code: batch.codes[0].code },
          { headers: customerHeaders }
        )
        expect(first.status).toEqual(200)
        const createdSubscriptionId = first.data.subscription_id

        // Second code for the same variant → extend, not duplicate.
        const previewExtend = await api.post(
          "/store/customers/me/redemptions/preview",
          { code: batch.codes[1].code },
          { headers: customerHeaders }
        )
        expect(previewExtend.status).toEqual(200)
        expect(previewExtend.data.kind).toEqual("extend")
        expect(previewExtend.data.target_subscription_id).toEqual(
          createdSubscriptionId
        )

        const second = await api.post(
          "/store/customers/me/redemptions",
          { code: batch.codes[1].code },
          { headers: customerHeaders }
        )
        expect(second.status).toEqual(200)
        expect(second.data.subscription_id).toEqual(createdSubscriptionId)
        expect(second.data.outcome).toEqual("subscription_extended")
        expect(second.data.free_cycles_remaining).toEqual(4)

        const subscriptionModule = container.resolve<SubscriptionModuleService>(
          SUBSCRIPTION_MODULE
        )
        const subscription = await subscriptionModule.retrieveSubscription(
          createdSubscriptionId
        )
        expect(subscription.free_cycles_remaining).toEqual(4)
        expect(subscription.status).toEqual("active")

        // History records both outcomes.
        const history = await api.get("/store/customers/me/redemptions", {
          headers: customerHeaders,
        })
        const outcomes = history.data.redemptions.map(
          (record: { outcome: string }) => record.outcome
        )
        expect(outcomes).toEqual([
          "subscription_extended",
          "subscription_created",
        ])
      })

      it("recovers dunning and reactivates a PAST_DUE subscription on extension", async () => {
        const container = getContainer()
        const customer = await createCustomer(container)
        const customerHeaders = await createStoreHeadersWithPublishableKey(
          container,
          customer
        )
        const { variant } = await createProductWithVariant(container)

        await createPlanOfferSeed(container, {
          name: "RDM-STORE-OFFER-006",
          scope: "variant",
          variant_id: variant.id,
          allowed_frequencies: [{ interval: "month", value: 1 }],
        })

        const batch = await createRedemptionBatch(container, {
          name: "RDM-STORE-BATCH-PASTDUE",
          variant_id: variant.id,
          free_cycles: 2,
          generated_code_count: 1,
        })

        // Seed a PAST_DUE subscription of the same variant with an open
        // dunning case (fixtures bypass the checkout flow).
        const subscriptionModule = container.resolve<SubscriptionModuleService>(
          SUBSCRIPTION_MODULE
        )
        const subscription = await subscriptionModule.createSubscriptions({
          reference: `SUB-RDM-PASTDUE-${Date.now()}`,
          status: "past_due",
          customer_id: customer.id,
          cart_id: null,
          product_id: variant.product_id ?? variant.product?.id ?? "prod_x",
          variant_id: variant.id,
          frequency_interval: "month",
          frequency_value: 1,
          started_at: new Date(),
          next_renewal_at: new Date(Date.now() - 24 * 60 * 60 * 1000),
          is_trial: false,
          product_snapshot: {
            product_id: variant.product_id ?? variant.product?.id ?? "prod_x",
            product_title: "Product",
            variant_id: variant.id,
            variant_title: "Variant",
            sku: null,
          },
          shipping_address: {},
          payment_context: {
            payment_provider_id: null,
            payment_mode: "auto",
            source_payment_collection_id: null,
            source_payment_session_id: null,
            payment_method_reference: null,
            customer_payment_reference: null,
          },
        } as any)

        const dunningModule = container.resolve<any>("dunning")
        const dunningCase = await dunningModule.createDunningCases({
          subscription_id: subscription.id,
          renewal_cycle_id: `rc_seed_${Date.now()}`,
          max_attempts: 3,
          status: "retry_scheduled",
        } as any)

        const redeem = await api.post(
          "/store/customers/me/redemptions",
          { code: batch.codes[0].code },
          { headers: customerHeaders }
        )
        expect(redeem.status).toEqual(200)
        expect(redeem.data.subscription_id).toEqual(subscription.id)
        expect(redeem.data.outcome).toEqual("subscription_extended")
        expect(redeem.data.dunning_recovered).toEqual(true)

        const updated = await subscriptionModule.retrieveSubscription(
          subscription.id
        )
        expect(updated.status).toEqual("active")
        expect(updated.free_cycles_remaining).toEqual(2)

        const recoveredCase = await dunningModule.retrieveDunningCase(
          dunningCase.id
        )
        expect(recoveredCase.status).toEqual("recovered")
        expect(recoveredCase.recovery_reason).toEqual(
          "redemption_free_cycles_applied"
        )
      })

      it("expires redemption subscriptions past their cancel boundary", async () => {
        const container = getContainer()
        const customer = await createCustomer(container)
        const customerHeaders = await createStoreHeadersWithPublishableKey(
          container,
          customer
        )
        const { variant } = await createProductWithVariant(container)

        await createPlanOfferSeed(container, {
          name: "RDM-STORE-OFFER-005",
          scope: "variant",
          variant_id: variant.id,
          allowed_frequencies: [{ interval: "month", value: 1 }],
        })

        const batch = await createRedemptionBatch(container, {
          name: "RDM-STORE-BATCH-EXPIRY",
          variant_id: variant.id,
          free_cycles: 1,
          generated_code_count: 1,
        })

        const redeem = await api.post(
          "/store/customers/me/redemptions",
          { code: batch.codes[0].code },
          { headers: customerHeaders }
        )
        const subscriptionId = redeem.data.subscription_id

        // Simulate the boundary passing.
        const subscriptionModule = container.resolve<SubscriptionModuleService>(
          SUBSCRIPTION_MODULE
        )
        await subscriptionModule.updateSubscriptions({
          id: subscriptionId,
          cancel_effective_at: new Date(Date.now() - 1000),
        } as any)

        // Run the expiry job body directly.
        const jobModule = await import("../../src/jobs/redemption-expiry")
        await jobModule.default(container)

        const subscription = await subscriptionModule.retrieveSubscription(
          subscriptionId
        )
        expect(subscription.status).toEqual("cancelled")
        expect(subscription.cancelled_at).toBeTruthy()

        const activityLogModule = container.resolve<ActivityLogModuleService>(
          ACTIVITY_LOG_MODULE
        )
        const logs = await activityLogModule.listSubscriptionLogs({
          subscription_id: subscriptionId,
        } as any)
        expect(
          logs.some(
            (log: { event_type: string }) =>
              log.event_type === "subscription.expired"
          )
        ).toBe(true)
      })

      it("requires customer authentication", async () => {
        const container = getContainer()
        const apiKeyModule = container.resolve<any>(Modules.API_KEY)
        const pk = await apiKeyModule.createApiKeys({
          title: `redemption-anon-${Date.now()}`,
          type: "publishable",
          created_by: "test",
        })
        await expect(
          api.post(
            "/store/customers/me/redemptions",
            { code: "RDM-XXXX-XXXX-XXXX" },
            { headers: { "x-publishable-api-key": pk.token } }
          )
        ).rejects.toMatchObject({ response: { status: 401 } })
      })

      it("quotes only its declared refusals, and keeps a fault of ours out of the body", async () => {
        const container = getContainer()
        const customer = await createCustomer(container)
        const customerHeaders = await createStoreHeadersWithPublishableKey(
          container,
          customer
        )
        const { variant } = await createProductWithVariant(container)
        const batch = await createRedemptionBatch(container, {
          name: "RDM-STORE-BATCH-DISCLOSURE",
          variant_id: variant.id,
          free_cycles: 1,
          generated_code_count: 1,
        })
        const redemptionModule = container.resolve<RedemptionModuleService>(
          REDEMPTION_MODULE
        )
        const stamp = Date.now()

        // A declared refusal keeps its own status here. The bridge route answers
        // the same refusal as a 400 because that is what its promise was built
        // on; this one has always let the domain type through, and an unknown
        // code is a 404.
        const unknownCode = await api.post(
          "/store/customers/me/redemptions",
          { code: `NOSUCH-STORE-${stamp}` },
          { headers: customerHeaders, validateStatus: () => true }
        )

        expect(unknownCode.status).toEqual(404)
        expect(String(unknownCode.data?.message)).toEqual(
          `Redemption code "NOSUCH-STORE-${stamp}" is invalid`
        )

        // Same declared step, a failure that is not one of its refusals: the
        // shape `dbErrorMapper` produces, whose message names a column. Before
        // this route classified its workflow's failures the serialized error was
        // rethrown verbatim and its wording reached the customer.
        const columnFault = new MedusaError(
          MedusaError.Types.INVALID_DATA,
          `column redemption_code.redemption_cont does not exist store-detail-${stamp}`
        )
        const listSpy = jest
          .spyOn(redemptionModule, "listRedemptionCodes")
          .mockRejectedValue(columnFault)

        const quoted = await api.post(
          "/store/customers/me/redemptions",
          { code: batch.codes[0].code },
          { headers: customerHeaders, validateStatus: () => true }
        )

        listSpy.mockRestore()

        expect(quoted.status).toEqual(400)
        expect(String(quoted.data?.message)).toEqual("redemption was refused")
        expect(JSON.stringify(quoted.data ?? {})).not.toContain("redemption_cont")
        expect(JSON.stringify(quoted.data ?? {})).not.toContain(
          `store-detail-${stamp}`
        )

        // Not a `MedusaError` at all: a driver fault survives serialization with
        // `code`, `table` and `detail`, and `formatException` would turn a
        // rethrown `23505` into a 422 that quotes them. It answers 500 and says
        // nothing about the cause.
        const driverFault = new Error(
          'insert or update on table "redemption_canary" violates unique constraint'
        ) as Error & { code: string; table: string; detail: string }
        driverFault.code = "23505"
        driverFault.table = `redemption_canary_table_${stamp}`
        driverFault.detail = `Key (id)=(canary-value-${stamp}) already exists.`
        const batchSpy = jest
          .spyOn(redemptionModule, "retrieveRedemptionBatch")
          .mockRejectedValue(driverFault)

        const internal = await api.post(
          "/store/customers/me/redemptions",
          { code: batch.codes[0].code },
          { headers: customerHeaders, validateStatus: () => true }
        )

        batchSpy.mockRestore()

        expect(internal.status).toEqual(500)
        const body = JSON.stringify(internal.data ?? {})
        expect(body).not.toContain(driverFault.table)
        expect(body).not.toContain("canary-value-")
        expect(body).not.toContain("23505")
      })
    })
  },
})

jest.setTimeout(120 * 1000)
