import { medusaIntegrationTestRunner } from "@medusajs/test-utils"
import path from "path"
import {
  ContainerRegistrationKeys,
  MedusaError,
  Modules,
} from "@medusajs/framework/utils"
import type {
  ICartModuleService,
  ILinkModuleService,
  IOrderModuleService,
  IPaymentModuleService,
  MedusaContainer,
} from "@medusajs/framework/types"
import { SUBSCRIPTION_MODULE } from "../../src/modules/subscription"
import type SubscriptionModuleService from "../../src/modules/subscription/service"
import { SubscriptionStatus } from "../../src/modules/subscription/types"
import { RENEWAL_MODULE } from "../../src/modules/renewal"
import type RenewalModuleService from "../../src/modules/renewal/service"
import { RenewalCycleStatus } from "../../src/modules/renewal/types"
import { REDEMPTION_MODULE } from "../../src/modules/redemption"
import type RedemptionModuleService from "../../src/modules/redemption/service"
import { SAAS_BRIDGE_TENANT_KEY } from "../../src/modules/saas-bridge/auth"
import type { SaasBridgeTenantConfig } from "../../src/modules/saas-bridge/types"
import { POST as postRenew } from "../../src/api/store/saas/renew/route"
import { createSubscriptionSeed } from "../helpers/subscription-fixtures"
import {
  createCustomer,
  createProductWithVariant,
} from "../helpers/subscription-fixtures"
import { createRenewalCycleSeed } from "../helpers/renewal-fixtures"
import { createPlanOfferSeed } from "../helpers/plan-offer-fixtures"
import { createRedemptionBatch } from "../helpers/redemption-fixtures"

jest.setTimeout(120 * 1000)

/**
 * The seam for the one documented `/store/saas/renew` outcome a real run cannot
 * produce: a workflow that reports neither an error nor a usable result. Every
 * path of `create-manual-renewal` either returns an order id or throws, so the
 * route's guard for that third case can only be pinned against a stub. What this
 * replaces is the `src` copy — the copy `postRenew` below calls directly — and
 * nothing else in the file: every other renew case goes over HTTP, which the
 * plugin's compiled copy serves.
 */
let mockRenewRunOutcome: { result: unknown; errors: unknown } | undefined

jest.mock("../../src/workflows/create-manual-renewal", () => {
  // Only `run` is stubbed. The refusal declarations stay the real ones so the
  // multi-error `errors[0]` case, which drives this handler directly, classifies
  // against the same list the route ships with rather than a restated copy.
  const actual = jest.requireActual(
    "../../src/workflows/create-manual-renewal"
  ) as {
    RENEW_CUSTOMER_REFUSALS: readonly {
      step: string
      type: string
      copy: RegExp
    }[]
  }

  return {
    __esModule: true,
    RENEW_CUSTOMER_REFUSALS: actual.RENEW_CUSTOMER_REFUSALS,
    createManualRenewalWorkflow: () => ({
      // The branch pinned below never consults the inventory; a failure the
      // workflow *reports* is pinned through real HTTP in this same file.
      run: async () => mockRenewRunOutcome,
    }),
  }
})

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
  tenantId: string | null = "default"
) {
  const customerModule = container.resolve<any>(Modules.CUSTOMER)
  return customerModule.createCustomers({
    email: `saas-bridge-${Date.now()}-${Math.random()}@medusa.test`,
    first_name: "Bridge",
    metadata: tenantId === null ? {} : { tenant_id: tenantId },
  })
}

/**
 * The customer read `POST /store/saas/redeem` performs in its own handler,
 * typed the way the route types it — a case below stands this one read up
 * against the step's, so that a row can be visible to the caller and gone by
 * the time `resolve-redemption-code` queries it.
 */
type BridgeCustomerRead = {
  retrieveCustomer: (
    id: string,
    config?: Record<string, unknown>
  ) => Promise<{ id: string; metadata?: Record<string, unknown> | null }>
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

      it("lists subscriptions for a tenant customer and 404s for foreign customers", async () => {
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
        // Not an empty list: that is also what a customer with no subscriptions
        // gets, so it would hide "you may not see this customer".
        expect(foreign.status).toEqual(404)
      })

      it("treats an unstamped customer as this tenant's on a single-tenant host", async () => {
        const container = getContainer()
        const headers = await bridgeHeaders(container)
        const customer = await createTenantCustomer(container, null)
        await seedBridgeOrder(container, customer, true)

        const response = await api.post(
          "/store/saas/reconcile",
          { customer_id: customer.id },
          { headers, validateStatus: () => true }
        )

        expect(response.status).toEqual(200)
        expect(response.data.subscriptions.length).toEqual(1)
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
        customer: { id: string; email: string },
        overrides: {
          reference?: string
          status?: SubscriptionStatus
          payment_mode?: string
        } = {}
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
          reference:
            overrides.reference ?? `SUB-BRIDGE-RENEW-${Date.now()}`,
          status: overrides.status ?? SubscriptionStatus.ACTIVE,
          customer_id: customer.id,
          cart_id: cart.id,
          next_renewal_at: new Date(),
          payment_context: {
            payment_provider_id: "pp_system_default",
            payment_mode: overrides.payment_mode ?? "manual",
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

      it("answers each declared refusal with 400 and that refusal's own copy", async () => {
        const container = getContainer()
        const headers = await bridgeHeaders(container)
        const customer = await createTenantCustomer(container)
        const stamp = Date.now()

        // `/renew` runs its policy inside the same step that later calls the
        // core order and payment workflows, so a refusal may be repeated only
        // when the workflow declared its exact text — and what it repeats is the
        // plugin's own customer copy, at 400. The whole sentence is asserted, not
        // a tail of it: a fragment would still match after the message was
        // reworded, and a reworded message is precisely what stops being
        // declared copy (it would degrade to the route's generic text).
        const refusals = [
          {
            overrides: { reference: `NATIVE-BRIDGE-${stamp}` },
            copy: (id: string) =>
              `Subscription '${id}' is a mirror of a PayPal-managed recurrence and cannot be renewed here`,
          },
          {
            overrides: { payment_mode: "auto" },
            copy: (id: string) =>
              `Subscription '${id}' is not in manual payment mode; use the standard renewal flow`,
          },
          {
            overrides: { status: SubscriptionStatus.PAST_DUE },
            copy: (id: string) =>
              `Subscription '${id}' is 'past_due'; only active subscriptions can be manually renewed`,
          },
        ]

        for (const refusal of refusals) {
          const subscriptionId = await seedManualSubscriptionForBridge(
            container,
            customer,
            refusal.overrides
          )

          const response = await api.post(
            "/store/saas/renew",
            { subscription_id: subscriptionId },
            { headers, validateStatus: () => true }
          )

          expect(response.status).toEqual(400)
          expect(response.data).toMatchObject({ type: "invalid_data" })
          expect(String(response.data?.message)).toEqual(
            refusal.copy(subscriptionId)
          )
        }
      })

      it("keeps a non-refusal conflict a 409 and leaks no cycle id", async () => {
        const container = getContainer()
        const headers = await bridgeHeaders(container)
        const customer = await createTenantCustomer(container)
        const subscriptionId = await seedManualSubscriptionForBridge(
          container,
          customer
        )

        // The state the renewal step's compensation leaves behind: a PROCESSING
        // cycle with no order. The step refuses with `alreadyProcessing`
        // (a `conflict`), which used to be rewrapped as a permanent 400 and now
        // keeps its retryable 409.
        const cycle = await createRenewalCycleSeed(container, {
          subscription_id: subscriptionId,
          status: RenewalCycleStatus.PROCESSING,
          generated_order_id: null,
        })

        const response = await api.post(
          "/store/saas/renew",
          { subscription_id: subscriptionId },
          { headers, validateStatus: () => true }
        )

        expect(response.status).not.toEqual(400)
        expect(response.status).toEqual(409)
        expect(JSON.stringify(response.data ?? {})).not.toContain(cycle.id)
      })

      it("keeps a non-refusal MedusaError's status and answers with its own text", async () => {
        const container = getContainer()
        const headers = await bridgeHeaders(container)
        const customer = await createTenantCustomer(container)
        const subscriptionId = await seedManualSubscriptionForBridge(
          container,
          customer
        )
        const stamp = Date.now()

        // A `MedusaError` that is not one of the declared refusals — here the
        // shape `dbErrorMapper` produces, whose message names a column — keeps
        // the status it was thrown with, but the body carries the route's own
        // wording.
        const renewalModule =
          container.resolve<RenewalModuleService>(RENEWAL_MODULE)
        const cycleSpy = jest
          .spyOn(renewalModule, "createRenewalCycles")
          .mockRejectedValue(
            new MedusaError(
              MedusaError.Types.INVALID_DATA,
              `Cannot set field 'generated_order_id' of Subscription renewal cycle to null internal-detail-${stamp}`
            )
          )

        const response = await api.post(
          "/store/saas/renew",
          { subscription_id: subscriptionId },
          { headers, validateStatus: () => true }
        )

        cycleSpy.mockRestore()

        expect(response.status).toEqual(400)
        expect(String(response.data?.message)).toEqual(
          "manual renewal was refused"
        )
        expect(JSON.stringify(response.data ?? {})).not.toContain(
          "generated_order_id"
        )
        expect(JSON.stringify(response.data ?? {})).not.toContain(
          `internal-detail-${stamp}`
        )
      })

      it("keeps a serialized Postgres fault a 500 and out of the response body", async () => {
        const container = getContainer()
        const headers = await bridgeHeaders(container)
        const customer = await createTenantCustomer(container)
        const subscriptionId = await seedManualSubscriptionForBridge(
          container,
          customer
        )
        const stamp = Date.now()

        const table = `renewal_canary_table_${stamp}`
        const detail = `Key (id)=(canary-value-${stamp}) already exists.`
        const driverFault = new Error(
          'duplicate key value violates unique constraint "renewal_canary_pkey"'
        ) as Error & { code: string; table: string; detail: string }
        driverFault.code = "23505"
        driverFault.table = table
        driverFault.detail = detail

        const renewalModule =
          container.resolve<RenewalModuleService>(RENEWAL_MODULE)
        const cycleSpy = jest
          .spyOn(renewalModule, "createRenewalCycles")
          .mockRejectedValue(driverFault)

        const response = await api.post(
          "/store/saas/renew",
          { subscription_id: subscriptionId },
          { headers, validateStatus: () => true }
        )

        cycleSpy.mockRestore()

        // Rethrowing the deserialized value would have let `formatException`
        // map its `code` to a 422 carrying `table` and `detail`.
        expect(response.status).not.toEqual(400)
        expect(response.status).not.toEqual(422)
        expect(response.status).toEqual(500)

        const body = JSON.stringify(response.data ?? {})
        expect(body).not.toContain(table)
        expect(body).not.toContain(detail)
        expect(body).not.toContain("canary-value-")
        expect(body).not.toContain("23505")
      })

      it("answers a vanished row 404 with its own text, not the step's 400", async () => {
        const container = getContainer()
        const subscriptionModule = container.resolve<SubscriptionModuleService>(
          SUBSCRIPTION_MODULE
        )
        const headers = await bridgeHeaders(container)
        const customer = await createTenantCustomer(container)
        const subscriptionId = await seedManualSubscriptionForBridge(
          container,
          customer
        )

        // The race this route documents: the handler has already seen the row,
        // so by the time the step reads it the subscription is gone and the step
        // refuses with its own `not_found` (`Subscription '<id>' was not found`).
        // That is not a declared refusal — before the disclosure rule it was
        // rewrapped as a 400 quoting the id, and now it keeps the status a
        // missing resource has always meant here while the wording becomes the
        // route's. First read is the handler's, second is the step's.
        const listSubscriptions = subscriptionModule.listSubscriptions.bind(
          subscriptionModule
        )
        let reads = 0
        const listSpy = jest
          .spyOn(subscriptionModule, "listSubscriptions")
          .mockImplementation(async (...args) =>
            reads++ === 0 ? listSubscriptions(...args) : []
          )

        const response = await api.post(
          "/store/saas/renew",
          { subscription_id: subscriptionId },
          { headers, validateStatus: () => true }
        )

        listSpy.mockRestore()

        expect(response.status).not.toEqual(400)
        expect(response.status).toEqual(404)
        expect(String(response.data?.message)).toEqual(
          "subscription not found"
        )
        expect(JSON.stringify(response.data ?? {})).not.toContain(
          subscriptionId
        )
        expect(JSON.stringify(response.data ?? {})).not.toContain(
          "was not found"
        )

        // The refusal happens before anything is written.
        const [row] = await subscriptionModule.listSubscriptions({
          id: [subscriptionId],
        })

        expect(row.payment_context).toMatchObject({ payment_mode: "manual" })
      })

      it("answers 500 with its own text when the workflow reports no result", async () => {
        const container = getContainer()
        const customer = await createTenantCustomer(container)
        const subscriptionId = await seedManualSubscriptionForBridge(
          container,
          customer
        )

        // The third outcome a `throwOnError: false` run can have, and the one no
        // real run of this workflow produces: neither an error nor a usable
        // result (every path of `create-manual-renewal` either returns an order
        // id or throws). The route must not answer 200 with a body of undefined
        // fields, so that guard is pinned against the stubbed workflow declared
        // at the top of this file, driven through the handler itself.
        // `unexpected_state` is core's 500 — a mapping already pinned over HTTP
        // by the Postgres-fault case above.
        mockRenewRunOutcome = { result: undefined, errors: undefined }

        // What the bridge auth middleware attaches to the request scope; the
        // handler reads it through `currentTenant(req)`.
        const scope = container as unknown as Record<string, unknown>
        const tenant: SaasBridgeTenantConfig = {
          tenant_id: "default",
          shared_secret: BRIDGE_SECRET,
        }
        scope[SAAS_BRIDGE_TENANT_KEY] = tenant

        let payload: unknown
        const request = {
          body: { subscription_id: subscriptionId },
          scope: container,
        } as unknown as Parameters<typeof postRenew>[0]
        const response = {
          json: (body: unknown) => {
            payload = body
          },
        } as unknown as Parameters<typeof postRenew>[1]

        try {
          await expect(postRenew(request, response)).rejects.toMatchObject({
            type: MedusaError.Types.UNEXPECTED_STATE,
            message: "manual renewal failed",
          })
        } finally {
          delete scope[SAAS_BRIDGE_TENANT_KEY]
          mockRenewRunOutcome = undefined
        }

        expect(payload).toBeUndefined()
      })
    })

    describe("POST /store/saas/auto-renew", () => {
      async function seedToggleSubscription(
        container: MedusaContainer,
        customer: { id: string }
      ): Promise<string> {
        const subscription = (await createSubscriptionSeed(container, {
          reference: `SUB-BRIDGE-TOGGLE-${Date.now()}`,
          status: SubscriptionStatus.ACTIVE,
          customer_id: customer.id,
          payment_context: {
            payment_provider_id: "pp_system_default",
            payment_mode: "manual",
            payment_method_reference: null,
          } as never,
        })) as unknown as { id: string }
        return subscription.id
      }

      it("toggles to auto and back with the strict { subscription_id, payment_mode } body", async () => {
        const container = getContainer()
        const headers = await bridgeHeaders(container)
        const customer = await createTenantCustomer(container)
        const subscriptionId = await seedToggleSubscription(
          container,
          customer
        )

        const enable = await api.post(
          "/store/saas/auto-renew",
          { subscription_id: subscriptionId, enabled: true },
          { headers }
        )
        expect(enable.status).toEqual(200)
        expect(enable.data).toEqual({
          subscription_id: subscriptionId,
          payment_mode: "auto",
        })

        const stored = await container
          .resolve<any>(SUBSCRIPTION_MODULE)
          .retrieveSubscription(subscriptionId)
        expect(stored.payment_context.payment_mode).toEqual("auto")

        const disable = await api.post(
          "/store/saas/auto-renew",
          { subscription_id: subscriptionId, enabled: false },
          { headers }
        )
        expect(disable.status).toEqual(200)
        expect(disable.data).toEqual({
          subscription_id: subscriptionId,
          payment_mode: "manual",
        })
      })

      it("400s a non-boolean enabled", async () => {
        const container = getContainer()
        const headers = await bridgeHeaders(container)
        const customer = await createTenantCustomer(container)
        const subscriptionId = await seedToggleSubscription(
          container,
          customer
        )

        const response = await api.post(
          "/store/saas/auto-renew",
          { subscription_id: subscriptionId, enabled: "yes" },
          { headers, validateStatus: () => true }
        )

        expect(response.status).toEqual(400)
      })

      it("404s a foreign-tenant subscription without leaking existence", async () => {
        const container = getContainer()
        const headers = await bridgeHeaders(container)
        const foreignCustomer = await createTenantCustomer(
          container,
          "another-tenant"
        )
        const subscriptionId = await seedToggleSubscription(
          container,
          foreignCustomer
        )

        const response = await api.post(
          "/store/saas/auto-renew",
          { subscription_id: subscriptionId, enabled: true },
          { headers, validateStatus: () => true }
        )

        expect(response.status).toEqual(404)
      })
    })

    describe("POST /store/saas/carts", () => {
      async function seedRegionAndVariant(container: MedusaContainer) {
        const regionModule = container.resolve<any>(Modules.REGION)
        const region = await regionModule.createRegions({
          name: `USD-${Date.now()}`,
          currency_code: "usd",
          countries: ["us"],
        } as never)
        const { product, variant } = await createProductWithVariant(container)

        // cart creation validates published products — the shared helper
        // seeds drafts, so publish before checkout
        const productModule = container.resolve<any>(Modules.PRODUCT)
        await productModule.updateProducts(product.id, {
          status: "published",
        })

        // cart creation resolves the variant price — seed a price set and
        // link it to the variant
        const pricingModule = container.resolve<any>(Modules.PRICING)
        const priceSet = await pricingModule.createPriceSets({
          prices: [{ amount: 1800, currency_code: "usd" }],
        })
        const link = container.resolve<ILinkModuleService>(
          ContainerRegistrationKeys.LINK
        )
        await link.create({
          [Modules.PRODUCT]: { variant_id: variant.id },
          [Modules.PRICING]: { price_set_id: priceSet.id },
        } as never)

        return { region: region as { id: string }, variant }
      }

      it("creates a customer-attached cart with the load-bearing placeholder address", async () => {
        const container = getContainer()
        const headers = await bridgeHeaders(container)
        const customer = await createTenantCustomer(container)
        const { region, variant } = await seedRegionAndVariant(container)

        const response = await api.post(
          "/store/saas/carts",
          {
            customer_id: customer.id,
            currency_code: "usd",
            variant_id: variant.id,
          },
          { headers }
        )

        expect(response.status).toEqual(200)
        expect(Object.keys(response.data).sort()).toEqual([
          "cart_id",
          "currency_code",
          "customer_id",
          "email",
        ])
        expect(response.data.cart_id).toMatch(/^cart_/)
        expect(response.data.currency_code).toEqual("usd")
        expect(response.data.customer_id).toEqual(customer.id)
        expect(response.data.email).toEqual(customer.email)

        // defaults: month / 1
        const cartModule = container.resolve<any>(Modules.CART)
        const cart = await cartModule.retrieveCart(response.data.cart_id, {
          relations: ["items", "shipping_address"],
        } as never)
        expect(cart.shipping_address.postal_code).toEqual("00000")
        expect(cart.shipping_address.country_code).toEqual("cn")
        expect(cart.shipping_address.first_name).toEqual("Digital")
        expect(cart.shipping_address.last_name).toEqual("Delivery")
        expect(cart.customer_id).toEqual(customer.id)
        const item = cart.items[0]
        expect(item.variant_id).toEqual(variant.id)
        expect(item.metadata.is_subscription).toEqual(true)
        expect(item.metadata.payment_mode).toEqual("manual")
        expect(item.metadata.frequency_interval).toEqual("month")
        expect(item.metadata.frequency_value).toEqual(1)

        void region
      })

      it("honors explicit frequency_interval and frequency_value", async () => {
        const container = getContainer()
        const headers = await bridgeHeaders(container)
        const customer = await createTenantCustomer(container)
        const { region, variant } = await seedRegionAndVariant(container)

        const response = await api.post(
          "/store/saas/carts",
          {
            customer_id: customer.id,
            currency_code: "usd",
            variant_id: variant.id,
            frequency_interval: "week",
            frequency_value: 2,
          },
          { headers }
        )

        expect(response.status).toEqual(200)

        const cartModule = container.resolve<any>(Modules.CART)
        const cart = await cartModule.retrieveCart(response.data.cart_id, {
          relations: ["items", "shipping_address"],
        } as never)
        expect(cart.items[0].metadata.frequency_interval).toEqual("week")
        expect(cart.items[0].metadata.frequency_value).toEqual(2)

        void region
      })

      it("404s a foreign-tenant customer without leaking existence", async () => {
        const container = getContainer()
        const headers = await bridgeHeaders(container)
        const foreignCustomer = await createTenantCustomer(
          container,
          "another-tenant"
        )
        const { variant } = await seedRegionAndVariant(container)

        const response = await api.post(
          "/store/saas/carts",
          {
            customer_id: foreignCustomer.id,
            currency_code: "usd",
            variant_id: variant.id,
          },
          { headers, validateStatus: () => true }
        )

        expect(response.status).toEqual(404)
      })
    })

    describe("POST /store/saas/redeem", () => {
      async function seedRedeemableCode(
        container: MedusaContainer,
        batchOverrides: { expires_at?: Date } = {}
      ): Promise<{ code: string; variant_id: string }> {
        const { product, variant } = await createProductWithVariant(container)
        await createPlanOfferSeed(container, {
          name: `BRIDGE-REDEEM-OFFER-${Date.now()}`,
          scope: "variant",
          product_id: product.id,
          variant_id: variant.id,
          allowed_frequencies: [{ interval: "month", value: 1 }],
        })
        const batch = await createRedemptionBatch(container, {
          name: `BRIDGE-REDEEM-BATCH-${Date.now()}`,
          variant_id: variant.id,
          free_cycles: 2,
          max_redemptions_per_code: 3,
          generated_code_count: 1,
          ...batchOverrides,
        })
        return { code: batch.codes[0].code, variant_id: variant.id }
      }

      it("redeems into a payment-free subscription with the pinned body", async () => {
        const container = getContainer()
        const headers = await bridgeHeaders(container)
        const customer = await createTenantCustomer(container)
        const { code } = await seedRedeemableCode(container)

        const response = await api.post(
          "/store/saas/redeem",
          { code, customer_id: customer.id },
          { headers }
        )

        expect(response.status).toEqual(200)
        expect(Object.keys(response.data).sort()).toEqual([
          "dunning_recovered",
          "free_cycles_remaining",
          // additive since the plan-offer trial rules landed: the created
          // subscription's trial state, mirrored for the SaaS entitlement
          "is_trial",
          "outcome",
          "redemption_record_id",
          "subscription_id",
          "subscription_reference",
          "trial_ends_at",
        ])
        expect(response.data.subscription_id).toEqual(expect.any(String))
        expect(response.data.subscription_reference).toEqual(
          expect.any(String)
        )
        expect(response.data.redemption_record_id).toEqual(expect.any(String))
        expect(response.data.outcome).toEqual("subscription_created")
        // the workflow's create branch carries no free_cycles_remaining —
        // only the extend branch does; the bridge surfaced the same null
        expect(response.data.free_cycles_remaining).toEqual(null)
        expect(response.data.dunning_recovered).toEqual(false)
        // no trial rule on this batch → non-trial grant
        expect(response.data.is_trial).toEqual(false)
        expect(response.data.trial_ends_at).toEqual(null)
      })

      it("enforces per-customer dedup on a second redeem with the same code", async () => {
        const container = getContainer()
        const headers = await bridgeHeaders(container)
        const customer = await createTenantCustomer(container)
        const { code } = await seedRedeemableCode(container)

        const first = await api.post(
          "/store/saas/redeem",
          { code, customer_id: customer.id },
          { headers }
        )
        expect(first.status).toEqual(200)

        const second = await api.post(
          "/store/saas/redeem",
          { code, customer_id: customer.id },
          { headers, validateStatus: () => true }
        )
        expect(second.status).toEqual(400)
      })

      it("404s a foreign-tenant customer without leaking existence", async () => {
        const container = getContainer()
        const headers = await bridgeHeaders(container)
        const foreignCustomer = await createTenantCustomer(
          container,
          "another-tenant"
        )
        const { code } = await seedRedeemableCode(container)

        const response = await api.post(
          "/store/saas/redeem",
          { code, customer_id: foreignCustomer.id },
          { headers, validateStatus: () => true }
        )

        expect(response.status).toEqual(404)
      })

      it("answers a customer that vanished after this handler saw it with its own refusal, and no variant id", async () => {
        const container = getContainer()
        const headers = await bridgeHeaders(container)
        const { code, variant_id } = await seedRedeemableCode(container)
        const vanishedCustomerId = `cus_vanished_${Date.now()}`

        // The race the renew route documents at its own vanished-row case, and
        // the only way this route's customer read and the step's can disagree:
        // the handler has already seen the row, so by the time
        // `resolve-redemption-code` queries the customer it is gone. An id that
        // never existed is answered by this handler's own `retrieveCustomer`
        // (404, core's wording) before the workflow runs, so it cannot reach
        // the step either.
        const customerModule = container.resolve<BridgeCustomerRead>(
          Modules.CUSTOMER
        )
        const readSpy = jest
          .spyOn(customerModule, "retrieveCustomer")
          .mockImplementation(async () => ({
            id: vanishedCustomerId,
            metadata: { tenant_id: "default" },
          }))

        const response = await api.post(
          "/store/saas/redeem",
          { code, customer_id: vanishedCustomerId },
          { headers, validateStatus: () => true }
        )

        readSpy.mockRestore()

        // A declared refusal answers 400 here — the status the bridge promise
        // gives every refusal — but it now states the true reason, and the
        // variant id the previous wording interpolated is out of the body.
        expect(response.status).toEqual(400)
        expect(String(response.data?.message)).toEqual(
          `Redemption customer ${vanishedCustomerId} not found`
        )

        const body = JSON.stringify(response.data ?? {})
        expect(body).not.toContain(variant_id)
        expect(body).not.toContain("variant")
        expect(body).not.toContain("active subscription")
      })

      it("answers each declared refusal with 400 and that refusal's own copy", async () => {
        const container = getContainer()
        const headers = await bridgeHeaders(container)
        const customer = await createTenantCustomer(container)
        const stamp = Date.now()

        // An unknown code is refused as `not_found` by the workflow, and the
        // bridge contract answers it as the 400 it has always answered: the
        // route repeats the refusal's own words at a 400, it does not forward
        // its status. An undeclared refusal would fall to the disclosure rule
        // and answer 404 with generic text, which is what this case catches.
        // Both messages are asserted in full, because a tail fragment would keep
        // passing after a rewording that no longer matches any declared copy.
        const refusals: {
          code: string | null
          expires_at?: Date
          copy: (seededCode: string) => string
        }[] = [
          {
            code: `NOSUCH-BRIDGE-${stamp}`,
            copy: () => `Redemption code "NOSUCH-BRIDGE-${stamp}" is invalid`,
          },
          {
            // window closed → `outsideWindow`, which interpolates the code
            // string, not its id (`steps/redeem-redemption-code.ts:116`)
            code: null,
            expires_at: new Date(Date.now() - 60 * 1000),
            copy: (seededCode) =>
              `Redemption code ${seededCode} is outside its validity window`,
          },
        ]

        for (const refusal of refusals) {
          const seeded = await seedRedeemableCode(
            container,
            refusal.expires_at ? { expires_at: refusal.expires_at } : {}
          )

          const response = await api.post(
            "/store/saas/redeem",
            {
              code: refusal.code ?? seeded.code,
              customer_id: customer.id,
            },
            { headers, validateStatus: () => true }
          )

          expect(response.status).toEqual(400)
          expect(response.data).toMatchObject({ type: "invalid_data" })
          expect(String(response.data?.message)).toEqual(
            refusal.copy(seeded.code)
          )
        }
      })

      it("never quotes a MedusaError that is not one of its declared refusals", async () => {
        const container = getContainer()
        const headers = await bridgeHeaders(container)
        const customer = await createTenantCustomer(container)
        const { code } = await seedRedeemableCode(container)
        const stamp = Date.now()

        // The failure surfaces *inside* the declared step, so the step's name
        // alone cannot tell it apart from a refusal: only the declared exact
        // text can. This one carries a column name, and the previous
        // implementation quoted it to the customer as a 400.
        const redemptionModule =
          container.resolve<RedemptionModuleService>(REDEMPTION_MODULE)
        const listSpy = jest
          .spyOn(redemptionModule, "listRedemptionCodes")
          .mockRejectedValue(
            new MedusaError(
              MedusaError.Types.INVALID_DATA,
              `column redemption_code.redemption_cont does not exist internal-detail-${stamp}`
            )
          )

        const response = await api.post(
          "/store/saas/redeem",
          { code, customer_id: customer.id },
          { headers, validateStatus: () => true }
        )

        listSpy.mockRestore()

        expect(response.status).toEqual(400)
        expect(String(response.data?.message)).toEqual(
          "redemption was refused"
        )
        const body = JSON.stringify(response.data ?? {})
        expect(body).not.toContain("redemption_code")
        expect(body).not.toContain(`internal-detail-${stamp}`)
      })

      it("keeps a non-refusal not_found a 404 and a serialized Postgres fault a 500", async () => {
        const container = getContainer()
        const headers = await bridgeHeaders(container)
        const customer = await createTenantCustomer(container)
        const stamp = Date.now()

        const driverFault = new Error(
          'insert or update on table "redemption_canary" violates foreign key constraint'
        ) as Error & { code: string; table: string; detail: string }
        driverFault.code = "23503"
        driverFault.table = `redemption_canary_table_${stamp}`
        driverFault.detail = `Key (batch_id)=(canary-value-${stamp}) is not present in table "redemption_batch".`

        const internalFailures = [
          {
            thrown: new MedusaError(
              MedusaError.Types.NOT_FOUND,
              `Redemption batch with id: rb_canary_${stamp} was not found`
            ),
            status: 404,
            message: "redemption target not found",
            leak: `rb_canary_${stamp}`,
          },
          {
            // Same step, same slot: a driver fault is not a business rejection
            // and must not be mapped by `formatException` from its `code`.
            thrown: driverFault,
            status: 500,
            message: null,
            leak: driverFault.table,
          },
        ]

        for (const internal of internalFailures) {
          const { code } = await seedRedeemableCode(container)
          const redemptionModule = container.resolve<RedemptionModuleService>(REDEMPTION_MODULE)
          const batchSpy = jest
            .spyOn(redemptionModule, "retrieveRedemptionBatch")
            .mockRejectedValue(internal.thrown)

          const response = await api.post(
            "/store/saas/redeem",
            { code, customer_id: customer.id },
            { headers, validateStatus: () => true }
          )

          batchSpy.mockRestore()

          expect(response.status).not.toEqual(400)
          expect(response.status).not.toEqual(422)
          expect(response.status).toEqual(internal.status)

          if (internal.message !== null) {
            expect(String(response.data?.message)).toEqual(internal.message)
          }

          const body = JSON.stringify(response.data ?? {})
          expect(body).not.toContain(internal.leak)
          expect(body).not.toContain("canary-value-")
          expect(body).not.toContain("23503")
        }
      })
    })

    describe("POST /store/saas/* — a tenant-scoping read fault never quotes internals", () => {
      // Structural views of the reads the spies stand behind, typed the way the
      // routes type them so no `any`/`as never`/non-null assertion is needed at
      // the spy boundary (the resolved services are singletons, so spying the
      // container copy is what the compiled route over HTTP also calls).
      type CustomerReads = {
        retrieveCustomer: (
          id: string,
          config?: Record<string, unknown>
        ) => Promise<unknown>
        listCustomers: (
          filters: Record<string, unknown>,
          config?: Record<string, unknown>
        ) => Promise<unknown[]>
      }

      type GraphQuery = {
        entity?: string
        fields?: string[]
        filters?: Record<string, unknown>
      }
      type ScopedQuery = {
        graph: (query: GraphQuery) => Promise<{ data: unknown[] }>
      }

      // A driver-shaped fault of exactly the kind `db-error-mapper` turns an
      // undefined column into: an `invalid_data` whose message names a table and
      // column and carries a unique canary. `readTenantScoped` must replace it
      // with the route's own sentence and never quote it into the body.
      const schemaFault = (context: string, stamp: number): MedusaError =>
        new MedusaError(
          MedusaError.Types.INVALID_DATA,
          `column subscription.next_renewal__canary does not exist ${context}-${stamp}`
        )

      const expectBodyCarriesNoCanary = (
        data: unknown,
        context: string,
        stamp: number
      ): void => {
        const body = JSON.stringify(data ?? {})
        expect(body).not.toContain(`${context}-${stamp}`)
        expect(body).not.toContain("next_renewal__canary")
      }

      it("auto-renew: a subscription-list read fault answers 404 with its own text", async () => {
        const container = getContainer()
        const headers = await bridgeHeaders(container)
        const subscriptionModule = container.resolve<SubscriptionModuleService>(
          SUBSCRIPTION_MODULE
        )
        const stamp = Date.now()
        const spy = jest
          .spyOn(subscriptionModule, "listSubscriptions")
          .mockRejectedValue(schemaFault("auto-renew-canary", stamp))

        const response = await api.post(
          "/store/saas/auto-renew",
          { subscription_id: `sub_bridge_${stamp}`, enabled: true },
          { headers, validateStatus: () => true }
        )
        spy.mockRestore()

        expect(response.status).toEqual(404)
        expect(response.data).toMatchObject({ type: "not_found" })
        expect(String(response.data?.message)).toEqual("subscription not found")
        expectBodyCarriesNoCanary(response.data, "auto-renew-canary", stamp)
      })

      it("renew: a subscription-list read fault answers 404, not a bridge 400", async () => {
        const container = getContainer()
        const headers = await bridgeHeaders(container)
        const subscriptionModule = container.resolve<SubscriptionModuleService>(
          SUBSCRIPTION_MODULE
        )
        const stamp = Date.now()
        const spy = jest
          .spyOn(subscriptionModule, "listSubscriptions")
          .mockRejectedValue(schemaFault("renew-canary", stamp))

        const response = await api.post(
          "/store/saas/renew",
          { subscription_id: `sub_bridge_${stamp}` },
          { headers, validateStatus: () => true }
        )
        spy.mockRestore()

        expect(response.status).toEqual(404)
        expect(response.data).toMatchObject({ type: "not_found" })
        expect(String(response.data?.message)).toEqual("subscription not found")
        expectBodyCarriesNoCanary(response.data, "renew-canary", stamp)
      })

      it("redeem: a customer-read fault answers 404 with its own text, not core's wording", async () => {
        const container = getContainer()
        const headers = await bridgeHeaders(container)
        const customerModule = container.resolve<CustomerReads>(Modules.CUSTOMER)
        const stamp = Date.now()
        const spy = jest
          .spyOn(customerModule, "retrieveCustomer")
          .mockRejectedValue(schemaFault("redeem-read-canary", stamp))

        const response = await api.post(
          "/store/saas/redeem",
          { code: `REDEEM-${stamp}`, customer_id: `cus_bridge_${stamp}` },
          { headers, validateStatus: () => true }
        )
        spy.mockRestore()

        // The read boundary answers 404 even on this bridge route whose declared
        // refusals are forced to 400 — a failed read is not a refusal.
        expect(response.status).toEqual(404)
        expect(response.data).toMatchObject({ type: "not_found" })
        expect(String(response.data?.message)).toEqual(
          "redemption target not found"
        )
        expect(response.data?.message).not.toMatch(/was not found/)
        expectBodyCarriesNoCanary(response.data, "redeem-read-canary", stamp)
      })

      it("carts: a customer-read fault answers 404 with the tenant sentence", async () => {
        const container = getContainer()
        const headers = await bridgeHeaders(container)
        const customerModule = container.resolve<CustomerReads>(Modules.CUSTOMER)
        const stamp = Date.now()
        const spy = jest
          .spyOn(customerModule, "retrieveCustomer")
          .mockRejectedValue(schemaFault("carts-read-canary", stamp))

        const response = await api.post(
          "/store/saas/carts",
          {
            customer_id: `cus_bridge_${stamp}`,
            currency_code: "usd",
            variant_id: "var_bridge_canary",
          },
          { headers, validateStatus: () => true }
        )
        spy.mockRestore()

        expect(response.status).toEqual(404)
        expect(response.data).toMatchObject({ type: "not_found" })
        expect(String(response.data?.message)).toEqual(
          "customer not found for this tenant"
        )
        expectBodyCarriesNoCanary(response.data, "carts-read-canary", stamp)
      })

      it("carts: a region query.graph fault answers 404 while genuine absence stays 400", async () => {
        const container = getContainer()
        const headers = await bridgeHeaders(container)
        const customer = await createTenantCustomer(container)
        const query = container.resolve<ScopedQuery>(
          ContainerRegistrationKeys.QUERY
        )
        const originalGraph = query.graph.bind(query)
        const stamp = Date.now()
        const spy = jest
          .spyOn(query, "graph")
          .mockImplementation(async (q: GraphQuery) => {
            if (q.entity === "region") {
              throw schemaFault("carts-region-canary", stamp)
            }
            return originalGraph(q)
          })

        const response = await api.post(
          "/store/saas/carts",
          {
            customer_id: customer.id,
            currency_code: "usd",
            variant_id: "var_bridge_canary",
          },
          { headers, validateStatus: () => true }
        )
        spy.mockRestore()

        expect(response.status).toEqual(404)
        expect(response.data).toMatchObject({ type: "not_found" })
        expect(String(response.data?.message)).toEqual(
          "No region configured for currency 'usd'"
        )
        expectBodyCarriesNoCanary(response.data, "carts-region-canary", stamp)
      })

      it("ensure-customer: a candidate-list read fault answers the route's new 404", async () => {
        const container = getContainer()
        const headers = await bridgeHeaders(container)
        const customerModule = container.resolve<CustomerReads>(Modules.CUSTOMER)
        const stamp = Date.now()
        const spy = jest
          .spyOn(customerModule, "listCustomers")
          .mockRejectedValue(schemaFault("ensure-canary", stamp))

        const response = await api.post(
          "/store/saas/ensure-customer",
          { external_id: `ext_bridge_${stamp}` },
          { headers, validateStatus: () => true }
        )
        spy.mockRestore()

        expect(response.status).toEqual(404)
        expect(response.data).toMatchObject({ type: "not_found" })
        expect(String(response.data?.message)).toEqual(
          "customer not found for this tenant"
        )
        expectBodyCarriesNoCanary(response.data, "ensure-canary", stamp)
      })

      it("reconcile: an order query.graph response read fault answers 404 with the route's sentence", async () => {
        const container = getContainer()
        const headers = await bridgeHeaders(container)
        const query = container.resolve<ScopedQuery>(
          ContainerRegistrationKeys.QUERY
        )
        const originalGraph = query.graph.bind(query)
        const stamp = Date.now()
        const spy = jest
          .spyOn(query, "graph")
          .mockImplementation(async (q: GraphQuery) => {
            if (q.entity === "order") {
              throw schemaFault("reconcile-order-canary", stamp)
            }
            return originalGraph(q)
          })

        // A fixed order id with no stamp: the route echoes its own
        // `Order '<id>' not found`, and only the injected column message may be
        // absent from the body.
        const response = await api.post(
          "/store/saas/reconcile",
          { order_id: "order_bridge_canary" },
          { headers, validateStatus: () => true }
        )
        spy.mockRestore()

        expect(response.status).toEqual(404)
        expect(response.data).toMatchObject({ type: "not_found" })
        expect(String(response.data?.message)).toEqual(
          "Order 'order_bridge_canary' not found"
        )
        expectBodyCarriesNoCanary(
          response.data,
          "reconcile-order-canary",
          stamp
        )
      })

      it("renew: with a lock fault and a declared refusal in one run, the refusal is what the caller sees", async () => {
        const container = getContainer()
        const customer = await createTenantCustomer(container)
        const stamp = Date.now()

        // A real manual subscription so the two scoping reads succeed and the
        // handler reaches the (stubbed) workflow run — this case pins the
        // classifier's `errors[0]` contract, not the engine's failure timing.
        const subscription = (await createSubscriptionSeed(container, {
          reference: `SUB-BRIDGE-CANARY-${stamp}`,
          status: SubscriptionStatus.ACTIVE,
          customer_id: customer.id,
          payment_context: {
            payment_provider_id: "pp_system_default",
            payment_mode: "manual",
            payment_method_reference: null,
          } as never,
        })) as unknown as { id: string }

        // The run's `errors` carries BOTH outcomes: the declared refusal the
        // create step authors (at index 0) and the lock step's compensation
        // fault (at index 1). `store-step-failure.ts` quotes `errors[0]`; this
        // is exactly the case that goes red if it ever stops answering the
        // declared refusal for a multi-error run (spec §D).
        const { RENEW_CUSTOMER_REFUSALS } = jest.requireActual(
          "../../src/workflows/create-manual-renewal"
        ) as {
          RENEW_CUSTOMER_REFUSALS: readonly {
            step: string
            type: string
            copy: RegExp
          }[]
        }
        const refusalText = `Subscription 'sub_canary_${stamp}' is not in manual payment mode; use the standard renewal flow`
        const declared = RENEW_CUSTOMER_REFUSALS.find((refusal) =>
          refusal.copy.test(refusalText)
        )

        if (!declared) {
          throw new Error(
            "RENEW_CUSTOMER_REFUSALS no longer declares the manual-payment-mode refusal; update this case to a refusal the workflow really authors."
          )
        }

        mockRenewRunOutcome = {
          result: undefined,
          errors: [
            {
              action: declared.step,
              handlerType: "step",
              error: {
                __isMedusaError: true,
                name: "Error",
                type: declared.type,
                message: refusalText,
              },
            },
            {
              action: "acquire-lock",
              handlerType: "step",
              error: {
                name: "Error",
                message: `inmem lock could not be released lock-${stamp}`,
                code: "40P01",
              },
            },
          ],
        }

        // The bridge auth middleware normally attaches the tenant to the request
        // scope; driven directly, the handler reads it through `currentTenant`.
        const scope = container as unknown as Record<string, unknown>
        scope[SAAS_BRIDGE_TENANT_KEY] = {
          tenant_id: "default",
          shared_secret: BRIDGE_SECRET,
        } satisfies SaasBridgeTenantConfig

        const request = {
          body: { subscription_id: subscription.id },
          scope: container,
        } as unknown as Parameters<typeof postRenew>[0]
        const response = {
          json: () => undefined,
        } as unknown as Parameters<typeof postRenew>[1]

        let thrown: unknown
        try {
          await postRenew(request, response)
        } catch (error) {
          thrown = error
        } finally {
          delete scope[SAAS_BRIDGE_TENANT_KEY]
          mockRenewRunOutcome = undefined
        }

        expect(thrown).toBeInstanceOf(MedusaError)
        if (thrown instanceof MedusaError) {
          // A refusal: `invalid_data` (400), the renewal's own text. The lock
          // fault at errors[1] — which would have become a 500 (or quoted a
          // driver code) had it been answered — must never surface.
          expect(thrown.type).toEqual(MedusaError.Types.INVALID_DATA)
          expect(thrown.message).toEqual(refusalText)
          expect(
            JSON.stringify({ type: thrown.type, message: thrown.message })
          ).not.toContain(`lock-${stamp}`)
        }
      })
    })
  },
})
