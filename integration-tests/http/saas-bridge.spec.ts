import { medusaIntegrationTestRunner } from "@medusajs/test-utils"
import path from "path"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import type {
  ICartModuleService,
  ILinkModuleService,
  IOrderModuleService,
  IPaymentModuleService,
  MedusaContainer,
} from "@medusajs/framework/types"
import { SUBSCRIPTION_MODULE } from "../../src/modules/subscription"
import { SubscriptionStatus } from "../../src/modules/subscription/types"
import { createSubscriptionSeed } from "../helpers/subscription-fixtures"

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

async function createTenantCustomer(
  container: MedusaContainer,
  tenantId = "default"
) {
  const customerModule = container.resolve<any>(Modules.CUSTOMER)
  return customerModule.createCustomers({
    email: `saas-bridge-${Date.now()}-${Math.random()}@medusa.test`,
    first_name: "Bridge",
    metadata: { tenant_id: tenantId },
  })
}

type SeededOrder = {
  order_id: string
  cart_id: string
  customer_id: string
  payment_collection_id: string
}

async function seedBridgeOrder(
  container: MedusaContainer,
  customer: { id: string; email: string },
  withSubscription = false
): Promise<SeededOrder> {
  const cartModule = container.resolve<ICartModuleService>(Modules.CART)
  const orderModule = container.resolve<IOrderModuleService>(Modules.ORDER)
  const paymentModule = container.resolve<IPaymentModuleService>(Modules.PAYMENT)
  const link = container.resolve<ILinkModuleService>(
    ContainerRegistrationKeys.LINK
  )

  const cart = (await cartModule.createCarts({
    currency_code: "usd",
    email: customer.email,
    customer_id: customer.id,
    metadata: {},
    shipping_address: {
      first_name: "Bridge",
      last_name: "Test",
      address_1: "1 Bridge Way",
      city: "Testville",
      postal_code: "00001",
      country_code: "us",
    },
    items: [
      {
        title: "Subscription item",
        subtitle: "Monthly plan",
        unit_price: 1800,
        quantity: 1,
        metadata: {
          is_subscription: true,
          payment_mode: "manual",
          frequency_interval: "month",
          frequency_value: 1,
        },
      } as never,
    ],
  } as never)) as unknown as { id: string }

  const paymentCollection = await paymentModule.createPaymentCollections({
    currency_code: "usd",
    amount: 1800,
  })
  await paymentModule.createPaymentSession(paymentCollection.id, {
    provider_id: "pp_system_default",
    currency_code: "usd",
    amount: 1800,
    data: {},
  } as never)

  const order = await orderModule.createOrders({
    customer_id: customer.id,
    email: customer.email,
    currency_code: "usd",
    status: "completed",
    metadata: {
      plan: "bridge-test-plan",
      email: customer.email,
      frequency_interval: "month",
    },
    items: [
      {
        title: "Subscription item",
        subtitle: "Monthly plan",
        quantity: 1,
        unit_price: 1800,
        metadata: { is_subscription: true },
      } as never,
    ],
    shipping_address: {
      first_name: "Bridge",
      last_name: "Test",
      address_1: "1 Bridge Way",
      city: "Testville",
      postal_code: "00001",
      country_code: "us",
    },
  } as never)

  const links: Record<string, Record<string, unknown>>[] = [
    {
      [Modules.ORDER]: { order_id: order.id },
      [Modules.CART]: { cart_id: cart.id },
    },
    {
      [Modules.ORDER]: { order_id: order.id },
      [Modules.PAYMENT]: { payment_collection_id: paymentCollection.id },
    },
  ]

  if (withSubscription) {
    const subscriptionModule = container.resolve<any>(SUBSCRIPTION_MODULE)
    const subscription = (await createSubscriptionSeed(container, {
      reference: `SUB-BRIDGE-${Date.now()}`,
      status: SubscriptionStatus.ACTIVE,
      customer_id: customer.id,
      cart_id: cart.id,
      payment_context: {
        payment_provider_id: "pp_system_default",
        payment_mode: "manual",
        payment_method_reference: null,
      } as never,
    })) as unknown as { id: string }

    await subscriptionModule.updateSubscriptions({
      id: subscription.id,
      metadata: { source_order_id: order.id },
    } as never)

    links.push({
      [SUBSCRIPTION_MODULE]: { subscription_id: subscription.id },
      [Modules.ORDER]: { order_id: order.id },
    })
  }

  await link.create(links as never)

  return {
    order_id: (order as unknown as { id: string }).id,
    cart_id: cart.id,
    customer_id: customer.id,
    payment_collection_id: paymentCollection.id,
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

    describe("POST /store/saas/reconcile — order snapshot", () => {
      it("returns the pinned camelCase order snapshot", async () => {
        const container = getContainer()
        const headers = await bridgeHeaders(container)
        const customer = await createTenantCustomer(container)
        const seed = await seedBridgeOrder(container, customer, true)

        const response = await api.post(
          "/store/saas/reconcile",
          { order_id: seed.order_id },
          { headers }
        )

        expect(response.status).toEqual(200)
        expect(Object.keys(response.data).sort()).toEqual(["order"])

        const order = response.data.order
        expect(Object.keys(order).sort()).toEqual([
          "cart",
          "cartId",
          "currencyCode",
          "customerId",
          "metadata",
          "orderId",
          "paymentStatus",
          "subscriptionId",
          "total",
        ])
        expect(order.orderId).toEqual(seed.order_id)
        // a created-but-unconfirmed session maps onto the legacy
        // order.payment_status vocabulary as "pending"
        expect(order.paymentStatus).toEqual("pending")
        expect(order.currencyCode).toEqual("usd")
        expect(order.total).toEqual(expect.any(Number))
        expect(order.customerId).toEqual(customer.id)
        expect(order.cartId).toEqual(seed.cart_id)
        expect(order.subscriptionId).toEqual(expect.any(String))
        expect(order.metadata.plan).toEqual("bridge-test-plan")
        expect(order.metadata.email).toEqual(customer.email)
        expect(order.metadata.frequency_interval).toEqual("month")
        expect(order.cart.currency_code).toEqual("usd")
        expect(order.cart.items[0].unit_price).toEqual(1800)
        expect(order.cart.items[0].quantity).toEqual(1)
      })

      it("404s a foreign-tenant order without leaking existence", async () => {
        const container = getContainer()
        const headers = await bridgeHeaders(container)
        const foreignCustomer = await createTenantCustomer(
          container,
          "another-tenant"
        )
        const seed = await seedBridgeOrder(container, foreignCustomer, false)

        const response = await api.post(
          "/store/saas/reconcile",
          { order_id: seed.order_id },
          { headers, validateStatus: () => true }
        )

        expect(response.status).toEqual(404)
      })
    })

    describe("POST /store/saas/reconcile — subscription snapshot", () => {
      it("returns the pinned subscription snapshot fields", async () => {
        const container = getContainer()
        const headers = await bridgeHeaders(container)
        const customer = await createTenantCustomer(container)
        const seed = await seedBridgeOrder(container, customer, true)

        const orderResponse = await api.post(
          "/store/saas/reconcile",
          { order_id: seed.order_id },
          { headers }
        )
        const subscriptionId = orderResponse.data.order.subscriptionId

        const response = await api.post(
          "/store/saas/reconcile",
          { subscription_id: subscriptionId },
          { headers }
        )

        expect(response.status).toEqual(200)
        expect(Object.keys(response.data).sort()).toEqual(["subscription"])

        const subscription = response.data.subscription
        expect(Object.keys(subscription).sort()).toEqual([
          "cancelEffectiveAt",
          "frequencyInterval",
          "frequencyValue",
          "hasPaymentMethod",
          "id",
          "nextRenewalAt",
          "orderId",
          "paymentMode",
          "reference",
          "status",
        ])
        expect(subscription.id).toEqual(subscriptionId)
        expect(subscription.status).toEqual("active")
        expect(subscription.frequencyInterval).toEqual("month")
        expect(subscription.frequencyValue).toEqual(1)
        expect(subscription.nextRenewalAt).toEqual(expect.any(String))
        expect(subscription.cancelEffectiveAt).toEqual(null)
        expect(subscription.paymentMode).toEqual("manual")
        expect(subscription.hasPaymentMethod).toEqual(false)
        expect(subscription.orderId).toEqual(seed.order_id)
      })

      it("lists subscriptions for a tenant customer and empties for foreign customers", async () => {
        const container = getContainer()
        const headers = await bridgeHeaders(container)
        const customer = await createTenantCustomer(container)
        await seedBridgeOrder(container, customer, true)

        const own = await api.post(
          "/store/saas/reconcile",
          { customer_id: customer.id },
          { headers }
        )
        expect(own.status).toEqual(200)
        expect(Array.isArray(own.data.subscriptions)).toEqual(true)
        expect(own.data.subscriptions.length).toEqual(1)
        expect(own.data.subscriptions[0].paymentMode).toEqual("manual")

        const foreignCustomer = await createTenantCustomer(
          container,
          "another-tenant"
        )
        const foreign = await api.post(
          "/store/saas/reconcile",
          { customer_id: foreignCustomer.id },
          { headers, validateStatus: () => true }
        )
        expect(foreign.status).toEqual(200)
        expect(foreign.data).toEqual({ subscriptions: [] })
      })

      it("rejects a body with camelCase keys (snake_case enforced) with 400", async () => {
        const container = getContainer()
        const headers = await bridgeHeaders(container)

        const response = await api.post(
          "/store/saas/reconcile",
          { orderId: "order_123" },
          { headers, validateStatus: () => true }
        )

        expect(response.status).toEqual(400)
      })
    })

    describe("POST /store/saas/renew", () => {
      async function seedManualSubscriptionForBridge(
        container: MedusaContainer,
        customer: { id: string; email: string }
      ): Promise<string> {
        const cartModule = container.resolve<ICartModuleService>(Modules.CART)
        const regionModule = container.resolve<any>(Modules.REGION)
        const region = await regionModule.createRegions({
          name: `US-${Date.now()}`,
          currency_code: "usd",
        } as never)

        const cart = (await cartModule.createCarts({
          currency_code: "usd",
          email: customer.email,
          customer_id: customer.id,
          region_id: region.id,
          metadata: {},
          items: [
            {
              title: "Subscription renewal",
              subtitle: "Monthly plan",
              unit_price: 1800,
              quantity: 1,
              requires_shipping: false,
            } as never,
          ],
          shipping_address: {
            first_name: "Manual",
            last_name: "Renewal",
            address_1: "1 Renewal Way",
            city: "Testville",
            postal_code: "00001",
            country_code: "us",
          },
        } as never)) as unknown as { id: string }

        const subscription = (await createSubscriptionSeed(container, {
          reference: `SUB-BRIDGE-RENEW-${Date.now()}`,
          status: SubscriptionStatus.ACTIVE,
          customer_id: customer.id,
          cart_id: cart.id,
          next_renewal_at: new Date(),
          payment_context: {
            payment_provider_id: "pp_system_default",
            payment_mode: "manual",
            source_payment_collection_id: "paycol_manual",
            source_payment_session_id: "payses_manual",
            payment_method_reference: null,
            customer_payment_reference: null,
          } as never,
        })) as unknown as { id: string }

        return subscription.id
      }

      it("returns { order_id, redirect_url, total, currency_code, reused }", async () => {
        const container = getContainer()
        const headers = await bridgeHeaders(container)
        const customer = await createTenantCustomer(container)
        const subscriptionId = await seedManualSubscriptionForBridge(
          container,
          customer
        )

        const first = await api.post(
          "/store/saas/renew",
          { subscription_id: subscriptionId },
          { headers }
        )

        expect(first.status).toEqual(200)
        expect(Object.keys(first.data).sort()).toEqual([
          "currency_code",
          "order_id",
          "redirect_url",
          "reused",
          "total",
        ])
        expect(first.data.order_id).toEqual(expect.any(String))
        expect(first.data.order_id).not.toEqual("")
        // pp_system_default produces no cashier redirect — nullable by contract
        expect(first.data.redirect_url).toEqual(null)
        expect(first.data.currency_code).toEqual("usd")
        expect(first.data.total).toBeGreaterThan(0)
        expect(first.data.reused).toEqual(false)

        const second = await api.post(
          "/store/saas/renew",
          { subscription_id: subscriptionId },
          { headers }
        )
        expect(second.status).toEqual(200)
        expect(second.data.order_id).toEqual(first.data.order_id)
        expect(second.data.reused).toEqual(true)
      })

      it("404s a foreign-tenant subscription without leaking existence", async () => {
        const container = getContainer()
        const headers = await bridgeHeaders(container)
        const foreignCustomer = await createTenantCustomer(
          container,
          "another-tenant"
        )
        const subscriptionId = await seedManualSubscriptionForBridge(
          container,
          foreignCustomer
        )

        const response = await api.post(
          "/store/saas/renew",
          { subscription_id: subscriptionId },
          { headers, validateStatus: () => true }
        )

        expect(response.status).toEqual(404)
      })
    })
  },
})
