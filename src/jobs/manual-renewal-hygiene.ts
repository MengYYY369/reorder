import { MedusaContainer } from "@medusajs/framework/types"
import { SUBSCRIPTION_MODULE } from "../modules/subscription"
import type SubscriptionModuleService from "../modules/subscription/service"
import { SubscriptionStatus } from "../modules/subscription/types"
import { isNativeSubscriptionReference } from "../modules/subscription/utils/native-subscription"

type HygieneSubscription = {
  id: string
  reference: string
  status: SubscriptionStatus
  payment_context: { payment_mode?: string | null } | null
  next_renewal_at: Date | null
}

/**
 * State hygiene for manual-mode subscriptions: the renewal/dunning schedulers
 * skip manual subscriptions entirely, so an abandoned subscription would stay
 * ACTIVE forever. This job marks manual subscriptions whose next_renewal_at
 * lapsed beyond the grace window as CANCELLED.
 *
 * It does NOT touch entitlements — SaaS-side entitlement expiry is driven by
 * D1 expires_at (D20/D26), never by subscription status.
 */
export default async function manualRenewalHygieneJob(
  container: MedusaContainer
) {
  const logger = container.resolve("logger") as {
    info: (msg: string) => void
  }

  const subscriptionModule = container.resolve<SubscriptionModuleService>(
    SUBSCRIPTION_MODULE
  )

  const GRACE_MS = 90 * 24 * 60 * 60 * 1000
  const cutoff = new Date(Date.now() - GRACE_MS)

  const lapsed = (await subscriptionModule.listSubscriptions({
    status: [SubscriptionStatus.ACTIVE, SubscriptionStatus.PAST_DUE],
    next_renewal_at: { $lt: cutoff },
  } as never)) as unknown as HygieneSubscription[]

  const manualLapsed = lapsed.filter(
    (subscription) =>
      !isNativeSubscriptionReference(subscription.reference) &&
      (subscription.payment_context?.payment_mode ?? "auto") === "manual"
  )

  if (!manualLapsed.length) {
    return
  }

  const now = new Date()

  for (const subscription of manualLapsed) {
    await subscriptionModule.updateSubscriptions({
      id: subscription.id,
      status: SubscriptionStatus.CANCELLED,
      cancelled_at: now,
      cancel_effective_at: now,
    } as never)
  }

  logger.info(
    `[reorder] manual-renewal hygiene: cancelled ${manualLapsed.length} lapsed manual subscription(s) (cutoff ${cutoff.toISOString()})`
  )
}

export const config = {
  name: "manual-renewal-hygiene",
  schedule: "0 4 * * *",
}
