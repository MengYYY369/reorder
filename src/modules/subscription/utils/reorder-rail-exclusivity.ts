import type { MedusaContainer } from "@medusajs/framework/types"
import { SUBSCRIPTION_MODULE } from ".."
import type SubscriptionModuleService from "../service"
import { SubscriptionStatus } from "../types"
import {
  TRACK_OCCUPYING_SUBSCRIPTION_STATUSES,
  isNativeSubscriptionReference,
} from "./native-subscription"
import { readPaymentProviderId } from "./payment-context"

/**
 * The reorder-rail half of the checkout-completion exclusion rule (T8).
 *
 * `native-exclusivity.ts` is the provider-owned half: its reader matches only
 * `NATIVE-` mirror rows, and its header names it as native-only. This sibling
 * is that reader's exact mirror for this plugin's own rows, so the completion
 * gate can refuse a checkout whose product a live subscription already
 * occupies — whichever rail the existing subscription runs on. The two
 * directions must not disagree about what "already subscribed" means: the
 * occupying status set is literally the same constant (renamed from
 * `TRACK_OCCUPYING_NATIVE_STATUSES` to a rail-neutral name, value unchanged).
 *
 * The rail split is the `NATIVE-` reference prefix, negated: `reference` is
 * NOT NULL, unique and indexed, so "not a native reference" has no NULL row to
 * disagree about. `native-subscription.ts` records why prefix matching on
 * `reference` — here its negation — is the only allowed test, never the
 * `mechanism` value inside the nullable `payment_context` jsonb.
 *
 * The negation is applied in this reader rather than pushed down as
 * `reference: { $not: { $like: … } }`: on the pinned stack (Medusa 2.20.0,
 * MikroORM 6.6.14) that filter reaches knex unexpanded and dies with
 * `DriverException: The operator "not" is not permitted` — measured, not
 * assumed. MikroORM 6.6.14's group operators are `$and`/`$or` only, so a SQL
 * NOT LIKE is not expressible through the module's filter path. The customer
 * and status predicates below stay pushed down (both indexed); the excluded
 * set is at most every subscription the one customer holds, and
 * `findBlockingReorderRailRow` re-checks the reference anyway, so no mirror
 * row can block through this rule even if this filter regressed.
 *
 * Like the native reader, errors propagate on purpose: failing open is a
 * decision, and it belongs to the caller (`resolveCheckoutGate`), not to this
 * read.
 */

/** A subscription row as far as this rule is concerned. */
export type ReorderRailRowCandidate = {
  id: string
  reference: string
  status: string
  product_id: string
  /**
   * Read for the checkout gate's subscription-track exception (ticket 12 /
   * D12). `is_trial` and `payment_context` decide whether a live row is one a
   * repeat purchase folds into; the occupying-status rule itself never reads
   * them.
   */
  is_trial?: boolean | null
  payment_context?: Record<string, unknown> | null
}

/**
 * Whether the checkout gate may let a subscription-track purchase through onto
 * this live row instead of refusing it (ticket 12 / D12).
 *
 * The predicate is a STRICT SUBSET of `resolveExtendTarget`'s fold set
 * (`stacking.ts`): that fold takes any non-native ACTIVE row, and this takes
 * only the shapes a repeat purchase can actually extend without leaving
 * undefined billing semantics behind —
 *
 * - a live trial row (`ACTIVE` + `is_trial`), which the extend converts to a
 *   paid row, and
 * - a paid live row (`ACTIVE` + not a trial + a stored provider id, i.e. the
 *   vaulted/epay rails), which the extend stacks onto.
 *
 * A trial row qualifies whether or not it has bound a payment method. An
 * earlier version of this predicate admitted only the card-free shape, on the
 * grounds that a bound auto trial "would double-charge against the method it
 * already holds" — that assumed the row keeps two independent charge dates, and
 * it does not. `extendSubscriptionRenewalDate` moves the anchor
 * (`next_renewal_at`), `ensureNextRenewalCycleStep` reconciles the upcoming
 * cycle onto it by role (`resolveUpcomingCycle`'s `adopt`, not a date-equality
 * match), and `process-renewal-cycle` refuses any cycle dated before
 * `trial_ends_at` — so the conversion charge *is* the slot the prepaid cadence
 * moved, and the extend clears `is_trial` / `trial_ends_at` on the way through.
 * The refusal made the ordinary production shape (a trial that has bound a
 * method, so its `payment_mode` is `auto`) unpayable: the customer's money
 * moved and the completion gate then answered `400 not_allowed`.
 *
 * The residual risk the old wording gestured at is `resolveUpcomingCycle`'s
 * `defer` branch, which refuses to move a cycle whose renewal order is already
 * in flight and so can leave two chargeable slots for one period. That window
 * is not a trial property — this predicate already admits paid rows, and a paid
 * row carries an in-flight order exactly as a bound trial can — and for a trial
 * whose `trial_ends_at` is still in the future it is unreachable, because the
 * eligibility gate in `process-renewal-cycle` refuses to process a cycle before
 * that date.
 *
 * Everything the fold would take but this refuses keeps the strict exclusion:
 * a redemption row (no provider id, its free period ends at
 * `cancel_effective_at`) would extend into undefined billing, and a PAUSED row
 * is not `ACTIVE` so the fold would `create` a second live row for the same
 * product. The subset property is pinned by `checkout-gate.spec.ts`, so a
 * change to the fold that this predicate does not follow reddens there rather
 * than at a customer's checkout.
 */
export function isFoldableReorderRailRow(
  row: ReorderRailRowCandidate
): boolean {
  if (isNativeSubscriptionReference(row.reference)) {
    return false
  }

  if (row.status !== SubscriptionStatus.ACTIVE) {
    return false
  }

  if (row.is_trial) {
    return true
  }

  return readPaymentProviderId(row.payment_context) !== null
}

/**
 * Every live subscription this customer holds on the reorder rail.
 *
 * The one place the inverted rail split is written, mirroring
 * `findLiveNativeRecurrences`. The checkout-completion gate reads it beside
 * the native reader so a live vault row — or a live trial row, which is an
 * ordinary active row — blocks a second subscription for the same product.
 */
export async function findLiveReorderRailSubscriptions(
  container: MedusaContainer,
  input: { customer_id: string }
): Promise<ReorderRailRowCandidate[]> {
  const subscriptionModule = container.resolve<SubscriptionModuleService>(
    SUBSCRIPTION_MODULE
  )

  const rows = (await subscriptionModule.listSubscriptions({
    customer_id: input.customer_id,
    status: [...TRACK_OCCUPYING_SUBSCRIPTION_STATUSES],
  })) as ReorderRailRowCandidate[]

  return rows.filter((row) => !isNativeSubscriptionReference(row.reference))
}

/**
 * The reorder-rail rule both directions of the checkout gate ask: does this
 * customer have a live subscription row for any of these products?
 *
 * Mirrors `findBlockingNativeRow` shape for shape, including its defense in
 * depth: the pushdown already excludes `NATIVE-` rows, and the reference
 * re-check here keeps a mirror row from ever blocking through this rule even
 * if a defective read handed one over — the native mirror rows are the other
 * reader's job, and the two rules must stay disjoint.
 *
 * @param productIds the products being purchased; a mixed cart is rejected as a
 *   whole, but the caller needs to name the colliding product in the message.
 */
export function findBlockingReorderRailRow<T extends ReorderRailRowCandidate>(
  rows: T[],
  productIds: Iterable<string>
): T | null {
  const wanted = new Set(productIds)

  for (const row of rows) {
    if (
      !isNativeSubscriptionReference(row.reference) &&
      (TRACK_OCCUPYING_SUBSCRIPTION_STATUSES as readonly string[]).includes(
        row.status
      ) &&
      wanted.has(row.product_id)
    ) {
      return row
    }
  }

  return null
}
