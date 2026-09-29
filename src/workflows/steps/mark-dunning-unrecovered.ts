import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { DUNNING_MODULE } from "../../modules/dunning"
import type DunningModuleService from "../../modules/dunning/service"
import { DunningCaseStatus } from "../../modules/dunning/types"
import { dunningErrors } from "../../modules/dunning/utils/errors"
import { RENEWAL_MODULE } from "../../modules/renewal"
import type RenewalModuleService from "../../modules/renewal/service"
import { RenewalCycleStatus } from "../../modules/renewal/types"
import { SUBSCRIPTION_MODULE } from "../../modules/subscription"
import type SubscriptionModuleService from "../../modules/subscription/service"
import {
  ActivityLogActorType,
  ActivityLogEventType,
} from "../../modules/activity-log/types"
import { persistDunningLifecycleEvent } from "../utils/dunning-log-event"
import {
  persistRenewalResolutionEvent,
  type RenewalLogEventSubscriptionDisplay,
} from "../utils/renewal-log-event"
import { toISOStringOrNull } from "../utils/date-output"

type DunningCaseRecord = {
  id: string
  status: DunningCaseStatus
  renewal_cycle_id: string
  renewal_order_id: string | null
  subscription_id: string
  attempt_count: number
  next_retry_at: Date | null
  closed_at: Date | null
  recovery_reason: string | null
  metadata: Record<string, unknown> | null
}

type RenewalCycleRecord = {
  id: string
  status: RenewalCycleStatus
  last_error: string | null
}

/**
 * Display-only projection: the closure event reads the subscription's labels,
 * but a missing subscription row must not fail the operator's write-off.
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

export type MarkDunningUnrecoveredStepInput = {
  dunning_case_id: string
  triggered_by?: string | null
  reason: string
}

function appendAuditMetadata(
  metadata: Record<string, unknown> | null,
  input: MarkDunningUnrecoveredStepInput,
  at: string
) {
  const existing = Array.isArray(metadata?.manual_actions)
    ? [...(metadata?.manual_actions as Record<string, unknown>[])]
    : []

  existing.push({
    action: "mark_unrecovered",
    who: input.triggered_by ?? null,
    when: at,
    reason: input.reason,
  })

  return {
    ...(metadata ?? {}),
    manual_actions: existing,
    last_manual_action: existing[existing.length - 1],
  }
}

export const markDunningUnrecoveredStep = createStep(
  "mark-dunning-unrecovered",
  async function (
    input: MarkDunningUnrecoveredStepInput,
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
        "be marked unrecovered"
      )
    }

    // Exhaustion abandons the originating cycle (decision R3) — the same
    // settlement the automatic exhaustion in `run-dunning-retry` performs,
    // here driven by the operator's closure: the case's write-off IS the
    // write-off of the period it recovers. The inverse already exists as the
    // settled-cycle guard (R2) in `run-dunning-retry`, which closes cases
    // whose cycle is ALREADY settled.
    //
    // The cycle write lands BEFORE the case closes (the same ordering
    // discipline recovery follows): a crash in between leaves an `abandoned`
    // cycle behind an open case, which the settled-cycle guard closes without
    // charging — the reverse window would re-arm a written-off period for the
    // scheduler.
    //
    // Decision R3: the subscription is left `past_due` and this plugin must
    // NOT cancel it. Cancelling a customer relationship is not a side effect
    // a background (or admin-initiated) job performs; the host receives the
    // abandonment signal and decides what happens to the relationship.
    //
    // Emission point (Tasks 11/12): the abandonment event (`renewal.abandoned`)
    // is persisted AND emitted exactly where the write below lands, carrying
    // the cycle id and the operator's reason.
    const renewalModule = container.resolve<RenewalModuleService>(RENEWAL_MODULE)
    const renewalCycle = (await renewalModule.retrieveRenewalCycle(
      dunningCase.renewal_cycle_id
    )) as unknown as RenewalCycleRecord

    // Display-only read for the activity-log snapshot: a missing subscription
    // row leaves the labels empty instead of failing the operator's write-off.
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

    const subscriptionDisplay: RenewalLogEventSubscriptionDisplay = subscription
      ? {
          customer_id: subscription.customer_id,
          reference: subscription.reference,
          customer_name: subscription.customer_snapshot?.full_name ?? null,
          product_title: subscription.product_snapshot?.product_title ?? null,
          variant_title: subscription.product_snapshot?.variant_title ?? null,
        }
      : null

    if (
      renewalCycle.status !== RenewalCycleStatus.SUCCEEDED &&
      renewalCycle.status !== RenewalCycleStatus.ABANDONED
    ) {
      // Terminal cycles keep their own outcome: a `succeeded` period is never
      // overwritten with `abandoned` (that would un-settle a paid period the
      // operator's case closure disagrees with), and an already `abandoned`
      // cycle makes the write a no-op.
      const abandonmentError = `Dunning case marked unrecovered by admin: ${input.reason}`

      await renewalModule.updateRenewalCycles({
        id: renewalCycle.id,
        status: RenewalCycleStatus.ABANDONED,
        last_error: abandonmentError,
      })

      await persistRenewalResolutionEvent(container, {
        event_type: ActivityLogEventType.RENEWAL_ABANDONED,
        subscription_id: dunningCase.subscription_id,
        renewal_cycle_id: renewalCycle.id,
        subscription_display: subscriptionDisplay,
        previous_state: {
          status: renewalCycle.status,
          last_error: renewalCycle.last_error,
        },
        new_state: {
          status: RenewalCycleStatus.ABANDONED,
          last_error: abandonmentError,
        },
        reason: input.reason,
        actor_type: input.triggered_by
          ? ActivityLogActorType.USER
          : ActivityLogActorType.SYSTEM,
        actor_id: input.triggered_by ?? null,
        trigger_type: "manual",
        source: "admin",
        dunning_case_id: dunningCase.id,
        order_id: dunningCase.renewal_order_id,
        attempt_no: dunningCase.attempt_count,
      })
    }

    const changedAt = new Date()

    const updated = await dunningModule.updateDunningCases({
      id: dunningCase.id,
      status: DunningCaseStatus.UNRECOVERED,
      next_retry_at: null,
      closed_at: changedAt,
      recovery_reason: "marked_unrecovered_by_admin",
      metadata: appendAuditMetadata(
        dunningCase.metadata,
        input,
        changedAt.toISOString()
      ),
    } as any)

    // DUNNING_UNRECOVERED (Task 11): persisted AND emitted through the shared
    // activity-log funnel for the operator-driven write-off.
    await persistDunningLifecycleEvent(container, {
      event_type: ActivityLogEventType.DUNNING_UNRECOVERED,
      dunning_case_id: updated.id,
      subscription_id: dunningCase.subscription_id,
      renewal_cycle_id: dunningCase.renewal_cycle_id,
      renewal_order_id: dunningCase.renewal_order_id,
      subscription_display: subscriptionDisplay,
      previous_state: {
        status: dunningCase.status,
        attempt_count: dunningCase.attempt_count,
        next_retry_at: toISOStringOrNull(dunningCase.next_retry_at),
      },
      new_state: {
        status: DunningCaseStatus.UNRECOVERED,
        attempt_count: updated.attempt_count,
        next_retry_at: null,
        recovery_reason: "marked_unrecovered_by_admin",
      },
      actor_type: input.triggered_by
        ? ActivityLogActorType.USER
        : ActivityLogActorType.SYSTEM,
      actor_id: input.triggered_by ?? null,
      trigger_type: "manual",
      reason: input.reason,
      dedupe_qualifier: toISOStringOrNull(changedAt),
    })

    return new StepResponse(updated, {
      previousCase: dunningCase,
      previousCycle: renewalCycle,
    })
  },
  async function (
    previous: { previousCase: DunningCaseRecord; previousCycle: RenewalCycleRecord },
    { container }
  ) {
    if (!previous) {
      return
    }

    const dunningModule = container.resolve<DunningModuleService>(DUNNING_MODULE)
    const renewalModule = container.resolve<RenewalModuleService>(RENEWAL_MODULE)

    // The rollback derives its field list from the write: the abandonment
    // touched `status` and `last_error` on the cycle, so exactly those are
    // restored alongside the case snapshot.
    if (previous.previousCycle) {
      await renewalModule.updateRenewalCycles({
        id: previous.previousCycle.id,
        status: previous.previousCycle.status,
        last_error: previous.previousCycle.last_error,
      })
    }

    await dunningModule.updateDunningCases(previous.previousCase as any)
  }
)
