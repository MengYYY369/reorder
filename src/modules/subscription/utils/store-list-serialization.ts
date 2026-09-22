import { SubscriptionFrequencyInterval } from "../types"
import { getEffectiveNextRenewalAt } from "./effective-next-renewal"

/**
 * Store-facing list item for `GET /store/customers/me/subscriptions`.
 *
 * Kept as a pure mapper (rather than inline in the route) for two reasons: the
 * storefront's benefit card derives the plan tier from `frequency_interval` ×
 * `frequency_value` and from whether a chargeable payment method is stored, and
 * those derived values must not drift from what the detail route reports for the
 * same subscription.
 */
export type StoreSubscriptionListItemSource = {
  id: string
  reference: string
  status: string
  created_at?: string | Date | null
  next_renewal_at?: string | Date | null
  frequency_interval: string
  frequency_value: number
  skip_next_cycle: boolean
  product_snapshot?: {
    product_title?: string | null
    variant_title?: string | null
  } | null
  payment_context?: Record<string, unknown> | null
}

export type StoreSubscriptionActiveCancellationCase = {
  id: string
  status: string
}

export type StoreSubscriptionListItemDto = {
  id: string
  reference: string
  status: string
  created_at: string | null
  product_title: string | null
  variant_title: string | null
  frequency_interval: string
  frequency_value: number
  next_renewal_at: string | null
  effective_next_renewal_at: string | null
  payment_mode: string | null
  has_payment_method: boolean
  active_cancellation_case: StoreSubscriptionActiveCancellationCase | null
}

export function serializeStoreSubscriptionListItem(
  subscription: StoreSubscriptionListItemSource,
  activeCancellationCase: StoreSubscriptionActiveCancellationCase | null
): StoreSubscriptionListItemDto {
  const paymentMode = subscription.payment_context?.payment_mode

  return {
    id: subscription.id,
    reference: subscription.reference,
    status: subscription.status,
    created_at: toIsoStringOrNull(subscription.created_at),
    product_title: subscription.product_snapshot?.product_title ?? null,
    variant_title: subscription.product_snapshot?.variant_title ?? null,
    frequency_interval: subscription.frequency_interval,
    frequency_value: subscription.frequency_value,
    next_renewal_at: toIsoStringOrNull(subscription.next_renewal_at),
    effective_next_renewal_at: toIsoStringOrNull(
      getEffectiveNextRenewalAt({
        next_renewal_at: subscription.next_renewal_at,
        skip_next_cycle: subscription.skip_next_cycle,
        frequency_interval: toFrequencyInterval(subscription.frequency_interval),
        frequency_value: subscription.frequency_value,
      })
    ),
    // `payment_context` is a nullable jsonb column: a row created before the
    // plugin stored anything there reads back as null, not as "no payment mode".
    payment_mode:
      typeof paymentMode === "string" && paymentMode ? paymentMode : null,
    has_payment_method: Boolean(
      subscription.payment_context?.payment_method_reference
    ),
    active_cancellation_case: activeCancellationCase
      ? {
          id: activeCancellationCase.id,
          status: activeCancellationCase.status,
        }
      : null,
  }
}

function toFrequencyInterval(value: string): SubscriptionFrequencyInterval {
  switch (value) {
    case SubscriptionFrequencyInterval.WEEK:
      return SubscriptionFrequencyInterval.WEEK
    case SubscriptionFrequencyInterval.YEAR:
      return SubscriptionFrequencyInterval.YEAR
    default:
      return SubscriptionFrequencyInterval.MONTH
  }
}

function toIsoStringOrNull(value: string | Date | null | undefined): string | null {
  if (!value) {
    return null
  }

  const date = value instanceof Date ? value : new Date(value)

  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}
