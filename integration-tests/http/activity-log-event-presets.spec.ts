import {
  ACTIVITY_LOG_DOMAIN_EVENT_TYPES,
} from "../../src/admin/routes/subscriptions/activity-log/activity-log-event-presets"

/**
 * The Admin activity-log page builds its quick-preset and event-type filter
 * options from `ACTIVITY_LOG_DOMAIN_EVENT_TYPES`
 * (src/admin/routes/subscriptions/activity-log/activity-log-event-presets.ts,
 * imported by the page). An event type absent from that list is written and
 * displayed but NOT filterable — which is exactly how `subscription.expired`
 * became unfilterable while it was only persisted — so the exact contents of
 * every group are pinned here. If this pin goes red because a group gained or
 * lost an entry, update it consciously: the filter must never silently lag the
 * event taxonomy.
 *
 * Event types deliberately have no i18n catalog keys (`formatEventType`
 * title-cases the raw string; docs/admin/i18n.md records the exception), so
 * there is nothing beyond this list to keep in sync.
 */
describe("activity-log admin filter presets", () => {
  it("pins the exact event types of every quick-preset group", () => {
    expect(ACTIVITY_LOG_DOMAIN_EVENT_TYPES).toEqual({
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
    })
  })

  it("lists every event type at most once across all groups", () => {
    const eventTypes = Object.values(ACTIVITY_LOG_DOMAIN_EVENT_TYPES).flat()
    const unique = new Set(eventTypes)

    expect(eventTypes).toHaveLength(unique.size)
  })
})
