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

/**
 * The partial unique index `Migration20260924120000` installs: at most one live
 * `SCHEDULED` cycle per subscription. Every case below that needs the shape the
 * retire exists for — a free stale row beside the row the step chooses — has to
 * put it on the table with this index down, because two live `SCHEDULED` rows
 * are exactly what the constraint rejects.
 */
const UPCOMING_CYCLE_INDEX = "renewal_cycle_one_scheduled_per_subscription"

/** The index, re-created with the statement the migration itself ends on. */
const UPCOMING_CYCLE_INDEX_SQL =
  `create unique index "${UPCOMING_CYCLE_INDEX}" on "renewal_cycle" ("subscription_id")` +
  ` where "status" = 'scheduled' and "deleted_at" is null`

/**
 * The phrase only the retire's own warnings carry. The `defer` branch's warning
 * names the same protected row the retirement names as `madeRoomFor`, so an id
 * filter cannot tell the two lines apart and this one can.
 */
const RETIRE_WARNING_MARKER = "stale upcoming renewal cycle"

/**
 * The app's own database handle. Medusa registers the suite connection as a knex
 * instance, whose `raw()` resolves an envelope carrying `rows` rather than the
 * bare array the migration harness's MikroORM manager returns.
 */
type PgConnectionHandle = {
  raw(sql: string): Promise<unknown>
}

/** How an unknown rejection reads when it has to be reported inside another error. */
function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}

/** The knex half of the two-driver pair: the envelope around a select. */
function rowsFromRaw(result: unknown): Array<Record<string, unknown>> {
  const rows = (result as { rows?: unknown }).rows

  if (!Array.isArray(rows)) {
    throw new TypeError(
      "knex raw() did not resolve to an object carrying a rows array"
    )
  }

  return rows.filter(
    (row): row is Record<string, unknown> =>
      typeof row === "object" && row !== null
  )
}

/**
 * How many rows `pg_indexes` carries for the one-live-cycle index: one while it
 * stands, none while a window has it down. Read after every window below so a
 * case that seeded outside the constraint cannot pass on a suite database left
 * in the drifted shape.
 */
async function upcomingCycleIndexRowCount(
  container: MedusaContainer
): Promise<number> {
  const raw = await container
    .resolve<PgConnectionHandle>(ContainerRegistrationKeys.PG_CONNECTION)
    .raw(
      `select indexname from pg_indexes where indexname = '${UPCOMING_CYCLE_INDEX}'`
    )

  return rowsFromRaw(raw).length
}

/**
 * Runs `use` with the one-live-cycle index down, then puts it back.
 *
 * The window is the only place the retire's own shape can be put on the table:
 * the constraint is what stops a second chargeable `SCHEDULED` row from being
 * written, and the rows the selector names are that second row. The re-create is
 * NOT hygiene, it is half of the assertion — `use` has already run the workflow,
 * so a stale row the step failed to retire is still live at this statement and
 * the index comes back as `could not create unique index ... is duplicated`. A
 * case that retired nothing therefore cannot pass by forgetting to restore, and
 * it cannot be repaired by dropping the restore either. When the body already
 * failed, its error is the one reported and the restore problem is appended to
 * it rather than replacing it.
 */
async function withUpcomingCycleIndexDropped(
  container: MedusaContainer,
  use: () => Promise<void>
): Promise<void> {
  const connection = container.resolve<PgConnectionHandle>(
    ContainerRegistrationKeys.PG_CONNECTION
  )

  await connection.raw(`drop index if exists "${UPCOMING_CYCLE_INDEX}"`)

  let bodyFailure: { error: unknown } | undefined

  try {
    await use()
  } catch (error) {
    bodyFailure = { error }
    throw error
  } finally {
    try {
      await connection.raw(UPCOMING_CYCLE_INDEX_SQL)
    } catch (restoreError) {
      const note =
        `re-creating "${UPCOMING_CYCLE_INDEX}" after the window failed, which means a ` +
        `second live SCHEDULED cycle is still on the table: ${describeError(
          restoreError
        )}`

      if (bodyFailure === undefined) {
        throw new Error(note)
      }

      if (bodyFailure.error instanceof Error) {
        bodyFailure.error.message = `${bodyFailure.error.message} [teardown: ${note}]`
        throw bodyFailure.error
      }

      throw new Error(`${describeError(bodyFailure.error)} [teardown: ${note}]`)
    }
  }
}

/**
 * The lines a run wrote about the retire set: the retirement itself, the
 * withheld report, and the rollback that undid one.
 */
function retireWarningsOf(warnings: string[]): string[] {
  return warnings.filter((message) => message.includes(RETIRE_WARNING_MARKER))
}

/** The lines naming one row that are NOT about the retire set. */
function warningsAboutRow(warnings: string[], rowId: string): string[] {
  return warnings.filter(
    (message) =>
      message.includes(rowId) && !message.includes(RETIRE_WARNING_MARKER)
  )
}

/** One captured cycle row by id, or a failure naming the row that is missing. */
function cycleRowById<T extends { id: string }>(rows: T[], id: string): T {
  const row = rows.find((candidate) => candidate.id === id)

  if (row === undefined) {
    throw new Error(`no renewal_cycle row came back for '${id}'`)
  }

  return row
}

/**
 * A persisted date as a comparable number. Throws on a missing column rather
 * than reading through `null`, because `new Date(null)` is the epoch: a write
 * that never landed would then fail as a wrong date instead of as the absent
 * value it is.
 */
function timeOf(
  value: Date | string | null | undefined,
  what: string
): number {
  if (value == null) {
    throw new Error(`${what} came back null or missing`)
  }

  return new Date(value).getTime()
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

      it("adopts the one open row and retires nothing when the entitlement date moved", async () => {
        const container = getContainer()

        const entitlementAt = new Date("2026-11-24T10:00:00.000Z")
        // The row sits on the date the purchase moved AWAY from. The selector
        // checks for an exact-date hit before it considers anything else, so a
        // seed on `entitlementAt` would resolve `match` and the `adopt` branch
        // under test would never run.
        const driftedAt = new Date("2026-10-24T10:00:00.000Z")

        const subscription = await createSubscriptionSeed(container, {
          reference: `SUB-ADOPT-NO-RETIRE-${Date.now()}`,
          status: SubscriptionStatus.ACTIVE,
          next_renewal_at: entitlementAt,
        })

        const open = await createRenewalCycleSeed(container, {
          subscription_id: subscription.id,
          scheduled_for: driftedAt,
        })

        // No index window anywhere in this case: one live `SCHEDULED` row is the
        // shape the constraint exists to keep, which is what makes this the
        // negative half of the retire. The row the run chose is the only row the
        // subscription has, so a retire that fired on `existingCycles` instead of
        // on the selector's set would soft-delete the renewal itself and redden
        // every expectation below.
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
          action: "adopted",
          subscription_id: subscription.id,
          renewal_cycle_id: open.id,
        })

        const rowsAfter = await captureRenewalCycleRows(
          container,
          subscription.id
        )

        // One row before, one row after, the same id, none of them deleted:
        // `adopt` is a reschedule, and a delete-and-recreate satisfies the date
        // below while breaking this.
        expect(rowsAfter.map((row) => row.id)).toEqual(
          rowsBefore.map((row) => row.id)
        )
        expect(rowsAfter.map((row) => row.deleted)).toEqual([false])
        expect(cycleRowById(rowsAfter, open.id).scheduled_for).toEqual(
          entitlementAt.getTime()
        )

        // And the run says so: an empty retire set writes nothing and therefore
        // claims nothing, neither retired nor withheld.
        expect(retireWarningsOf(warnings)).toEqual([])
        expect(warnings).toEqual([])
      })

      /**
       * The third shape the step's `retire` can carry, and the only one a host
       * reaches WITHOUT anybody dropping an index: the partial unique constraint
       * covers live `scheduled` rows only, so a `SUCCEEDED` row sitting exactly on
       * the entitlement date with one free `scheduled` neighbour behind it is a
       * state a migrated database holds legally — which is precisely what the
       * normalization in `migrations.spec.ts` leaves behind (its CTE filters
       * `status = 'scheduled'`, so it never touches a terminal row) and what
       * `resolveUpcomingCycle`'s pinned contract refuses to adopt.
       *
       * The other two retire cases had to drop the index to seed at all; this one
       * asserts the index is up before it seeds, so the whole case doubles as
       * proof that the shape is reachable in production without any drift.
       */
      it("retires the stale neighbour behind the terminal row that owns the entitlement date", async () => {
        const container = getContainer()
        const renewalModule =
          container.resolve<RenewalModuleService>(RENEWAL_MODULE)

        const entitlementAt = new Date("2026-11-24T10:00:00.000Z")
        const staleAt = new Date("2026-09-24T10:00:00.000Z")

        const subscription = await createSubscriptionSeed(container, {
          reference: `SUB-RETIRE-MATCH-${Date.now()}`,
          status: SubscriptionStatus.ACTIVE,
          next_renewal_at: entitlementAt,
        })

        // Asserted rather than assumed: with the constraint down this case would
        // prove nothing about the shape being reachable, and a leaked window from
        // an earlier case would be exactly that failure.
        expect(await upcomingCycleIndexRowCount(container)).toBe(1)

        const settledOrderId = `order_settled_${Date.now()}`

        const settled = await createRenewalCycleSeed(container, {
          subscription_id: subscription.id,
          scheduled_for: entitlementAt,
          processed_at: entitlementAt,
          status: RenewalCycleStatus.SUCCEEDED,
          generated_order_id: settledOrderId,
        })

        const stale = await createRenewalCycleSeed(container, {
          subscription_id: subscription.id,
          scheduled_for: staleAt,
        })

        // The before/after pair around the scheduler's own read, so the absence
        // below cannot be satisfied by the row never having been visible: the
        // exclusion list (manual mode, native mirrors) does not apply to this
        // subscription, and `staleAt` is in the past, so a live row here IS one the
        // scheduler would charge on the next tick.
        const dueBefore = await listDueRenewalCyclesForProcessing(container, {
          limit: 500,
          offset: 0,
        })

        expect(dueBefore.cycles.map((cycle) => cycle.id)).toContain(stale.id)

        const {
          value: { result },
          warnings,
        } = await captureWarnings(container, () =>
          ensureNextRenewalCycleWorkflow(container).run({
            input: { subscription_id: subscription.id },
          })
        )

        // `retired`, not `noop`: a row went, and a run that cleared a chargeable
        // cycle while reporting nothing-happened would make the field signal the
        // whole feature exists for say the opposite of what it did.
        expect(result).toMatchObject({
          action: "retired",
          subscription_id: subscription.id,
          renewal_cycle_id: settled.id,
        })

        const rowsAfter = await captureRenewalCycleRows(
          container,
          subscription.id
        )

        // The terminal row is not a candidate for anything: the settled period
        // keeps its date, its order and its row.
        expect(cycleRowById(rowsAfter, settled.id)).toMatchObject({
          status: RenewalCycleStatus.SUCCEEDED,
          generated_order_id: settledOrderId,
          deleted: false,
        })
        expect(cycleRowById(rowsAfter, settled.id).scheduled_for).toEqual(
          entitlementAt.getTime()
        )

        // Soft, not hard — and nothing else moved: both rows are still on the
        // table, only one of them is no longer chargeable.
        expect(cycleRowById(rowsAfter, stale.id).deleted).toBe(true)
        expect(cycleRowById(rowsAfter, stale.id).scheduled_for).toEqual(
          staleAt.getTime()
        )
        expect(rowsAfter.map((row) => row.id).sort()).toEqual(
          [settled.id, stale.id].sort()
        )

        expect(
          await renewalModule.listRenewalCycles({
            subscription_id: subscription.id,
          })
        ).toHaveLength(1)

        const dueAfter = await listDueRenewalCyclesForProcessing(container, {
          limit: 500,
          offset: 0,
        })

        expect(dueAfter.cycles.map((cycle) => cycle.id)).not.toContain(stale.id)

        expect(retireWarningsOf(warnings)).toEqual([
          "[reorder] retired 1 stale upcoming renewal cycle(s) of subscription " +
            `'${subscription.id}' (${stale.id}) behind '${settled.id}'`,
        ])
        // The settled row is the one the retirement names as made room for, so an
        // id filter alone would read the retirement as a second untouched-row
        // warning; the pin above and the text marker are what keep the two apart.
        expect(warningsAboutRow(warnings, settled.id)).toEqual([])
      })

      it("defers the in-flight row and retires the unrelated stale neighbour", async () => {
        const container = getContainer()
        const renewalModule =
          container.resolve<RenewalModuleService>(RENEWAL_MODULE)
        const subscriptionModule = container.resolve<SubscriptionModuleService>(
          SUBSCRIPTION_MODULE
        )

        const entitlementAt = new Date("2026-11-24T10:00:00.000Z")
        // The in-flight row is NOT on the entitlement date: `defer` is only
        // reached when `findUpcomingRenewalCycle` misses, and a seed at
        // `entitlementAt` resolves `match` instead — the case would then prove
        // the deferral branch never entered. It is also the LATER of the two
        // rows, because `preferLaterCycle` picks the candidate: a free row in
        // front of it would be adopted, and the deferral would name the wrong
        // row as protected.
        const inFlightAt = new Date("2026-12-24T10:00:00.000Z")
        const staleAt = new Date("2026-09-24T10:00:00.000Z")

        const subscription = await createSubscriptionSeed(container, {
          reference: `SUB-RETIRE-DEFER-${Date.now()}`,
          status: SubscriptionStatus.ACTIVE,
          next_renewal_at: entitlementAt,
        })

        const outstandingOrderId = `order_outstanding_${Date.now()}`

        await withUpcomingCycleIndexDropped(container, async () => {
          const stale = await createRenewalCycleSeed(container, {
            subscription_id: subscription.id,
            scheduled_for: staleAt,
          })

          const inFlight = await createRenewalCycleSeed(container, {
            subscription_id: subscription.id,
            scheduled_for: inFlightAt,
            generated_order_id: outstandingOrderId,
          })

          const rowsBefore = await captureRenewalCycleRows(
            container,
            subscription.id
          )

          // Both rows really are live and chargeable before the run:
          // `listDueRenewalCyclesForProcessing` selects `scheduled` with
          // `deleted_at` null, so two of them is one customer charged twice.
          expect(
            rowsBefore
              .filter((row) => !row.deleted)
              .map((row) => row.id)
              .sort()
          ).toEqual([inFlight.id, stale.id].sort())

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

          const rowsAfter = await captureRenewalCycleRows(
            container,
            subscription.id
          )

          // The protected row: same id, still live, still on its own date, still
          // carrying the order in flight. Refusing to move it is the promise the
          // branch makes, and the retirement beside it must not break it.
          const survivor = cycleRowById(rowsAfter, inFlight.id)
          expect(survivor).toMatchObject({
            status: RenewalCycleStatus.SCHEDULED,
            generated_order_id: outstandingOrderId,
            deleted: false,
          })
          expect(survivor.scheduled_for).toEqual(inFlightAt.getTime())

          // The neighbour: retired, so it keeps its row and its children and the
          // scheduler stops seeing it. A hard delete would leave this case green
          // on the live set and break the history the soft delete exists for.
          const retiredRow = cycleRowById(rowsAfter, stale.id)
          expect(retiredRow.deleted).toBe(true)
          expect(retiredRow.scheduled_for).toEqual(staleAt.getTime())
          expect(rowsAfter.map((row) => row.id).sort()).toEqual(
            [inFlight.id, stale.id].sort()
          )

          const liveScheduledAfter = rowsAfter.filter(
            (row) =>
              !row.deleted && row.status === RenewalCycleStatus.SCHEDULED
          )
          expect(liveScheduledAfter.map((row) => row.id)).toEqual([inFlight.id])
          expect(
            await renewalModule.listRenewalCycles({
              subscription_id: subscription.id,
            })
          ).toHaveLength(1)

          // The two lines that name the protected row, told apart by `stale`:
          // the deferral warning this run is expected to write, and exactly one
          // retirement. Nothing was withheld, so the retire set went whole.
          const deferralWarnings = warningsAboutRow(warnings, inFlight.id)
          expect(deferralWarnings).toHaveLength(1)
          expect(deferralWarnings[0]).toContain(outstandingOrderId)
          expect(deferralWarnings[0]).toContain(subscription.id)
          expect(deferralWarnings[0]).toContain(entitlementAt.toISOString())

          expect(retireWarningsOf(warnings)).toEqual([
            "[reorder] retired 1 stale upcoming renewal cycle(s) of subscription " +
              `'${subscription.id}' (${stale.id}) behind '${inFlight.id}'`,
          ])

          // The subscription keeps the date the deferral refused to chase.
          const [persisted] = await subscriptionModule.listSubscriptions({
            id: subscription.id,
          })
          expect(timeOf(persisted.next_renewal_at, "next_renewal_at")).toEqual(
            entitlementAt.getTime()
          )
        })

        // Restored, and asserted rather than assumed: the window above already
        // could not close over a second live row, and a case that never tried to
        // reopen it would leave the suite database one index short for every
        // later case in this file.
        expect(await upcomingCycleIndexRowCount(container)).toBe(1)
      })

      it("retires the stale neighbour the adopted row made room for", async () => {
        const container = getContainer()

        const entitlementAt = new Date("2026-11-24T10:00:00.000Z")
        // The candidate is the latest open row and carries no order, so the
        // resolution is `adopt`; the older one is the neighbour the selector
        // names and this run has to clear. Neither sits on the entitlement date,
        // which is what keeps the resolution away from `match`.
        const candidateAt = new Date("2026-12-24T10:00:00.000Z")
        const staleAt = new Date("2026-09-24T10:00:00.000Z")

        const subscription = await createSubscriptionSeed(container, {
          reference: `SUB-RETIRE-ADOPT-${Date.now()}`,
          status: SubscriptionStatus.ACTIVE,
          next_renewal_at: entitlementAt,
        })

        await withUpcomingCycleIndexDropped(container, async () => {
          const stale = await createRenewalCycleSeed(container, {
            subscription_id: subscription.id,
            scheduled_for: staleAt,
          })

          const adopted = await createRenewalCycleSeed(container, {
            subscription_id: subscription.id,
            scheduled_for: candidateAt,
          })

          const {
            value: { result },
            warnings,
          } = await captureWarnings(container, () =>
            ensureNextRenewalCycleWorkflow(container).run({
              input: { subscription_id: subscription.id },
            })
          )

          expect(result).toMatchObject({
            action: "adopted",
            subscription_id: subscription.id,
            renewal_cycle_id: adopted.id,
          })

          const rowsAfter = await captureRenewalCycleRows(
            container,
            subscription.id
          )

          // The reconciliation write and the retire are one run: the row the run
          // moved follows the entitlement date, and the row it moved past stops
          // standing for a charge. Either half on its own leaves two live
          // `SCHEDULED` rows, which the window below reports directly.
          expect(cycleRowById(rowsAfter, adopted.id)).toMatchObject({
            deleted: false,
            status: RenewalCycleStatus.SCHEDULED,
          })
          expect(cycleRowById(rowsAfter, adopted.id).scheduled_for).toEqual(
            entitlementAt.getTime()
          )
          expect(cycleRowById(rowsAfter, stale.id).deleted).toBe(true)
          expect(rowsAfter.map((row) => row.id).sort()).toEqual(
            [adopted.id, stale.id].sort()
          )

          expect(retireWarningsOf(warnings)).toEqual([
            "[reorder] retired 1 stale upcoming renewal cycle(s) of subscription " +
              `'${subscription.id}' (${stale.id}) behind '${adopted.id}'`,
          ])
          expect(warningsAboutRow(warnings, adopted.id)).toEqual([])
        })

        expect(await upcomingCycleIndexRowCount(container)).toBe(1)
      })

      it("rolls the applied adopt back when the retirement fails mid-run", async () => {
        const container = getContainer()
        const renewalModule =
          container.resolve<RenewalModuleService>(RENEWAL_MODULE)

        const entitlementAt = new Date("2026-11-24T10:00:00.000Z")
        const candidateAt = new Date("2026-12-24T10:00:00.000Z")
        const staleAt = new Date("2026-09-24T10:00:00.000Z")

        const subscription = await createSubscriptionSeed(container, {
          reference: `SUB-RETIRE-ROLLBACK-${Date.now()}`,
          status: SubscriptionStatus.ACTIVE,
          next_renewal_at: entitlementAt,
        })

        await withUpcomingCycleIndexDropped(container, async () => {
          const stale = await createRenewalCycleSeed(container, {
            subscription_id: subscription.id,
            scheduled_for: staleAt,
          })

          const adopted = await createRenewalCycleSeed(container, {
            subscription_id: subscription.id,
            scheduled_for: candidateAt,
          })

          // I-4 end to end. The module spec pins that a failed retire is
          // reported as a permanent step failure carrying the snapshot; what only
          // a driven workflow can show is that the engine then runs this step's
          // rollback off that stored response instead of leaving the applied
          // write in place. The container hands out the module service as a
          // singleton, so the instance the step resolves is the one spied here —
          // the same seam the metadata-write case above uses on the subscription
          // module. `run` throws on a failed step by default
          // (`workflow-export.js:99`), and the rejection is captured rather than
          // allowed to propagate so the log and the rows can still be read.
          const softDeleteSpy = jest
            .spyOn(renewalModule, "softDeleteRenewalCycles")
            .mockRejectedValue(new Error("connection terminated unexpectedly"))

          const {
            value: runFailure,
            warnings,
          } = await captureWarnings(container, () =>
            ensureNextRenewalCycleWorkflow(container)
              .run({ input: { subscription_id: subscription.id } })
              .then(
                () => null,
                (error: Error) => error
              )
          ).finally(() => {
            softDeleteSpy.mockRestore()
          })

          const rowsAfter = await captureRenewalCycleRows(
            container,
            subscription.id
          )

          // The write that landed is gone: the row is back on the date it was
          // seeded with, not the entitlement date the `adopt` moved it to. This is
          // the whole of I-4 and it is asserted FIRST, because a reverted fix
          // leaves the row on `entitlementAt` and that leak — not the shape of the
          // error — is what a reader has to see. A step that threw instead of
          // reporting a permanent failure never compensates, so the row would stay
          // moved while the run still "failed".
          expect(cycleRowById(rowsAfter, adopted.id)).toMatchObject({
            deleted: false,
            status: RenewalCycleStatus.SCHEDULED,
          })
          expect(cycleRowById(rowsAfter, adopted.id).scheduled_for).toEqual(
            candidateAt.getTime()
          )

          // The run did fail, and it failed at the retire rather than somewhere
          // else in the workflow.
          expect(runFailure?.message ?? "").toContain("failed to retire")

          // The retire never landed either, and the rollback still said what it
          // did: no retirement line, and a restore line naming the row it brought
          // back, so the log cannot read as a retirement that stuck.
          expect(cycleRowById(rowsAfter, stale.id).deleted).toBe(false)
          expect(
            await renewalModule.listRenewalCycles({
              subscription_id: subscription.id,
            })
          ).toHaveLength(2)
          expect(retireWarningsOf(warnings)).toEqual([])
          expect(
            warnings.filter((message) =>
              message.includes("the retirement was rolled back")
            )
          ).toEqual([
            "[reorder] restored 1 retired upcoming renewal cycle(s) " +
              `(${stale.id}) — the retirement was rolled back and these rows are ` +
              "chargeable again",
          ])

          // Both rows are live again, which is exactly what the rollback
          // guarantees, so the window cannot close over them. This case's own rows
          // go first — a hard delete, since nothing here is a retirement to
          // measure — and the re-create below still gets to enforce the constraint
          // every later case in this file depends on.
          await renewalModule.deleteRenewalCycles([stale.id, adopted.id])
        })

        expect(await upcomingCycleIndexRowCount(container)).toBe(1)
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
