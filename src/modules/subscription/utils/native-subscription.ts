import { SubscriptionStatus } from "../types"

/**
 * The one definition of "this subscription row mirrors a provider-owned
 * recurrence".
 *
 * A native row is written by the neutral rail event (`payment-rail.native_subscription.changed`)
 * or by the backfill, and gets a fixed `NATIVE-{kind}-{provider_subscription_id}`
 * reference — `kind` is the provider family (`paypal`), so a row says which rail
 * it belongs to without a join, and the provider's own id keeps its dashes.
 * Reference-prefix matching is the
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
 * The provider target of a native mirror row: which provider key owns it and
 * which of the provider's own subscription ids it stands for, or `null` when
 * the row is not a native mirror at all.
 *
 * The raw id lives in `payment_context.customer_payment_reference` (written when
 * the row was mirrored) because the `NATIVE-…` reference is a *key*: the
 * provider's `cancel` takes its own id, and nothing here parses the key back
 * into parts.
 */
export function readNativeProviderTarget(row: {
  reference?: unknown
  payment_context?: unknown
}): { providerId: string | null; reference: string | null } | null {
  if (!isNativeSubscriptionReference(row?.reference)) {
    return null
  }

  const context = (row?.payment_context ?? null) as Record<string, unknown> | null

  return {
    providerId: readText(context?.payment_provider_id),
    reference: readText(context?.customer_payment_reference),
  }
}

function readText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null
}

/**
 * Reference for a mirror row: `NATIVE-{kind}-{providerSubscriptionId}`, or null
 * when either half is missing — a native row without them could never be
 * located again, so it must not be created.
 *
 * Nothing parses this back into its parts for identity: the raw provider id
 * travels separately in `payment_context.customer_payment_reference`, which is
 * what a provider's `cancel` receives.
 */
export function buildNativeSubscriptionReference(
  kind: unknown,
  providerSubscriptionId: unknown
): string | null {
  const providerKind = typeof kind === "string" ? kind.trim() : ""
  const id =
    typeof providerSubscriptionId === "string"
      ? providerSubscriptionId.trim()
      : ""

  if (!providerKind || !id) {
    return null
  }

  return `${NATIVE_SUBSCRIPTION_REFERENCE_PREFIX}${providerKind}-${id}`
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
 * A subscription row only occupies the billing track while it is running or
 * deliberately paused — on either rail, which is why the constant carries a
 * rail-neutral name and is shared by both checkout directions.
 *
 * `cancelled` and `past_due` are let through on purpose: a customer whose PayPal
 * charge just failed must keep the door open to buy the period themselves and
 * not lose their entitlement, and a subscription that ended months ago should
 * not lock the customer out for the rest of its nominal term.
 */
export const TRACK_OCCUPYING_SUBSCRIPTION_STATUSES = [
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
      (TRACK_OCCUPYING_SUBSCRIPTION_STATUSES as readonly string[]).includes(row.status) &&
      wanted.has(row.product_id)
    ) {
      return row
    }
  }

  return null
}
