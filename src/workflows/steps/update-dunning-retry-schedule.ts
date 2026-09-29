import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { DUNNING_MODULE } from "../../modules/dunning"
import type DunningModuleService from "../../modules/dunning/service"
import {
  DunningCaseStatus,
  type DunningRetrySchedule,
} from "../../modules/dunning/types"
import { dunningErrors } from "../../modules/dunning/utils/errors"
import {
  calculateNextRetryAt,
  validateDunningRetrySchedule,
} from "../../modules/dunning/utils/retry-schedule"
import { SUBSCRIPTION_MODULE } from "../../modules/subscription"
import type SubscriptionModuleService from "../../modules/subscription/service"
import {
  ActivityLogActorType,
  ActivityLogEventType,
} from "../../modules/activity-log/types"
import { persistDunningLifecycleEvent } from "../utils/dunning-log-event"
import { toISOStringOrNull } from "../utils/date-output"

type DunningCaseRecord = {
  id: string
  subscription_id: string
  renewal_cycle_id: string
  renewal_order_id: string | null
  status: DunningCaseStatus
  attempt_count: number
  max_attempts: number
  retry_schedule: DunningRetrySchedule | null
  next_retry_at: Date | null
  metadata: Record<string, unknown> | null
}

/**
 * Display-only projection: the schedule-update event reads the subscription's
 * labels, but a missing subscription row must not fail the operator's override.
 */
type SubscriptionDisplayRecord = {
  reference: string
  customer_id: string
  customer_snapshot: { full_name?: string | null } | null
  product_snapshot: {
    product_title?: string | null
    variant_title?: string | null
  } | null
}

export type UpdateDunningRetryScheduleStepInput = {
  dunning_case_id: string
  intervals: number[]
  max_attempts: number
  triggered_by?: string | null
  reason?: string | null
}

function appendAuditMetadata(
  metadata: Record<string, unknown> | null,
  input: UpdateDunningRetryScheduleStepInput,
  at: string
) {
  const existing = Array.isArray(metadata?.manual_actions)
    ? [...(metadata?.manual_actions as Record<string, unknown>[])]
    : []

  existing.push({
    action: "update_retry_schedule",
    who: input.triggered_by ?? null,
    when: at,
    reason: input.reason ?? null,
    schedule: {
      intervals: input.intervals,
      max_attempts: input.max_attempts,
    },
  })

  return {
    ...(metadata ?? {}),
    manual_actions: existing,
    last_manual_action: existing[existing.length - 1],
  }
}

export const updateDunningRetryScheduleStep = createStep(
  "update-dunning-retry-schedule",
  async function (
    input: UpdateDunningRetryScheduleStepInput,
    { container }
  ) {
    const dunningModule = container.resolve<DunningModuleService>(DUNNING_MODULE)

    const dunningCase = (await dunningModule.retrieveDunningCase(
      input.dunning_case_id
    )) as DunningCaseRecord

    if (dunningCase.status === DunningCaseStatus.RECOVERED) {
      throw dunningErrors.alreadyRecovered(dunningCase.id)
    }

    if (dunningCase.status === DunningCaseStatus.UNRECOVERED) {
      throw dunningErrors.alreadyUnrecovered(dunningCase.id)
    }

    if (dunningCase.status === DunningCaseStatus.RETRYING) {
      throw dunningErrors.retryInFlightTransitionBlocked(
        dunningCase.id,
        "update retry schedule"
      )
    }

    const retrySchedule: DunningRetrySchedule = {
      strategy: "fixed_intervals",
      intervals: [...input.intervals],
      timezone: "UTC",
      source: "manual_override",
    }

    try {
      validateDunningRetrySchedule(retrySchedule, input.max_attempts)
    } catch (error) {
      throw dunningErrors.invalidData(
        error instanceof Error ? error.message : "Invalid retry schedule"
      )
    }

    if (input.max_attempts < dunningCase.attempt_count) {
      throw dunningErrors.conflict(
        `DunningCase '${dunningCase.id}' already has ${dunningCase.attempt_count} attempts, which exceeds the requested max_attempts`
      )
    }

    const changedAt = new Date()

    let nextRetryAt = dunningCase.next_retry_at
    let nextStatus = dunningCase.status

    if (dunningCase.status === DunningCaseStatus.OPEN) {
      nextRetryAt = calculateNextRetryAt(retrySchedule, 0, changedAt)
      nextStatus = DunningCaseStatus.RETRY_SCHEDULED
    } else if (dunningCase.status === DunningCaseStatus.RETRY_SCHEDULED) {
      nextRetryAt = calculateNextRetryAt(
        retrySchedule,
        dunningCase.attempt_count,
        changedAt
      )
      nextStatus = DunningCaseStatus.RETRY_SCHEDULED
    } else if (dunningCase.status === DunningCaseStatus.AWAITING_MANUAL_RESOLUTION) {
      nextRetryAt = null
      nextStatus = DunningCaseStatus.AWAITING_MANUAL_RESOLUTION
    }

    if (
      nextStatus === DunningCaseStatus.RETRY_SCHEDULED &&
      !nextRetryAt
    ) {
      throw dunningErrors.invalidRetryScheduleOverride(dunningCase.id)
    }

    const updated = await dunningModule.updateDunningCases({
      id: dunningCase.id,
      status: nextStatus,
      retry_schedule: retrySchedule,
      max_attempts: input.max_attempts,
      next_retry_at: nextRetryAt,
      metadata: appendAuditMetadata(
        dunningCase.metadata,
        input,
        changedAt.toISOString()
      ),
    } as any)

    // Display-only read for the activity-log snapshot: a missing subscription
    // row leaves the labels empty instead of failing the override.
    const subscriptionModule =
      container.resolve<SubscriptionModuleService>(SUBSCRIPTION_MODULE)

    let subscription: SubscriptionDisplayRecord | null = null

    try {
      subscription = (await subscriptionModule.retrieveSubscription(
        dunningCase.subscription_id
      )) as unknown as SubscriptionDisplayRecord
    } catch {
      subscription = null
    }

    // DUNNING_RETRY_SCHEDULE_UPDATED (Task 11): persisted AND emitted through
    // the shared activity-log funnel for the operator's schedule override.
    await persistDunningLifecycleEvent(container, {
      event_type: ActivityLogEventType.DUNNING_RETRY_SCHEDULE_UPDATED,
      dunning_case_id: dunningCase.id,
      subscription_id: dunningCase.subscription_id,
      renewal_cycle_id: dunningCase.renewal_cycle_id,
      renewal_order_id: dunningCase.renewal_order_id,
      subscription_display: subscription
        ? {
            customer_id: subscription.customer_id,
            reference: subscription.reference,
            customer_name: subscription.customer_snapshot?.full_name ?? null,
            product_title: subscription.product_snapshot?.product_title ?? null,
            variant_title: subscription.product_snapshot?.variant_title ?? null,
          }
        : null,
      previous_state: {
        status: dunningCase.status,
        attempt_count: dunningCase.attempt_count,
        max_attempts: dunningCase.max_attempts,
        next_retry_at: toISOStringOrNull(dunningCase.next_retry_at),
        retry_schedule: dunningCase.retry_schedule ?? null,
      },
      new_state: {
        status: nextStatus,
        attempt_count: dunningCase.attempt_count,
        max_attempts: input.max_attempts,
        next_retry_at: toISOStringOrNull(nextRetryAt),
        retry_schedule: retrySchedule,
      },
      actor_type: input.triggered_by
        ? ActivityLogActorType.USER
        : ActivityLogActorType.SYSTEM,
      actor_id: input.triggered_by ?? null,
      trigger_type: "manual",
      reason: input.reason ?? null,
      dedupe_qualifier: toISOStringOrNull(changedAt),
    })

    return new StepResponse(updated, dunningCase)
  },
  async function (previousCase: DunningCaseRecord, { container }) {
    if (!previousCase) {
      return
    }

    const dunningModule = container.resolve<DunningModuleService>(DUNNING_MODULE)

    await dunningModule.updateDunningCases(previousCase as any)
  }
)
