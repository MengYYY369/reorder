import { medusaIntegrationTestRunner } from "@medusajs/test-utils"
import path from "path"
import { Modules } from "@medusajs/framework/utils"
import type { MedusaContainer } from "@medusajs/framework/types"
import {
  createCustomer,
  createStoreCustomerAuthHeaders,
  createSubscriptionSeed,
} from "../helpers/subscription-fixtures"
import { SubscriptionStatus } from "../../src/modules/subscription/types"

jest.setTimeout(120 * 1000)

type ApiKeyModule = {
  createApiKeys: (input: {
    title: string
    type: string
    created_by: string
  }) => Promise<{ token: string }>
}

function seedId(created: unknown): string {
  const [first] = (Array.isArray(created) ? created : [created]) as Array<{
    id: string
  }>

  return first.id
}

async function publishableKeyHeader(container: MedusaContainer) {
  const apiKeyModule = container.resolve<ApiKeyModule>(Modules.API_KEY)
  const publishableKey = await apiKeyModule.createApiKeys({
    title: `auto-renew-${Date.now()}`,
    type: "publishable",
    created_by: "test",
  })

  return { "x-publishable-api-key": publishableKey.token }
}

async function storeHeaders(
  container: MedusaContainer,
  customer: { id: string; email?: string | null }
) {
  return {
    ...(await createStoreCustomerAuthHeaders(container, customer)),
    ...(await publishableKeyHeader(container)),
  }
}

/** A vaulted row: manual mode with a stored instrument the toggle can flip. */
function vaultedPaymentContext() {
  return {
    payment_provider_id: "pp_system_default",
    payment_mode: "manual",
    source_payment_collection_id: null,
    source_payment_session_id: null,
    payment_method_reference: "pm_saved_auto_renew",
    customer_payment_reference: null,
  }
}

medusaIntegrationTestRunner({
  medusaConfigFile: path.resolve(process.cwd(), "integration-tests"),
  env: {
    JWT_SECRET: "supersecret",
    COOKIE_SECRET: "supersecret",
  },
  testSuite: ({ api, getContainer }) => {
    describe("POST /store/customers/me/subscriptions/:id/auto-renew", () => {
      it("enables auto-renewal for the authenticated owner", async () => {
        const container = getContainer()
        const customer = await createCustomer(container)
        const headers = await storeHeaders(container, customer)

        const subscription = await createSubscriptionSeed(container, {
          customer_id: customer.id,
          status: SubscriptionStatus.ACTIVE,
          payment_context: vaultedPaymentContext(),
        })
        const id = seedId(subscription)

        const response = await api.post(
          `/store/customers/me/subscriptions/${id}/auto-renew`,
          { enabled: true },
          { headers }
        )

        expect(response.status).toEqual(200)
        expect(response.data).toEqual({
          subscription_id: id,
          payment_mode: "auto",
        })
      })

      it("disables auto-renewal again", async () => {
        const container = getContainer()
        const customer = await createCustomer(container)
        const headers = await storeHeaders(container, customer)

        const subscription = await createSubscriptionSeed(container, {
          customer_id: customer.id,
          status: SubscriptionStatus.ACTIVE,
          payment_context: {
            ...vaultedPaymentContext(),
            payment_mode: "auto",
          },
        })
        const id = seedId(subscription)

        const response = await api.post(
          `/store/customers/me/subscriptions/${id}/auto-renew`,
          { enabled: false },
          { headers }
        )

        expect(response.status).toEqual(200)
        expect(response.data).toEqual({
          subscription_id: id,
          payment_mode: "manual",
        })
      })

      it("answers 404 for a subscription owned by another customer", async () => {
        const container = getContainer()
        const customer = await createCustomer(container)
        const other = await createCustomer(container)
        const headers = await storeHeaders(container, customer)

        const subscription = await createSubscriptionSeed(container, {
          customer_id: other.id,
          status: SubscriptionStatus.ACTIVE,
          payment_context: vaultedPaymentContext(),
        })
        const id = seedId(subscription)

        const response = await api.post(
          `/store/customers/me/subscriptions/${id}/auto-renew`,
          { enabled: true },
          { headers, validateStatus: () => true }
        )

        // Existence is not leaked: "not yours" and "not there" are the same
        // answer, so a caller cannot probe for other customers' rows.
        expect(response.status).toEqual(404)
      })

      it("answers 401 without a customer token", async () => {
        const container = getContainer()
        const customer = await createCustomer(container)

        const subscription = await createSubscriptionSeed(container, {
          customer_id: customer.id,
          status: SubscriptionStatus.ACTIVE,
          payment_context: vaultedPaymentContext(),
        })
        const id = seedId(subscription)

        // The publishable key is what a storefront always sends; the customer
        // token is the part that is missing here, so the answer is the auth
        // middleware's 401 and not the key middleware's 400.
        const response = await api.post(
          `/store/customers/me/subscriptions/${id}/auto-renew`,
          { enabled: true },
          {
            headers: await publishableKeyHeader(container),
            validateStatus: () => true,
          }
        )

        expect(response.status).toEqual(401)
      })

      it("refuses to switch a provider mirror to auto-renewal", async () => {
        const container = getContainer()
        const customer = await createCustomer(container)
        const headers = await storeHeaders(container, customer)

        const mirror = await createSubscriptionSeed(container, {
          customer_id: customer.id,
          reference: "NATIVE-paypal-I-TEST",
          status: SubscriptionStatus.ACTIVE,
          payment_context: {
            payment_provider_id: "pp_paypal_paypal",
            payment_mode: "manual",
            mechanism: "native",
            source_payment_collection_id: null,
            source_payment_session_id: null,
            payment_method_reference: null,
            customer_payment_reference: null,
          },
        })
        const id = seedId(mirror)

        const response = await api.post(
          `/store/customers/me/subscriptions/${id}/auto-renew`,
          { enabled: true },
          { headers, validateStatus: () => true }
        )

        expect(response.status).toEqual(400)
        expect(response.data.message).toMatch(
          /is a mirror of a provider-managed recurrence/
        )
      })
    })
  },
})
