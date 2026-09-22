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

export type StackingDecision = {
  extend_subscription_id: string | null
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
 */
export async function resolveStackingDecision(
  container: { resolve: <T>(key: string) => T },
  input: {
    customer_id: string
    product_id: string
    purchased_cycles: number
    row_stacking_policy: PlanOfferRowStackingPolicy
    max_stacking_cycles: number | null
  }
): Promise<StackingDecision> {
  const subscriptionModule = container.resolve<SubscriptionModuleService>(
    SUBSCRIPTION_MODULE
  )

  const rows = (await subscriptionModule.listSubscriptions({
    customer_id: input.customer_id,
    product_id: input.product_id,
    status: [SubscriptionStatus.ACTIVE],
  } as never)) as unknown as ExtendableSubscription[]

  const target = resolveExtendTarget(rows, input)

  if (target.action === "create" || !target.subscription) {
    return {
      extend_subscription_id: null,
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
