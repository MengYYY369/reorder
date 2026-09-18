import type { SubscriptionRecord } from "./types"

/**
 * Authoritative subscription snapshot for POST /store/saas/reconcile — the
 * exact camelCase field set the SaaS reads. Any drift here breaks the SaaS
 * webhook recovery path; the integration suite pins these fields.
 */
export function snapshot(subscription: SubscriptionRecord) {
  return {
    id: subscription.id,
    reference: subscription.reference,
    status: subscription.status,
    frequencyInterval: subscription.frequency_interval,
    frequencyValue: subscription.frequency_value,
    nextRenewalAt: subscription.next_renewal_at
      ? new Date(subscription.next_renewal_at).toISOString()
      : null,
    // Redemption-code grants terminate the free period at this date.
    cancelEffectiveAt: subscription.cancel_effective_at
      ? new Date(subscription.cancel_effective_at).toISOString()
      : null,
    paymentMode: subscription.payment_context?.payment_mode ?? null,
    // Auto-renewal needs a stored instrument; null means the user has not
    // saved one yet (manual-mode checkout) and the switch is unavailable.
    hasPaymentMethod: Boolean(
      subscription.payment_context?.payment_method_reference
    ),
    orderId: readSubscriptionOrderId(subscription.metadata),
  }
}

function readSubscriptionOrderId(
  metadata: Record<string, unknown> | null
): string | null {
  const value = metadata?.source_order_id

  return typeof value === "string" ? value : null
}
