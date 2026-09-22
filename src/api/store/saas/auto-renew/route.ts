import { MedusaError } from "@medusajs/framework/utils"
import { Modules } from "@medusajs/framework/utils"
import type {
  MedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http"
import { assertTenantVisible } from "../lib/tenant-ownership"
import { isNativeSubscriptionReference } from "../../../../modules/subscription/utils/native-subscription"

type CustomerModule = {
  retrieveCustomer: (
    id: string,
    config?: Record<string, unknown>
  ) => Promise<{ metadata?: Record<string, unknown> | null }>
}

type SubscriptionModule = {
  listSubscriptions: (f: Record<string, unknown>) => Promise<
    Array<{
      id: string
      reference: string
      customer_id: string
      status: string
      next_renewal_at: Date | string | null
      payment_context: { payment_mode?: string | null } | null
    }>
  >
  updateSubscriptions: (data: Record<string, unknown>) => Promise<unknown>
}

const GRACE_MS = 24 * 60 * 60 * 1000

/**
 * POST /store/saas/auto-renew
 * Body: { subscription_id, enabled: boolean }
 * → { subscription_id, payment_mode }
 *
 * Flips the subscription between manual (cashier-link) and auto
 * (off-session scheduler) payment modes. The auto scheduler charges the
 * stored payment method reference at next_renewal_at; a stale reference
 * (never saved / instrument removed) surfaces as renewal.failed + PAST_DUE
 * on the SaaS side, not here — this route only rewrites the mode.
 *
 * Guards:
 *  - TENANT ISOLATION: subscription → customer → metadata.tenant_id must
 *    match the calling tenant, else 404 (existence is not leaked).
 *  - Overdue: when enabling auto on a subscription whose next_renewal_at is
 *    more than GRACE_MS in the past, the scheduler would charge immediately.
 *    That surprise-charge window is rejected — the SaaS tells the user to
 *    renew manually first.
 */
export async function POST(
  req: MedusaRequest,
  res: MedusaResponse
) {
  const { subscription_id, enabled } = (req.body ?? {}) as {
    subscription_id?: string
    enabled?: boolean
  }

  if (typeof subscription_id !== "string" || !subscription_id.trim()) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      "body.subscription_id must be a subscription id"
    )
  }
  if (typeof enabled !== "boolean") {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      "body.enabled must be a boolean"
    )
  }

  // TENANT ISOLATION: same pattern as /renew — resolve through the owner
  // customer's tenant stamp before touching anything.
  const customerModule = req.scope.resolve<CustomerModule>(Modules.CUSTOMER)
  const subscriptionModule = req.scope.resolve<SubscriptionModule>("subscription")

  const subscriptions = await subscriptionModule.listSubscriptions({
    id: [subscription_id],
  })
  const subscription = subscriptions[0] ?? null

  if (!subscription) {
    throw new MedusaError(
      MedusaError.Types.NOT_FOUND,
      "subscription not found"
    )
  }

  const customer = await customerModule.retrieveCustomer(subscription.customer_id)

  assertTenantVisible(req, customer?.metadata, "subscription")

  if (isNativeSubscriptionReference(subscription.reference)) {
    // The read-side exclusions in the scheduler are not enough: this call
    // rewrites payment_context, so one request could turn a mirror row into a
    // row the scheduler considers chargeable.
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      "subscription is a mirror of a PayPal-managed recurrence; manage it at the provider"
    )
  }

  const currentMode = subscription.payment_context?.payment_mode ?? "manual"

  if (enabled && currentMode !== "auto") {
    const nextRenewal = subscription.next_renewal_at
      ? new Date(subscription.next_renewal_at).getTime()
      : null

    if (
      subscription.status === "past_due" ||
      (nextRenewal !== null &&
        Date.now() - nextRenewal > GRACE_MS)
    ) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "subscription is overdue — renew manually before enabling auto-renewal"
      )
    }
  }

  await subscriptionModule.updateSubscriptions({
    // MedusaService-generated updater takes the entity object (id included).
    id: subscription.id,
    // payment_context is a JSON column — write the whole object with the
    // flipped mode, preserving the stored provider/reference fields.
    payment_context: {
      ...(subscription.payment_context ?? {}),
      payment_mode: enabled ? "auto" : "manual",
    },
  })

  res.json({
    subscription_id: subscription.id,
    payment_mode: enabled ? "auto" : "manual",
  })
}
