import {
  SubscriptionFrequencyInterval,
  SubscriptionProductSnapshot,
  SubscriptionShippingAddress,
  SubscriptionStatus,
} from "../types"
import { buildNativeSubscriptionReference } from "./native-subscription"

/**
 * Turns a `paypal.subscription.*` event into the fields of a mirror row.
 *
 * The mirror exists so "does this customer already have a PayPal recurrence for
 * this product" is a local indexed query instead of a provider call. Reorder
 * never charges these rows, extends them, or puts them into dunning — see
 * `native-subscription.ts` for how they are recognized.
 *
 * Every field a row needs must come from the payload. Nothing here infers a
 * date from the event type: `next_billing_at` is only known when PayPal said
 * so, so a mirror row may legitimately have `next_renewal_at: null`, and the
 * Admin surfaces that as "to be confirmed" rather than a guessed date.
 */

export type NativeSubscriptionEventPayload = {
  subscription_id?: string | null
  paypal_subscription_id?: string | null
  status?: string | null
  customer_id?: string | null
  product_id?: string | null
  variant_id?: string | null
  plan_id?: string | null
  frequency_interval?: string | number | null
  frequency_value?: string | number | null
  next_billing_at?: string | null
  last_billing_at?: string | null
}

export type NativeMirrorFields = {
  reference: string
  paypal_subscription_id: string
  status: SubscriptionStatus
  customer_id: string
  product_id: string
  variant_id: string
  frequency_interval: SubscriptionFrequencyInterval
  frequency_value: number
  next_renewal_at: string | null
  last_renewal_at: string | null
  plan_id: string | null
}

export type NativeMirrorResult =
  | { ok: true; fields: NativeMirrorFields }
  | { ok: false; reason: string }

/** Event names whose payload status must not decide the mirrored status. */
export const PAYPAL_SUBSCRIPTION_EVENT_NAMES = [
  "paypal.subscription.activated",
  "paypal.subscription.suspended",
  "paypal.subscription.resumed",
  "paypal.subscription.cancelled",
  "paypal.subscription.expired",
  "paypal.subscription.payment_succeeded",
  "paypal.subscription.payment_failed",
  "paypal.subscription.revised",
] as const

export type PaypalSubscriptionEventName =
  (typeof PAYPAL_SUBSCRIPTION_EVENT_NAMES)[number]

/**
 * PayPal reports five states; reorder has `active | paused | cancelled |
 * past_due`. EXPIRED maps to `cancelled` for the same reason the manual dunning
 * silence does: there is nothing left to charge, and `cancelled` is the state
 * the rest of the plugin already treats as terminal.
 *
 * APPROVAL_PENDING has no mirror: a recurrence the customer never finished
 * approving blocks nothing, and writing an `active` row for it would reject
 * their checkout.
 */
const STATUS_BY_PAYPAL_STATE: Record<string, SubscriptionStatus | null> = {
  APPROVAL_PENDING: null,
  ACTIVE: SubscriptionStatus.ACTIVE,
  SUSPENDED: SubscriptionStatus.PAUSED,
  CANCELLED: SubscriptionStatus.CANCELLED,
  EXPIRED: SubscriptionStatus.CANCELLED,
}

export function mapNativeStatus(
  paypalStatus: string | null | undefined
): SubscriptionStatus | null {
  if (typeof paypalStatus !== "string") {
    return null
  }

  return STATUS_BY_PAYPAL_STATE[paypalStatus.trim().toUpperCase()] ?? null
}

/**
 * @param eventName the bus event; only `payment_failed` and `expired` override
 * the payload status.
 */
export function resolveNativeStatus(
  eventName: string,
  payload: NativeSubscriptionEventPayload
): SubscriptionStatus | null {
  if (eventName === "paypal.subscription.payment_failed") {
    return SubscriptionStatus.PAST_DUE
  }

  if (eventName === "paypal.subscription.expired") {
    return SubscriptionStatus.CANCELLED
  }

  return mapNativeStatus(payload.status)
}

/**
 * Fields that identify and model the row. Missing any of them means the event
 * cannot produce a usable row, and a half-populated mirror is worse than none:
 * it would look like a live recurrence to the exclusivity checks.
 */
const MIRROR_BUILD_FIELDS = [
  "customer_id",
  "product_id",
  "variant_id",
  "frequency_interval",
  "frequency_value",
] as const

export function buildNativeMirrorFields(
  eventName: string,
  payload: NativeSubscriptionEventPayload
): NativeMirrorResult {
  const paypalSubscriptionId =
    text(payload.paypal_subscription_id) ?? text(payload.subscription_id)

  if (!paypalSubscriptionId) {
    return { ok: false, reason: "missing_paypal_subscription_id" }
  }

  const reference = buildNativeSubscriptionReference(paypalSubscriptionId)

  if (!reference) {
    return { ok: false, reason: "missing_paypal_subscription_id" }
  }

  const status = resolveNativeStatus(eventName, payload)

  if (!status) {
    return { ok: false, reason: `unmappable_status_${String(payload.status)}` }
  }

  if (eventName === "paypal.subscription.revised") {
    // Plan/frequency changes arrive as `revised` in medusa-paypal 0.5.0; until
    // that release ships, the reconciliation job is the only backstop here.
    // TODO(#06, blocked externally): drop this guard once
    // `paypal.subscription.revised` is emitted with plan_id + frequency fields,
    // and let it update the plan and frequency of the existing row in place.
    return { ok: false, reason: "revised_not_supported_until_paypal_0_5_0" }
  }

  const missing = MIRROR_BUILD_FIELDS.filter((field) => !isPresent(payload[field]))

  if (missing.length) {
    return { ok: false, reason: `missing_${missing.join("_and_")}` }
  }

  const frequency = readFrequency(payload)

  if (!frequency) {
    return { ok: false, reason: "unsupported_frequency" }
  }

  return {
    ok: true,
    fields: {
      reference,
      paypal_subscription_id: paypalSubscriptionId,
      status,
      customer_id: text(payload.customer_id)!,
      product_id: text(payload.product_id)!,
      variant_id: text(payload.variant_id)!,
      frequency_interval: frequency.interval,
      frequency_value: frequency.value,
      next_renewal_at: readDate(payload.next_billing_at),
      last_renewal_at: readDate(payload.last_billing_at),
      plan_id: text(payload.plan_id),
    },
  }
}

function readFrequency(payload: NativeSubscriptionEventPayload): {
  interval: SubscriptionFrequencyInterval
  value: number
} | null {
  const interval = text(payload.frequency_interval)?.toLowerCase()
  const rawValue = payload.frequency_value
  const value =
    typeof rawValue === "number"
      ? rawValue
      : typeof rawValue === "string"
        ? Number.parseInt(rawValue, 10)
        : Number.NaN

  if (!Number.isInteger(value) || value <= 0) {
    return null
  }

  switch (interval) {
    case SubscriptionFrequencyInterval.WEEK:
      return { interval: SubscriptionFrequencyInterval.WEEK, value }
    case SubscriptionFrequencyInterval.MONTH:
      return { interval: SubscriptionFrequencyInterval.MONTH, value }
    case SubscriptionFrequencyInterval.YEAR:
      return { interval: SubscriptionFrequencyInterval.YEAR, value }
    default:
      return null
  }
}

/**
 * A row of medusa-paypal's `paypal_subscription` table, as it arrives through
 * query.graph. Used by the backfill: existing provider subscriptions never
 * re-emit their `activated` event, so without this the mirror set would only
 * cover subscriptions created after the plugin was installed.
 */
export type ProviderSubscriptionRecord = {
  id?: string | null
  paypal_subscription_id?: string | null
  paypal_plan_id?: string | null
  status?: string | null
  customer_id?: string | null
  variant_id?: string | null
  interval_unit?: string | null
  interval_count?: string | number | null
  next_billing_at?: string | Date | null
  last_billing_at?: string | Date | null
}

/**
 * Map a provider row to mirror fields. `product_id` comes from the caller
 * because the provider table only knows the variant.
 */
export function buildNativeMirrorFieldsFromRecord(
  record: ProviderSubscriptionRecord,
  productId: string | null | undefined
): NativeMirrorResult {
  return buildNativeMirrorFields("paypal.subscription.activated", {
    paypal_subscription_id: record.paypal_subscription_id,
    subscription_id: record.id,
    status: record.status,
    customer_id: record.customer_id,
    product_id: productId,
    variant_id: record.variant_id,
    plan_id: record.paypal_plan_id,
    frequency_interval: record.interval_unit,
    frequency_value: record.interval_count,
    next_billing_at:
      record.next_billing_at instanceof Date
        ? record.next_billing_at.toISOString()
        : record.next_billing_at,
    last_billing_at:
      record.last_billing_at instanceof Date
        ? record.last_billing_at.toISOString()
        : record.last_billing_at,
  })
}

/**
 * Update payload for an existing mirror row. A date the event did not carry is
 * left out rather than written as null: the previous value came from a real
 * PayPal response, and a later event without the field knows nothing about it.
 */
export function nativeMirrorReconcileFields(
  id: string,
  fields: NativeMirrorFields
): Record<string, unknown> {
  const update: Record<string, unknown> = {
    id,
    status: fields.status,
    product_id: fields.product_id,
    variant_id: fields.variant_id,
    frequency_interval: fields.frequency_interval,
    frequency_value: fields.frequency_value,
  }

  if (fields.next_renewal_at) {
    update.next_renewal_at = new Date(fields.next_renewal_at)
  }

  if (fields.last_renewal_at) {
    update.last_renewal_at = new Date(fields.last_renewal_at)
  }

  return update
}

function isPresent(value: unknown): boolean {  if (typeof value === "string") {
    return !!value.trim()
  }

  if (typeof value === "number") {
    return Number.isFinite(value)
  }

  return value !== null && value !== undefined
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null
}

function readDate(value: unknown): string | null {
  const raw = text(value)

  if (!raw) {
    return null
  }

  const date = new Date(raw)

  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

/**
 * The subscription model requires a shipping-address snapshot, but a PayPal
 * recurrence is billed by the provider and never re-ordered by this plugin, so
 * no fulfillment is ever computed from it. This placeholder is inert, and its
 * `N/A` country is what tells an operator the row is a mirror rather than a
 * reorder row that lost its address.
 */
export const NATIVE_MIRROR_SHIPPING_ADDRESS: SubscriptionShippingAddress = {
  first_name: "Digital",
  last_name: "Delivery",
  company: null,
  address_1: "N/A",
  address_2: null,
  city: "N/A",
  postal_code: "00000",
  province: null,
  country_code: "N/A",
  phone: null,
}

/**
 * Product snapshot from the ids the event carries plus whatever titles the
 * caller resolved. Titles fall back to the ids because the Admin lists mirror
 * rows, and a blank column reads as a data bug while an id reads as "provider
 * row, not resolved".
 */
export function buildNativeMirrorProductSnapshot(input: {
  product_id: string
  variant_id: string
  product_title?: string | null
  variant_title?: string | null
  sku?: string | null
}): SubscriptionProductSnapshot {
  return {
    product_id: input.product_id,
    product_title: text(input.product_title) ?? input.product_id,
    variant_id: input.variant_id,
    variant_title: text(input.variant_title) ?? input.variant_id,
    sku: text(input.sku),
  }
}
