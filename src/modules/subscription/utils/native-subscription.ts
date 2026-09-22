import { SubscriptionStatus } from "../types"

/**
 * The one definition of "this subscription row mirrors a provider-owned
 * recurrence".
 *
 * A native row is written by the PayPal event bridge and gets a fixed
 * `NATIVE-{paypal_subscription_id}` reference. Reference-prefix matching is the
 * only allowed test, and it is deliberately not the `mechanism` value inside
 * `payment_context`:
 *
 * `payment_context` is a nullable jsonb column, and rows written before the
 * discriminator existed have no `mechanism` key at all. In SQL
 * `payment_context->>'mechanism'` then returns NULL, `NULL != 'native'` is NULL
 * rather than true, and an exclusion filter built on it silently drops **every**
 * existing row — the guard would look correct, pass a hand-built test, and do
 * nothing in production. `reference` is NOT NULL, unique and indexed, so the
 * same comparison is exact and can be pushed into the query.
 *
 * `mechanism` is still written on new rows as information for humans reading
 * the record; it must never be a query predicate.
 */
export const NATIVE_SUBSCRIPTION_REFERENCE_PREFIX = "NATIVE-"

/** SQL LIKE pattern matching every native mirror row. */
export const NATIVE_SUBSCRIPTION_REFERENCE_PATTERN = `${NATIVE_SUBSCRIPTION_REFERENCE_PREFIX}%`

export function isNativeSubscriptionReference(reference: unknown): boolean {
  return (
    typeof reference === "string" &&
    reference.startsWith(NATIVE_SUBSCRIPTION_REFERENCE_PREFIX)
  )
}

/**
 * Reference for a mirror row, or null when the event carries no provider id —
 * a native row without one could never be located again, so it must not be
 * created.
 */
export function buildNativeSubscriptionReference(
  providerSubscriptionId: unknown
): string | null {
  if (typeof providerSubscriptionId !== "string") {
    return null
  }

  const id = providerSubscriptionId.trim()

  return id ? `${NATIVE_SUBSCRIPTION_REFERENCE_PREFIX}${id}` : null
}

/** Push-down filter for "only native mirror rows". */
export function nativeSubscriptionReferenceFilter() {
  return {
    reference: {
      $like: NATIVE_SUBSCRIPTION_REFERENCE_PATTERN,
    },
  }
}

/**
 * A provider recurrence only occupies the billing track while it is running or
 * deliberately paused.
 *
 * `cancelled` and `past_due` are let through on purpose: a customer whose PayPal
 * charge just failed must keep the door open to buy the period themselves and
 * not lose their entitlement, and a subscription that ended months ago should
 * not lock the customer out for the rest of its nominal term.
 */
export const TRACK_OCCUPYING_NATIVE_STATUSES = [
  SubscriptionStatus.ACTIVE,
  SubscriptionStatus.PAUSED,
] as const

export type NativeRowCandidate = {
  id: string
  reference: string
  status: string
  product_id: string
}

/**
 * The one rule both checkout gates ask: does this customer have a live provider
 * recurrence for any of these products?
 *
 * @param productIds the products being purchased; a mixed cart is rejected as a
 *   whole, but the caller needs to name the colliding product in the message.
 */
export function findBlockingNativeRow<T extends NativeRowCandidate>(
  rows: T[],
  productIds: Iterable<string>
): T | null {
  const wanted = new Set(productIds)

  for (const row of rows) {
    if (
      isNativeSubscriptionReference(row.reference) &&
      (TRACK_OCCUPYING_NATIVE_STATUSES as readonly string[]).includes(row.status) &&
      wanted.has(row.product_id)
    ) {
      return row
    }
  }

  return null
}
