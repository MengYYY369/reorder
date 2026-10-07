import path from "path"
import { asValue } from "awilix"
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
/** The bonus the target variant's plan offer carries, used as the fallback. */
const OFFER_BONUS_DAYS = 3
/** The batch's own bonus: must win over the offer's on the bind path. */
const BATCH_BONUS_DAYS = 5
const DAY_MS = 86_400_000

/** The registration key derived from the fake PayPal declaration below. */
const FAKE_PAYMENT_PROVIDER_KEY = "pp_paypal_paypal_test"

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

async function postBind(
  api: {
    post: (url: string, body?: unknown, config?: unknown) => Promise<unknown>
  },
  subscriptionId: string,
  body: Record<string, unknown>,
  headers: Record<string, string>
): Promise<{ status: number; data: { message?: string; bind?: unknown } }> {
  return (await api
    .post(`/store/customers/me/trials/${subscriptionId}/bind`, body, {
      headers,
    })
    .catch((error: AxiosLikeError) => {
      if (!error.response) {
        throw error
      }

      return error.response
    })) as { status: number; data: { message?: string; bind?: unknown } }
}

/**
 * Registers the fake vault capability the way the bind tests do: the resolved
 * `paymentMethods` answers the 0.2.0 binding surface (the container is the
 * first argument — its arity is the version discriminator), and the payment
 * module's provider declaration carries a PayPal provider. Returns a restore
 * function — the suite's container is shared by the file's tests.
 */
function registerFakeVaultProvider(
  container: MedusaContainer,
  input: { setupTokenId: string; approveUrl: string; vaultId: string }
): { restore: () => void } {
  // Plain async functions, NOT jest.fn(): the capability resolver reads the
  // function's arity (length >= 2) as the version gate, and a jest.fn() mock
  // always reports length 0 no matter its implementation.
  container.register({
    paymentMethods: asValue({
      startBinding: async function (_container: unknown, call: unknown) {
        void call
        return {
          approvalUrl: input.approveUrl,
          state: input.setupTokenId,
        }
      },
      completeBinding: async function (_container: unknown, call: unknown) {
        void call
        return {
          method: {
            id: input.vaultId,
            provider_id: FAKE_PAYMENT_PROVIDER_KEY,
          },
        }
      },
    }),
  })

  const paymentModule = container.resolve(Modules.PAYMENT) as unknown as {
    moduleDeclaration?: { providers?: Array<Record<string, unknown>> }
  }
  const previousDeclaration = paymentModule.moduleDeclaration
  paymentModule.moduleDeclaration = {
    ...(previousDeclaration ?? {}),
    providers: [
      ...(previousDeclaration?.providers ?? []),
      {
        resolve: "@mengyyy369/medusa-paypal/providers/paypal",
        id: "paypal_test",
        options: {},
      },
    ],
  }

  return {
    restore: () => {
      container.register({ paymentMethods: asValue(null) })
      paymentModule.moduleDeclaration = previousDeclaration
    },
  }
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
            trial_bonus_days: OFFER_BONUS_DAYS,
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

      it("records the batch's trial bonus on the row and grants it on bind, overriding the offer", async () => {
        const { container, customer, variant, headers } = await setup()

        // The batch carries its own bonus, different from the offer's so the
        // bind's source of truth is observable.
        const batch = await createRedemptionBatch(container, {
          name: `RDM-BONUS-${Date.now()}`,
          variant_id: variant.id,
          free_cycles: 1,
          generated_code_count: 1,
          trial_enabled: true,
          trial_days: TRIAL_DAYS,
          trial_bonus_days: BATCH_BONUS_DAYS,
        })

        const response = await redeem(api, batch.codes[0].code, headers)
        expect(response.status).toEqual(200)

        const subscriptionModule = container.resolve<SubscriptionModuleService>(
          SUBSCRIPTION_MODULE
        )
        const [row] = await subscriptionModule.listSubscriptions({
          customer_id: customer.id,
        })

        expect(row.is_trial).toBe(true)
        // The batch value lands on the row in the same shape the claim door
        // writes it (create-trial-subscription), so the bind reads it.
        expect(row.metadata?.trial_bonus_days).toEqual(BATCH_BONUS_DAYS)

        const setupTokenId = `ST-${Date.now()}`
        const { restore } = registerFakeVaultProvider(container, {
          setupTokenId,
          approveUrl: `https://www.sandbox.paypal.com/vault/setup-tokens/${setupTokenId}`,
          vaultId: `VAULT-${Date.now()}`,
        })

        try {
          const start = await postBind(
            api,
            row.id,
            {
              action: "start",
              return_url: "https://storefront.example/subscription/return",
              cancel_url: "https://storefront.example/subscription/cancel",
            },
            headers
          )
          expect(start.status).toEqual(200)

          const complete = await postBind(
            api,
            row.id,
            { action: "complete", setup_token_id: setupTokenId },
            headers
          )
          expect(complete.status).toEqual(200)

          // The batch's bonus, not the offer's: the bind prefers the value the
          // trial recorded at claim time.
          expect(complete.data.bind).toMatchObject({
            bonus_days_applied: BATCH_BONUS_DAYS,
            payment_mode: "auto",
          })

          const [bound] = await subscriptionModule.listSubscriptions({
            id: [row.id],
          })
          const expectedEndMs =
            new Date(bound.started_at as unknown as string).getTime() +
            (TRIAL_DAYS + BATCH_BONUS_DAYS) * DAY_MS
          expect(
            Math.abs(
              new Date(bound.trial_ends_at as unknown as string).getTime() -
                expectedEndMs
            )
          ).toBeLessThan(2000)
        } finally {
          restore()
        }
      })
    })
  },
})
