import path from "path"
import { medusaIntegrationTestRunner } from "@medusajs/test-utils"
import { Modules } from "@medusajs/framework/utils"
import type { MedusaContainer } from "@medusajs/framework/types"
import { SUBSCRIPTION_MODULE } from "../../src/modules/subscription"
import type SubscriptionModuleService from "../../src/modules/subscription/service"
import { SubscriptionStatus } from "../../src/modules/subscription/types"
import {
  PlanOfferFrequencyInterval,
  PlanOfferScope,
  PlanOfferStackingPolicy,
} from "../../src/modules/plan-offer/types"
import { createPlanOfferSeed } from "../helpers/plan-offer-fixtures"
import { createRedemptionBatch } from "../helpers/redemption-fixtures"
import {
  createCustomer,
  createProductWithVariant,
  createStoreCustomerAuthHeaders,
  createSubscriptionSeed,
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

type AxiosLikeError = {
  response?: { status: number; data: { message?: string } }
  message: string
}

async function storeHeaders(
  container: MedusaContainer,
  customer: { id: string; email?: string | null }
) {
  const apiKeyModule = container.resolve<ApiKeyModule>(Modules.API_KEY)
  const publishableKey = await apiKeyModule.createApiKeys({
    title: `redemption-batch-trial-${Date.now()}`,
    type: "publishable",
    created_by: "test",
  })

  return {
    ...(await createStoreCustomerAuthHeaders(container, customer)),
    "x-publishable-api-key": publishableKey.token,
  }
}

async function redeem(
  api: {
    post: (
      url: string,
      body?: unknown,
      config?: unknown
    ) => Promise<{ status: number; data: { message?: string } }>
  },
  code: string,
  headers: Record<string, string>
) {
  return (await api
    .post("/store/customers/me/redemptions", { code }, { headers })
    .catch((error: AxiosLikeError) => {
      if (!error.response) {
        throw error
      }

      return error.response
    })) as { status: number; data: { message?: string } }
}

medusaIntegrationTestRunner({
  medusaConfigFile: path.resolve(process.cwd(), "integration-tests"),
  env: {
    JWT_SECRET: "supersecret",
    COOKIE_SECRET: "supersecret",
  },
  testSuite: ({ api, getContainer }) => {
    /**
     * Ticket 14 (D14): a redemption batch carries its own trial configuration,
     * default off, instead of inheriting the target variant's plan-offer trial
     * rules. That is what lets a normal code batch and a trial offer live on the
     * same variant.
     */
    describe("redemption batch trial configuration (D14)", () => {
      async function setup() {
        const container = getContainer()
        const customer = await createCustomer(container)
        const { product, variant } = await createProductWithVariant(container)

        // The variant's offer offers a trial; the batch config is what decides
        // whether a code grants one.
        await createPlanOfferSeed(container, {
          name: `rdm-trial-offer-${Date.now()}`,
          scope: PlanOfferScope.VARIANT,
          product_id: product.id,
          variant_id: variant.id,
          is_enabled: true,
          allowed_frequencies: [
            { interval: PlanOfferFrequencyInterval.MONTH, value: 1 },
          ],
          rules: {
            minimum_cycles: 1,
            trial_enabled: true,
            trial_days: TRIAL_DAYS,
            stacking_policy: PlanOfferStackingPolicy.ALLOWED,
          },
        })

        const headers = await storeHeaders(container, customer)

        return { container, customer, product, variant, headers }
      }

      it("keeps a normal batch's create semantics on a trial-enabled offer", async () => {
        const { container, customer, variant, headers } = await setup()

        const batch = await createRedemptionBatch(container, {
          name: `RDM-NORMAL-${Date.now()}`,
          variant_id: variant.id,
          free_cycles: 2,
          generated_code_count: 1,
        })

        const response = await redeem(api, batch.codes[0].code, headers)
        expect(response.status).toEqual(200)

        const subscriptionModule = container.resolve<SubscriptionModuleService>(
          SUBSCRIPTION_MODULE
        )
        const rows = await subscriptionModule.listSubscriptions({
          customer_id: customer.id,
        })

        expect(rows).toHaveLength(1)
        expect(rows[0].is_trial).toBe(false)
        expect(rows[0].trial_ends_at).toBeNull()
        // The free-period grant keeps its boundary; the offer's trial rules are
        // not read.
        expect(rows[0].cancel_effective_at).toBeTruthy()
      })

      it("grants a trial when the batch enables one", async () => {
        const { container, customer, variant, headers } = await setup()

        const batch = await createRedemptionBatch(container, {
          name: `RDM-TRIAL-${Date.now()}`,
          variant_id: variant.id,
          free_cycles: 1,
          generated_code_count: 1,
          trial_enabled: true,
          trial_days: TRIAL_DAYS,
        })

        const response = await redeem(api, batch.codes[0].code, headers)
        expect(response.status).toEqual(200)

        const subscriptionModule = container.resolve<SubscriptionModuleService>(
          SUBSCRIPTION_MODULE
        )
        const rows = await subscriptionModule.listSubscriptions({
          customer_id: customer.id,
        })

        expect(rows).toHaveLength(1)
        expect(rows[0].is_trial).toBe(true)
        expect(rows[0].trial_ends_at).toBeTruthy()
        expect(rows[0].cancel_effective_at).toBeNull()

        const trialDays =
          (new Date(rows[0].trial_ends_at as unknown as string).getTime() -
            Date.now()) /
          86_400_000
        expect(trialDays).toBeGreaterThan(TRIAL_DAYS - 1)
        expect(trialDays).toBeLessThan(TRIAL_DAYS + 1)
      })

      it("refuses to extend a live trial row with a normal batch", async () => {
        const { container, customer, product, variant, headers } = await setup()

        await createSubscriptionSeed(container, {
          customer_id: customer.id,
          product_id: product.id,
          variant_id: variant.id,
          reference: `SUB-TRIAL-${Date.now()}`,
          status: SubscriptionStatus.ACTIVE,
          is_trial: true,
          trial_ends_at: new Date(Date.now() + TRIAL_DAYS * 86_400_000),
          payment_context: {
            payment_provider_id: null,
            payment_mode: "auto",
            source_payment_collection_id: null,
            source_payment_session_id: null,
            payment_method_reference: null,
            customer_payment_reference: null,
          },
        })

        const batch = await createRedemptionBatch(container, {
          name: `RDM-REFUSE-${Date.now()}`,
          variant_id: variant.id,
          free_cycles: 2,
          generated_code_count: 1,
        })

        const response = await redeem(api, batch.codes[0].code, headers)

        expect(response.status).toEqual(400)
        expect(String(response.data?.message)).toContain(
          "cannot extend the trial subscription"
        )

        // The refusal consumed nothing: one subscription, the trial, unchanged.
        const subscriptionModule = container.resolve<SubscriptionModuleService>(
          SUBSCRIPTION_MODULE
        )
        const rows = await subscriptionModule.listSubscriptions({
          customer_id: customer.id,
        })
        expect(rows).toHaveLength(1)
        expect(rows[0].is_trial).toBe(true)
      })

      it("still refuses a second claim for a trial batch", async () => {
        const { container, customer, variant, headers } = await setup()

        const batch = await createRedemptionBatch(container, {
          name: `RDM-TRIAL-ONLY-${Date.now()}`,
          variant_id: variant.id,
          free_cycles: 1,
          generated_code_count: 2,
          trial_enabled: true,
          trial_days: TRIAL_DAYS,
        })

        const first = await redeem(api, batch.codes[0].code, headers)
        expect(first.status).toEqual(200)

        const second = await redeem(api, batch.codes[1].code, headers)
        expect(second.status).toEqual(400)
        expect(String(second.data?.message)).toContain(
          "Trial codes are for new users only"
        )

        const subscriptionModule = container.resolve<SubscriptionModuleService>(
          SUBSCRIPTION_MODULE
        )
        const rows = await subscriptionModule.listSubscriptions({
          customer_id: customer.id,
        })
        expect(rows).toHaveLength(1)
      })
    })
  },
})
