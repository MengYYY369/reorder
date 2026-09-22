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

type ListedSubscription = {
  id: string
  frequency_interval: string
  frequency_value: number
  next_renewal_at: string | null
  effective_next_renewal_at: string | null
  payment_mode: string | null
  has_payment_method: boolean
}

function seedId(created: unknown): string {
  const [first] = (Array.isArray(created) ? created : [created]) as Array<{
    id: string
  }>

  return first.id
}

async function storeHeaders(container: MedusaContainer, customer: {
  id: string
  email?: string | null
}) {
  const apiKeyModule = container.resolve<ApiKeyModule>(Modules.API_KEY)
  const publishableKey = await apiKeyModule.createApiKeys({
    title: `store-list-${Date.now()}`,
    type: "publishable",
    created_by: "test",
  })

  return {
    ...(await createStoreCustomerAuthHeaders(container, customer)),
    "x-publishable-api-key": publishableKey.token,
  }
}

medusaIntegrationTestRunner({
  medusaConfigFile: path.resolve(process.cwd(), "integration-tests"),
  env: {
    JWT_SECRET: "supersecret",
    COOKIE_SECRET: "supersecret",
  },
  testSuite: ({ api, getContainer }) => {
    describe("GET /store/customers/me/subscriptions", () => {
      it("serializes cadence and payment fields for the benefit card", async () => {
        const container = getContainer()
        const customer = await createCustomer(container)
        const headers = await storeHeaders(container, customer)

        const autoSubscription = await createSubscriptionSeed(container, {
          customer_id: customer.id,
          status: SubscriptionStatus.ACTIVE,
          skip_next_cycle: true,
          payment_context: {
            payment_provider_id: "pp_system_default",
            payment_mode: "auto",
            payment_method_reference: "pm_saved_123",
          },
        })

        const manualSubscription = await createSubscriptionSeed(container, {
          customer_id: customer.id,
          status: SubscriptionStatus.ACTIVE,
          frequency_interval: "year",
          frequency_value: 2,
          payment_context: {
            payment_provider_id: "pp_system_default",
            payment_mode: "manual",
            payment_method_reference: null,
          },
        })

        const autoId = seedId(autoSubscription)
        const manualId = seedId(manualSubscription)

        const response = await api.get("/store/customers/me/subscriptions", {
          headers,
        })

        const listed = response.data.subscriptions as ListedSubscription[]
        const byId = new Map(listed.map((item) => [item.id, item]))

        expect(byId.get(autoId)).toMatchObject({
          frequency_interval: "month",
          frequency_value: 1,
          payment_mode: "auto",
          has_payment_method: true,
        })

        expect(byId.get(manualId)).toMatchObject({
          frequency_interval: "year",
          frequency_value: 2,
          payment_mode: "manual",
          has_payment_method: false,
        })

        // The stored column stays authoritative; the effective date is the one
        // that already accounts for the skipped cycle.
        const auto = byId.get(autoId)!

        expect(auto.next_renewal_at).not.toBeNull()
        expect(
          new Date(auto.effective_next_renewal_at!).getTime()
        ).toBeGreaterThan(new Date(auto.next_renewal_at!).getTime())
      })

      it("keeps another customer's subscriptions out of the list", async () => {
        const container = getContainer()
        const customer = await createCustomer(container)
        const other = await createCustomer(container)
        const headers = await storeHeaders(container, customer)

        await createSubscriptionSeed(container, {
          customer_id: other.id,
          status: SubscriptionStatus.ACTIVE,
        })

        const response = await api.get("/store/customers/me/subscriptions", {
          headers,
        })

        expect(response.data.subscriptions).toEqual([])
      })
    })
  },
})
