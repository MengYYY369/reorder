import { medusaIntegrationTestRunner } from "@medusajs/test-utils"
import path from "path"
import {
  ContainerRegistrationKeys,
  Modules,
} from "@medusajs/framework/utils"
import type {
  ICartModuleService,
  ILinkModuleService,
  IOrderModuleService,
  IPaymentModuleService,
  IRegionModuleService,
  IWorkflowEngineService,
  MedusaContainer,
  RemoteQueryFunction,
} from "@medusajs/framework/types"
import { SUBSCRIPTION_MODULE } from "../../src/modules/subscription"
import type SubscriptionModuleService from "../../src/modules/subscription/service"
import { SubscriptionStatus } from "../../src/modules/subscription/types"
import { ACTIVITY_LOG_MODULE } from "../../src/modules/activity-log"
import type ActivityLogModuleService from "../../src/modules/activity-log/service"
import { listDueRenewalCyclesForProcessing } from "../../src/modules/renewal/utils/scheduler-query"
import orderPlacedSubscriptionHandler from "../../src/subscribers/order-placed-create-subscription"
import { createRenewalCycleSeed } from "../helpers/renewal-fixtures"
import {
  createCustomer,
  createPlanOfferSeed,
  createProductWithVariant,
  createSubscriptionSeed,
} from "../helpers/plan-offer-fixtures"
import {
  PlanOfferFrequencyInterval,
  PlanOfferRules,
  PlanOfferScope,
  PlanOfferStackingPolicy,
} from "../../src/modules/plan-offer/types"

jest.setTimeout(120 * 1000)

type SeedResult = {
  order_id: string
  cart_id: string
  customer_id: string
  product_id: string
  variant_id: string
}

async function seedSubscriptionOrder(
  container: MedusaContainer,
  options: {
    withSubscriptionItem?: boolean
    withPlanOffer?: boolean
    addressMode?: "complete" | "stub" | "none"
    /** Offer rules for the seeded product; defaults are the conservative ones. */
    planOfferRules?: Partial<PlanOfferRules>
    /** Put customer_id into the payment session, as a consent-collecting
     *  storefront does. */
    sessionCarriesConsent?: boolean
    /** Reuse an existing customer + product to model a repeat purchase. */
    existing?: {
      customer_id: string
      email: string
      product_id: string
      variant_id: string
    }
  } = {}
): Promise<SeedResult> {
  const withSubscriptionItem = options.withSubscriptionItem ?? true
  const withPlanOffer = options.withPlanOffer ?? true
  const addressMode = options.addressMode ?? "complete"
  const existing = options.existing ?? null

  const cartModule = container.resolve<ICartModuleService>(Modules.CART)
  const orderModule = container.resolve<IOrderModuleService>(Modules.ORDER)
  const paymentModule = container.resolve<IPaymentModuleService>(Modules.PAYMENT)
  const link = container.resolve<ILinkModuleService>(
    ContainerRegistrationKeys.LINK
  )

  const customer = existing
    ? { id: existing.customer_id, email: existing.email }
    : await createCustomer(container, {
        email: `from-order-${Date.now()}-${Math.random()}@medusa.test`,
        first_name: "Order",
        last_name: "Driven",
      })

  // The placeholder snapshot falls back to the cart region for the country, so
  // the addressless case needs a region that actually carries one.
  let regionId: string | undefined

  if (addressMode === "none") {
    const regionModule = container.resolve<IRegionModuleService>(Modules.REGION)
    const region = await regionModule.createRegions({
      name: `from-order-region-${Date.now()}`,
      currency_code: "usd",
      countries: ["de"],
    } as never)

    regionId = region.id
  }

  const cartAddress =
    addressMode === "complete"
      ? {
          first_name: "Order",
          last_name: "Driven",
          address_1: "1 Test Way",
          city: "Testville",
          postal_code: "00001",
          country_code: "us",
        }
      : addressMode === "stub"
        ? { country_code: "us" }
        : undefined

  const { product, variant } = existing
    ? {
        product: { id: existing.product_id },
        variant: { id: existing.variant_id },
      }
    : await createProductWithVariant(container)

  if (withPlanOffer && !existing) {
    await createPlanOfferSeed(container, {
      name: `from-order-plan-${Date.now()}`,
      scope: PlanOfferScope.VARIANT,
      product_id: product.id,
      variant_id: variant.id,
      is_enabled: true,
      allowed_frequencies: [
        { interval: PlanOfferFrequencyInterval.MONTH, value: 1 },
        { interval: PlanOfferFrequencyInterval.MONTH, value: 3 },
      ],
      rules: {
        minimum_cycles: 1,
        trial_enabled: false,
        trial_days: null,
        stacking_policy: PlanOfferStackingPolicy.ALLOWED,
        ...(options.planOfferRules ?? {}),
      },
    })
  }

  const itemMetadata: Record<string, unknown> = withSubscriptionItem
    ? {
        is_subscription: true,
        frequency_interval: "month",
        frequency_value: 1,
        payment_mode: "manual",
      }
    : {}

  const cart = await cartModule.createCarts({
    currency_code: "usd",
    email: customer.email,
    customer_id: customer.id,
    ...(regionId ? { region_id: regionId } : {}),
    metadata: {},
    shipping_address: cartAddress,
    items: [
      {
        title: "Subscription item",
        subtitle: product.title,
        unit_price: 1800,
        quantity: 1,
        variant_id: variant.id,
        metadata: itemMetadata,
      } as never,
    ],
  } as never)

  const paymentCollection = await paymentModule.createPaymentCollections({
    currency_code: "usd",
    amount: 1800,
  })

  await paymentModule.createPaymentSession(paymentCollection.id, {
    provider_id: "pp_system_default",
    currency_code: "usd",
    amount: 1800,
    data: options.sessionCarriesConsent ? { customer_id: customer.id } : {},
  } as never)

  const order = await orderModule.createOrders({
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
      first_name: "Order",
      last_name: "Driven",
      address_1: "1 Test Way",
      city: "Testville",
      postal_code: "00001",
      country_code: "us",
    },
  } as never)

  await link.create([
    {
      [Modules.ORDER]: { order_id: order.id },
      [Modules.CART]: { cart_id: cart.id },
    },
    {
      [Modules.ORDER]: { order_id: order.id },
      [Modules.PAYMENT]: {
        payment_collection_id: paymentCollection.id,
      },
    },
    {
      [Modules.CART]: { cart_id: cart.id },
      [Modules.PAYMENT]: {
        payment_collection_id: paymentCollection.id,
      },
    },
  ])

  return {
    order_id: order.id,
    cart_id: cart.id,
    customer_id: customer.id,
    product_id: product.id,
    variant_id: variant.id,
  }
}

medusaIntegrationTestRunner({
  medusaConfigFile: path.resolve(process.cwd(), "integration-tests"),
  env: {
    JWT_SECRET: "supersecret",
    COOKIE_SECRET: "supersecret",
  },
  testSuite: ({ getContainer }) => {
    describe("create-subscription-from-order", () => {
      it("creates an active manual-mode subscription from a placed order", async () => {
        const container = getContainer()
        const subscriptionModule = container.resolve<SubscriptionModuleService>(
          SUBSCRIPTION_MODULE
        )
        const engine = container.resolve<IWorkflowEngineService>(
          Modules.WORKFLOW_ENGINE
        )

        const seed = await seedSubscriptionOrder(container)

        const { result } = await engine.run("create-subscription-from-order", {
          input: { order_id: seed.order_id },
          throwOnError: true,
        })

        expect(result.subscription).toMatchObject({
          status: SubscriptionStatus.ACTIVE,
          customer_id: seed.customer_id,
          frequency_interval: "month",
          frequency_value: 1,
        })

        expect(result.subscription?.payment_context).toMatchObject({
          payment_provider_id: "pp_system_default",
          payment_mode: "manual",
          payment_method_reference: null,
        })

        expect(
          result.subscription?.metadata as Record<string, unknown>
        ).toMatchObject({
          source: "store_order_placed",
          source_order_id: seed.order_id,
        })

        const persisted = await subscriptionModule.listSubscriptions({
          customer_id: seed.customer_id,
        })

        expect(persisted).toHaveLength(1)
      })

      it("snapshots a country-only region stub as a digital-goods placeholder", async () => {
        const container = getContainer()
        const engine = container.resolve<IWorkflowEngineService>(
          Modules.WORKFLOW_ENGINE
        )

        const seed = await seedSubscriptionOrder(container, {
          addressMode: "stub",
        })

        const { result } = await engine.run("create-subscription-from-order", {
          input: { order_id: seed.order_id },
          throwOnError: true,
        })

        expect(result.subscription?.shipping_address).toMatchObject({
          first_name: "Order",
          last_name: "Driven",
          address_1: "N/A",
          city: "N/A",
          postal_code: "00000",
          country_code: "US",
        })
      })

      it("snapshots a cart without any address from the region country", async () => {
        const container = getContainer()
        const engine = container.resolve<IWorkflowEngineService>(
          Modules.WORKFLOW_ENGINE
        )

        const seed = await seedSubscriptionOrder(container, {
          addressMode: "none",
        })

        const { result } = await engine.run("create-subscription-from-order", {
          input: { order_id: seed.order_id },
          throwOnError: true,
        })

        expect(result.subscription?.shipping_address).toMatchObject({
          first_name: "Order",
          last_name: "Driven",
          address_1: "N/A",
          postal_code: "00000",
          country_code: "DE",
        })
      })

      it("is idempotent when re-run against the same order", async () => {
        const container = getContainer()
        const subscriptionModule = container.resolve<SubscriptionModuleService>(
          SUBSCRIPTION_MODULE
        )
        const engine = container.resolve<IWorkflowEngineService>(
          Modules.WORKFLOW_ENGINE
        )

        const seed = await seedSubscriptionOrder(container)

        for (let i = 0; i < 2; i += 1) {
          await engine.run("create-subscription-from-order", {
            input: { order_id: seed.order_id },
            throwOnError: true,
          })
        }

        const persisted = await subscriptionModule.listSubscriptions({
          customer_id: seed.customer_id,
        })

        expect(persisted).toHaveLength(1)
      })
      it("folds a repeat purchase of the same product into the existing row", async () => {
        const container = getContainer()
        const subscriptionModule = container.resolve<SubscriptionModuleService>(
          SUBSCRIPTION_MODULE
        )
        const engine = container.resolve<IWorkflowEngineService>(
          Modules.WORKFLOW_ENGINE
        )

        const first = await seedSubscriptionOrder(container)

        await engine.run("create-subscription-from-order", {
          input: { order_id: first.order_id },
          throwOnError: true,
        })

        const [before] = await subscriptionModule.listSubscriptions({
          customer_id: first.customer_id,
        })

        const second = await seedSubscriptionOrder(container, {
          existing: {
            customer_id: first.customer_id,
            email: "repeat@medusa.test",
            product_id: first.product_id,
            variant_id: first.variant_id,
          },
        })

        await engine.run("create-subscription-from-order", {
          input: { order_id: second.order_id },
          throwOnError: true,
        })

        const rows = await subscriptionModule.listSubscriptions({
          customer_id: first.customer_id,
        })

        expect(rows).toHaveLength(1)
        expect(rows[0].metadata).toMatchObject({ cycles_purchased: 2 })
        expect(new Date(rows[0].next_renewal_at as string).getTime()).toBeGreaterThan(
          new Date(before.next_renewal_at as string).getTime()
        )

        // F7: the second order has to be linked to the row it extended, or a
        // replay of it would fall into the create branch and split the row.
        const query = container.resolve<RemoteQueryFunction>(
          ContainerRegistrationKeys.QUERY
        )
        const { data: links } = await query.graph({
          entity: "subscription_order",
          fields: ["order_id"],
          filters: { subscription_id: [rows[0].id] },
        })

        expect(
          (links as Array<{ order_id: string }>).map((entry) => entry.order_id)
        ).toEqual(expect.arrayContaining([first.order_id, second.order_id]))
      })


      it("keeps separate rows when the offer allows multiple rows", async () => {
        const container = getContainer()
        const subscriptionModule = container.resolve<SubscriptionModuleService>(
          SUBSCRIPTION_MODULE
        )
        const engine = container.resolve<IWorkflowEngineService>(
          Modules.WORKFLOW_ENGINE
        )

        const first = await seedSubscriptionOrder(container, {
          planOfferRules: { row_stacking_policy: "allow_multiple" },
        })

        await engine.run("create-subscription-from-order", {
          input: { order_id: first.order_id },
          throwOnError: true,
        })

        const second = await seedSubscriptionOrder(container, {
          planOfferRules: { row_stacking_policy: "allow_multiple" },
          existing: {
            customer_id: first.customer_id,
            email: "multi@medusa.test",
            product_id: first.product_id,
            variant_id: first.variant_id,
          },
        })

        await engine.run("create-subscription-from-order", {
          input: { order_id: second.order_id },
          throwOnError: true,
        })

        const rows = await subscriptionModule.listSubscriptions({
          customer_id: first.customer_id,
        })

        expect(rows).toHaveLength(2)
      })

      it("refuses a purchase that would stack past the ceiling", async () => {
        const container = getContainer()
        const subscriptionModule = container.resolve<SubscriptionModuleService>(
          SUBSCRIPTION_MODULE
        )
        const engine = container.resolve<IWorkflowEngineService>(
          Modules.WORKFLOW_ENGINE
        )

        const ceiling = { max_stacking_cycles: 2 }
        const first = await seedSubscriptionOrder(container, {
          planOfferRules: ceiling,
        })

        await engine.run("create-subscription-from-order", {
          input: { order_id: first.order_id },
          throwOnError: true,
        })

        for (let purchase = 2; purchase <= 3; purchase += 1) {
          const next = await seedSubscriptionOrder(container, {
            planOfferRules: ceiling,
            existing: {
              customer_id: first.customer_id,
              email: "ceiling@medusa.test",
              product_id: first.product_id,
              variant_id: first.variant_id,
            },
          })

          const { errors } = await engine.run("create-subscription-from-order", {
            input: { order_id: next.order_id },
            throwOnError: false,
          })

          if (purchase === 2) {
            expect(errors ?? []).toHaveLength(0)
            continue
          }

          expect((errors?.[0]?.error as Error)?.message ?? "").toContain(
            "stacked up to 2 cycles"
          )
        }

        const rows = await subscriptionModule.listSubscriptions({
          customer_id: first.customer_id,
        })

        expect(rows).toHaveLength(1)
        expect(rows[0].metadata).toMatchObject({ cycles_purchased: 2 })
      })

      it("starts charging an extended row automatically when consent is proven", async () => {
        const container = getContainer()
        const subscriptionModule = container.resolve<SubscriptionModuleService>(
          SUBSCRIPTION_MODULE
        )
        const engine = container.resolve<IWorkflowEngineService>(
          Modules.WORKFLOW_ENGINE
        )

        const customer = await createCustomer(container)
        const { product, variant } = await createProductWithVariant(container)

        await createPlanOfferSeed(container, {
          name: "consent-extend-" + Date.now(),
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
            consent_from_session: "customer_id",
          },
        })

        // The row the repeat purchase folds into: manual mode, but it already
        // holds a chargeable method, so consent can take effect immediately.
        await createSubscriptionSeed(container, {
          customer_id: customer.id,
          product_id: product.id,
          variant_id: variant.id,
          status: SubscriptionStatus.ACTIVE,
          payment_context: {
            payment_provider_id: "pp_system_default",
            payment_mode: "manual",
            payment_method_reference: "pm_stored_123",
          },
        })

        const purchase = await seedSubscriptionOrder(container, {
          existing: {
            customer_id: customer.id,
            email: "consent-extend@medusa.test",
            product_id: product.id,
            variant_id: variant.id,
          },
          sessionCarriesConsent: true,
        })

        await engine.run("create-subscription-from-order", {
          input: { order_id: purchase.order_id },
          throwOnError: true,
        })

        const rows = await subscriptionModule.listSubscriptions({
          customer_id: customer.id,
        })

        expect(rows).toHaveLength(1)
        expect(rows[0].payment_context).toMatchObject({
          payment_mode: "auto",
          mechanism: "reorder_auto",
          // The method collected by the first purchase has to survive.
          payment_method_reference: "pm_stored_123",
        })
        expect(rows[0].metadata).toMatchObject({ cycles_purchased: 2 })
      })

      it("rejects orders without a subscription line item", async () => {
        const container = getContainer()
        const engine = container.resolve<IWorkflowEngineService>(
          Modules.WORKFLOW_ENGINE
        )

        const seed = await seedSubscriptionOrder(container, {
          withSubscriptionItem: false,
        })

        const { errors } = await engine.run("create-subscription-from-order", {
          input: { order_id: seed.order_id },
          throwOnError: false,
        })

        expect(errors?.length).toBeGreaterThan(0)
      })

      it("subscriber precheck creates the subscription on order.placed", async () => {
        const container = getContainer()
        const subscriptionModule = container.resolve<SubscriptionModuleService>(
          SUBSCRIPTION_MODULE
        )

        const seed = await seedSubscriptionOrder(container)

        await orderPlacedSubscriptionHandler({
          event: {
            name: "order.placed",
            data: { id: seed.order_id },
            broadcast: false,
          },
          container,
          pluginOptions: {},
        })

        const persisted = await subscriptionModule.listSubscriptions({
          customer_id: seed.customer_id,
        })

        expect(persisted).toHaveLength(1)
        expect(persisted[0].payment_context).toMatchObject({
          payment_mode: "manual",
        })
      })

      it("records one creation_failed activity log row per failing step", async () => {
        const container = getContainer()
        const subscriptionModule = container.resolve<SubscriptionModuleService>(
          SUBSCRIPTION_MODULE
        )
        const activityLogModule = container.resolve<ActivityLogModuleService>(
          ACTIVITY_LOG_MODULE
        )

        const seed = await seedSubscriptionOrder(container, {
          withPlanOffer: false,
        })

        const runSubscriber = () =>
          orderPlacedSubscriptionHandler({
            event: {
              name: "order.placed",
              data: { id: seed.order_id },
              broadcast: false,
            },
            container,
            pluginOptions: {},
          })

        await runSubscriber()
        await runSubscriber()

        const logs = await activityLogModule.listSubscriptionLogs({
          event_type: "subscription.creation_failed",
        })

        expect(logs).toHaveLength(1)
        expect(logs[0]).toMatchObject({
          subscription_id: null,
          subscription_reference: null,
          customer_id: seed.customer_id,
          actor_type: "system",
        })
        expect(logs[0].reason).toContain(
          "No active subscription offer is configured"
        )
        expect(logs[0].dedupe_key).toBe(
          `subscription.creation_failed:order:${seed.order_id}:validate-subscription-cart`
        )
        expect(logs[0].metadata).toMatchObject({
          order_id: seed.order_id,
          source: "store",
          trigger_type: "order_placed",
          reason_code: "validate-subscription-cart",
        })

        const persisted = await subscriptionModule.listSubscriptions({
          customer_id: seed.customer_id,
        })

        expect(persisted).toHaveLength(0)
      })

      it("does not log a creation failure for plain orders", async () => {
        const container = getContainer()
        const activityLogModule = container.resolve<ActivityLogModuleService>(
          ACTIVITY_LOG_MODULE
        )

        const seed = await seedSubscriptionOrder(container, {
          withSubscriptionItem: false,
          withPlanOffer: false,
        })

        await orderPlacedSubscriptionHandler({
          event: {
            name: "order.placed",
            data: { id: seed.order_id },
            broadcast: false,
          },
          container,
          pluginOptions: {},
        })

        const logs = await activityLogModule.listSubscriptionLogs({
          event_type: "subscription.creation_failed",
        })

        expect(logs).toHaveLength(0)
      })

      it("excludes manual-mode subscriptions from the renewal scheduler", async () => {
        const container = getContainer()
        const subscriptionModule = container.resolve<SubscriptionModuleService>(
          SUBSCRIPTION_MODULE
        )

        const manualSubscription = await subscriptionModule.createSubscriptions({
          reference: `SUB-MANUAL-${Date.now()}`,
          status: SubscriptionStatus.ACTIVE,
          customer_id: `cus_${Date.now()}`,
          cart_id: `cart_${Date.now()}`,
          product_id: `prod_${Date.now()}`,
          variant_id: `variant_${Date.now()}`,
          frequency_interval: "month",
          frequency_value: 1,
          started_at: new Date(),
          next_renewal_at: new Date(),
          last_renewal_at: null,
          paused_at: null,
          cancelled_at: null,
          cancel_effective_at: null,
          skip_next_cycle: false,
          is_trial: false,
          trial_ends_at: null,
          customer_snapshot: {
            email: "manual@example.com",
            full_name: "Manual Subscriber",
          },
          product_snapshot: {
            product_id: `prod_${Date.now()}`,
            product_title: "Manual Product",
            variant_id: `variant_${Date.now()}`,
            variant_title: "Manual Variant",
            sku: null,
          },
          pricing_snapshot: null,
          shipping_address: {
            first_name: "M",
            last_name: "S",
            company: null,
            address_1: "1 Way",
            address_2: null,
            city: "Town",
            postal_code: "00000",
            province: null,
            country_code: "US",
            phone: null,
          },
          payment_context: {
            payment_provider_id: "pp_epay_epay-payment",
            payment_mode: "manual",
            source_payment_collection_id: "paycol_manual",
            source_payment_session_id: "payses_manual",
            payment_method_reference: null,
            customer_payment_reference: null,
          },
          pending_update_data: null,
          metadata: {},
        } as never)

        const autoSubscription = await createSubscriptionSeed(container, {
          reference: `SUB-AUTO-${Date.now()}`,
          status: SubscriptionStatus.ACTIVE,
          next_renewal_at: new Date(),
          payment_context: {
            payment_provider_id: "pp_stripe_stripe",
            source_payment_collection_id: `paycol_${Date.now()}`,
            source_payment_session_id: `payses_${Date.now()}`,
            payment_method_reference: "pm_auto",
            customer_payment_reference: null,
          },
        })

        const manualCycle = await createRenewalCycleSeed(container, {
          subscription_id: manualSubscription.id,
          scheduled_for: new Date(Date.now() - 1000),
        })

        const autoCycle = await createRenewalCycleSeed(container, {
          subscription_id: autoSubscription.id,
          scheduled_for: new Date(Date.now() - 1000),
        })

        const { cycles } = await listDueRenewalCyclesForProcessing(container, {
          limit: 10,
          offset: 0,
        })

        const cycleIds = cycles.map((cycle) => cycle.id)

        expect(cycleIds).toContain(autoCycle.id)
        expect(cycleIds).not.toContain(manualCycle.id)
      })
    })
  },
})
