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
