import { medusaIntegrationTestRunner } from "@medusajs/test-utils"
import path from "path"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import type {
  ICartModuleService,
  IPaymentModuleService,
  IRegionModuleService,
  IWorkflowEngineService,
  MedusaContainer,
} from "@medusajs/framework/types"
import { SUBSCRIPTION_MODULE } from "../../src/modules/subscription"
import type SubscriptionModuleService from "../../src/modules/subscription/service"
import { SubscriptionStatus } from "../../src/modules/subscription/types"
import { RENEWAL_MODULE } from "../../src/modules/renewal"
import type RenewalModuleService from "../../src/modules/renewal/service"
import { RenewalCycleStatus } from "../../src/modules/renewal/types"
import { createRenewalCycleSeed } from "../helpers/renewal-fixtures"
import {
  createCustomer,
  createProductWithVariant,
  createSubscriptionSeed,
} from "../helpers/plan-offer-fixtures"
import manualRenewalHygieneJob from "../../src/jobs/manual-renewal-hygiene"

jest.setTimeout(120 * 1000)

const MANUAL_PAYMENT_CONTEXT = {
  payment_provider_id: "pp_system_default",
  payment_mode: "manual",
  source_payment_collection_id: "paycol_manual",
  source_payment_session_id: "payses_manual",
  payment_method_reference: null,
  customer_payment_reference: null,
}

type SeedResult = {
  subscription_id: string
  customer_id: string
}

async function seedManualSubscription(
  container: MedusaContainer,
  input: { next_renewal_at?: Date; unit_price?: number } = {}
): Promise<SeedResult> {
  const customer = await createCustomer(container, {
    email: `manual-renewal-${Date.now()}-${Math.random()}@medusa.test`,
  })

  await createProductWithVariant(container)

  // A real cart: manual renewal orders are built from the subscription's
  // source cart (region/sales channel/currency/address).
  const cartModule = container.resolve<ICartModuleService>(Modules.CART)
  const regionModule = container.resolve<IRegionModuleService>(Modules.REGION)
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
        unit_price: input.unit_price ?? 1800,
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
    reference: `SUB-MANUAL-RENEW-${Date.now()}`,
    status: SubscriptionStatus.ACTIVE,
    customer_id: customer.id,
    cart_id: cart.id,
    next_renewal_at: input.next_renewal_at ?? new Date(),
    payment_context: MANUAL_PAYMENT_CONTEXT as never,
  })) as unknown as { id: string }

  return { subscription_id: subscription.id, customer_id: customer.id }
}

medusaIntegrationTestRunner({
  medusaConfigFile: path.resolve(process.cwd(), "integration-tests"),
  env: {
    JWT_SECRET: "supersecret",
    COOKIE_SECRET: "supersecret",
  },
  testSuite: ({ getContainer }) => {
    describe("manual renewal (mc03/mc04)", () => {
      it("creates a renewal order with an unconfirmed payment session", async () => {
        const container = getContainer()
        const engine = container.resolve<IWorkflowEngineService>(
          Modules.WORKFLOW_ENGINE
        )
        const renewalModule =
          container.resolve<RenewalModuleService>(RENEWAL_MODULE)

        const seed = await seedManualSubscription(container)

        const { result } = await engine.run("create-manual-renewal", {
          input: { subscription_id: seed.subscription_id },
          throwOnError: true,
        })

        expect(result.renewal_order_id).toBeTruthy()
        expect(result.renewal_cycle_id).toBeTruthy()
        expect(result.currency_code).toEqual("usd")
        expect(result.total).toBeGreaterThan(0)
        // pp_system_default does not produce a cashier redirect; epay will.
        expect(result.payment_provider_id).toEqual("pp_system_default")

        const cycles = await renewalModule.listRenewalCycles({
          id: [result.renewal_cycle_id],
        })
        const cycle = cycles[0] as unknown as {
          status: RenewalCycleStatus
          generated_order_id: string | null
        }
        expect(cycle.generated_order_id).toEqual(result.renewal_order_id)
      })

      it("is idempotent while a renewal order is outstanding", async () => {
        const container = getContainer()
        const engine = container.resolve<IWorkflowEngineService>(
          Modules.WORKFLOW_ENGINE
        )
        const renewalModule =
          container.resolve<RenewalModuleService>(RENEWAL_MODULE)

        const seed = await seedManualSubscription(container)

        const first = await engine.run("create-manual-renewal", {
          input: { subscription_id: seed.subscription_id },
          throwOnError: true,
        })

        const second = await engine.run("create-manual-renewal", {
          input: { subscription_id: seed.subscription_id },
          throwOnError: true,
        })

        expect(second.result.renewal_order_id).toEqual(
          first.result.renewal_order_id
        )

        const orders = await renewalModule.listRenewalCycles({
          subscription_id: [seed.subscription_id],
        })
        const generated = orders.filter((c) => c.generated_order_id)
        expect(generated.length).toEqual(1)
      })

      it("advances the cadence on complete-manual-renewal (anchor = max(now, scheduled_for))", async () => {
        const container = getContainer()
        const engine = container.resolve<IWorkflowEngineService>(
          Modules.WORKFLOW_ENGINE
        )
        const subscriptionModule =
          container.resolve<SubscriptionModuleService>(SUBSCRIPTION_MODULE)
        const renewalModule =
          container.resolve<RenewalModuleService>(RENEWAL_MODULE)

        // overdue anchor: renewal starts fresh from payment date
        const past = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000)
        const seed = await seedManualSubscription(container, {
          next_renewal_at: past,
        })

        const created = await engine.run("create-manual-renewal", {
          input: { subscription_id: seed.subscription_id },
          throwOnError: true,
        })

        const completed = await engine.run("complete-manual-renewal", {
          input: { renewal_order_id: created.result.renewal_order_id },
          throwOnError: true,
        })

        const nextRenewal = new Date(completed.result.next_renewal_at)

        // Anchor = now (overdue), cadence = 1 month
        expect(nextRenewal.getTime()).toBeGreaterThan(Date.now())
        const approxMonth = 31 * 24 * 60 * 60 * 1000
        expect(
          nextRenewal.getTime() - Date.now()
        ).toBeLessThanOrEqual(approxMonth)

        const cycles = await renewalModule.listRenewalCycles({
          id: [completed.result.renewal_cycle_id],
        })
        expect(cycles[0].status).toEqual(RenewalCycleStatus.SUCCEEDED)

        const subscriptions = await subscriptionModule.listSubscriptions({
          id: [seed.subscription_id],
        })
        const subscription = subscriptions[0] as unknown as {
          next_renewal_at: Date
          status: SubscriptionStatus
        }
        expect(subscription.status).toEqual(SubscriptionStatus.ACTIVE)
        expect(
          subscription.next_renewal_at.toISOString()
        ).toEqual(completed.result.next_renewal_at)
      })

      it("re-running complete on a succeeded cycle is a no-op (idempotent)", async () => {
        const container = getContainer()
        const engine = container.resolve<IWorkflowEngineService>(
          Modules.WORKFLOW_ENGINE
        )

        const seed = await seedManualSubscription(container)

        const created = await engine.run("create-manual-renewal", {
          input: { subscription_id: seed.subscription_id },
          throwOnError: true,
        })

        await engine.run("complete-manual-renewal", {
          input: { renewal_order_id: created.result.renewal_order_id },
          throwOnError: true,
        })

        const rerun = await engine.run("complete-manual-renewal", {
          input: { renewal_order_id: created.result.renewal_order_id },
          throwOnError: true,
        })

        expect(rerun.result.subscription_id).toEqual(seed.subscription_id)
      })

      it("emits subscription lifecycle events on the bus (mc04)", async () => {
        const container = getContainer()
        const eventBus = container.resolve("event_bus") as unknown as {
          emit: (data: unknown) => Promise<void>
        }

        const emitSpy = jest.spyOn(eventBus, "emit")

        const seed = await seedManualSubscription(container)
        const engine = container.resolve<IWorkflowEngineService>(
          Modules.WORKFLOW_ENGINE
        )

        const created = await engine.run("create-manual-renewal", {
          input: { subscription_id: seed.subscription_id },
          throwOnError: true,
        })

        await engine.run("complete-manual-renewal", {
          input: { renewal_order_id: created.result.renewal_order_id },
          throwOnError: true,
        })

        const emittedEvents = emitSpy.mock.calls.flatMap((call) =>
          (call[0] as Array<{ name?: string }> | undefined) ?? []
        )
        const names = emittedEvents.map((event) => event?.name)

        expect(names).toContain("renewal.succeeded")
      })

      it("resolves one payment collection through the shared helper at the 0.01 epsilon boundary", async () => {
    const container = getContainer()
    const engine = container.resolve<IWorkflowEngineService>(
      Modules.WORKFLOW_ENGINE
    )
    const paymentModule = container.resolve<IPaymentModuleService>(
      Modules.PAYMENT
    )
    const query = container.resolve<any>(ContainerRegistrationKeys.QUERY)

    // 0.01 sits exactly on the USD currency epsilon where Medusa 2.20's
    // read-time total decoration zeroes pending_difference; the shared
    // resolve-or-create helper must not depend on the order summary.
    const seed = await seedManualSubscription(container, { unit_price: 0.01 })

    const created = await engine.run("create-manual-renewal", {
      input: { subscription_id: seed.subscription_id },
      throwOnError: true,
    })

    expect(created.result.renewal_order_id).toBeTruthy()
    expect(created.result.total).toBeGreaterThan(0)
    expect(created.result.currency_code).toEqual("usd")
    expect(created.result.payment_provider_id).toEqual("pp_system_default")

    const orderId = created.result.renewal_order_id as string

    const { data: links } = (await query.graph({
      entity: "order_payment_collection",
      fields: ["payment_collection_id"],
      filters: { order_id: orderId },
    })) as { data: Array<{ payment_collection_id: string }> }
    expect(links).toHaveLength(1)

    const collections = (await paymentModule.listPaymentCollections(
      { id: links.map((link) => link.payment_collection_id) },
      { relations: ["payment_sessions"] }
    )) as unknown as Array<{
      id: string
      amount: number
      payment_sessions: Array<{ id: string; status: string }>
    }>

    expect(collections).toHaveLength(1)
    expect(collections[0].amount).toEqual(0.01)
    // Redirect-only behavior unchanged: the session stays unconfirmed.
    expect(collections[0].payment_sessions).toHaveLength(1)
    expect(collections[0].payment_sessions[0].status).toEqual("pending")

    // The idempotent re-run reuses the outstanding order without minting a
    // second collection.
    await engine.run("create-manual-renewal", {
      input: { subscription_id: seed.subscription_id },
      throwOnError: true,
    })

    const { data: linksAfterReuse } = (await query.graph({
      entity: "order_payment_collection",
      fields: ["payment_collection_id"],
      filters: { order_id: orderId },
    })) as { data: Array<{ payment_collection_id: string }> }
    expect(linksAfterReuse).toHaveLength(1)
  })

  it("hygiene job cancels lapsed manual subscriptions only", async () => {
        const container = getContainer()
        const subscriptionModule =
          container.resolve<SubscriptionModuleService>(SUBSCRIPTION_MODULE)
        const renewalModule =
          container.resolve<RenewalModuleService>(RENEWAL_MODULE)

        const lapsedAt = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000)

        const lapsed = (await createSubscriptionSeed(container, {
          reference: `SUB-LAPSED-${Date.now()}`,
          status: SubscriptionStatus.ACTIVE,
          next_renewal_at: lapsedAt,
          payment_context: MANUAL_PAYMENT_CONTEXT as never,
        })) as unknown as { id: string }

        const fresh = (await createSubscriptionSeed(container, {
          reference: `SUB-FRESH-${Date.now()}`,
          status: SubscriptionStatus.ACTIVE,
          next_renewal_at: new Date(Date.now() + 24 * 60 * 60 * 1000),
          payment_context: MANUAL_PAYMENT_CONTEXT as never,
        })) as unknown as { id: string }

        const autoLapsed = (await createSubscriptionSeed(container, {
          reference: `SUB-AUTO-LAPSED-${Date.now()}`,
          status: SubscriptionStatus.ACTIVE,
          next_renewal_at: lapsedAt,
          payment_context: {
            payment_provider_id: "pp_stripe_stripe",
            source_payment_collection_id: `paycol_${Date.now()}`,
            source_payment_session_id: `payses_${Date.now()}`,
            payment_method_reference: "pm_auto",
            customer_payment_reference: null,
          } as never,
        })) as unknown as { id: string }

        await manualRenewalHygieneJob(container)

        const lapsedSubs = await subscriptionModule.listSubscriptions({
          id: [lapsed.id],
        })
        const freshSubs = await subscriptionModule.listSubscriptions({
          id: [fresh.id],
        })
        const autoSubs = await subscriptionModule.listSubscriptions({
          id: [autoLapsed.id],
        })

        expect(
          (lapsedSubs[0] as unknown as { status: string }).status
        ).toEqual("cancelled")
        expect(
          (freshSubs[0] as unknown as { status: string }).status
        ).toEqual("active")
        expect(
          (autoSubs[0] as unknown as { status: string }).status
        ).toEqual("active")

        // Silence unused-var lint for renewalModule in this scope.
        expect(renewalModule).toBeTruthy()
      })
    })
  },
})
