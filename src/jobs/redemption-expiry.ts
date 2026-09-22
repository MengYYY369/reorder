import { MedusaContainer } from "@medusajs/framework/types"
import { SUBSCRIPTION_MODULE } from "../modules/subscription"
import type SubscriptionModuleService from "../modules/subscription/service"
import { SubscriptionStatus } from "../modules/subscription/types"
import { ACTIVITY_LOG_MODULE } from "../modules/activity-log"
import ActivityLogModuleService from "../modules/activity-log/service"
import { ActivityLogActorType, ActivityLogEventType } from "../modules/activity-log/types"
import {
  emitSubscriptionBusEvent,
} from "../workflows/steps/create-subscription-log-event"
import { persistSubscriptionLogEvent } from "../modules/activity-log/utils/persist-log-event"
import { normalizeActivityLogEvent } from "../modules/activity-log/utils/normalize-log-event"

type ExpirySubscription = {
  id: string
  status: SubscriptionStatus
  reference: string
  customer_id: string
  cancel_effective_at: Date | null
  customer_snapshot: { full_name?: string | null } | null
  product_snapshot: {
    product_title?: string | null
    variant_title?: string | null
  } | null
  metadata: { source?: string | null } | null
}

/**
 * Finalizes redemption-created subscriptions whose free period has ended.
 * Their cancel_effective_at is preset at creation, which already stops the
 * scheduler from pre-creating cycles beyond the boundary; this job flips the
 * status to CANCELLED and logs subscription.expired. Scoped by the
 * metadata.source = "redemption" origin marker — regular subscriptions are
 * never touched, even with a past cancel_effective_at.
 */
export default async function redemptionExpiryJob(
  container: MedusaContainer
) {
  const logger = container.resolve("logger") as {
    info: (msg: string) => void
  }

  const subscriptionModule = container.resolve<SubscriptionModuleService>(
    SUBSCRIPTION_MODULE
  )

  const now = new Date()

  const candidates = (await subscriptionModule.listSubscriptions({
    status: [SubscriptionStatus.ACTIVE, SubscriptionStatus.PAST_DUE],
    cancel_effective_at: { $lte: now },
  } as never)) as unknown as ExpirySubscription[]

  const expired = candidates.filter(
    (subscription) => subscription.metadata?.source === "redemption"
  )

  if (!expired.length) {
    return
  }

  const activityLogModule = container.resolve<ActivityLogModuleService>(
    ACTIVITY_LOG_MODULE
  )

  for (const subscription of expired) {
    await subscriptionModule.updateSubscriptions({
      id: subscription.id,
      status: SubscriptionStatus.CANCELLED,
      cancelled_at: now,
      cancel_effective_at: subscription.cancel_effective_at ?? now,
      next_renewal_at: null,
    } as never)

    const logEvent = normalizeActivityLogEvent({
      subscription_id: subscription.id,
      customer_id: subscription.customer_id,
      event_type: ActivityLogEventType.SUBSCRIPTION_EXPIRED,
      actor_type: ActivityLogActorType.SCHEDULER,
      actor_id: null,
      display: {
        subscription_reference: subscription.reference,
        customer_name: subscription.customer_snapshot?.full_name ?? null,
        product_title: subscription.product_snapshot?.product_title ?? null,
        variant_title: subscription.product_snapshot?.variant_title ?? null,
      },
      previous_state: {
        status: subscription.status,
      },
      new_state: {
        status: SubscriptionStatus.CANCELLED,
        reason: "redemption_free_period_ended",
      },
      metadata: {
        source: "redemption",
      },
      dedupe: {
        scope: "subscription_expiry",
        target_id: subscription.id,
      },
    })

    const persisted = await persistSubscriptionLogEvent(container, logEvent)
    if (persisted.action === "created") {
      await emitSubscriptionBusEvent(container, logEvent)
    }
  }

  logger.info(
    `[reorder] redemption expiry: cancelled ${expired.length} expired redemption subscription(s)`
  )

  void activityLogModule
}

export const config = {
  name: "redemption-expiry",
  schedule: "30 4 * * *",
}
