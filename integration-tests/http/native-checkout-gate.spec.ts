import path from "path"
import { medusaIntegrationTestRunner } from "@medusajs/test-utils"
import { Modules } from "@medusajs/framework/utils"
import type {
  IOrderModuleService,
  MedusaContainer,
} from "@medusajs/framework/types"
import { SubscriptionStatus } from "../../src/modules/subscription/types"
import {
  createCustomer,
  createProductWithVariant,
  createSubscriptionSeed,
  createStoreCustomerAuthHeaders,
} from "../helpers/subscription-fixtures"
import { seedSubscriptionCheckoutCart } from "../helpers/checkout-fixtures"

jest.setTimeout(120 * 1000)

const GUARD_MESSAGE = "managed by your payment provider"

/**
 * The reorder-rail guard's own wording (T8): the two directions must stay
 * distinguishable, so the flipped case below asserts this fragment's presence
 * AND the native fragment's absence.
 */
const REORDER_GUARD_MESSAGE =
  "A product can be covered by only one active subscription at a time"

type GateError = {
  message?: string
  type?: string
  data?: { product_id?: string; subscription_id?: string } | null
}

type ApiKeyModule = {
  createApiKeys: (input: {
    title: string
    type: string
    created_by: string
  }) => Promise<{ token: string }>
}

async function orderCount(container: MedusaContainer, customerId: string) {
  const orderModule = container.resolve<IOrderModuleService>(Modules.ORDER)
  const [, count] = await orderModule.listAndCountOrders({
    customer_id: customerId,
  })

  return count
}

/**
 * Proves the registration premise behind ticket 12: a method-level middleware
 * on the core `POST /store/carts/:id/complete` runs before the core handler, so
 * it can refuse an order without taking the route over.
 */
medusaIntegrationTestRunner({
  medusaConfigFile: path.resolve(process.cwd(), "integration-tests"),
  env: {
    JWT_SECRET: "supersecret",
    COOKIE_SECRET: "supersecret",
  },
  testSuite: ({ api, getContainer }) => {
    describe("checkout completion gate for provider recurrences", () => {
      async function setup(nativeStatus: SubscriptionStatus | null) {
        const container = getContainer()
        const customer = await createCustomer(container)
        const { product, variant } = await createProductWithVariant(container)
        const checkout = await seedSubscriptionCheckoutCart(
          container,
          customer,
          { product_id: product.id, variant_id: variant.id }
        )

        if (nativeStatus) {
          await createSubscriptionSeed(container, {
            customer_id: customer.id,
            product_id: product.id,
            variant_id: variant.id,
            reference: `NATIVE-I-GATE${Date.now()}`,
            status: nativeStatus,
          })
        }

        const apiKeyModule = container.resolve<ApiKeyModule>(Modules.API_KEY)
        const publishableKey = await apiKeyModule.createApiKeys({
          title: `gate-${Date.now()}`,
          type: "publishable",
          created_by: "test",
        })

        const headers = {
          ...(await createStoreCustomerAuthHeaders(container, customer)),
          "x-publishable-api-key": publishableKey.token,
        }

        return { container, customer, product, variant, checkout, headers }
      }

      function postComplete(
        api: typeof api,
        cartId: string,
        headers: Record<string, string>
      ) {
        return api.post(
          `/store/carts/${cartId}/complete`,
          {},
          { headers, validateStatus: () => true }
        )
      }

      it("refuses the order before the core handler runs, naming the product", async () => {
        const { container, customer, product, checkout, headers } = await setup(
          SubscriptionStatus.ACTIVE
        )

        const ordersBefore = await orderCount(container, customer.id)

        const response = await postComplete(api, checkout.cart_id, headers)
        const body = response.data as GateError

        expect(response.status).toEqual(400)
        expect(body.type).toEqual("not_allowed")
        expect(body.message).toContain(GUARD_MESSAGE)
        expect(body.data).toMatchObject({
          product_id: product.id,
        })

        // Nothing moved: the core completion handler never ran for this cart.
        expect(await orderCount(container, customer.id)).toEqual(ordersBefore)
      })

      it("also refuses while the recurrence is only paused", async () => {
        const { checkout, headers } = await setup(SubscriptionStatus.PAUSED)

        const body = (await postComplete(
          api,
          checkout.cart_id,
          headers
        )) as { data: GateError }

        expect(body.data.message).toContain(GUARD_MESSAGE)
      })

      it.each([
        ["cancelled", SubscriptionStatus.CANCELLED],
        ["past_due", SubscriptionStatus.PAST_DUE],
      ])("lets a %s recurrence reach the core handler", async (_label, status) => {
        const { checkout, headers } = await setup(status)

        const response = await postComplete(api, checkout.cart_id, headers)

        expect((response.data as GateError).message ?? "").not.toContain(
          GUARD_MESSAGE
        )
      })

      it("lets a customer with no provider recurrence reach the core handler", async () => {
        const { checkout, headers } = await setup(null)

        // What is provable in a unit-style container: the guard did not answer.
        // (The seeded cart carries an unpaid balance, so core completion itself
        // fails here with its own error; "a matching purchase still produces an
        // order" needs a funded checkout and stays on the e2e/host list.)
        const response = await postComplete(api, checkout.cart_id, headers)
        const body = response.data as GateError

        expect(body.message ?? "").not.toContain(GUARD_MESSAGE)
        expect(body.type).not.toEqual("not_allowed")
        expect(body.data ?? null).toBeNull()
      })

      it("blocks a live subscription row on this plugin's own rail, with the reorder-rail message", async () => {
        // T8 flipped the old "never blocks on this plugin's own subscription
        // row" case: a live non-NATIVE row now occupies the product exactly
        // like a provider recurrence, so the same cart is refused — with the
        // reorder-rail wording, never the native one, so the two directions
        // stay distinguishable in this spec and in the logs.
        const { container, customer, product, variant, checkout, headers } =
          await setup(null)

        const ordersBefore = await orderCount(container, customer.id)

        const ownedRow = await createSubscriptionSeed(container, {
          customer_id: customer.id,
          product_id: product.id,
          variant_id: variant.id,
          reference: `SUB-OWNED-${Date.now()}`,
          status: SubscriptionStatus.ACTIVE,
        })

        const response = await postComplete(api, checkout.cart_id, headers)
        const body = response.data as GateError

        expect(response.status).toEqual(400)
        expect(body.type).toEqual("not_allowed")
        expect(body.message).toContain(REORDER_GUARD_MESSAGE)
        expect(body.message).not.toContain(GUARD_MESSAGE)
        expect(body.data).toMatchObject({
          product_id: product.id,
          subscription_id: ownedRow.id,
        })

        // Nothing moved: the core completion handler never ran for this cart.
        expect(await orderCount(container, customer.id)).toEqual(ordersBefore)
      })

      it("counts a live trial row on the reorder rail as occupying", async () => {
        const container = getContainer()
        const { customer, product, variant, checkout, headers } = await setup(
          null
        )

        await createSubscriptionSeed(container, {
          customer_id: customer.id,
          product_id: product.id,
          variant_id: variant.id,
          reference: `SUB-TRIAL-${Date.now()}`,
          status: SubscriptionStatus.ACTIVE,
          is_trial: true,
        })

        const response = await postComplete(api, checkout.cart_id, headers)
        const body = response.data as GateError

        expect(response.status).toEqual(400)
        expect(body.type).toEqual("not_allowed")
        expect(body.message).toContain(REORDER_GUARD_MESSAGE)
        expect(body.message).not.toContain(GUARD_MESSAGE)
      })

      it("lets a cancelled row on the reorder rail reach the core handler", async () => {
        const container = getContainer()
        const { customer, product, variant, checkout, headers } = await setup(
          null
        )

        await createSubscriptionSeed(container, {
          customer_id: customer.id,
          product_id: product.id,
          variant_id: variant.id,
          reference: `SUB-CANCELLED-${Date.now()}`,
          status: SubscriptionStatus.CANCELLED,
        })

        const response = await postComplete(api, checkout.cart_id, headers)
        const body = response.data as GateError

        expect(body.message ?? "").not.toContain(REORDER_GUARD_MESSAGE)
        expect(body.message ?? "").not.toContain(GUARD_MESSAGE)
        expect(body.type).not.toEqual("not_allowed")
        expect(body.data ?? null).toBeNull()
      })
    })
  },
})