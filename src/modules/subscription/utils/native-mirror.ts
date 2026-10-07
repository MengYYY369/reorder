import {
  SubscriptionFrequencyInterval,
  SubscriptionProductSnapshot,
  SubscriptionShippingAddress,
  SubscriptionStatus,
} from "../types"
import { buildNativeSubscriptionReference } from "./native-subscription"
import type { SubscriptionWriteInput } from "./subscription-write-input"

/**
 * Turns a provider's own record of a subscription into the fields of a mirror
 * row.
 *
 * The mirror exists so "does this customer already have a provider recurrence
 * for this product" is a local indexed query instead of a provider call.
 * Reorder never charges these rows, extends them, or puts them into dunning —
 * see `native-subscription.ts` for how they are recognized.
 *
 * **Two paths, one builder.** The neutral rail event
 * (`payment-rail.native_subscription.changed`) and the hourly backfill
 * (`capabilities[].native.listRecords`) hand over the same shape — the record
 * the provider package defines — so there is one mapping here, not two. That is
 * the fix for the dead event path: the two halves used to disagree about what an
 * event carries, and nothing failed loudly because each half was tested against
 * its own invented payload.
 *
 * Every field a row needs must come from the record. Nothing here infers a date:
 * `next_billing_at` is only known when the provider said so, so a mirror row may
 * legitimately have `next_renewal_at: null`, and the Admin surfaces that as "to
 * be confirmed" rather than a guessed date.
 */

/**
 * One subscription as a provider package reports it, plus the two facts reorder
 * supplies: which family it is (`kind`, the reference's middle token) and which
 * payment-module provider key it was registered under (`provider_id`, what the
 * checkout gates and the cancel path resolve against).
 */
export type NativeSubscriptionRecordInput = {
  kind: string
  provider_id: string
  provider_subscription_id: string
  plan_id: string | null
  /** The rail-neutral status vocabulary; `null` means "do not mirror". */
  status: string | null
  customer_id: string | null
  variant_id: string | null
  interval_unit: string
  interval_count: number
  next_billing_at: string | null
  last_billing_at: string | null
}

export type NativeMirrorFields = {
  reference: string
  /** The provider's own subscription id, the value its `cancel` takes. */
  provider_subscription_id: string
  /** The payment-module provider key this row belongs to. */
  provider_id: string
  kind: string
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

/**
 * The rail's status vocabulary, read as reorder's own.
 *
 * The two are deliberately the same four words (`active | paused | past_due |
 * cancelled`) — that sameness is what lets a provider map its states once,
 * inside its own package, and lets this file be a lookup instead of a second
 * provider-specific table. A status outside the vocabulary (or `null`, the
 * provider's "do not mirror": an approval nobody finished) writes nothing: a
 * half-populated row would look like a live recurrence to the checkout gates.
 */
const MIRROR_STATUS_BY_RAIL_STATUS: Record<string, SubscriptionStatus> = {
  active: SubscriptionStatus.ACTIVE,
  paused: SubscriptionStatus.PAUSED,
  past_due: SubscriptionStatus.PAST_DUE,
  cancelled: SubscriptionStatus.CANCELLED,
}

/**
 * Fields that identify and model the row. Missing any of them means the record
 * cannot produce a usable row, and a half-populated mirror is worse than none:
 * it would look like a live recurrence to the exclusivity checks.
 */
const MIRROR_BUILD_FIELDS = [
  "customer_id",
  "variant_id",
  "interval_unit",
] as const

/**
 * @param productId resolved by the caller from the record's variant: a provider
 *   package knows the variant (that is what the merchant declared) but never
 *   reorder's product graph.
 */
export function buildNativeMirrorFieldsFromRecord(
  record: NativeSubscriptionRecordInput,
  productId: string | null | undefined
): NativeMirrorResult {
  const providerSubscriptionId = text(record.provider_subscription_id)

  if (!providerSubscriptionId) {
    return { ok: false, reason: "missing_provider_subscription_id" }
  }

  const reference = buildNativeSubscriptionReference(
    record.kind,
    providerSubscriptionId
  )

  if (!reference) {
    return { ok: false, reason: "missing_kind" }
  }

  const status = text(record.status)
    ? MIRROR_STATUS_BY_RAIL_STATUS[text(record.status)!.toLowerCase()] ?? null
    : null

  if (!status) {
    return { ok: false, reason: `unmappable_status_${String(record.status)}` }
  }

  const missing = MIRROR_BUILD_FIELDS.filter(
    (field) => !isPresent((record as Record<string, unknown>)[field])
  )

  if (missing.length || !text(productId)) {
    const reasons = [
      ...missing,
      ...(text(productId) ? [] : ["product_id"]),
    ]

    return { ok: false, reason: `missing_${reasons.join("_and_")}` }
  }

  const frequency = readFrequency(record)

  if (!frequency) {
    return { ok: false, reason: "unsupported_frequency" }
  }

  return {
    ok: true,
    fields: {
      reference,
      provider_subscription_id: providerSubscriptionId,
      provider_id: text(record.provider_id) ?? "",
      kind: text(record.kind)!,
      status,
      customer_id: text(record.customer_id)!,
      product_id: text(productId)!,
      variant_id: text(record.variant_id)!,
      frequency_interval: frequency.interval,
      frequency_value: frequency.value,
      next_renewal_at: readDate(record.next_billing_at),
      last_renewal_at: readDate(record.last_billing_at),
      plan_id: text(record.plan_id),
    },
  }
}

function readFrequency(record: NativeSubscriptionRecordInput): {
  interval: SubscriptionFrequencyInterval
  value: number
} | null {
  const interval = text(record.interval_unit)?.toLowerCase()
  const rawValue = record.interval_count
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
 * Update payload for an existing mirror row. A date the record did not carry is
 * left out rather than written as null: the previous value came from a real
 * provider response, and a later event without the field knows nothing about it.
 */
export function nativeMirrorReconcileFields(
  id: string,
  fields: NativeMirrorFields
): SubscriptionWriteInput {
  const update: SubscriptionWriteInput = {
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

function isPresent(value: unknown): boolean {
  if (typeof value === "string") {
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
 * The subscription model requires a shipping-address snapshot, but a provider
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
 * Product snapshot from the ids the record carries plus whatever titles the
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
