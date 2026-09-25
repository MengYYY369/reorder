import type { PlanOfferRowStackingPolicy } from "../../plan-offer/types"
import {
  SubscriptionFrequencyInterval,
  SubscriptionStatus,
} from "../types"
import { addSubscriptionCadence } from "./effective-next-renewal"
import { isNativeSubscriptionReference } from "./native-subscription"
import { SUBSCRIPTION_MODULE } from ".."
import type SubscriptionModuleService from "../service"

/**
 * Repeat-purchase handling for one customer and one product (R1).
 *
 * Buying the same product again must extend the subscription the customer
 * already has instead of opening a second row: two active rows on one product
 * each carry their own renewal date, so the customer is charged twice in
 * overlapping windows and nothing about either row says so. The merge key is
 * `customer_id + product_id`, deliberately not the variant — a customer moving
 * from monthly to annual on the same product is continuing one relationship, and
 * keying on the variant is what would silently start the second row again.
 */

/** Cumulative cadence units purchased on one row, the stacking ceiling's unit. */
export const STACKING_CYCLES_METADATA_KEY = "cycles_purchased"

/**
 * The row as the stacking decision consumes it: the fields the merge, the
 * ceiling and the consent flip read, and nothing else. Deliberately narrower
 * than `StackingSubscriptionRecord` below — that one is what the module returns,
 * this one is what this file is allowed to depend on. `resolveStackingDecision`
 * hands one to the other at its call site, which is where the compiler checks
 * that the service still answers with every field the decision reads,
 * `reference` included.
 */
export type ExtendableSubscription = {
  id: string
  reference: string
  status: string
  started_at: string | Date | null
  next_renewal_at: string | Date | null
  metadata: Record<string, unknown> | null
  payment_context: Record<string, unknown> | null
}

export type ExtendTarget = {
  action: "extend" | "create"
  subscription: ExtendableSubscription | null
}

/**
 * The whole query `resolveStackingDecision` runs: one customer, one product.
 *
 * Declared here because the read is narrow on purpose, and it is annotated on the
 * object the module is called with. It is not policed by the service type: the
 * generated `listSubscriptions` takes its filters structurally, so `any` is what
 * the parameter really is. What pins it is the spec's `toHaveBeenCalledWith`,
 * which is also why the shape gets a name.
 */
export type StackingSubscriptionFilter = {
  customer_id: string
  product_id: string
  status: SubscriptionStatus[]
}

/**
 * The module surface the repeat-purchase read uses: `listSubscriptions` named on
 * the subscription module service, picked where it is declared.
 *
 * This replaced a reader that restated the method locally
 * (`listSubscriptions(filter: StackingSubscriptionFilter): Promise<…>`), and the
 * difference is which side has to agree. Restating it meant the type checked
 * nothing the container had to satisfy — the module is resolved by string key —
 * so renaming or re-signing `listSubscriptions` on the service degraded from a
 * compile error into a runtime `TypeError` inside the step: loud at checkout,
 * invisible to the unit suite, since `toHaveBeenCalledWith` pins the filter and
 * not the method's existence. Naming the service puts that failure back where the
 * compiler can see it, and it costs no cast: the generated method takes its
 * filters as `any` and hands back concrete records, so the narrow query and the
 * row shape line up on their own.
 *
 * The consumer still does not trust the read: `resolveConsentFlip` refuses a
 * reference it cannot read at runtime instead of treating its absence as
 * "not native".
 */
export type StackingSubscriptionReader = Pick<
  SubscriptionModuleService,
  "listSubscriptions"
>

/**
 * The row that read answers with, taken off the method rather than restated. The
 * fixtures in the spec are built at this width, so a fake cannot claim a row
 * shape the real service does not have; `ExtendableSubscription` above is the
 * narrower contract the decision logic consumes, and the call site handing one to
 * the other is the check that the two still line up.
 */
export type StackingSubscriptionRecord = Awaited<
  ReturnType<StackingSubscriptionReader["listSubscriptions"]>
>[number]

/**
 * A container able to hand out that reader; `MedusaContainer` satisfies it.
 *
 * The key is this module's own registration literal, not `string`: a `resolve`
 * that answered *any* key with the reader would hand the reader type to a lookup
 * of some other module, which is the same hole the generic
 * `resolve: <T>(key: string) => T` had. `SUBSCRIPTION_MODULE` is a `const`, so
 * this follows the registration if it ever moves.
 */
export type StackingContainer = {
  resolve: (key: typeof SUBSCRIPTION_MODULE) => StackingSubscriptionReader
}

export type StackingDecision = {
  extend_subscription_id: string | null
  /**
   * The reference of the row being folded into, or null when nothing is being
   * extended. Travels together with `extend_subscription_id`, because the
   * consumer that decides whether this purchase may start plugin charging
   * (`resolveConsentFlip`) decides on the reference and on nothing else: a
   * decision which extended a row without naming it used to leave that caller
   * passing nothing, and nothing read as "not native". It reads as
   * "undecidable" now, which strands the purchase instead of double-billing it —
   * naming the row here is what keeps that branch unreachable from checkout.
   */
  extend_subscription_reference: string | null
  total_cycles: number
  /**
   * The row being folded into, as it stands before this purchase. The consent
   * flip needs it (mode, mechanism, and whether a chargeable method is already
   * stored) and it must not be re-read by the caller.
   */
  existing_payment_context: Record<string, unknown> | null
  /**
   * Checked before anything is written so checkout can refuse the purchase
   * instead of creating a second row or over-stacking the first one.
   */
  ceiling_exceeded: boolean
}

/**
 * The row a new purchase should fold into, if any.
 *
 * Provider-owned (`NATIVE-`) rows are never a target: extending a mirror row
 * would sell the customer a period that PayPal does not know about. The
 * exclusion runs on the reference through the single shared predicate, and only
 * after the query, because `payment_context` is jsonb and cannot carry this
 * filter safely.
 */
export function resolveExtendTarget(
  rows: ExtendableSubscription[],
  input: {
    customer_id: string
    product_id: string
    row_stacking_policy: "extend" | "allow_multiple"
  }
): ExtendTarget {
  if (input.row_stacking_policy === "allow_multiple") {
    return { action: "create", subscription: null }
  }

  const candidate = rows.find(
    (row) =>
      !isNativeSubscriptionReference(row.reference) &&
      row.status === SubscriptionStatus.ACTIVE
  )

  return candidate
    ? { action: "extend", subscription: candidate }
    : { action: "create", subscription: null }
}

/**
 * Anchor for the extension: the date the current period already ends at. A row
 * whose next_renewal_at was never resolved restarts from the purchase date
 * rather than guessing backwards.
 */
export function extendSubscriptionRenewalDate(
  currentNextRenewalAt: string | Date | null | undefined,
  purchasedAt: Date,
  interval: SubscriptionFrequencyInterval,
  value: number
): Date {
  const anchor = toValidDate(currentNextRenewalAt) ?? purchasedAt

  return addSubscriptionCadence(anchor, interval, value)
}

/** Cycles recorded on a row; rows predating the counter count as one period. */
export function readStackedCycles(
  metadata: Record<string, unknown> | null | undefined
): number {
  const raw = metadata?.[STACKING_CYCLES_METADATA_KEY]
  const cycles =
    typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN

  return Number.isInteger(cycles) && cycles > 0 ? cycles : 1
}

/** Metadata written alongside an extension or a new row. */
export function withStackedCycles(
  metadata: Record<string, unknown> | null | undefined,
  cycles: number
): Record<string, unknown> {
  return {
    ...(metadata ?? {}),
    [STACKING_CYCLES_METADATA_KEY]: cycles,
  }
}

/**
 * Ceiling check. `max` of null means unlimited; otherwise the purchase is
 * rejected when it would take the row past the configured number of
 * accumulated periods.
 */
export function exceedsStackingCeiling(input: {
  existing_cycles: number
  purchased_cycles: number
  max_stacking_cycles: number | null
}): boolean {
  if (input.max_stacking_cycles === null) {
    return false
  }

  return input.existing_cycles + input.purchased_cycles > input.max_stacking_cycles
}

/**
 * Read the customer's existing rows for one product and decide what a new
 * purchase should do with them.
 *
 * The query is intentionally narrow (customer + product + active) and the
 * native exclusion happens afterwards in `resolveExtendTarget`.
 *
 * The rows come back as `StackingSubscriptionRecord` and are handed to
 * `resolveExtendTarget` as `ExtendableSubscription[]` with no assertion between
 * them: that assignment is the check that the service still answers with every
 * field the decision reads, `reference` included.
 */
export async function resolveStackingDecision(
  container: StackingContainer,
  input: {
    customer_id: string
    product_id: string
    purchased_cycles: number
    row_stacking_policy: PlanOfferRowStackingPolicy
    max_stacking_cycles: number | null
  }
): Promise<StackingDecision> {
  const subscriptionModule = container.resolve(SUBSCRIPTION_MODULE)

  const filter: StackingSubscriptionFilter = {
    customer_id: input.customer_id,
    product_id: input.product_id,
    status: [SubscriptionStatus.ACTIVE],
  }

  const rows = await subscriptionModule.listSubscriptions(filter)

  const target = resolveExtendTarget(rows, input)

  if (target.action === "create" || !target.subscription) {
    return {
      extend_subscription_id: null,
      extend_subscription_reference: null,
      total_cycles: input.purchased_cycles,
      existing_payment_context: null,
      ceiling_exceeded: exceedsStackingCeiling({
        existing_cycles: 0,
        purchased_cycles: input.purchased_cycles,
        max_stacking_cycles: input.max_stacking_cycles,
      }),
    }
  }

  const existingCycles = readStackedCycles(target.subscription.metadata)
  const totalCycles = existingCycles + input.purchased_cycles

  return {
    extend_subscription_id: target.subscription.id,
    extend_subscription_reference: target.subscription.reference,
    total_cycles: totalCycles,
    existing_payment_context: target.subscription.payment_context ?? null,
    ceiling_exceeded: exceedsStackingCeiling({
      existing_cycles: existingCycles,
      purchased_cycles: input.purchased_cycles,
      max_stacking_cycles: input.max_stacking_cycles,
    }),
  }
}

function toValidDate(value: string | Date | null | undefined): Date | null {
  if (!value) {
    return null
  }

  const date = value instanceof Date ? value : new Date(value)

  return Number.isNaN(date.getTime()) ? null : date
}
