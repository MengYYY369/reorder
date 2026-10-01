import path from "path"
import { medusaIntegrationTestRunner } from "@medusajs/test-utils"
import {
  ContainerRegistrationKeys,
  Modules,
} from "@medusajs/framework/utils"
import type {
  IWorkflowEngineService,
  MedusaContainer,
} from "@medusajs/framework/types"
import { SUBSCRIPTION_MODULE } from "../../src/modules/subscription"
import type SubscriptionModuleService from "../../src/modules/subscription/service"
import { SubscriptionStatus } from "../../src/modules/subscription/types"
import {
  PlanOfferFrequencyInterval,
  PlanOfferScope,
  PlanOfferStackingPolicy,
} from "../../src/modules/plan-offer/types"
import { seedSubscriptionCheckoutCart } from "../helpers/checkout-fixtures"
import { createPlanOfferSeed } from "../helpers/plan-offer-fixtures"
import {
  createCustomer,
  createProductWithVariant,
  createStoreCustomerAuthHeaders,
} from "../helpers/subscription-fixtures"

jest.setTimeout(120 * 1000)

const TRIAL_DAYS = 7

type ApiKeyModule = {
  createApiKeys: (input: {
    title: string
    type: string
    created_by: string
  }) => Promise<{ token: string }>
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

async function seedTrialOffer(
  container: MedusaContainer,
  input: { product_id: string; variant_id: string }
) {
  await createPlanOfferSeed(container, {
    name: `trial-decoupled-${Date.now()}`,
    scope: PlanOfferScope.PRODUCT,
    product_id: input.product_id,
    variant_id: input.variant_id,
    is_enabled: true,
    allowed_frequencies: [
      { interval: PlanOfferFrequencyInterval.MONTH, value: 1 },
    ],
    rules: {
      minimum_cycles: 1,
      trial_enabled: true,
      trial_days: TRIAL_DAYS,
      trial_bonus_days: TRIAL_DAYS,
      trial_requires_payment_method: false,
      stacking_policy: PlanOfferStackingPolicy.ALLOWED,
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
    /**
     * Ticket 13 (D13): the offer's `trial_*` rules describe what the claim
     * endpoint may grant; the checkout track must never mint a trial row from
     * them. Before the change, `validate-subscription-cart` injected the offer's
     * `trial_days` and an ordinary subscription purchase became a trial: a
     * manual purchase ended at `trial_days`, and an auto purchase was charged
     * once for the trial period and again at the first real renewal.
     */
    describe("checkout trial decoupling (D13)", () => {
      it("does not turn an order-driven purchase into a trial", async () => {
        const container = getContainer()
        const subscriptionModule = container.resolve<SubscriptionModuleService>(
          SUBSCRIPTION_MODULE
        )
        const engine = container.resolve<IWorkflowEngineService>(
          Modules.WORKFLOW_ENGINE
        )

        const customer = await createCustomer(container)
        const { product, variant } = await createProductWithVariant(container)
        await seedTrialOffer(container, {
          product_id: product.id,
          variant_id: variant.id,
        })

        const checkout = await seedSubscriptionCheckoutCart(container, customer, {
          product_id: product.id,
          variant_id: variant.id,
        })

        await engine.run("create-subscription-from-order", {
          input: { order_id: checkout.order_id },
          throwOnError: true,
        })

        const rows = await subscriptionModule.listSubscriptions({
          customer_id: customer.id,
        })

        expect(rows).toHaveLength(1)
        expect(rows[0].is_trial).toBe(false)
        expect(rows[0].trial_ends_at).toBeNull()

        // The first renewal sits one cadence out, not at the offer's trial end:
        // a trial row would anchor `next_renewal_at` at +TRIAL_DAYS.
        const daysToRenewal =
          (new Date(rows[0].next_renewal_at as unknown as string).getTime() -
            Date.now()) /
          86_400_000
        expect(daysToRenewal).toBeGreaterThan(TRIAL_DAYS + 20)
      })

      it("still mints a trial row from the claim endpoint on the same offer", async () => {
        const container = getContainer()
        const subscriptionModule = container.resolve<SubscriptionModuleService>(
          SUBSCRIPTION_MODULE
        )
        const { product, variant } = await createProductWithVariant(container)
        const customer = await createCustomer(container)
        await seedTrialOffer(container, {
          product_id: product.id,
          variant_id: variant.id,
        })

        const regionModule = container.resolve<RegionModuleLike>(Modules.REGION)
        const region = await regionModule.createRegions({
          name: `trial-decoupled-region-${Date.now()}`,
          currency_code: "usd",
        })

        const pricingModule = container.resolve<PricingModuleLike>(Modules.PRICING)
        const priceSet = await pricingModule.createPriceSets({
          prices: [{ amount: 1800, currency_code: "usd" }],
        })
        const link = container.resolve(ContainerRegistrationKeys.LINK)
        await link.create({
          [Modules.PRODUCT]: { variant_id: variant.id },
          [Modules.PRICING]: { price_set_id: priceSet.id },
        })

        const productModule = container.resolve<{
          updateProducts: (
            id: string,
            data: Record<string, unknown>
          ) => Promise<unknown>
        }>(Modules.PRODUCT)
        await productModule.updateProducts(product.id, { status: "published" })

        const apiKeyModule = container.resolve<ApiKeyModule>(Modules.API_KEY)
        const publishableKey = await apiKeyModule.createApiKeys({
          title: `trial-decoupled-${Date.now()}`,
          type: "publishable",
          created_by: "test",
        })
        const headers = {
          ...(await createStoreCustomerAuthHeaders(container, customer)),
          "x-publishable-api-key": publishableKey.token,
        }

        const response = await api.post(
          "/store/customers/me/trials",
          { variant_id: variant.id, region_id: region.id, binding: "none" },
          { headers }
        )

        expect(response.status).toEqual(201)

        const rows = await subscriptionModule.listSubscriptions({
          customer_id: customer.id,
        })

        expect(rows).toHaveLength(1)
        expect(rows[0].is_trial).toBe(true)
        expect(rows[0].status).toEqual(SubscriptionStatus.ACTIVE)
        expect(rows[0].trial_ends_at).toBeTruthy()

        const trialDays =
          (new Date(rows[0].trial_ends_at as unknown as string).getTime() -
            Date.now()) /
          86_400_000
        expect(trialDays).toBeGreaterThan(TRIAL_DAYS - 1)
        expect(trialDays).toBeLessThan(TRIAL_DAYS + 1)
      })
    })
  },
})
