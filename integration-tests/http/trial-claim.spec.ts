import path from "path"
import { asValue } from "awilix"
import { medusaIntegrationTestRunner } from "@medusajs/test-utils"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import type { MedusaContainer } from "@medusajs/framework/types"
import {
  createAdminAuthHeaders,
  createCustomer,
  createProductWithVariant,
  createStoreCustomerAuthHeaders,
} from "../helpers/subscription-fixtures"
import { createPlanOfferSeed } from "../helpers/plan-offer-fixtures"
import { TRIAL_CLAIM_MODULE } from "../../src/modules/trial-claim"
import TrialClaimModuleService from "../../src/modules/trial-claim/service"
import { SUBSCRIPTION_MODULE } from "../../src/modules/subscription"
import { RENEWAL_MODULE } from "../../src/modules/renewal"
import type SubscriptionModuleService from "../../src/modules/subscription/service"
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

async function createStoreHeadersWithPublishableKey(
  container: MedusaContainer,
  customer: { id: string }
): Promise<Record<string, string>> {
  const apiKeyModule = container.resolve<ApiKeyModule>(Modules.API_KEY)
  const pk = await apiKeyModule.createApiKeys({
    title: `trial-claim-route-${Date.now()}`,
    type: "publishable",
    created_by: "test",
  })
  return {
    ...(await createStoreCustomerAuthHeaders(container, customer)),
    "x-publishable-api-key": pk.token,
  }
}

type RegionModuleLike = {
  createRegions: (input: {
    name: string
    currency_code: string
  }) => Promise<{ id: string; currency_code: string }>
}

type PricingModuleLike = {
  createPriceSets: (input: {
    prices: Array<{ amount: number; currency_code: string }>
  }) => Promise<{ id: string }>
}

type SubscriptionRow = {
  id: string
  reference: string
  status: string
  customer_id: string
  cart_id: string | null
  product_id: string
  variant_id: string
  is_trial: boolean
  trial_ends_at: Date | string | null
  next_renewal_at: Date | string | null
  payment_context: { payment_mode?: string; mechanism?: string } | null
  metadata: Record<string, unknown> | null
}

type RenewalCycleRow = {
  id: string
  subscription_id: string
  status: string
  scheduled_for: Date | string
}

type AxiosLikeError = {
  response?: { status: number; data: { message?: string } }
  message: string
}

/**
 * The axios instance behind `api` throws on 4xx, so every refusal assertion
 * captures the error and reads its response.
 */
async function postTrial(
  api: {
    post: (url: string, body?: unknown, config?: unknown) => Promise<unknown>
  },
  body: Record<string, unknown>,
  headers?: Record<string, string>
): Promise<{ status: number; data: { message?: string; trial?: unknown } }> {
  const result = (await api
    .post("/store/customers/me/trials", body, { headers })
    .catch((error: AxiosLikeError) => {
      if (!error.response) {
        throw error
      }

      return error.response
    })) as { status: number; data: { message?: string; trial?: unknown } }

  return result
}

async function createPublishableKeyHeader(
  container: MedusaContainer
): Promise<Record<string, string>> {
  const apiKeyModule = container.resolve<ApiKeyModule>(Modules.API_KEY)
  const pk = await apiKeyModule.createApiKeys({
    title: `trial-claim-anon-${Date.now()}`,
    type: "publishable",
    created_by: "test",
  })
  return { "x-publishable-api-key": pk.token }
}

async function createRegion(
  container: MedusaContainer,
  currency: string
): Promise<{ id: string; currency_code: string }> {
  const regionModule = container.resolve<RegionModuleLike>(Modules.REGION)
  return await regionModule.createRegions({
    name: `trial-claim-${currency}-${Date.now()}-${Math.random()}`,
    currency_code: currency,
  } as never)
}

async function attachPrice(
  container: MedusaContainer,
  variantId: string,
  currency: string
): Promise<void> {
  const pricingModule = container.resolve<PricingModuleLike>(Modules.PRICING)
  const priceSet = await pricingModule.createPriceSets({
    prices: [{ amount: 1800, currency_code: currency }],
  })

  const link = container.resolve(ContainerRegistrationKeys.LINK)
  await link.create({
    [Modules.PRODUCT]: {
      variant_id: variantId,
    },
    [Modules.PRICING]: {
      price_set_id: priceSet.id,
    },
  })
}

medusaIntegrationTestRunner({
  medusaConfigFile: path.resolve(process.cwd(), "integration-tests"),
  env: {
    JWT_SECRET: "supersecret",
    COOKIE_SECRET: "supersecret",
  },
  testSuite: ({ api, getContainer }) => {
    describe("POST /store/customers/me/trials (the claim endpoint)", () => {
      it("creates a card-free trial: manual mode, one cycle at trial_ends_at, one ledger row, a completed template cart", async () => {
        const container = getContainer()
        const subscriptionModule = container.resolve<SubscriptionModuleService>(
          SUBSCRIPTION_MODULE
        )
        const trialClaimModule =
          container.resolve<TrialClaimModuleService>(TRIAL_CLAIM_MODULE)
        const { product, variant } = await createProductWithVariant(container)
        const customer = await createCustomer(container)
        const region = await createRegion(container, "usd")
        await attachPrice(container, variant.id, "usd")
        await createPlanOfferSeed(container, {
          scope: PlanOfferScope.PRODUCT,
          product_id: product.id,
          rules: {
            minimum_cycles: 1,
            trial_enabled: true,
            trial_days: 7,
            trial_requires_payment_method: false,
            stacking_policy: PlanOfferStackingPolicy.ALLOWED,
          },
        })

        const productModule = container.resolve<any>(Modules.PRODUCT)
        await productModule.updateProducts(product.id, { status: "published" })

        const headers = await createStoreHeadersWithPublishableKey(
          container,
          customer
        )

        const response = await api.post(
          "/store/customers/me/trials",
          { variant_id: variant.id, region_id: region.id, binding: "none" },
          { headers }
        )

        expect(response.status).toEqual(201)
        expect(response.data.trial.subscription_id).toBeTruthy()
        expect(response.data.trial.claim_recorded).toEqual(true)

        const subscriptions = (await subscriptionModule.listSubscriptions({
          customer_id: customer.id,
        })) as unknown as SubscriptionRow[]
        expect(subscriptions).toHaveLength(1)
        const subscription = subscriptions[0]
        expect(subscription.is_trial).toBe(true)
        expect(subscription.payment_context?.payment_mode).toEqual("manual")
        expect(subscription.cart_id).toBeTruthy()
        expect(subscription.next_renewal_at).toEqual(subscription.trial_ends_at)

        // The template cart is completed: un-completable, un-subscribable.
        const cartModule = container.resolve<any>(Modules.CART)
        const carts = await cartModule.listCarts({
          id: subscription.cart_id,
        })
        expect(carts).toHaveLength(1)
        expect(carts[0].completed_at).toBeTruthy()

        // The leaked cart id is not written into renewal line-item metadata
        // anywhere — the template cart's own line item carries none.
        expect(carts[0].items?.[0]?.metadata?.renewal_source_cart_id).toBeUndefined()

        const renewalModule = container.resolve<any>(RENEWAL_MODULE)
        const cycleRows = (await renewalModule.listRenewalCycles({
          subscription_id: subscription.id,
        })) as RenewalCycleRow[]
        expect(cycleRows).toHaveLength(1)
        expect(cycleRows[0].status).toEqual("scheduled")

        const trialEndsMs = new Date(subscription.trial_ends_at!).getTime()
        const scheduledMs = new Date(cycleRows[0].scheduled_for).getTime()
        expect(Math.abs(trialEndsMs - scheduledMs)).toBeLessThan(1000)

        const claims = (await trialClaimModule.listTrialClaims({
          customer_id: customer.id,
        })) as Array<{ id: string; source: string }>
        expect(claims).toHaveLength(1)
        expect(claims[0].source).toEqual("self_service")
      })

      it("refuses a second claim for the same product and creates nothing", async () => {
        const container = getContainer()
        const subscriptionModule = container.resolve<SubscriptionModuleService>(
          SUBSCRIPTION_MODULE
        )
        const { product, variant } = await createProductWithVariant(container)
        const customer = await createCustomer(container)
        const region = await createRegion(container, "usd")
        await attachPrice(container, variant.id, "usd")
        await createPlanOfferSeed(container, {
          scope: PlanOfferScope.PRODUCT,
          product_id: product.id,
          rules: {
            minimum_cycles: 1,
            trial_enabled: true,
            trial_days: 7,
            trial_requires_payment_method: false,
            stacking_policy: PlanOfferStackingPolicy.ALLOWED,
          },
        })

        const productModule = container.resolve<any>(Modules.PRODUCT)
        await productModule.updateProducts(product.id, { status: "published" })

        const headers = await createStoreHeadersWithPublishableKey(
          container,
          customer
        )
        const first = await api.post(
          "/store/customers/me/trials",
          { variant_id: variant.id, region_id: region.id },
          { headers }
        )
        expect(first.status).toEqual(201)

        const second = await postTrial(
          api,
          { variant_id: variant.id, region_id: region.id },
          headers
        )
        expect(second.status).toEqual(400)
        expect(second.data.message).toEqual(
          `Trial has already been claimed for customer ${customer.id} and product ${product.id}`
        )

        const subscriptions = (await subscriptionModule.listSubscriptions({
          customer_id: customer.id,
        })) as unknown as SubscriptionRow[]
        expect(subscriptions).toHaveLength(1)
      })

      it("refuses a card-free claim when the offer requires a bound method, permits it with binding intent", async () => {
        const container = getContainer()
        const { product, variant } = await createProductWithVariant(container)
        const customer = await createCustomer(container)
        const region = await createRegion(container, "usd")
        await attachPrice(container, variant.id, "usd")
        await createPlanOfferSeed(container, {
          scope: PlanOfferScope.PRODUCT,
          product_id: product.id,
          rules: {
            minimum_cycles: 1,
            trial_enabled: true,
            trial_days: 14,
            trial_requires_payment_method: true,
            stacking_policy: PlanOfferStackingPolicy.ALLOWED,
          },
        })

        const productModule = container.resolve<any>(Modules.PRODUCT)
        await productModule.updateProducts(product.id, { status: "published" })

        const headers = await createStoreHeadersWithPublishableKey(
          container,
          customer
        )
        const refused = await postTrial(
          api,
          { variant_id: variant.id, region_id: region.id, binding: "none" },
          headers
        )
        expect(refused.status).toEqual(400)
        expect(refused.data.message).toEqual(
          'This trial requires binding a payment method. Send binding: "vault" to claim it.'
        )

        const permitted = await api.post(
          "/store/customers/me/trials",
          { variant_id: variant.id, region_id: region.id, binding: "vault" },
          { headers }
        )
        expect(permitted.status).toEqual(201)
      })

      it("fails with a clear message when the variant has no sellable price in the region", async () => {
        const container = getContainer()
        const { product, variant } = await createProductWithVariant(container)
        const customer = await createCustomer(container)
        const usdRegion = await createRegion(container, "usd")
        const eurRegion = await createRegion(container, "eur")
        await attachPrice(container, variant.id, "usd")
        await createPlanOfferSeed(container, {
          scope: PlanOfferScope.PRODUCT,
          product_id: product.id,
          rules: {
            minimum_cycles: 1,
            trial_enabled: true,
            trial_days: 7,
            trial_requires_payment_method: false,
            stacking_policy: PlanOfferStackingPolicy.ALLOWED,
          },
        })

        const productModule = container.resolve<any>(Modules.PRODUCT)
        await productModule.updateProducts(product.id, { status: "published" })

        const headers = await createStoreHeadersWithPublishableKey(
          container,
          customer
        )
        const response = await postTrial(
          api,
          { variant_id: variant.id, region_id: eurRegion.id },
          headers
        )

        expect(response.status).toEqual(400)
        expect(response.data.message).toEqual(
          `This trial is not available in the selected region '${eurRegion.id}'.`
        )
      })

      it("reports per-customer eligibility on the store offer DTO, with the vault binding supported when the provider ships the capability", async () => {
        const container = getContainer()
        const subscriptionModule = container.resolve<SubscriptionModuleService>(
          SUBSCRIPTION_MODULE
        )
        const { product, variant } = await createProductWithVariant(container)
        const customerA = await createCustomer(container)
        const customerB = await createCustomer(container)
        const region = await createRegion(container, "usd")
        await attachPrice(container, variant.id, "usd")
        await createPlanOfferSeed(container, {
          scope: PlanOfferScope.PRODUCT,
          product_id: product.id,
          rules: {
            minimum_cycles: 1,
            trial_enabled: true,
            trial_days: 7,
            trial_requires_payment_method: false,
            stacking_policy: PlanOfferStackingPolicy.ALLOWED,
            trial_bonus_days: 7,
          },
        })

        // Publish so the offer DTO's read model mirrors production. No claim
        // happens in this test, so no cart pricing is involved.
        const productModule = container.resolve<any>(Modules.PRODUCT)
        await productModule.updateProducts(product.id, {
          status: "published",
        })

        const headersA = await createStoreHeadersWithPublishableKey(
          container,
          customerA
        )

        // Task 22: the DTO's `binding.supported` follows the duck-typed
        // capability of the installed provider — dynamic, never a hardcoded
        // literal. No provider is registered in this suite (the acceptance
        // environment ships none), so the flag answers false and the request
        // stays a 200.
        const withoutProvider = await api.get(
          `/store/products/${product.id}/subscription-offer`,
          { headers: headersA }
        )
        expect(withoutProvider.data.subscription_offer.trial.eligible).toEqual(
          true
        )
        expect(withoutProvider.data.subscription_offer.trial.binding).toEqual({
          method: "vault",
          supported: false,
        })

        // Register a fake that ships both methods — the state a host on
        // medusa-paypal >= 0.7.0 runs in — and the same DTO flips to true.
        container.register({
          paypalSubscription: asValue({
            startVaultApproval: jest.fn(),
            completeVaultApproval: jest.fn(),
          }),
        })

        try {
          const anonymous = await api
            .get(`/store/products/${product.id}/subscription-offer`, {
              headers: await createPublishableKeyHeader(container),
            })
            .catch((error: AxiosLikeError) => {
              if (!error.response) {
                throw error
              }

              return error.response
            })
          expect(anonymous.status).toEqual(200)
          expect(
            anonymous.data.subscription_offer.trial.eligible
          ).toEqual(false)
          expect(
            anonymous.data.subscription_offer.trial.reason
          ).toEqual("authentication_required")
          expect(anonymous.headers["cache-control"]).toEqual("no-store")

          const eligible = await api.get(
            `/store/products/${product.id}/subscription-offer`,
            { headers: headersA }
          )
          expect(eligible.data.subscription_offer.trial.eligible).toEqual(true)
          expect(eligible.data.subscription_offer.trial.bonus_days).toEqual(7)
          expect(eligible.data.subscription_offer.trial.binding).toEqual({
            method: "vault",
            supported: true,
          })
        } finally {
          // Awilix 8 has no unregister; a null value is the same answer for
          // the duck-typed capability as a missing registration.
          container.register({ paypalSubscription: asValue(null) })
        }

        // And the absence left behind answers false again: every flavor of
        // "no provider" (never registered, registered as null) is false —
        // the probe is total, so the DTO can never 500 on it.
        const absentAgain = await api.get(
          `/store/products/${product.id}/subscription-offer`,
          { headers: headersA }
        )
        expect(absentAgain.data.subscription_offer.trial.binding).toEqual({
          method: "vault",
          supported: false,
        })

        // Customer B holds a live subscription for the product: ineligible.
        await subscriptionModule.createSubscriptions({
          reference: `SUB-TRIAL-PAID-${Date.now()}`,
          status: "active",
          customer_id: customerB.id,
          cart_id: null,
          product_id: product.id,
          variant_id: variant.id,
          frequency_interval: "month",
          frequency_value: 1,
          started_at: new Date(),
          next_renewal_at: new Date(Date.now() + 86_400_000),
          last_renewal_at: null,
          paused_at: null,
          cancelled_at: null,
          cancel_effective_at: null,
          skip_next_cycle: false,
          free_cycles_remaining: 0,
          is_trial: false,
          trial_ends_at: null,
          customer_snapshot: { email: customerB.email ?? "", full_name: null },
          product_snapshot: {
            product_id: product.id,
            product_title: "P",
            variant_id: variant.id,
            variant_title: "V",
            sku: null,
          },
          pricing_snapshot: null,
          shipping_address: {
            first_name: "T",
            last_name: "T",
            company: null,
            address_1: "T",
            address_2: null,
            city: "T",
            postal_code: "00000",
            province: null,
            country_code: "us",
            phone: null,
          },
          payment_context: {
            payment_mode: "auto",
            mechanism: "vault",
            payment_provider_id: null,
            source_payment_collection_id: null,
            source_payment_session_id: null,
            payment_method_reference: null,
            customer_payment_reference: null,
          },
          pending_update_data: null,
          metadata: null,
        } as never)

        const headersB = await createStoreHeadersWithPublishableKey(
          container,
          customerB
        )
        const ineligible = await api.get(
          `/store/products/${product.id}/subscription-offer`,
          { headers: headersB }
        )
        expect(ineligible.data.subscription_offer.trial.eligible).toEqual(false)
        expect(ineligible.data.subscription_offer.trial.reason).toEqual(
          "already_claimed_or_subscribed"
        )
      })

      /**
       * T03 (2026-10-02 walkthrough plan): seeds a subscription directly so
       * the guard's product scope can be asserted without a full claim.
       * Mirrors the seed the eligibility test inlines.
       */
      const seedSubscriptionFor = async (
        subscriptionModule: SubscriptionModuleService,
        customer: { id: string; email?: string | null },
        product: { id: string },
        variant: { id: string },
        status: "active" | "cancelled"
      ) => {
        await subscriptionModule.createSubscriptions({
          reference: `SUB-TRIAL-SCOPE-${Date.now()}`,
          status,
          customer_id: customer.id,
          cart_id: null,
          product_id: product.id,
          variant_id: variant.id,
          frequency_interval: "month",
          frequency_value: 1,
          started_at: new Date(),
          next_renewal_at: new Date(Date.now() + 86_400_000),
          last_renewal_at: null,
          paused_at: null,
          cancelled_at: status === "cancelled" ? new Date() : null,
          cancel_effective_at: null,
          skip_next_cycle: false,
          free_cycles_remaining: 0,
          is_trial: false,
          trial_ends_at: null,
          customer_snapshot: { email: customer.email ?? "", full_name: null },
          product_snapshot: {
            product_id: product.id,
            product_title: "P",
            variant_id: variant.id,
            variant_title: "V",
            sku: null,
          },
          pricing_snapshot: null,
          shipping_address: {
            first_name: "T",
            last_name: "T",
            company: null,
            address_1: "T",
            address_2: null,
            city: "T",
            postal_code: "00000",
            province: null,
            country_code: "us",
            phone: null,
          },
          payment_context: {
            payment_mode: "auto",
            mechanism: "vault",
            payment_provider_id: null,
            source_payment_collection_id: null,
            source_payment_session_id: null,
            payment_method_reference: null,
            customer_payment_reference: null,
          },
          pending_update_data: null,
          metadata: null,
        } as never)
      }

      it("keeps the trial scope per product: another product's subscription does not block", async () => {
        const container = getContainer()
        const subscriptionModule = container.resolve<SubscriptionModuleService>(
          SUBSCRIPTION_MODULE
        )
        const { product, variant } = await createProductWithVariant(container)
        const other = await createProductWithVariant(container)
        const customer = await createCustomer(container)
        const region = await createRegion(container, "usd")
        await attachPrice(container, variant.id, "usd")
        await createPlanOfferSeed(container, {
          scope: PlanOfferScope.PRODUCT,
          product_id: product.id,
          rules: {
            minimum_cycles: 1,
            trial_enabled: true,
            trial_days: 7,
            trial_requires_payment_method: false,
            stacking_policy: PlanOfferStackingPolicy.ALLOWED,
            trial_bonus_days: 7,
          },
        })

        const productModule = container.resolve<any>(Modules.PRODUCT)
        await productModule.updateProducts(product.id, { status: "published" })

        // An active subscription on ANOTHER product is out of scope for this
        // product's trial (the 2026-10-02 walkthrough defect was the opposite:
        // rows stranded on a deleted product were invisible to the guard).
        await seedSubscriptionFor(
          subscriptionModule,
          customer,
          other.product,
          other.variant,
          "active"
        )

        const headers = await createStoreHeadersWithPublishableKey(
          container,
          customer
        )
        const offer = await api.get(
          `/store/products/${product.id}/subscription-offer`,
          { headers }
        )
        expect(offer.data.subscription_offer.trial.eligible).toEqual(true)
      })

      it("still refuses when the product's only subscription is cancelled", async () => {
        const container = getContainer()
        const subscriptionModule = container.resolve<SubscriptionModuleService>(
          SUBSCRIPTION_MODULE
        )
        const { product, variant } = await createProductWithVariant(container)
        const customer = await createCustomer(container)
        const region = await createRegion(container, "usd")
        await attachPrice(container, variant.id, "usd")
        await createPlanOfferSeed(container, {
          scope: PlanOfferScope.PRODUCT,
          product_id: product.id,
          rules: {
            minimum_cycles: 1,
            trial_enabled: true,
            trial_days: 7,
            trial_requires_payment_method: false,
            stacking_policy: PlanOfferStackingPolicy.ALLOWED,
            trial_bonus_days: 7,
          },
        })

        const productModule = container.resolve<any>(Modules.PRODUCT)
        await productModule.updateProducts(product.id, { status: "published" })

        // The migration end state: the row is cancelled but keeps its
        // product_id, and the guard counts any status.
        await seedSubscriptionFor(
          subscriptionModule,
          customer,
          product,
          variant,
          "cancelled"
        )

        const headers = await createStoreHeadersWithPublishableKey(
          container,
          customer
        )
        const offer = await api.get(
          `/store/products/${product.id}/subscription-offer`,
          { headers }
        )
        expect(offer.data.subscription_offer.trial.eligible).toEqual(false)
        expect(offer.data.subscription_offer.trial.reason).toEqual(
          "already_claimed_or_subscribed"
        )
      })

      it("refuses the claim without authentication", async () => {
        const container = getContainer()
        const { product, variant } = await createProductWithVariant(container)
        const region = await createRegion(container, "usd")
        await createPlanOfferSeed(container, {
          scope: PlanOfferScope.PRODUCT,
          product_id: product.id,
          rules: {
            minimum_cycles: 1,
            trial_enabled: true,
            trial_days: 7,
            trial_requires_payment_method: false,
            stacking_policy: PlanOfferStackingPolicy.ALLOWED,
          },
        })

        const response = (await api
          .post(
            "/store/customers/me/trials",
            { variant_id: variant.id, region_id: region.id },
            { headers: await createPublishableKeyHeader(container) }
          )
          .catch((error: AxiosLikeError) => {
            if (!error.response) {
              throw error
            }

            return error.response
          })) as { status: number }

        expect(response.status).toEqual(401)
      })
    })
  },
})
