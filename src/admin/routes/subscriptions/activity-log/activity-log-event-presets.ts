/**
 * The event types behind the Admin activity-log quick-preset filter groups,
 * kept as a pure, dependency-free module so its contents stay unit-assertable.
 *
 * An event type absent from this list is written and displayed but not
 * filterable from the activity-log page, so every persistable value of
 * `ActivityLogEventType` must appear in exactly one group here.
 *
 * There are deliberately no i18n catalog keys for event types:
 * `formatEventType` title-cases the raw string, and docs/admin/i18n.md
 * records that as the exception ("There is no fixed vocabulary to translate").
 */
export const ACTIVITY_LOG_DOMAIN_EVENT_TYPES = {
  subscriptions: [
    "subscription.created",
    "subscription.paused",
    "subscription.resumed",
    "subscription.canceled",
    "subscription.plan_change_scheduled",
    "subscription.shipping_address_updated",
    "subscription.next_delivery_skipped",
    "subscription.payment_method_updated",
    "subscription.expired",
    "subscription.creation_failed",
    "subscription.trial_ending",
  ],
  renewals: [
    "renewal.cycle_created",
    "renewal.approval_approved",
    "renewal.approval_rejected",
    "renewal.force_requested",
    "renewal.succeeded",
    "renewal.failed",
    "renewal.abandoned",
    "renewal.awaiting_manual_resolution",
    "renewal.upcoming",
  ],
  dunning: [
    "dunning.started",
    "dunning.retry_executed",
    "dunning.recovered",
    "dunning.unrecovered",
    "dunning.retry_schedule_updated",
  ],
  cancellation: [
    "cancellation.case_started",
    "cancellation.offer_applied",
    "cancellation.reason_updated",
    "cancellation.finalized",
  ],
} as const
