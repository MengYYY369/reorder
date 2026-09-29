import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import type { MedusaContainer } from "@medusajs/framework/types"
import { SUBSCRIPTION_MODULE } from ".."
import type SubscriptionModuleService from "../service"
import {
  TRACK_OCCUPYING_SUBSCRIPTION_STATUSES,
  isNativeSubscriptionReference,
} from "./native-subscription"

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
