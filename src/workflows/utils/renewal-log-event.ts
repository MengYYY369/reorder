import type { MedusaContainer } from "@medusajs/framework/types"
import {
  ActivityLogActorType,
  ActivityLogEventType,
} from "../../modules/activity-log/types"
import { normalizeActivityLogEvent } from "../../modules/activity-log/utils/normalize-log-event"
import { persistAndEmitSubscriptionLogEvent } from "../steps/create-subscription-log-event"

/**
 * The two operational renewal outcomes Task 12 of the billing hardening plan
 * adds to the event taxonomy. `renewal.abandoned` tells the host a period was
 * written off (decision R3: the plugin never cancels the subscription as a
 * side effect — the host decides); `renewal.awaiting_manual_resolution` tells
 * it a stuck cycle was parked for a human (decision R5: payment state is
 * undecidable, the period is neither paid nor written off).
 */
export type RenewalResolutionEventType =
  | ActivityLogEventType.RENEWAL_ABANDONED
  | ActivityLogEventType.RENEWAL_AWAITING_MANUAL_RESOLUTION

/**
 * What the emitting site knows about the subscription at emission time. Sites
 * that already loaded the subscription pass its display fields; paths that
 * never read the subscription row pass null — the event still carries the
 * `subscription_id` it is centered on, only the display labels stay empty.
 * Same shape and contract as the dunning lifecycle events.
 */
export type RenewalLogEventSubscriptionDisplay = {
  customer_id: string | null
  reference: string | null
  customer_name: string | null
  product_title: string | null
  variant_title: string | null
} | null

export type RenewalResolutionEventInput = {
  event_type: RenewalResolutionEventType
  subscription_id: string
  renewal_cycle_id: string
  subscription_display?: RenewalLogEventSubscriptionDisplay
  previous_state?: Record<string, unknown> | null
  new_state?: Record<string, unknown> | null
  actor_type: ActivityLogActorType
  actor_id?: string | null
  trigger_type: string
  /** Which machinery drove the write: "scheduler", "admin" or "dunning". */
  source: string
  reason?: string | null
  reason_code?: string | null
  order_id?: string | null
  dunning_case_id?: string | null
  attempt_no?: number | null
  correlation_id?: string | null
}

/**
 * The single write path for the two operational renewal events. It normalizes
 * the payload (redaction, metadata allow-list, deterministic `dedupe_key`) and
 * persists + emits it through the shared subscription-log funnel, so each
 * event appears in the Admin activity log AND on the event bus. Emission is
 * suppressed when the persist deduped, so a replayed workflow cannot
 * double-emit one occurrence.
 *
 * The dedupe key has no qualifier on purpose: both states are terminal for a
 * cycle (`abandoned` can never be left; a parked cycle re-parked by a second
 * reconciliation run does not change state), so one cycle yields at most one
 * of each event no matter how many times a workflow around it replays.
 */
export async function persistRenewalResolutionEvent(
  container: MedusaContainer,
  input: RenewalResolutionEventInput
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
      source: input.source,
      trigger_type: input.trigger_type,
      renewal_cycle_id: input.renewal_cycle_id,
      order_id: input.order_id ?? null,
      dunning_case_id: input.dunning_case_id ?? null,
      attempt_no: input.attempt_no ?? null,
      reason_code: input.reason_code ?? null,
    },
    correlation_id: input.correlation_id ?? null,
    dedupe: {
      scope: "renewal",
      target_id: input.renewal_cycle_id,
      qualifier: null,
    },
  })

  await persistAndEmitSubscriptionLogEvent(container, logEvent)
}
