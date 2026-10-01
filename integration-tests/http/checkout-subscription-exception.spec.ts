import path from "path"
import { medusaIntegrationTestRunner } from "@medusajs/test-utils"
import { Modules } from "@medusajs/framework/utils"
import type {
  ICartModuleService,
  IPaymentModuleService,
  IWorkflowEngineService,
  MedusaContainer,
} from "@medusajs/framework/types"
import type { PaymentDTO } from "@medusajs/framework/types"
import paymentCapturedSavePaymentMethodHandler from "../../src/subscribers/payment-captured-save-payment-method"
import { SUBSCRIPTION_MODULE } from "../../src/modules/subscription"
import type SubscriptionModuleService from "../../src/modules/subscription/service"
import { SubscriptionStatus } from "../../src/modules/subscription/types"
import { RENEWAL_MODULE } from "../../src/modules/renewal"
import type RenewalModuleService from "../../src/modules/renewal/service"
import {
  PlanOfferFrequencyInterval,
  PlanOfferScope,
  PlanOfferStackingPolicy,
} from "../../src/modules/plan-offer/types"
import { createPlanOfferSeed } from "../helpers/plan-offer-fixtures"
import { seedSubscriptionCheckoutCart } from "../helpers/checkout-fixtures"
import {
  createCustomer,
  createProductWithVariant,
  createStoreCustomerAuthHeaders,
  createSubscriptionSeed,
} from "../helpers/subscription-fixtures"

jest.setTimeout(120 * 1000)

const REORDER_GUARD_MESSAGE =
  "A product can be covered by only one active subscription at a time"

const VAULT_TOKEN = "paypal-vault-token-stack-1"

type ApiKeyModule = {
  createApiKeys: (input: {
    title: string
    type: string
    created_by: string
  }) => Promise<{ token: string }>
}

type GateError = {
  message?: string
  type?: string
  data?: { product_id?: string; subscription_id?: string } | null
}

/** A payment context with no stored method: a card-free trial or redemption row. */
const noMethodContext = {
  payment_provider_id: null,
  payment_mode: "auto" as const,
  source_payment_collection_id: null,
  source_payment_session_id: null,
  payment_method_reference: null,
  customer_payment_reference: null,
}

/** A paid live row on a provider rail. */
const vaultedContext = {
  payment_provider_id: "pp_paypal_paypal",
  payment_mode: "auto" as const,
  source_payment_collection_id: null,
  source_payment_session_id: null,
  payment_method_reference: "pm_vaulted_1",
  customer_payment_reference: null,
}

function seedId(created: unknown): string {
  const [first] = (Array.isArray(created) ? created : [created]) as Array<{
    id: string
  }>

  return first.id
}

async function storeHeaders(
  container: MedusaContainer,
  customer: { id: string; email?: string | null }
) {
  const apiKeyModule = container.resolve<ApiKeyModule>(Modules.API_KEY)
  const publishableKey = await apiKeyModule.createApiKeys({
    title: `subscription-exception-${Date.now()}`,
    type: "publishable",
    created_by: "test",
  })

  return {
    ...(await createStoreCustomerAuthHeaders(container, customer)),
    "x-publishable-api-key": publishableKey.token,
  }
}

async function seedOffer(
  container: MedusaContainer,
  input: { product_id: string; variant_id: string }
) {
  await createPlanOfferSeed(container, {
    name: `subscription-exception-${Date.now()}`,
    scope: PlanOfferScope.VARIANT,
    product_id: input.product_id,
    variant_id: input.variant_id,
    is_enabled: true,
    allowed_frequencies: [
      { interval: PlanOfferFrequencyInterval.MONTH, value: 1 },
    ],
    rules: {
      minimum_cycles: 1,
      trial_enabled: false,
      trial_days: null,
      stacking_policy: PlanOfferStackingPolicy.ALLOWED,
      // Lets the vaulted purchase's `payment.captured` flip the row to auto.
      consent_from_session: "customer_id",
    },
  })
}

/**
 * A cart the checkout gate can decide on. Only the line item matters: the gate
 * reads the cart's product ids and its subscription signal.
 */
async function seedGateCart(
  container: MedusaContainer,
  customer: { id: string; email: string | null },
  variantId: string,
  isSubscription: boolean
): Promise<string> {
  const cartModule = container.resolve<ICartModuleService>(Modules.CART)

  // SAFETY: `createCarts` answers a single created cart at runtime, while the
  // pinned types declare an array; this narrows it to the id the request uses.
  const cart = (await cartModule.createCarts({
    currency_code: "usd",
    email: customer.email,
    customer_id: customer.id,
    metadata: {},
    shipping_address: {
      first_name: "Gate",
      last_name: "Test",
      address_1: "1 Test Way",
      city: "Testville",
      postal_code: "00001",
      country_code: "us",
    },
    items: [
      {
        title: "Item",
        unit_price: 18,
        quantity: 1,
        variant_id: variantId,
        metadata: isSubscription
          ? {
              is_subscription: true,
              frequency_interval: "month",
              frequency_value: 1,
              payment_mode: "manual",
            }
          : {},
      } as never,
    ],
  } as never)) as unknown as { id: string }

  return cart.id
}

async function seedTrialRow(
  container: MedusaContainer,
  input: {
    customer_id: string
    product_id: string
    variant_id: string
    trial_ends_at: Date
  }
) {
  return createSubscriptionSeed(container, {
    customer_id: input.customer_id,
    product_id: input.product_id,
    variant_id: input.variant_id,
    reference: `SUB-TRIAL-${Date.now()}`,
    status: SubscriptionStatus.ACTIVE,
    is_trial: true,
    trial_ends_at: input.trial_ends_at,
    next_renewal_at: input.trial_ends_at,
    cart_id: `cart_template_${Date.now()}`,
    payment_context: {
      payment_provider_id: null,
      payment_mode: "manual",
      source_payment_collection_id: null,
      source_payment_session_id: null,
      payment_method_reference: null,
      customer_payment_reference: null,
    },
  })
}

function stubPayment(
  container: MedusaContainer,
  paymentCollectionId: string
): string {
  const paymentModule = container.resolve<IPaymentModuleService>(Modules.PAYMENT)
  const paymentId = `payment_${Date.now()}`

  jest.spyOn(paymentModule, "retrievePayment").mockResolvedValue({
    id: paymentId,
    payment_collection_id: paymentCollectionId,
  } as unknown as PaymentDTO)

  return paymentId
}

async function runPaymentCapturedSubscriber(
  container: MedusaContainer,
  paymentId: string
) {
  await paymentCapturedSavePaymentMethodHandler({
    event: {
      name: "payment.captured",
      data: { id: paymentId },
    },
    container,
    pluginOptions: {},
  })
}

medusaIntegrationTestRunner({
  medusaConfigFile: path.resolve(process.cwd(), "integration-tests"),
  env: {
    JWT_SECRET: "supersecret",
    COOKIE_SECRET: "supersecret",
  },
  testSuite: ({ api, getContainer }) => {
    describe("checkout gate: the subscription-track exception (D12)", () => {
      async function setup() {
        const container = getContainer()
        const customer = await createCustomer(container)
        const { product, variant } = await createProductWithVariant(container)
        const headers = await storeHeaders(container, customer)

        return { container, customer, product, variant, headers }
      }

      async function completeCart(
        cartId: string,
        headers: Record<string, string>
      ) {
        return api.post(
          `/store/carts/${cartId}/complete`,
          {},
          { headers, validateStatus: () => true }
        )
      }

      it("lets a subscription-track cart fold into a card-free trial row", async () => {
        const { container, customer, product, variant, headers } = await setup()
        await createSubscriptionSeed(container, {
          customer_id: customer.id,
          product_id: product.id,
          variant_id: variant.id,
          reference: `SUB-TRIAL-${Date.now()}`,
          status: SubscriptionStatus.ACTIVE,
          is_trial: true,
          payment_context: noMethodContext,
        })
        const cartId = await seedGateCart(container, customer, variant.id, true)

        const response = await completeCart(cartId, headers)
        const body = response.data as GateError

        expect(body.message ?? "").not.toContain(REORDER_GUARD_MESSAGE)
        expect(body.type).not.toEqual("not_allowed")
      })

      it("lets a subscription-track cart fold into a paid vaulted row", async () => {
        const { container, customer, product, variant, headers } = await setup()
        await createSubscriptionSeed(container, {
          customer_id: customer.id,
          product_id: product.id,
          variant_id: variant.id,
          reference: `SUB-VAULT-${Date.now()}`,
          status: SubscriptionStatus.ACTIVE,
          is_trial: false,
          payment_context: vaultedContext,
        })
        const cartId = await seedGateCart(container, customer, variant.id, true)

        const response = await completeCart(cartId, headers)
        const body = response.data as GateError

        expect(body.message ?? "").not.toContain(REORDER_GUARD_MESSAGE)
        expect(body.type).not.toEqual("not_allowed")
      })

      it("still refuses a pure one-time purchase of the same product", async () => {
        const { container, customer, product, variant, headers } = await setup()
        await createSubscriptionSeed(container, {
          customer_id: customer.id,
          product_id: product.id,
          variant_id: variant.id,
          reference: `SUB-TRIAL-${Date.now()}`,
          status: SubscriptionStatus.ACTIVE,
          is_trial: true,
          payment_context: noMethodContext,
        })
        const cartId = await seedGateCart(container, customer, variant.id, false)

        const response = await completeCart(cartId, headers)
        const body = response.data as GateError

        expect(response.status).toEqual(400)
        expect(body.type).toEqual("not_allowed")
        expect(body.message).toContain(REORDER_GUARD_MESSAGE)
      })

      it.each([
        [
          "a bound auto trial row",
          {
            is_trial: true,
            status: SubscriptionStatus.ACTIVE,
            payment_context: vaultedContext,
          },
        ],
        [
          "a redemption row with no provider",
          {
            is_trial: false,
            status: SubscriptionStatus.ACTIVE,
            payment_context: noMethodContext,
          },
        ],
        [
          "a paused row",
          {
            is_trial: true,
            status: SubscriptionStatus.PAUSED,
            payment_context: noMethodContext,
          },
        ],
      ])(
        "still refuses a subscription-track purchase onto %s",
        async (_label, row) => {
          const { container, customer, product, variant, headers } =
            await setup()
          await createSubscriptionSeed(container, {
            customer_id: customer.id,
            product_id: product.id,
            variant_id: variant.id,
            reference: `SUB-BLOCK-${Date.now()}`,
            status: row.status,
            is_trial: row.is_trial,
            payment_context: row.payment_context,
          })
          const cartId = await seedGateCart(
            container,
            customer,
            variant.id,
            true
          )

          const response = await completeCart(cartId, headers)
          const body = response.data as GateError

          expect(response.status).toEqual(400)
          expect(body.type).toEqual("not_allowed")
          expect(body.message).toContain(REORDER_GUARD_MESSAGE)
        }
      )

      it("still refuses a native recurrence", async () => {
        const { container, customer, product, variant, headers } = await setup()
        await createSubscriptionSeed(container, {
          customer_id: customer.id,
          product_id: product.id,
          variant_id: variant.id,
          reference: `NATIVE-I-EXC${Date.now()}`,
          status: SubscriptionStatus.ACTIVE,
          payment_context: vaultedContext,
        })
        const cartId = await seedGateCart(container, customer, variant.id, true)

        const response = await completeCart(cartId, headers)
        const body = response.data as GateError

        expect(response.status).toEqual(400)
        expect(body.type).toEqual("not_allowed")
        expect(body.message).toContain("managed by your payment provider")
      })
    })

    describe("trial row conversion on a repeat purchase (D12)", () => {
      async function setupPurchase(options?: {
        sessionDataFor?: (customerId: string) => Record<string, unknown>
      }) {
        const container = getContainer()
        const subscriptionModule =
          container.resolve<SubscriptionModuleService>(SUBSCRIPTION_MODULE)
        const engine = container.resolve<IWorkflowEngineService>(
          Modules.WORKFLOW_ENGINE
        )

        const customer = await createCustomer(container)
        const { product, variant } = await createProductWithVariant(container)
        await seedOffer(container, {
          product_id: product.id,
          variant_id: variant.id,
        })

        const trialEndsAt = new Date(Date.now() + 7 * 86_400_000)
        const trial = await seedTrialRow(container, {
          customer_id: customer.id,
          product_id: product.id,
          variant_id: variant.id,
          trial_ends_at: trialEndsAt,
        })

        const checkout = await seedSubscriptionCheckoutCart(
          container,
          customer,
          { product_id: product.id, variant_id: variant.id },
          options?.sessionDataFor
            ? { session_data: options.sessionDataFor(customer.id) }
            : undefined
        )

        return {
          container,
          subscriptionModule,
          engine,
          customer,
          product,
          variant,
          trialId: seedId(trial),
          trialEndsAt,
          checkout,
        }
      }

      function runOrder(
        engine: IWorkflowEngineService,
        orderId: string,
        throwOnError = true
      ) {
        return engine.run("create-subscription-from-order", {
          input: { order_id: orderId },
          throwOnError,
        })
      }

      afterEach(() => {
        jest.restoreAllMocks()
      })

      it("converts the trial row and stacks the new cycle onto it", async () => {
        const {
          subscriptionModule,
          engine,
          customer,
          trialId,
          trialEndsAt,
          checkout,
        } = await setupPurchase()

        await runOrder(engine, checkout.order_id)

        const rows = await subscriptionModule.listSubscriptions({
          customer_id: customer.id,
        })

        expect(rows).toHaveLength(1)
        const row = rows[0]
        expect(row.id).toEqual(trialId)
        expect(row.is_trial).toBe(false)
        expect(row.trial_ends_at).toBeNull()
        expect(row.cart_id).toEqual(checkout.cart_id)
        expect(row.metadata).toMatchObject({ cycles_purchased: 2 })

        // The new period ends one cadence past the trial's own end, not at it.
        const next = new Date(row.next_renewal_at as unknown as string)
        const expected = new Date(trialEndsAt)
        expected.setUTCMonth(expected.getUTCMonth() + 1)
        expect(Math.abs(next.getTime() - expected.getTime())).toBeLessThan(2000)
      })

      it("stamps the purchase provider onto a row with no stored method", async () => {
        const { subscriptionModule, engine, trialId, checkout } =
          await setupPurchase()

        await runOrder(engine, checkout.order_id)

        const [row] = await subscriptionModule.listSubscriptions({
          id: [trialId],
        })

        const context = row.payment_context as Record<string, unknown>
        expect(context.payment_provider_id).toEqual("pp_system_default")
        // The method reference itself stays the capture subscriber's write.
        expect(context.payment_method_reference).toBeNull()
        // The mode is not moved by the attribution.
        expect(context.payment_mode).toEqual("manual")
      })

      it("does not overwrite a row that already holds a method", async () => {
        const {
          container,
          subscriptionModule,
          engine,
          customer,
          product,
          variant,
          trialId,
          checkout,
        } = await setupPurchase()

        // Replace the trial row with a paid row that already stores a method:
        // the purchase must extend it without touching that context.
        await subscriptionModule.deleteSubscriptions([trialId])
        const paid = await createSubscriptionSeed(container, {
          customer_id: customer.id,
          product_id: product.id,
          variant_id: variant.id,
          reference: `SUB-PAID-${Date.now()}`,
          status: SubscriptionStatus.ACTIVE,
          payment_context: {
            payment_provider_id: "pp_stored_provider",
            payment_mode: "manual",
            source_payment_collection_id: null,
            source_payment_session_id: null,
            payment_method_reference: "pm_stored_1",
            customer_payment_reference: null,
          },
        })

        await runOrder(engine, checkout.order_id)

        const [row] = await subscriptionModule.listSubscriptions({
          id: [seedId(paid)],
        })

        expect(row.payment_context).toMatchObject({
          payment_provider_id: "pp_stored_provider",
          payment_mode: "manual",
          payment_method_reference: "pm_stored_1",
        })
      })

      it("is idempotent for a repeated order event", async () => {
        const { subscriptionModule, engine, customer, trialId, checkout } =
          await setupPurchase()

        await runOrder(engine, checkout.order_id)
        await runOrder(engine, checkout.order_id)

        const rows = await subscriptionModule.listSubscriptions({
          customer_id: customer.id,
        })

        expect(rows).toHaveLength(1)
        expect(rows[0].id).toEqual(trialId)
        expect(rows[0].metadata).toMatchObject({ cycles_purchased: 2 })
      })

      it("restores the trial state when a later step fails", async () => {
        const {
          container,
          subscriptionModule,
          engine,
          trialId,
          checkout,
        } = await setupPurchase()

        const renewalModule =
          container.resolve<RenewalModuleService>(RENEWAL_MODULE)
        const cycleWrite = jest
          .spyOn(renewalModule, "createRenewalCycles")
          .mockRejectedValue(new Error("cycle write down"))

        const outcome = await runOrder(engine, checkout.order_id, false)

        cycleWrite.mockRestore()

        expect((outcome.errors ?? []).length).toBeGreaterThan(0)

        const [row] = await subscriptionModule.listSubscriptions({
          id: [trialId],
        })

        expect(row.is_trial).toBe(true)
        expect(row.trial_ends_at).toBeTruthy()
        expect(row.cart_id).not.toEqual(checkout.cart_id)
      })

      it("lands the vaulted method and flips the row to auto after the extension", async () => {
        const {
          container,
          subscriptionModule,
          engine,
          trialId,
          checkout,
        } = await setupPurchase({
          sessionDataFor: (customerId) => ({
            payment_method: VAULT_TOKEN,
            customer_id: customerId,
          }),
        })

        await runOrder(engine, checkout.order_id)

        // The row now carries the purchase's provider and cart, so the capture
        // subscriber can match this purchase's session and store its token.
        await runPaymentCapturedSubscriber(
          container,
          stubPayment(container, checkout.payment_collection_id)
        )

        const [row] = await subscriptionModule.listSubscriptions({
          id: [trialId],
        })

        expect(row.payment_context).toMatchObject({
          payment_method_reference: VAULT_TOKEN,
          payment_mode: "auto",
          mechanism: "reorder_auto",
        })
      })
    })
  },
})
