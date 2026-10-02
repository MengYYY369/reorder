import path from "path"
import { medusaIntegrationTestRunner } from "@medusajs/test-utils"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import type {
  ICartModuleService,
  ISalesChannelModuleService,
  MedusaContainer,
} from "@medusajs/framework/types"
import {
  createCustomer,
  createProductWithVariant,
  createStoreCustomerAuthHeaders,
  createSubscriptionSeed,
} from "../helpers/subscription-fixtures"
import { createPlanOfferSeed } from "../helpers/plan-offer-fixtures"
import { createRenewalCycleSeed } from "../helpers/renewal-fixtures"
import { TRIAL_CLAIM_MODULE } from "../../src/modules/trial-claim"
import TrialClaimModuleService from "../../src/modules/trial-claim/service"
import { TrialClaimSource } from "../../src/modules/trial-claim/types"
import { SUBSCRIPTION_MODULE } from "../../src/modules/subscription"
import type SubscriptionModuleService from "../../src/modules/subscription/service"
import {
  SubscriptionPaymentContext,
  SubscriptionStatus,
} from "../../src/modules/subscription/types"
import { RENEWAL_MODULE } from "../../src/modules/renewal"
import type RenewalModuleService from "../../src/modules/renewal/service"
import { RenewalCycleStatus } from "../../src/modules/renewal/types"
import { listDueRenewalCyclesForProcessing } from "../../src/modules/renewal/utils/scheduler-query"
import { processRenewalCycleWorkflow } from "../../src/workflows"
import { setSubscriptionAutoRenewWorkflow } from "../../src/workflows/set-subscription-auto-renew"
import {
  PlanOfferScope,
  PlanOfferStackingPolicy,
} from "../../src/modules/plan-offer/types"

jest.setTimeout(180 * 1000)

type ApiKeyModule = {
  createApiKeys: (input: {
    title: string
    type: string
    created_by: string
  }) => Promise<{ token: string }>
}

type EmittedBusEvent = { name?: string; data?: Record<string, unknown> }

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

function resolveEventBusSpy(container: MedusaContainer) {
  const eventBus = container.resolve("event_bus") as unknown as {
    emit: (data: unknown) => Promise<void>
  }

  return jest.spyOn(eventBus, "emit")
}

type AxiosLikeError = {
  response?: { status: number; data: { message?: string } }
  message: string
}

type TestApi = {
  post: (url: string, body?: unknown, config?: unknown) => Promise<unknown>
}

/**
 * The axios instance behind `api` throws on 4xx, so every refusal assertion
 * captures the error and reads its response.
 */
async function postAndCapture(
  api: TestApi,
  url: string,
  body: Record<string, unknown> | undefined,
  headers?: Record<string, string>
): Promise<{
  status: number
  data: { message?: string; [key: string]: unknown }
}> {
  const result = (await api
    .post(url, body, { headers })
    .catch((error: AxiosLikeError) => {
      if (!error.response) {
        throw error
      }

      return error.response
    })) as { status: number; data: { message?: string; [key: string]: unknown } }

  return result
}

async function createStoreHeadersWithPublishableKey(
  container: MedusaContainer,
  customer: { id: string }
): Promise<Record<string, string>> {
  const apiKeyModule = container.resolve<ApiKeyModule>(Modules.API_KEY)
  const pk = await apiKeyModule.createApiKeys({
    title: `trial-cancel-finalize-${Date.now()}`,
    type: "publishable",
    created_by: "test",
  })
  return {
    ...(await createStoreCustomerAuthHeaders(container, customer)),
    "x-publishable-api-key": pk.token,
  }
}

/**
 * The payment shape a claimed card-free trial carries: manual mode, no stored
 * method, no provider (`createTrialSubscriptionStep`'s context).
 */
const CLAIMED_TRIAL_PAYMENT_CONTEXT: SubscriptionPaymentContext = {
  payment_provider_id: null,
  payment_mode: "manual",
  source_payment_collection_id: null,
  source_payment_session_id: null,
  payment_method_reference: null,
  customer_payment_reference: null,
}

/**
 * Arranges the state a successful trial claim leaves behind — an active trial
 * subscription in manual mode anchored on `trial_ends_at`, carrying exactly
 * one SCHEDULED cycle standing at the anchor, plus its `trial_claim` ledger
 * row — without going through the claim endpoint.
 *
 * The claim endpoint's sellable-price pre-check is broken on the current
 * framework (the `product_variant_price_set` graph does not expand `prices.*`
 * on Medusa 2.20.0, so every successful claim is refused) — that step belongs
 * to Task 21, not this task, so the fixtures write the same rows the claim
 * workflow writes (`createTrialSubscriptionStep` + `recordTrialClaimStep` +
 * `ensureNextRenewalCycleStep`).
 */
async function seedClaimedTrial(
  container: MedusaContainer,
  input: {
    customer: { id: string; email?: string | null }
    reference: string
    trialEndsAt: Date
    withLedgerRow: boolean
  }
) {
  const { product, variant } = await createProductWithVariant(container)
  const subscriptionModule =
    container.resolve<SubscriptionModuleService>(SUBSCRIPTION_MODULE)

  const subscription = await createSubscriptionSeed(container, {
    reference: input.reference,
    status: SubscriptionStatus.ACTIVE,
    customer_id: input.customer.id,
    cart_id: `cart_trial_${Date.now()}`,
    product_id: product.id,
    variant_id: variant.id,
    next_renewal_at: input.trialEndsAt,
    is_trial: true,
    payment_context: CLAIMED_TRIAL_PAYMENT_CONTEXT,
  })
  await subscriptionModule.updateSubscriptions({
    id: subscription.id,
    trial_ends_at: input.trialEndsAt,
    metadata: { source: "trial_claim" },
  })

  const cycle = await createRenewalCycleSeed(container, {
    subscription_id: subscription.id,
    status: RenewalCycleStatus.SCHEDULED,
    scheduled_for: input.trialEndsAt,
  })

  if (input.withLedgerRow) {
    const trialClaimModule =
      container.resolve<TrialClaimModuleService>(TRIAL_CLAIM_MODULE)
    await trialClaimModule.record({
      customer_id: input.customer.id,
      product_id: product.id,
      variant_id: variant.id,
      source: TrialClaimSource.SELF_SERVICE,
      subscription_id: subscription.id,
      trial_ends_at: input.trialEndsAt,
    })
  }

  const headers = await createStoreHeadersWithPublishableKey(
    container,
    input.customer
  )

  return {
    headers,
    subscriptionId: subscription.id,
    productId: product.id,
    variantId: variant.id,
    cycleId: cycle.id,
  }
}

medusaIntegrationTestRunner({
  medusaConfigFile: path.resolve(process.cwd(), "integration-tests"),
  env: {
    JWT_SECRET: "supersecret",
    COOKIE_SECRET: "supersecret",
  },
  testSuite: ({ api, getContainer }) => {
    describe("Trial exit paths: store finalize-cancellation route", () => {
      let runId: string

      beforeEach(() => {
        jest.restoreAllMocks()
        runId = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`
      })

      async function openCancellationCase(
        headers: Record<string, string>,
        subscriptionId: string
      ) {
        const response = await api.post(
          `/store/customers/me/subscriptions/${subscriptionId}/cancellation`,
          { reason: "I do not want to continue after the trial." },
          { headers }
        )

        expect(response.status).toEqual(200)

        return response.data.cancellation_case as { id: string; status: string }
      }

      async function listScheduledCycles(
        container: MedusaContainer,
        subscriptionId: string
      ) {
        const renewalModule =
          container.resolve<RenewalModuleService>(RENEWAL_MODULE)
        const cycles = (await renewalModule.listRenewalCycles({
          subscription_id: subscriptionId,
        } as Record<string, unknown>)) as Array<{ status: string }>

        return cycles.filter(
          (cycle) => cycle.status === RenewalCycleStatus.SCHEDULED
        )
      }

      async function queryLinkedSubscriptionOrderIds(
        container: MedusaContainer,
        subscriptionId: string
      ): Promise<string[]> {
        const query = container.resolve(ContainerRegistrationKeys.QUERY)
        const { data } = await query.graph({
          entity: "subscription_order",
          fields: ["order_id"],
          filters: { subscription_id: [subscriptionId] },
        })

        return (data as Array<{ order_id: string }>).map(
          (entry) => entry.order_id
        )
      }

      async function queryOpenCancellationCases(
        container: MedusaContainer,
        subscriptionId: string
      ): Promise<Array<{ id: string; status: string }>> {
        const query = container.resolve(ContainerRegistrationKeys.QUERY)
        const { data } = await query.graph({
          entity: "cancellation_case",
          fields: ["id", "subscription_id", "status"],
          filters: { subscription_id: [subscriptionId] },
        })

        return data as Array<{ id: string; status: string }>
      }

      it("requires customer authentication", async () => {
        const container = getContainer()
        const customer = await createCustomer(container, {
          email: `finalize-anon-${runId}@medusa.test`,
        })
        const subscription = await createSubscriptionSeed(container, {
          reference: `SUB-FIN-ANON-${runId}`,
          customer_id: customer.id,
        })

        const apiKeyModule = container.resolve<ApiKeyModule>(Modules.API_KEY)
        const pk = await apiKeyModule.createApiKeys({
          title: `finalize-anon-${Date.now()}`,
          type: "publishable",
          created_by: "test",
        })

        const response = await postAndCapture(
          api,
          `/store/customers/me/subscriptions/${subscription.id}/cancellation/finalize`,
          undefined,
          { "x-publishable-api-key": pk.token }
        )

        expect(response.status).toEqual(401)
      })

      it("finalizing during a trial leaves no SCHEDULED cycle, no charge at trial_ends_at, and no renewal.failed", async () => {
        const container = getContainer()
        const subscriptionModule =
          container.resolve<SubscriptionModuleService>(SUBSCRIPTION_MODULE)
        const customer = await createCustomer(container, {
          email: `finalize-trial-${runId}@medusa.test`,
        })

        // The trial is cancelled mid-flight, well before the anchor.
        const trialEndsAt = new Date(Date.now() + 7 * 86_400_000)
        const trial = await seedClaimedTrial(container, {
          customer,
          reference: `SUB-FIN-TRIAL-${runId}`,
          trialEndsAt,
          withLedgerRow: true,
        })
        const subscriptionId = trial.subscriptionId

        // Pre-state: exactly one SCHEDULED cycle standing at trial_ends_at.
        expect(await listScheduledCycles(container, subscriptionId)).toHaveLength(1)

        await openCancellationCase(trial.headers, subscriptionId)

        const emitSpy = resolveEventBusSpy(container)

        const response = await api.post(
          `/store/customers/me/subscriptions/${subscriptionId}/cancellation/finalize`,
          undefined,
          { headers: trial.headers }
        )

        expect(response.status).toEqual(200)
        expect(response.data.cancellation_case).toMatchObject({
          id: expect.any(String),
          subscription_id: subscriptionId,
          status: "canceled",
          final_outcome: "canceled",
          cancellation_effective_at: expect.any(String),
        })

        // The subscription is cancelled now and nothing is anchored on the
        // trial end any more.
        const subscription = await subscriptionModule.retrieveSubscription(
          subscriptionId
        )
        expect(subscription.status).toEqual(SubscriptionStatus.CANCELLED)
        expect(subscription.cancelled_at).toBeTruthy()
        expect(subscription.next_renewal_at).toBeNull()

        // The SCHEDULED trial-end cycle is gone: nothing can fire at
        // trial_ends_at.
        expect(await listScheduledCycles(container, subscriptionId)).toHaveLength(0)

        // The scheduler driven past the anchor finds nothing of this
        // subscription's to charge.
        const pastTrialEnd = new Date(trialEndsAt.getTime() + 5 * 60_000)
        const { cycles: dueCycles } = await listDueRenewalCyclesForProcessing(
          container,
          { limit: 200, offset: 0, now: pastTrialEnd }
        )
        expect(
          dueCycles.filter((cycle) => cycle.subscription_id === subscriptionId)
        ).toHaveLength(0)

        // No renewal order was ever minted for the trial.
        expect(
          await queryLinkedSubscriptionOrderIds(container, subscriptionId)
        ).toHaveLength(0)

        // No false failure event for a period that was never charged (T5).
        expect(busEventsWithName(emitSpy, "renewal.failed")).toHaveLength(0)
      })

      it("keeps the paid period on self-service finalize: cancel_effective_at lands on the pre-cancel next_renewal_at", async () => {
        const container = getContainer()
        const subscriptionModule =
          container.resolve<SubscriptionModuleService>(SUBSCRIPTION_MODULE)
        const customer = await createCustomer(container, {
          email: `finalize-eoc-${runId}@medusa.test`,
        })

        const trialEndsAt = new Date(Date.now() + 7 * 86_400_000)
        const trial = await seedClaimedTrial(container, {
          customer,
          reference: `SUB-FIN-EOC-${runId}`,
          trialEndsAt,
          withLedgerRow: false,
        })

        const before = await subscriptionModule.retrieveSubscription(
          trial.subscriptionId
        )
        expect(before.next_renewal_at?.toISOString()).toEqual(
          trialEndsAt.toISOString()
        )

        await openCancellationCase(trial.headers, trial.subscriptionId)

        const response = await api.post(
          `/store/customers/me/subscriptions/${trial.subscriptionId}/cancellation/finalize`,
          undefined,
          { headers: trial.headers }
        )

        expect(response.status).toEqual(200)
        expect(
          new Date(
            response.data.cancellation_case.cancellation_effective_at as string
          ).toISOString()
        ).toEqual(trialEndsAt.toISOString())

        // The route passes `end_of_cycle`, so the subscription keeps its paid
        // period: the effective date is the pre-cancel renewal anchor, not the
        // cancellation instant.
        const after = await subscriptionModule.retrieveSubscription(
          trial.subscriptionId
        )
        expect(after.status).toEqual(SubscriptionStatus.CANCELLED)
        expect(after.cancelled_at).toBeTruthy()
        expect(after.cancel_effective_at?.toISOString()).toEqual(
          trialEndsAt.toISOString()
        )
        expect(after.cancel_effective_at!.getTime()).toBeGreaterThan(
          after.cancelled_at!.getTime()
        )
      })

      it("a customer who cancelled during the trial cannot claim the trial again (the ledger row survives)", async () => {
        const container = getContainer()
        const subscriptionModule =
          container.resolve<SubscriptionModuleService>(SUBSCRIPTION_MODULE)
        const customer = await createCustomer(container, {
          email: `reclaim-${runId}@medusa.test`,
        })

        // The offer must exist and the product must be sellable-shaped so the
        // re-claim reaches the eligibility check instead of an earlier refusal.
        const trialEndsAt = new Date(Date.now() + 7 * 86_400_000)
        const trial = await seedClaimedTrial(container, {
          customer,
          reference: `SUB-FIN-RECLAIM-${runId}`,
          trialEndsAt,
          withLedgerRow: true,
        })
        await createPlanOfferSeed(container, {
          scope: PlanOfferScope.PRODUCT,
          product_id: trial.productId,
          rules: {
            minimum_cycles: 1,
            trial_enabled: true,
            trial_days: 7,
            trial_requires_payment_method: false,
            stacking_policy: PlanOfferStackingPolicy.ALLOWED,
          },
        })
        const productModule = container.resolve(Modules.PRODUCT) as {
          updateProducts: (
            id: string,
            data: Record<string, unknown>
          ) => Promise<unknown>
        }
        await productModule.updateProducts(trial.productId, {
          status: "published",
        })

        const regionModule = container.resolve(Modules.REGION) as {
          createRegions: (input: {
            name: string
            currency_code: string
          }) => Promise<{ id: string; currency_code: string }>
        }
        const region = await regionModule.createRegions({
          name: `trial-reclaim-${runId}`,
          currency_code: "usd",
        } as never)

        await openCancellationCase(trial.headers, trial.subscriptionId)

        const finalizeResponse = await postAndCapture(
          api,
          `/store/customers/me/subscriptions/${trial.subscriptionId}/cancellation/finalize`,
          undefined,
          trial.headers
        )
        expect(finalizeResponse.status).toEqual(200)

        // The re-claim is refused — the ledger row written before the
        // cancellation survived it, and the cancelled subscription row is
        // still there; `assertEligible` reads both halves.
        const reclaim = await postAndCapture(
          api,
          "/store/customers/me/trials",
          {
            variant_id: trial.variantId,
            region_id: region.id,
            binding: "none",
          },
          trial.headers
        )

        expect(reclaim.status).toEqual(400)
        expect(reclaim.data.message).toContain("Trial has already been claimed")

        // The refusal created nothing: the cancelled row is still the only
        // subscription the customer holds for the product.
        const subscriptions = (await subscriptionModule.listSubscriptions({
          customer_id: customer.id,
        })) as unknown as Array<{ id: string }>
        expect(subscriptions).toHaveLength(1)
        expect(subscriptions[0].id).toEqual(trial.subscriptionId)
      })

      it("answers 404 for a subscription with no open cancellation case and finalizes nothing", async () => {
        const container = getContainer()
        const subscriptionModule =
          container.resolve<SubscriptionModuleService>(SUBSCRIPTION_MODULE)
        const customer = await createCustomer(container, {
          email: `finalize-nocase-${runId}@medusa.test`,
        })

        const trialEndsAt = new Date(Date.now() + 7 * 86_400_000)
        const trial = await seedClaimedTrial(container, {
          customer,
          reference: `SUB-FIN-NOCASE-${runId}`,
          trialEndsAt,
          withLedgerRow: false,
        })

        const response = await postAndCapture(
          api,
          `/store/customers/me/subscriptions/${trial.subscriptionId}/cancellation/finalize`,
          undefined,
          trial.headers
        )

        expect(response.status).toEqual(404)

        // Nothing was finalized: the trial is still active and its cycle is
        // still standing.
        const subscription = await subscriptionModule.retrieveSubscription(
          trial.subscriptionId
        )
        expect(subscription.status).toEqual(SubscriptionStatus.ACTIVE)
        expect(
          await listScheduledCycles(container, trial.subscriptionId)
        ).toHaveLength(1)
      })

      it("a customer cannot finalize another customer's case (404, the case stays open)", async () => {
        const container = getContainer()
        const subscriptionModule =
          container.resolve<SubscriptionModuleService>(SUBSCRIPTION_MODULE)
        const owner = await createCustomer(container, {
          email: `finalize-owner-${runId}@medusa.test`,
        })
        const stranger = await createCustomer(container, {
          email: `finalize-stranger-${runId}@medusa.test`,
        })

        const trialEndsAt = new Date(Date.now() + 7 * 86_400_000)
        const trial = await seedClaimedTrial(container, {
          customer: owner,
          reference: `SUB-FIN-STRANGER-${runId}`,
          trialEndsAt,
          withLedgerRow: false,
        })
        const openCase = await openCancellationCase(
          trial.headers,
          trial.subscriptionId
        )

        const strangerHeaders = await createStoreHeadersWithPublishableKey(
          container,
          stranger
        )

        const response = await postAndCapture(
          api,
          `/store/customers/me/subscriptions/${trial.subscriptionId}/cancellation/finalize`,
          undefined,
          strangerHeaders
        )

        expect(response.status).toEqual(404)

        // The owner's subscription and case are untouched.
        const subscription = await subscriptionModule.retrieveSubscription(
          trial.subscriptionId
        )
        expect(subscription.status).toEqual(SubscriptionStatus.ACTIVE)

        const cases = await queryOpenCancellationCases(
          container,
          trial.subscriptionId
        )
        expect(cases).toHaveLength(1)
        expect(cases[0].id).toEqual(openCase.id)
        expect(cases[0].status).toEqual("requested")
      })

      it("the auto-renew toggle alone prevents the charge for a manual trial: the trial-end branch never charges a manual subscription", async () => {
        // Reasoning (Task 24 Step 3): for a manual trial the guarantee is NOT
        // "excluded from the scheduler" — Task 3's carve-out deliberately keeps
        // a manual trial's trial-end cycle processable
        // (`resolveCycleDisposition` answers "trial_end" for it, asserted below
        // via the due query). The guarantee is "the trial-end branch never
        // charges a manual subscription". This test holds the exact pre-state
        // that WOULD charge (auto mode, stored method, chargeable cart — pinned
        // as the conversion path in trial-conversion.spec.ts), flips only the
        // auto-renew toggle off (the same `set-subscription-auto-renew` write
        // `POST /store/saas/auto-renew` performs), and proves the cycle still
        // runs but charges nothing.
        const container = getContainer()
        const subscriptionModule =
          container.resolve<SubscriptionModuleService>(SUBSCRIPTION_MODULE)
        const emitSpy = resolveEventBusSpy(container)

        const customer = await createCustomer(container, {
          email: `toggle-exit-${runId}@medusa.test`,
        })
        const productModule = container.resolve(Modules.PRODUCT) as unknown as {
          createProducts: (
            data: Record<string, unknown>
          ) => Promise<{
            id: string
            variants?: Array<{ id: string }>
          }>
        }
        const product = await productModule.createProducts({
          title: `Trial Toggle Product ${runId}`,
          status: "published",
          options: [{ title: "Plan", values: ["Default"] }],
          variants: [
            {
              title: "Default Variant",
              sku: `TRIAL-TOGGLE-${runId}`,
              manage_inventory: false,
              options: { Plan: "Default" },
            },
          ],
        })
        const variant = product.variants?.[0]
        if (!variant) {
          throw new Error("Failed to create product variant for test")
        }

        const pricingModule = container.resolve(Modules.PRICING) as {
          createPriceSets: (input: {
            prices: Array<{ amount: number; currency_code: string }>
          }) => Promise<{ id: string }>
        }
        const priceSet = await pricingModule.createPriceSets({
          prices: [{ amount: 0.01, currency_code: "usd" }],
        })
        const link = container.resolve(ContainerRegistrationKeys.LINK)
        await link.create({
          [Modules.PRODUCT]: { variant_id: variant.id },
          [Modules.PRICING]: { price_set_id: priceSet.id },
        })

        const regionModule = container.resolve(Modules.REGION) as {
          createRegions: (input: {
            name: string
            currency_code: string
          }) => Promise<{ id: string; currency_code: string }>
        }
        const region = await regionModule.createRegions({
          name: `trial-toggle-${runId}`,
          currency_code: "usd",
        } as never)

        const salesChannelModule = container.resolve<ISalesChannelModuleService>(
          Modules.SALES_CHANNEL
        )
        const salesChannel = (await salesChannelModule.createSalesChannels({
          name: `trial-toggle-sc-${runId}`,
        } as never)) as unknown as { id: string }

        const cartModule = container.resolve<ICartModuleService>(Modules.CART)
        const cart = (await cartModule.createCarts({
          currency_code: "usd",
          email: customer.email,
          customer_id: customer.id,
          region_id: region.id,
          sales_channel_id: salesChannel.id,
          metadata: {},
          items: [
            {
              title: "Trial toggle renewal",
              subtitle: "Monthly plan",
              unit_price: 0.01,
              quantity: 1,
              requires_shipping: false,
            } as never,
          ],
          shipping_address: {
            first_name: "Trial",
            last_name: "Toggle",
            address_1: "1 Toggle Way",
            city: "Testville",
            postal_code: "00001",
            country_code: "us",
          },
        } as never)) as unknown as { id: string }

        const trialEndsAt = new Date(Date.now() - 5 * 60_000)
        const trialPaymentContext: SubscriptionPaymentContext = {
          payment_provider_id: "pp_system_default",
          payment_mode: "auto",
          source_payment_collection_id: null,
          source_payment_session_id: null,
          payment_method_reference: `pm_trial_${runId}`,
          customer_payment_reference: null,
        }
        const subscription = await createSubscriptionSeed(container, {
          reference: `SUB-FIN-TOGGLE-${runId}`,
          status: SubscriptionStatus.ACTIVE,
          customer_id: customer.id,
          cart_id: cart.id,
          product_id: product.id,
          variant_id: variant.id,
          next_renewal_at: trialEndsAt,
          is_trial: true,
          payment_context: trialPaymentContext,
        })
        await subscriptionModule.updateSubscriptions({
          id: subscription.id,
          trial_ends_at: trialEndsAt,
        })

        const cycle = await createRenewalCycleSeed(container, {
          subscription_id: subscription.id,
          status: RenewalCycleStatus.SCHEDULED,
          scheduled_for: trialEndsAt,
        })

        // The toggle: the only write `POST /store/saas/auto-renew` performs.
        // Disabling is never refused, past the anchor included.
        const toggle = await setSubscriptionAutoRenewWorkflow(container).run({
          input: { subscription_id: subscription.id, enabled: false },
        })
        expect(toggle.result.payment_mode).toEqual("manual")

        const toggled = await subscriptionModule.retrieveSubscription(
          subscription.id
        )
        expect(toggled.payment_context?.payment_mode).toEqual("manual")

        // The carve-out: a manual trial's trial-end cycle is NOT excluded from
        // the scheduler — it is exactly how the trial-end branch gets to run.
        const { cycles: dueCycles } = await listDueRenewalCyclesForProcessing(
          container,
          { limit: 200, offset: 0 }
        )
        expect(dueCycles.map((record) => record.id)).toContain(cycle.id)

        const { result } = await processRenewalCycleWorkflow(container).run({
          input: { renewal_cycle_id: cycle.id, trigger_type: "scheduler" },
        })

        // The trial-end branch ends the trial deterministically and charges
        // nothing — the guarantee, not a scheduler exclusion.
        expect(result.renewal_cycle.status).toEqual(RenewalCycleStatus.SUCCEEDED)
        expect(result.generated_order_id).toBeNull()
        expect(
          await queryLinkedSubscriptionOrderIds(container, subscription.id)
        ).toHaveLength(0)

        const ended = await subscriptionModule.retrieveSubscription(
          subscription.id
        )
        expect(ended.status).toEqual(SubscriptionStatus.CANCELLED)

        expect(busEventsWithName(emitSpy, "renewal.failed")).toHaveLength(0)
        expect(busEventsWithName(emitSpy, "renewal.succeeded")).toHaveLength(0)
      })
    })
  },
})
