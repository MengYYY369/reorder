import { medusaIntegrationTestRunner } from "@medusajs/test-utils"
import path from "path"
import { Modules } from "@medusajs/framework/utils"
import type { MedusaContainer } from "@medusajs/framework/types"

jest.setTimeout(120 * 1000)

const BRIDGE_SECRET = "test-bridge-secret"
const DEFAULT_TENANT = { "x-tenant-id": "default" }

async function createPublishableKey(
  container: MedusaContainer
): Promise<string> {
  const apiKeyModule = container.resolve<any>(Modules.API_KEY)
  const pk = await apiKeyModule.createApiKeys({
    title: `saas-bridge-test-${Date.now()}`,
    type: "publishable",
    created_by: "test",
  })
  return pk.token
}

async function bridgeHeaders(
  container: MedusaContainer,
  extra: Record<string, string> = {}
): Promise<Record<string, string>> {
  const pk = await createPublishableKey(container)
  return {
    "x-publishable-api-key": pk,
    "x-bridge-secret": BRIDGE_SECRET,
    ...DEFAULT_TENANT,
    ...extra,
  }
}

medusaIntegrationTestRunner({
  medusaConfigFile: path.resolve(process.cwd(), "integration-tests"),
  env: {
    JWT_SECRET: "supersecret",
    COOKIE_SECRET: "supersecret",
  },
  testSuite: ({ api, getContainer }) => {
    describe("POST /store/saas/ensure-customer", () => {
      it("creates a customer and returns the pinned { customer: { id, email } } body", async () => {
        const container = getContainer()
        const headers = await bridgeHeaders(container)
        const email = `saas-bridge-${Date.now()}-${Math.random()}@medusa.test`

        const response = await api.post(
          "/store/saas/ensure-customer",
          { email, display_name: "Ada Lovelace" },
          { headers }
        )

        expect(response.status).toEqual(200)
        expect(Object.keys(response.data).sort()).toEqual(["customer"])
        expect(response.data.customer.id).toMatch(/^cus_/)
        expect(response.data.customer.email).toEqual(email)
        expect(Object.keys(response.data.customer).sort()).toEqual([
          "email",
          "id",
        ])
      })

      it("honors display_name as the customer first name", async () => {
        const container = getContainer()
        const headers = await bridgeHeaders(container)
        const email = `saas-bridge-name-${Date.now()}-${Math.random()}@medusa.test`

        const response = await api.post(
          "/store/saas/ensure-customer",
          { email, display_name: "Grace Hopper" },
          { headers }
        )

        expect(response.status).toEqual(200)
        const customerModule = container.resolve<any>(Modules.CUSTOMER)
        const customer = await customerModule.retrieveCustomer(
          response.data.customer.id
        )
        expect(customer.first_name).toEqual("Grace")
      })

      it("is idempotent per email — same id on repeat", async () => {
        const container = getContainer()
        const headers = await bridgeHeaders(container)
        const email = `saas-bridge-idem-${Date.now()}-${Math.random()}@medusa.test`

        const first = await api.post(
          "/store/saas/ensure-customer",
          { email },
          { headers }
        )
        const second = await api.post(
          "/store/saas/ensure-customer",
          { email },
          { headers }
        )

        expect(first.status).toEqual(200)
        expect(second.status).toEqual(200)
        expect(second.data.customer.id).toEqual(first.data.customer.id)
      })

      it("adopts an unstamped customer sharing the email instead of duplicating", async () => {
        const container = getContainer()
        const headers = await bridgeHeaders(container)
        const customerModule = container.resolve<any>(Modules.CUSTOMER)
        const email = `saas-bridge-adopt-${Date.now()}-${Math.random()}@medusa.test`

        const preExisting = await customerModule.createCustomers({
          email,
          first_name: "Pre",
        })

        const response = await api.post(
          "/store/saas/ensure-customer",
          { email, external_id: "ext-adopt-1" },
          { headers }
        )

        expect(response.status).toEqual(200)
        expect(response.data.customer.id).toEqual(preExisting.id)

        const adopted = await customerModule.retrieveCustomer(preExisting.id)
        expect(adopted.metadata?.tenant_id).toEqual("default")
        expect(adopted.metadata?.external_id).toEqual("ext-adopt-1")
      })

      it("rejects a body without external_id or a valid email with 400", async () => {
        const container = getContainer()
        const headers = await bridgeHeaders(container)

        const response = await api.post(
          "/store/saas/ensure-customer",
          { display_name: "No Contact" },
          { headers, validateStatus: () => true }
        )

        expect(response.status).toEqual(400)
      })
    })

    describe("shared-secret auth fail-closed", () => {
      it("rejects a wrong secret with 401 on every /store/saas/* route", async () => {
        const container = getContainer()
        const headers = await bridgeHeaders(container, {
          "x-bridge-secret": "wrong-secret",
        })

        for (const route of [
          "/store/saas/ensure-customer",
          "/store/saas/reconcile",
          "/store/saas/renew",
          "/store/saas/auto-renew",
          "/store/saas/carts",
          "/store/saas/redeem",
        ]) {
          const response = await api.post(
            route,
            {},
            { headers, validateStatus: () => true }
          )
          expect(response.status).toEqual(401)
        }
      })

      it("rejects a missing secret with 401", async () => {
        const container = getContainer()
        const pk = await createPublishableKey(container)

        const response = await api.post(
          "/store/saas/ensure-customer",
          { email: "nobody@medusa.test" },
          {
            headers: { "x-publishable-api-key": pk },
            validateStatus: () => true,
          }
        )

        expect(response.status).toEqual(401)
      })

      it("rejects a valid secret when no tenant id matches in multi-tenant setups", async () => {
        const container = getContainer()
        const headers = await bridgeHeaders(container, {
          "x-tenant-id": "no-such-tenant",
        })

        const response = await api.post(
          "/store/saas/ensure-customer",
          { email: `saas-bridge-${Date.now()}@medusa.test` },
          { headers, validateStatus: () => true }
        )

        expect(response.status).toEqual(401)
        expect(response.data.error).toEqual("unknown-tenant")
      })
    })
  },
})
