import path from "path"
import { medusaIntegrationTestRunner } from "@medusajs/test-utils"
import { Modules } from "@medusajs/framework/utils"
import type {
  IWorkflowEngineService,
  MedusaContainer,
} from "@medusajs/framework/types"
import { SUBSCRIPTION_MODULE } from "../../src/modules/subscription"
import type SubscriptionModuleService from "../../src/modules/subscription/service"
import { SubscriptionStatus } from "../../src/modules/subscription/types"
import {
  createCustomer,
  createSubscriptionSeed,
} from "../helpers/subscription-fixtures"
import { seedSubscriptionCheckoutCart } from "../helpers/checkout-fixtures"

jest.setTimeout(120 * 1000)

/**
 * Run the subscription-track creation workflow for a seeded checkout and
 * report the engine errors instead of throwing, so the guard's message can be
 * asserted.
 */
async function subscriptionTrackErrors(
  container: MedusaContainer,
  orderId: string
): Promise<string[]> {
  const engine = container.resolve<IWorkflowEngineService>(
    Modules.WORKFLOW_ENGINE
  )

  const { errors } = await engine.run("create-subscription-from-order", {
    input: { order_id: orderId },
    throwOnError: false,
  })

  return ((Array.isArray(errors) ? errors : []) as Array<{ error?: Error }>).map(
    (entry) => entry.error?.message ?? ""
  )
}

medusaIntegrationTestRunner({
  medusaConfigFile: path.resolve(process.cwd(), "integration-tests"),
  env: {
    JWT_SECRET: "supersecret",
    COOKIE_SECRET: "supersecret",
  },
  testSuite: ({ getContainer }) => {
    describe("native exclusivity on the subscription track", () => {
      it("rejects a subscription purchase while a provider recurrence is live", async () => {
        const container = getContainer()
        const customer = await createCustomer(container)
        const checkout = await seedSubscriptionCheckoutCart(container, customer)

        await createSubscriptionSeed(container, {
          customer_id: customer.id,
          product_id: checkout.product_id,
          variant_id: checkout.variant_id,
          reference: `NATIVE-I-LIVE${Date.now()}`,
          status: SubscriptionStatus.ACTIVE,
        })

        const errors = await subscriptionTrackErrors(
          container,
          checkout.order_id
        )

        expect(errors.join("\n")).toContain("already have an active subscription")

        const subscriptionModule = container.resolve<SubscriptionModuleService>(
          SUBSCRIPTION_MODULE
        )

        // Only the mirror row exists: the purchase produced no second row.
        const rows = await subscriptionModule.listSubscriptions({
          customer_id: customer.id,
        })

        expect(rows).toHaveLength(1)
        expect(rows[0].reference).toMatch(/^NATIVE-/)
      })

      it("blocks while the recurrence is paused", async () => {
        const container = getContainer()
        const customer = await createCustomer(container)
        const checkout = await seedSubscriptionCheckoutCart(container, customer)

        await createSubscriptionSeed(container, {
          customer_id: customer.id,
          product_id: checkout.product_id,
          variant_id: checkout.variant_id,
          reference: `NATIVE-I-PAUSED${Date.now()}`,
          status: SubscriptionStatus.PAUSED,
        })

        const errors = await subscriptionTrackErrors(
          container,
          checkout.order_id
        )

        expect(errors.join("\n")).toContain("already have an active subscription")
      })

      it.each([
        ["cancelled", SubscriptionStatus.CANCELLED],
        ["past_due", SubscriptionStatus.PAST_DUE],
      ])(
        "lets a %s recurrence through so the customer can buy the period",
        async (_label, status) => {
          const container = getContainer()
          const customer = await createCustomer(container)
          const checkout = await seedSubscriptionCheckoutCart(
            container,
            customer
          )

          await createSubscriptionSeed(container, {
            customer_id: customer.id,
            product_id: checkout.product_id,
            variant_id: checkout.variant_id,
            reference: `NATIVE-I-${Date.now()}`,
            status,
          })

          expect(
            await subscriptionTrackErrors(container, checkout.order_id)
          ).toEqual([])
        }
      )

      it("never blocks on this plugin's own active row for the same product", async () => {
        const container = getContainer()
        const customer = await createCustomer(container)
        const checkout = await seedSubscriptionCheckoutCart(container, customer)

        // Regression for a first draft of the guard that filtered on customer +
        // status only: a healthy reorder subscription would then have rejected
        // its own owner's next purchase.
        await createSubscriptionSeed(container, {
          customer_id: customer.id,
          product_id: checkout.product_id,
          variant_id: checkout.variant_id,
          reference: `SUB-OWNED-${Date.now()}`,
          status: SubscriptionStatus.ACTIVE,
          skip_next_cycle: false,
          payment_context: {
            payment_provider_id: "pp_system_default",
            payment_mode: "manual",
          },
        })

        expect(
          await subscriptionTrackErrors(container, checkout.order_id)
        ).toEqual([])
      })
    })
  },
})
