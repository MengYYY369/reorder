import path from "path"
import { medusaIntegrationTestRunner } from "@medusajs/test-utils"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import type {
  ICartModuleService,
  ILinkModuleService,
  IPaymentModuleService,
  MedusaContainer,
} from "@medusajs/framework/types"
import type { PaymentDTO } from "@medusajs/framework/types"
import paymentCapturedSavePaymentMethodHandler from "../../src/subscribers/payment-captured-save-payment-method"
import { SUBSCRIPTION_MODULE } from "../../src/modules/subscription"
import type SubscriptionModuleService from "../../src/modules/subscription/service"
import { SubscriptionStatus } from "../../src/modules/subscription/types"
import { ACTIVITY_LOG_MODULE } from "../../src/modules/activity-log"
import type ActivityLogModuleService from "../../src/modules/activity-log/service"
import {
  createCustomer,
  createProductWithVariant,
  createSubscriptionSeed,
} from "../helpers/subscription-fixtures"
import { createPlanOfferSeed } from "../helpers/plan-offer-fixtures"
import {
  PlanOfferFrequencyInterval,
  PlanOfferScope,
  PlanOfferStackingPolicy,
} from "../../src/modules/plan-offer/types"

jest.setTimeout(120 * 1000)

const VAULT_TOKEN = "paypal-vault-token-abc123"

type CaptureSeed = {
  payment_collection_id: string
  subscription_id: string
  customer_id: string
}

/**
 * Everything the payment.captured subscriber walks, except the Payment row
 * itself: the event payload only carries its id, and the subscriber reads
 * nothing off the payment but `payment_collection_id` (see stubPayment).
 */
async function seedCaptureContainer(
  container: MedusaContainer,
  options: {
    consentFromSession: "customer_id" | null
    sessionCarriesConsent?: boolean
  }
): Promise<CaptureSeed> {
  const cartModule = container.resolve<ICartModuleService>(Modules.CART)
  const paymentModule = container.resolve<IPaymentModuleService>(Modules.PAYMENT)
  const link = container.resolve<ILinkModuleService>(
    ContainerRegistrationKeys.LINK
  )

  const customer = await createCustomer(container)
  const { product, variant } = await createProductWithVariant(container)

  await createPlanOfferSeed(container, {
    name: `consent-flip-${Date.now()}`,
    scope: PlanOfferScope.VARIANT,
    product_id: product.id,
    variant_id: variant.id,
    is_enabled: true,
    allowed_frequencies: [
      { interval: PlanOfferFrequencyInterval.MONTH, value: 1 },
    ],
    rules: {
      minimum_cycles: null,
      trial_enabled: false,
      trial_days: null,
      stacking_policy: PlanOfferStackingPolicy.ALLOWED,
      consent_from_session: options.consentFromSession,
    },
  })

  const cart = await cartModule.createCarts({
    currency_code: "usd",
    email: customer.email,
    customer_id: customer.id,
    metadata: {},
  } as never)

  const subscription = await createSubscriptionSeed(container, {
    customer_id: customer.id,
    cart_id: cart.id,
    product_id: product.id,
    variant_id: variant.id,
    status: SubscriptionStatus.ACTIVE,
    payment_context: {
      payment_provider_id: "pp_system_default",
      payment_mode: "manual",
      source_payment_collection_id: null,
      source_payment_session_id: null,
      payment_method_reference: null,
      customer_payment_reference: null,
    },
  })

  const paymentCollection = await paymentModule.createPaymentCollections({
    currency_code: "usd",
    amount: 1800,
  })

  await paymentModule.createPaymentSession(paymentCollection.id, {
    provider_id: "pp_system_default",
    currency_code: "usd",
    amount: 1800,
    data: {
      payment_method: VAULT_TOKEN,
      ...(options.consentFromSession && options.sessionCarriesConsent !== false
        ? { customer_id: customer.id }
        : {}),
    },
  } as never)

  await link.create([
    {
      [Modules.CART]: { cart_id: cart.id },
      [Modules.PAYMENT]: { payment_collection_id: paymentCollection.id },
    },
  ])

  return {
    payment_collection_id: paymentCollection.id,
    subscription_id: Array.isArray(subscription)
      ? subscription[0].id
      : subscription.id,
    customer_id: customer.id,
  }
}

function stubPayment(
  container: MedusaContainer,
  paymentCollectionId: string
): string {
  const paymentModule = container.resolve<IPaymentModuleService>(Modules.PAYMENT)
  const paymentId = `payment_${Date.now()}`

  jest
    .spyOn(paymentModule, "retrievePayment")
    .mockResolvedValue(
      { id: paymentId, payment_collection_id: paymentCollectionId } as unknown as PaymentDTO
    )

  return paymentId
}

async function runSubscriber(container: MedusaContainer, paymentId: string) {
  await paymentCapturedSavePaymentMethodHandler({
    event: {
      name: "payment.captured",
      data: { id: paymentId },
      broadcast: false,
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
  testSuite: ({ getContainer }) => {
    describe("consent to auto-renew flip", () => {
      afterEach(() => {
        jest.restoreAllMocks()
      })

      it("stores the method and flips the mode in one update when consent is proven", async () => {
        const container = getContainer()
        const subscriptionModule = container.resolve<SubscriptionModuleService>(
          SUBSCRIPTION_MODULE
        )
        const activityLogModule = container.resolve<ActivityLogModuleService>(
          ACTIVITY_LOG_MODULE
        )

        const seed = await seedCaptureContainer(container, {
          consentFromSession: "customer_id",
        })

        const updateSpy = jest.spyOn(subscriptionModule, "updateSubscriptions")

        await runSubscriber(container, stubPayment(container, seed.payment_collection_id))

        const [updated] = await subscriptionModule.listSubscriptions({
          id: seed.subscription_id,
        })

        // A row that is half-flipped (method stored, mode still manual) is the
        // race this ticket exists to remove, so both must be in one write.
        expect(updated.payment_context).toMatchObject({
          payment_mode: "auto",
          mechanism: "reorder_auto",
          payment_method_reference: VAULT_TOKEN,
        })
        expect(updateSpy).toHaveBeenCalledTimes(1)
        expect(updateSpy.mock.calls[0][0]).toMatchObject({
          payment_context: {
            payment_mode: "auto",
            mechanism: "reorder_auto",
            payment_method_reference: VAULT_TOKEN,
          },
        })

        const logs = await activityLogModule.listSubscriptionLogs({
          subscription_id: seed.subscription_id,
        })

        expect(logs).toHaveLength(1)
        expect(logs[0].event_type).toEqual("subscription.payment_method_updated")
        expect(logs[0].reason).toContain("customer_id")
        expect(logs[0].metadata).toMatchObject({
          source: "payment_captured",
          trigger_type: "consent_flip",
        })

        await runSubscriber(container, stubPayment(container, seed.payment_collection_id))

        const [afterReplay] = await subscriptionModule.listSubscriptions({
          id: seed.subscription_id,
        })

        expect(afterReplay.payment_context).toMatchObject({
          payment_mode: "auto",
        })
        expect(updateSpy).toHaveBeenCalledTimes(1)
        expect(
          await activityLogModule.listSubscriptionLogs({
            subscription_id: seed.subscription_id,
          })
        ).toHaveLength(1)
      })

      it("keeps the subscription manual when the offer collects no consent", async () => {
        const container = getContainer()
        const subscriptionModule = container.resolve<SubscriptionModuleService>(
          SUBSCRIPTION_MODULE
        )
        const activityLogModule = container.resolve<ActivityLogModuleService>(
          ACTIVITY_LOG_MODULE
        )

        const seed = await seedCaptureContainer(container, {
          consentFromSession: null,
        })

        await runSubscriber(container, stubPayment(container, seed.payment_collection_id))

        const [updated] = await subscriptionModule.listSubscriptions({
          id: seed.subscription_id,
        })

        expect(updated.payment_context).toMatchObject({
          payment_mode: "manual",
          payment_method_reference: VAULT_TOKEN,
        })
        expect(
          (updated.payment_context as Record<string, unknown>).mechanism
        ).toBeUndefined()

        expect(
          await activityLogModule.listSubscriptionLogs({
            subscription_id: seed.subscription_id,
          })
        ).toHaveLength(0)
      })

      it("stores the method without flipping when the session lacks the field", async () => {
        const container = getContainer()
        const subscriptionModule = container.resolve<SubscriptionModuleService>(
          SUBSCRIPTION_MODULE
        )

        // The offer asks for consent; this storefront never collected it.
        const seed = await seedCaptureContainer(container, {
          consentFromSession: "customer_id",
          sessionCarriesConsent: false,
        })

        await runSubscriber(container, stubPayment(container, seed.payment_collection_id))

        const [updated] = await subscriptionModule.listSubscriptions({
          id: seed.subscription_id,
        })

        expect(updated.payment_context).toMatchObject({
          payment_mode: "manual",
          payment_method_reference: VAULT_TOKEN,
        })
      })
    })
  },
})
