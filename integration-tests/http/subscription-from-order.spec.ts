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
import { RENEWAL_MODULE } from "../../src/modules/renewal"
import type RenewalModuleService from "../../src/modules/renewal/service"
import { RenewalCycleStatus } from "../../src/modules/renewal/types"
import { listDueRenewalCyclesForProcessing } from "../../src/modules/renewal/utils/scheduler-query"
import { ensureNextRenewalCycleWorkflow } from "../../src/workflows"
import orderPlacedSubscriptionHandler from "../../src/subscribers/order-placed-create-subscription"
import {
  createRenewalAttemptSeed,
  createRenewalCycleSeed,
} from "../helpers/renewal-fixtures"
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

/**
 * Deep copy of every `metadata` object in an update input, taken before the
 * input reaches the DAL: jsonb payloads are merged on the way in, so a reference
 * held by a test spy would show the post-merge state rather than the write.
 */
function metadataSnapshotsOf(update: unknown): Array<Record<string, unknown>> {
  const entries = Array.isArray(update) ? update : [update]

  return entries
    .filter(
      (entry): entry is { metadata?: Record<string, unknown> | null } =>
        !!entry && typeof entry === "object" && "metadata" in entry
    )
    .map((entry) => entry.metadata)
    .filter((metadata) => !!metadata)
    .map(
      (metadata) =>
        JSON.parse(JSON.stringify(metadata)) as Record<string, unknown>
    )
}

/**
 * Every `renewal_cycle` row a subscription owns, soft-deleted ones included,
 * reduced to the columns the upcoming-cycle invariant (#08) speaks about and
 * sorted by id so two captures compare order-independently.
 *
 * The default list hides soft-deleted rows, so "exactly one live SCHEDULED"
 * alone cannot tell a reschedule (`adopt`, which keeps the row) from
 * delete-and-recreate: both leave one live row. Row identity and the absence of
 * an appended row are what separate them, and both need the deleted rows back.
 */
async function captureRenewalCycleRows(
  container: MedusaContainer,
  subscriptionId: string
) {
  const renewalModule = container.resolve<RenewalModuleService>(RENEWAL_MODULE)

  const rows = await renewalModule.listRenewalCycles(
    { subscription_id: subscriptionId },
    { withDeleted: true }
  )

  return rows
    .map((row) => ({
      id: row.id,
      status: row.status,
      scheduled_for: new Date(row.scheduled_for).getTime(),
      generated_order_id: row.generated_order_id ?? null,
      deleted: row.deleted_at != null,
    }))
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
}

/**
 * Run `run` with every `logger.warn` message recorded, then restore the logger.
 * The container registers the app logger as a value, so the object a step
 * resolves is the object this spies on: a step's warning is assertable from the
 * outside, and the original still writes to the log so a red run stays readable.
 */
async function captureWarnings<TRunResult>(
  container: MedusaContainer,
  run: () => Promise<TRunResult>
): Promise<{ value: TRunResult; warnings: string[] }> {
  const logger = container.resolve<{ warn: (message: string) => void }>(
    ContainerRegistrationKeys.LOGGER
  )
  const warnOriginal = logger.warn.bind(logger)
  const warnings: string[] = []
  const warnSpy = jest
    .spyOn(logger, "warn")
    .mockImplementation((message: string) => {
      warnings.push(message)
      warnOriginal(message)
    })

  try {
    return { value: await run(), warnings }
  } finally {
    warnSpy.mockRestore()
  }
}

type RowOwnedByOtherWriters = {
  subscription_id: string
  customer_id: string
  product_id: string
  variant_id: string
  first_order_id: string
  /** Owned by `update-subscription-payment-method.ts:118-123`. */
  payment_method_update_context: Record<string, unknown>
  /** Owned by `pause-subscription.ts:96`. */
  pause_context: Record<string, unknown>
}

/**
 * A live row that has been bought once and then touched by the two steps that
 * write keys of their own into `subscription.metadata`. Both of those steps
 * spread-merge, so the row is the state a repeat purchase must arrive at.
 */
async function seedRowOwnedByOtherWriters(
  container: MedusaContainer
): Promise<RowOwnedByOtherWriters> {
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

  const [row] = await subscriptionModule.listSubscriptions({
    customer_id: first.customer_id,
  })

  const paymentMethodUpdateContext = {
    triggered_by: "customer",
    updated_at: "2026-09-20T10:00:00.000Z",
  }
  const pauseContext = {
    reason: "vacation",
    effective_at: "2026-09-21T10:00:00.000Z",
    triggered_by: "admin",
  }

  await subscriptionModule.updateSubscriptions({
    id: row.id,
    metadata: {
      ...(row.metadata ?? {}),
      payment_method_update_context: paymentMethodUpdateContext,
      pause_context: pauseContext,
    },
  } as never)

  return {
    subscription_id: row.id,
    customer_id: first.customer_id,
    product_id: first.product_id,
    variant_id: first.variant_id,
    first_order_id: first.order_id,
    payment_method_update_context: paymentMethodUpdateContext,
    pause_context: pauseContext,
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

        // The state a stacked purchase has to arrive at: one live upcoming cycle
        // for the first period, with a charge attempt already attached to it.
        const renewalModule =
          container.resolve<RenewalModuleService>(RENEWAL_MODULE)
        const rowsBefore = await captureRenewalCycleRows(
          container,
          before.id
        )
        const liveScheduledBefore = rowsBefore.filter(
          (row) =>
            row.status === RenewalCycleStatus.SCHEDULED && row.deleted === false
        )

        expect(liveScheduledBefore).toHaveLength(1)

        const attemptBefore = await createRenewalAttemptSeed(container, {
          renewal_cycle_id: liveScheduledBefore[0].id,
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

        // #08: stacking forward has to move the upcoming renewal, never append
        // a second one. Two live SCHEDULED rows means the scheduler charges the
        // customer at both dates.
        const upcomingCycles = await renewalModule.listRenewalCycles({
          subscription_id: rows[0].id,
          status: RenewalCycleStatus.SCHEDULED,
        })

        expect(upcomingCycles).toHaveLength(1)
        expect(new Date(upcomingCycles[0].scheduled_for).getTime()).toEqual(
          new Date(rows[0].next_renewal_at!).getTime()
        )
        expect(
          new Date(upcomingCycles[0].scheduled_for).getTime()
        ).toBeGreaterThan(Date.now())

        // The end-to-end half of #08: the one live row is the row that already
        // existed, moved onto the new entitlement date. `adopt` is a reschedule,
        // so the cycle id survives, no row is appended (soft-deleted or not) and
        // the attempt child stays attached. Soft-deleting the old row and
        // creating a fresh one satisfies the count above and still breaks this.
        const rowsAfter = await captureRenewalCycleRows(container, rows[0].id)
        const futureScheduledAfter = rowsAfter.filter(
          (row) =>
            row.status === RenewalCycleStatus.SCHEDULED &&
            row.deleted === false &&
            row.scheduled_for > Date.now()
        )
        const survivor = futureScheduledAfter[0]

        expect(futureScheduledAfter).toHaveLength(1)
        expect(survivor.id).toEqual(liveScheduledBefore[0].id)
        expect(survivor.deleted).toBe(false)
        // the tracked row was the pre-purchase upcoming cycle sitting on the old
        // entitlement date, and it is now the one on the extended date
        expect(liveScheduledBefore[0].scheduled_for).toEqual(
          new Date(before.next_renewal_at!).getTime()
        )
        expect(survivor.scheduled_for).toBeGreaterThan(
          liveScheduledBefore[0].scheduled_for
        )
        expect(rowsAfter.map((row) => row.id)).toEqual(
          rowsBefore.map((row) => row.id)
        )
        expect(
          await renewalModule.listRenewalAttempts({
            renewal_cycle_id: survivor.id,
          })
        ).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ id: attemptBefore.id }),
          ])
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

      it("keeps metadata written by other steps on a stacked row", async () => {
        const container = getContainer()
        const subscriptionModule = container.resolve<SubscriptionModuleService>(
          SUBSCRIPTION_MODULE
        )
        const engine = container.resolve<IWorkflowEngineService>(
          Modules.WORKFLOW_ENGINE
        )

        const seeded = await seedRowOwnedByOtherWriters(container)

        const second = await seedSubscriptionOrder(container, {
          existing: {
            customer_id: seeded.customer_id,
            email: "repeat-metadata@medusa.test",
            product_id: seeded.product_id,
            variant_id: seeded.variant_id,
          },
        })

        await engine.run("create-subscription-from-order", {
          input: { order_id: second.order_id },
          throwOnError: true,
        })

        const [row] = await subscriptionModule.listSubscriptions({
          customer_id: seeded.customer_id,
        })

        expect(row.metadata).toMatchObject({
          payment_method_update_context: seeded.payment_method_update_context,
          pause_context: seeded.pause_context,
          cycles_purchased: 2,
          // Merging is not enough: the newest purchase still wins on the
          // provenance keys, so a replay cannot be attributed to the first order.
          source: "store_order_placed",
          source_order_id: second.order_id,
        })
      })

      it("sends the other writers' keys back when a purchase stacks", async () => {
        const container = getContainer()
        const subscriptionModule = container.resolve<SubscriptionModuleService>(
          SUBSCRIPTION_MODULE
        )
        const engine = container.resolve<IWorkflowEngineService>(
          Modules.WORKFLOW_ENGINE
        )

        const seeded = await seedRowOwnedByOtherWriters(container)

        // The persisted row cannot discriminate this write: the DAL merges jsonb
        // payloads on the way in (`mergeObjectProperties`), so a step that sends a
        // literal metadata object leaves its neighbours on the row and even sees
        // its own argument come back enriched. The payload at the module boundary
        // is the contract, so it is snapshotted synchronously, at call time.
        const sentMetadata: Array<Record<string, unknown>> = []
        const updateSubscriptions =
          subscriptionModule.updateSubscriptions.bind(subscriptionModule)

        const spy = jest
          .spyOn(subscriptionModule, "updateSubscriptions")
          .mockImplementation(
            ((
              ...args: Parameters<
                SubscriptionModuleService["updateSubscriptions"]
              >
            ) => {
              sentMetadata.push(...metadataSnapshotsOf(args[0]))

              return updateSubscriptions(...args)
            }) as never
          )

        const second = await seedSubscriptionOrder(container, {
          existing: {
            customer_id: seeded.customer_id,
            email: "repeat-metadata-write@medusa.test",
            product_id: seeded.product_id,
            variant_id: seeded.variant_id,
          },
        })

        try {
          await engine.run("create-subscription-from-order", {
            input: { order_id: second.order_id },
            throwOnError: true,
          })
        } finally {
          spy.mockRestore()
        }

        expect(sentMetadata).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              payment_method_update_context:
                seeded.payment_method_update_context,
              pause_context: seeded.pause_context,
              cycles_purchased: 2,
              source: "store_order_placed",
              source_order_id: second.order_id,
            }),
          ])
        )
      })

      it("defers instead of rescheduling a cycle whose renewal order is already outstanding", async () => {
        const container = getContainer()
        const renewalModule =
          container.resolve<RenewalModuleService>(RENEWAL_MODULE)
        const subscriptionModule = container.resolve<SubscriptionModuleService>(
          SUBSCRIPTION_MODULE
        )

        const inFlightAt = new Date("2026-10-24T10:00:00.000Z")
        const entitlementAt = new Date("2026-11-24T10:00:00.000Z")

        const subscription = await createSubscriptionSeed(container, {
          reference: `SUB-DEFER-${Date.now()}`,
          status: SubscriptionStatus.ACTIVE,
          next_renewal_at: entitlementAt,
        })

        const outstandingOrderId = `order_outstanding_${Date.now()}`

        // The manual renewal flow reuses a due SCHEDULED row and only stamps
        // generated_order_id, so an unpaid order can sit on a row that still
        // reads SCHEDULED. Moving its date would re-arm a billed period.
        const inFlight = await createRenewalCycleSeed(container, {
          subscription_id: subscription.id,
          scheduled_for: inFlightAt,
          generated_order_id: outstandingOrderId,
        })

        // `defer` is a zero-write branch, so it is the first thing asserted after
        // the run: a red run must name the write, not a reworded log line. The
        // warning is then the only thing an operator gets back — the container
        // hands out the app logger as a value, which is the same object the step
        // resolves, so the warn is observable without touching the step.
        const rowsBefore = await captureRenewalCycleRows(
          container,
          subscription.id
        )

        const {
          value: { result },
          warnings,
        } = await captureWarnings(container, () =>
          ensureNextRenewalCycleWorkflow(container).run({
            input: { subscription_id: subscription.id },
          })
        )

        expect(result).toMatchObject({
          action: "deferred",
          subscription_id: subscription.id,
          renewal_cycle_id: inFlight.id,
        })

        // it was a read: the same rows, the same dates, nothing soft-deleted
        const rowsAfter = await captureRenewalCycleRows(
          container,
          subscription.id
        )

        expect(rowsAfter).toEqual(rowsBefore)

        // exactly one warn line, and it names the row it refused to move
        const deferralWarnings = warnings.filter((message) =>
          message.includes(inFlight.id)
        )

        expect(deferralWarnings).toHaveLength(1)
        expect(deferralWarnings[0]).toContain(subscription.id)
        expect(deferralWarnings[0]).toContain(outstandingOrderId)
        expect(deferralWarnings[0]).toContain(RenewalCycleStatus.SCHEDULED)
        expect(deferralWarnings[0]).toContain(entitlementAt.toISOString())

        const cycles = await renewalModule.listRenewalCycles({
          subscription_id: subscription.id,
        })

        expect(cycles).toHaveLength(1)
        expect(cycles[0]).toMatchObject({
          id: inFlight.id,
          status: RenewalCycleStatus.SCHEDULED,
          generated_order_id: inFlight.generated_order_id,
        })
        expect(new Date(cycles[0].scheduled_for).getTime()).toEqual(
          inFlightAt.getTime()
        )

        const [persisted] = await subscriptionModule.listSubscriptions({
          id: subscription.id,
        })

        expect(new Date(persisted.next_renewal_at!).getTime()).toEqual(
          entitlementAt.getTime()
        )
      })

      it("refuses a second live scheduled cycle for one subscription in the database", async () => {
        const container = getContainer()
        const renewalModule =
          container.resolve<RenewalModuleService>(RENEWAL_MODULE)

        const subscription = await createSubscriptionSeed(container, {
          reference: `SUB-UNIQUE-${Date.now()}`,
          status: SubscriptionStatus.ACTIVE,
          next_renewal_at: new Date("2026-12-24T10:00:00.000Z"),
        })

        await createRenewalCycleSeed(container, {
          subscription_id: subscription.id,
          scheduled_for: new Date("2026-12-24T10:00:00.000Z"),
        })

        const duplicate = await createRenewalCycleSeed(container, {
          subscription_id: subscription.id,
          scheduled_for: new Date("2027-01-24T10:00:00.000Z"),
        }).then(
          () => null,
          (error: Error) => error
        )

        // renewal_cycle_one_scheduled_per_subscription, reported by the DAL as a
        // uniqueness violation on subscription_id
        expect(duplicate).toBeInstanceOf(Error)
        expect(duplicate?.message).toMatch(
          /Renewal cycle with subscription_id: .*, already exists\./
        )

        // The predicate is partial on purpose: a terminal row for the same
        // subscription stays legal, so dunning retries are not affected.
        await createRenewalCycleSeed(container, {
          subscription_id: subscription.id,
          scheduled_for: new Date("2027-02-24T10:00:00.000Z"),
          status: RenewalCycleStatus.FAILED,
        })

        const liveCycles = await renewalModule.listRenewalCycles({
          subscription_id: subscription.id,
        })

        expect(liveCycles).toHaveLength(2)
        expect(
          liveCycles.filter(
            (record) => record.status === RenewalCycleStatus.SCHEDULED
          )
        ).toHaveLength(1)
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
