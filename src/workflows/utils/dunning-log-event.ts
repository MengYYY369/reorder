import type { MedusaContainer } from "@medusajs/framework/types"
import {
  ActivityLogActorType,
  ActivityLogEventType,
} from "../../modules/activity-log/types"
import { normalizeActivityLogEvent } from "../../modules/activity-log/utils/normalize-log-event"
import { persistAndEmitSubscriptionLogEvent } from "../steps/create-subscription-log-event"

const DUNNING_LIFECYCLE_EVENT_TYPES = [
  ActivityLogEventType.DUNNING_STARTED,
  ActivityLogEventType.DUNNING_RETRY_EXECUTED,
  ActivityLogEventType.DUNNING_RECOVERED,
  ActivityLogEventType.DUNNING_UNRECOVERED,
  ActivityLogEventType.DUNNING_RETRY_SCHEDULE_UPDATED,
] as const

export type DunningLifecycleEventType =
  (typeof DUNNING_LIFECYCLE_EVENT_TYPES)[number]

/**
 * What the emitting step knows about the subscription at emission time. Steps
 * that already loaded the subscription pass its display fields; paths that
 * close a case before the subscription row is ever read (the settled-cycle
 * guard in `run-dunning-retry`) pass null — the event still carries the
 * `subscription_id` it is centered on, only the display labels stay empty.
 */
export type DunningLogEventSubscriptionDisplay = {
  customer_id: string | null
  reference: string | null
  customer_name: string | null
  product_title: string | null
  variant_title: string | null
} | null

export type DunningLifecycleEventInput = {
  event_type: DunningLifecycleEventType
  dunning_case_id: string
  subscription_id: string
  renewal_cycle_id: string
  renewal_order_id?: string | null
  subscription_display?: DunningLogEventSubscriptionDisplay
  previous_state?: Record<string, unknown> | null
  new_state?: Record<string, unknown> | null
  actor_type: ActivityLogActorType
  actor_id?: string | null
  trigger_type: string
  attempt_no?: number | null
  reason?: string | null
  correlation_id?: string | null
  dedupe_qualifier?: string | number | null
}

/**
 * The single write path for the five dunning lifecycle events (`dunning.*`
 * had no writer before Task 11 of the billing hardening plan). It normalizes
 * the payload (redaction, metadata allow-list, deterministic `dedupe_key`)
 * and persists + emits it through the shared subscription-log funnel, so each
 * event appears in the Admin activity log AND on the event bus. Emission is
 * suppressed when the persist deduped, so a replayed workflow cannot
 * double-emit one occurrence.
 */
export async function persistDunningLifecycleEvent(
  container: MedusaContainer,
  input: DunningLifecycleEventInput
): Promise<void> {
  const display = input.subscription_display

  const logEvent = normalizeActivityLogEvent({
    subscription_id: input.subscription_id,
    customer_id: display?.customer_id ?? null,
    event_type: input.event_type,
    actor_type: input.actor_type,
    actor_id: input.actor_id ?? null,
    display: {
      subscription_reference: display?.reference ?? null,
      customer_name: display?.customer_name ?? null,
      product_title: display?.product_title ?? null,
      variant_title: display?.variant_title ?? null,
    },
    previous_state: input.previous_state ?? null,
    new_state: input.new_state ?? null,
    reason: input.reason ?? null,
    metadata: {
      source: "dunning",
      trigger_type: input.trigger_type,
      dunning_case_id: input.dunning_case_id,
      renewal_cycle_id: input.renewal_cycle_id,
      order_id: input.renewal_order_id ?? null,
      attempt_no: input.attempt_no ?? null,
    },
    correlation_id: input.correlation_id ?? null,
    dedupe: {
      scope: "dunning",
      target_id: input.dunning_case_id,
      qualifier: input.dedupe_qualifier ?? null,
    },
  })

  await persistAndEmitSubscriptionLogEvent(container, logEvent)
}
