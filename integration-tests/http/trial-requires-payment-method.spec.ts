import path from "path"
import { medusaIntegrationTestRunner } from "@medusajs/test-utils"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import type {
  ICartModuleService,
  IOrderModuleService,
  IPaymentModuleService,
  IWorkflowEngineService,
  MedusaContainer,
} from "@medusajs/framework/types"
import {
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
import {
  PlanOfferFrequencyInterval,
  PlanOfferScope,
  PlanOfferStackingPolicy,
} from "../../src/modules/plan-offer/types"

jest.setTimeout(120 * 1000)

const VAULT_TOKEN = "tok_trial_vault_token"

/**
 * The refusal `validate-subscription-cart` raises for a trial checkout that is
 * not in auto mode while the offer's `trial_requires_payment_method` rule is on.
 */
const CHECKOUT_REFUSAL =
  "This trial requires a payment method on file. Complete the checkout with automatic renewal payments instead of manual payment to start the trial."

/**
 * The refusal `resolve-redemption-code` raises for a trial-enabled code under
 * the same rule. The redemption path refuses the redemption outright (plan
 * Task 15 decision): it has no cart and no way to collect a payment method, and
 * silently degrading the code to a non-trial grant would make the offer's rule
 * a lie. The pin below is that decision.
 */
const expectedRedemptionRefusal = (code: string) =>
  `Redemption code ${code} grants a trial that requires a payment method, which redemption codes cannot collect`

type CheckoutSeed = {
  order_id: string
  customer_id: string
}

/**
 * The seed's id reader. The cart and order module create methods return a
 * single entity at runtime while their DTO types claim an array (the same
 * mismatch the older checkout specs silence with casts); this reads the id off
 * either shape without `any` and fails loudly on neither.
 */
function idOf(entity: unknown): string {
  if (
    !!entity &&
    typeof entity === "object" &&
    "id" in entity &&
    typeof (entity as { id: unknown }).id === "string"
  ) {
    return (entity as { id: string }).id
  }

  throw new TypeError("seed expected a created entity carrying a string id")
}

/**
 * The checkout shape `create-subscription-from-order` re-validates: a placed
 * order whose cart carries one subscription line item, a payment collection
 * with one session, and a trial-enabled plan offer on the variant. The line
 * item metadata carries the payment mode, which is what the rule reads.
 */
async function seedTrialCheckout(
  container: MedusaContainer,
  options: {
    payment_mode: "manual" | "auto"
    trial_requires_payment_method: boolean
  }
): Promise<CheckoutSeed> {
  const cartModule = container.resolve<ICartModuleService>(Modules.CART)
  const orderModule = container.resolve<IOrderModuleService>(Modules.ORDER)
  const paymentModule = container.resolve<IPaymentModuleService>(Modules.PAYMENT)
  const link = container.resolve<{
    create: (
      links: Array<Record<string, Record<string, string>>>
    ) => Promise<unknown>
  }>(ContainerRegistrationKeys.LINK)

  const customer = await createCustomer(container)
  const { product, variant } = await createProductWithVariant(container)

  await createPlanOfferSeed(container, {
    name: `trial-requires-pm-${Date.now()}`,
    scope: PlanOfferScope.VARIANT,
    product_id: product.id,
    variant_id: variant.id,
    is_enabled: true,
    allowed_frequencies: [
      { interval: PlanOfferFrequencyInterval.MONTH, value: 1 },
    ],
    rules: {
      minimum_cycles: null,
      trial_enabled: true,
      trial_days: 7,
      trial_requires_payment_method: options.trial_requires_payment_method,
      stacking_policy: PlanOfferStackingPolicy.ALLOWED,
    },
  })

  const itemMetadata = {
    is_subscription: true,
    frequency_interval: "month",
    frequency_value: 1,
    payment_mode: options.payment_mode,
  }

  const cartId = idOf(
    await cartModule.createCarts({
      currency_code: "usd",
      email: customer.email,
      customer_id: customer.id,
      metadata: {},
      shipping_address: {
        first_name: "Trial",
        last_name: "Checkout",
        address_1: "1 Test Way",
        city: "Testville",
        postal_code: "00001",
        country_code: "us",
      },
      items: [
        {
          title: "Subscription item",
          subtitle: product.title,
          unit_price: 18,
          quantity: 1,
          variant_id: variant.id,
          metadata: itemMetadata,
        } as never,
      ],
    } as never)
  )

  const paymentCollection = await paymentModule.createPaymentCollections({
    currency_code: "usd",
    amount: 18,
  })

  await paymentModule.createPaymentSession(paymentCollection.id, {
    provider_id: "pp_system_default",
    currency_code: "usd",
    amount: 18,
    // An auto-mode checkout proves the method through the session data: the
    // reusable token itself is only written when the payment is captured.
    data:
      options.payment_mode === "auto" ? { payment_method: VAULT_TOKEN } : {},
  } as never)

  const orderId = idOf(
    await orderModule.createOrders({
      customer_id: customer.id,
      email: customer.email,
      currency_code: "usd",
      status: "completed",
      items: [
        {
          title: "Subscription item",
          subtitle: product.title,
          quantity: 1,
          unit_price: 1800,
          variant_id: variant.id,
          metadata: itemMetadata,
        } as never,
      ],
      shipping_address: {
        first_name: "Trial",
        last_name: "Checkout",
        address_1: "1 Test Way",
        city: "Testville",
        postal_code: "00001",
        country_code: "us",
      },
    } as never)
  )

  await link.create([
    {
      [Modules.ORDER]: { order_id: orderId },
      [Modules.CART]: { cart_id: cartId },
    },
    {
      [Modules.ORDER]: { order_id: orderId },
      [Modules.PAYMENT]: {
        payment_collection_id: paymentCollection.id,
      },
    },
    {
      [Modules.CART]: { cart_id: cartId },
      [Modules.PAYMENT]: {
        payment_collection_id: paymentCollection.id,
      },
    },
  ])

  return {
    order_id: orderId,
    customer_id: customer.id,
  }
}

async function runOrderDrivenCheckout(
  container: MedusaContainer,
  orderId: string
) {
  const engine = container.resolve<IWorkflowEngineService>(
    Modules.WORKFLOW_ENGINE
  )

  return engine.run("create-subscription-from-order", {
    input: { order_id: orderId },
    throwOnError: false,
  })
}

async function createStoreHeadersWithPublishableKey(
  container: MedusaContainer,
  customer: { id: string }
): Promise<Record<string, string>> {
  const apiKeyModule = container.resolve<{
    createApiKeys: (input: {
      title: string
      type: string
      created_by: string
    }) => Promise<{ token: string }>
  }>(Modules.API_KEY)
  const pk = await apiKeyModule.createApiKeys({
    title: `trial-requires-pm-test-${Date.now()}`,
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
    describe("trial_requires_payment_method at checkout", () => {
      it("rejects a manual-mode trial checkout and creates nothing", async () => {
        const container = getContainer()
        const subscriptionModule =
          container.resolve<SubscriptionModuleService>(SUBSCRIPTION_MODULE)

        const seed = await seedTrialCheckout(container, {
          payment_mode: "manual",
          trial_requires_payment_method: true,
        })

        const { errors } = await runOrderDrivenCheckout(container, seed.order_id)

        expect(errors?.length).toBeGreaterThan(0)
        expect((errors?.[0]?.error as Error)?.message ?? "").toContain(
          CHECKOUT_REFUSAL
        )

        // Nothing created: the guard runs inside the validate step, before the
        // subscription record, its links and its initial renewal cycle.
        const rows = await subscriptionModule.listSubscriptions({
          customer_id: seed.customer_id,
        })
        expect(rows).toHaveLength(0)
      })

      it("allows a manual-mode trial checkout when the rule is off", async () => {
        const container = getContainer()
        const subscriptionModule =
          container.resolve<SubscriptionModuleService>(SUBSCRIPTION_MODULE)

        const seed = await seedTrialCheckout(container, {
          payment_mode: "manual",
          trial_requires_payment_method: false,
        })

        const { errors } = await runOrderDrivenCheckout(container, seed.order_id)

        expect(errors ?? []).toHaveLength(0)

        const [row] = await subscriptionModule.listSubscriptions({
          customer_id: seed.customer_id,
        })
        expect(row.is_trial).toEqual(true)
        expect(row.trial_ends_at).toBeTruthy()
        expect(row.payment_context).toMatchObject({
          payment_mode: "manual",
        })
      })

      it("allows an auto-mode trial checkout when the rule is on — the check is on the mode, not a stored token", async () => {
        const container = getContainer()
        const subscriptionModule =
          container.resolve<SubscriptionModuleService>(SUBSCRIPTION_MODULE)

        const seed = await seedTrialCheckout(container, {
          payment_mode: "auto",
          trial_requires_payment_method: true,
        })

        const { errors } = await runOrderDrivenCheckout(container, seed.order_id)

        expect(errors ?? []).toHaveLength(0)

        const [row] = await subscriptionModule.listSubscriptions({
          customer_id: seed.customer_id,
        })
        expect(row.is_trial).toEqual(true)
        // The context holds the session-carried reference; no vault token was
        // ever stored on the subscription before the capture wrote it.
        expect(row.payment_context).toMatchObject({
          payment_mode: "auto",
          payment_method_reference: VAULT_TOKEN,
        })
      })
    })

    describe("trial_requires_payment_method on the redemption path", () => {
      it("refuses a trial-enabled redemption outright and consumes nothing", async () => {
        const container = getContainer()
        const subscriptionModule =
          container.resolve<SubscriptionModuleService>(SUBSCRIPTION_MODULE)
        const redemptionModule =
          container.resolve<RedemptionModuleService>(REDEMPTION_MODULE)

        const customer = await createCustomer(container)
        const customerHeaders = await createStoreHeadersWithPublishableKey(
          container,
          customer
        )
        const { variant } = await createProductWithVariant(container)

        await createPlanOfferSeed(container, {
          name: `RDM-TRIAL-PM-ON-${Date.now()}`,
          scope: PlanOfferScope.VARIANT,
          variant_id: variant.id,
          allowed_frequencies: [
            { interval: PlanOfferFrequencyInterval.MONTH, value: 1 },
          ],
          rules: {
            minimum_cycles: null,
            trial_enabled: true,
            trial_days: 7,
            trial_requires_payment_method: true,
            stacking_policy: PlanOfferStackingPolicy.ALLOWED,
          },
        })

        const batch = await createRedemptionBatch(container, {
          name: `RDM-TRIAL-PM-BATCH-${Date.now()}`,
          variant_id: variant.id,
          free_cycles: 1,
          generated_code_count: 1,
        })
        const code = batch.codes[0]

        const response = await api.post(
          "/store/customers/me/redemptions",
          { code: code.code },
          { headers: customerHeaders, validateStatus: () => true }
        )

        // The declared refusal is quoted verbatim at 400. This pin is the
        // refuse decision: the code is not degraded into a non-trial grant.
        expect(response.status).toEqual(400)
        expect(response.data.message).toEqual(
          expectedRedemptionRefusal(code.code)
        )

        // Nothing created and nothing consumed.
        const rows = await subscriptionModule.listSubscriptions({
          customer_id: customer.id,
        })
        expect(rows).toHaveLength(0)

        const records = await redemptionModule.listCustomerRecords(customer.id)
        expect(records).toHaveLength(0)

        const [persistedCode] = await redemptionModule.listRedemptionCodes({
          id: [code.id],
        })
        expect(persistedCode.redemption_count).toEqual(0)
      })

      it("redeems a trial-enabled code when the rule is off", async () => {
        const container = getContainer()
        const subscriptionModule =
          container.resolve<SubscriptionModuleService>(SUBSCRIPTION_MODULE)

        const customer = await createCustomer(container)
        const customerHeaders = await createStoreHeadersWithPublishableKey(
          container,
          customer
        )
        const { variant } = await createProductWithVariant(container)

        await createPlanOfferSeed(container, {
          name: `RDM-TRIAL-PM-OFF-${Date.now()}`,
          scope: PlanOfferScope.VARIANT,
          variant_id: variant.id,
          allowed_frequencies: [
            { interval: PlanOfferFrequencyInterval.MONTH, value: 1 },
          ],
          rules: {
            minimum_cycles: null,
            trial_enabled: true,
            trial_days: 7,
            trial_requires_payment_method: false,
            stacking_policy: PlanOfferStackingPolicy.ALLOWED,
          },
        })

        const batch = await createRedemptionBatch(container, {
          name: `RDM-TRIAL-PM-OFF-BATCH-${Date.now()}`,
          variant_id: variant.id,
          free_cycles: 1,
          generated_code_count: 1,
        })

        const redeem = await api.post(
          "/store/customers/me/redemptions",
          { code: batch.codes[0].code },
          { headers: customerHeaders }
        )
        expect(redeem.status).toEqual(200)
        expect(redeem.data.is_trial).toEqual(true)
        expect(redeem.data.trial_ends_at).toBeTruthy()

        const [row] = await subscriptionModule.listSubscriptions({
          customer_id: customer.id,
        })
        expect(row.is_trial).toEqual(true)
        expect(row.trial_ends_at).toBeTruthy()
      })
    })
  },
})
