export enum SubscriptionStatus {
  ACTIVE = "active",
  PAUSED = "paused",
  CANCELLED = "cancelled",
  PAST_DUE = "past_due",
}

export enum SubscriptionFrequencyInterval {
  WEEK = "week",
  MONTH = "month",
  YEAR = "year",
}

export type SubscriptionCustomerSnapshot = {
  email: string
  full_name: string | null
}

export type SubscriptionProductSnapshot = {
  product_id: string
  product_title: string
  variant_id: string
  variant_title: string
  sku: string | null
}

export type SubscriptionPricingSnapshot = {
  discount_type: "percentage" | "fixed"
  discount_value: number
  label: string | null
}

export type SubscriptionShippingAddress = {
  first_name: string
  last_name: string
  company: string | null
  address_1: string
  address_2: string | null
  city: string
  postal_code: string
  province: string | null
  country_code: string
  phone: string | null
}

/**
 * How renewals are charged for a subscription.
 *
 * - "auto": the off-session scheduler charges `payment_method_reference`
 *   directly (tokenizable providers). Default for upstream compatibility.
 * - "manual": renewals are paid through an interactive cashier link minted by
 *   the manual renewal flow; the scheduler skips these subscriptions.
 */
export type SubscriptionPaymentMode = "manual" | "auto"

/**
 * Which system actually charges this subscription.
 *
 * - `"manual"`: nothing charges on its own; renewals are paid through the
 *   interactive manual-renewal flow. Written when a row is created without any
 *   stored consent.
 * - `"reorder_auto"`: this plugin's off-session scheduler charges
 *   `payment_method_reference`.
 * - `"native"`: an external provider (PayPal) owns the recurrence and this row
 *   is a mirror of it. Reorder must never charge it, extend it, or put it into
 *   dunning.
 *
 * Optional because `payment_context` is a jsonb column: rows persisted before
 * this discriminator exists simply have no `mechanism` key. Nothing may filter
 * on it — see `src/modules/subscription/utils/native-subscription.ts`.
 */
export type SubscriptionPaymentMechanism = "manual" | "reorder_auto" | "native"

export type SubscriptionPaymentContext = {
  payment_provider_id: string | null
  payment_mode: SubscriptionPaymentMode
  mechanism?: SubscriptionPaymentMechanism
  source_payment_collection_id: string | null
  source_payment_session_id: string | null
  payment_method_reference: string | null
  customer_payment_reference: string | null
}

export type SubscriptionPaymentMethodSummary = {
  id: string
  provider_id: string
  type: string | null
  brand: string | null
  last4: string | null
  exp_month: number | null
  exp_year: number | null
  created_at: number | null
}

export type SubscriptionAccountHolderRecord = {
  id: string
  provider_id: string
  external_id?: string | null
  email?: string | null
  data?: Record<string, unknown> | null
  metadata?: Record<string, unknown> | null
}

export type SubscriptionPaymentMethodRecord = {
  id: string
  provider_id?: string | null
  data?: Record<string, unknown> | null
}

export type SubscriptionPendingUpdateData = {
  variant_id: string
  variant_title: string
  sku: string | null
  frequency_interval: SubscriptionFrequencyInterval
  frequency_value: number
  effective_at: string | null
  requested_at: string
  requested_by: string | null
}
