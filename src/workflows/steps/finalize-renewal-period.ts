import { MedusaContainer } from "@medusajs/framework/types"
import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { RENEWAL_MODULE } from "../../modules/renewal"
import RenewalModuleService from "../../modules/renewal/service"
import {
  RenewalAppliedPendingUpdateData,
  RenewalAttemptStatus,
  RenewalCycleStatus,
} from "../../modules/renewal/types"
import { renewalErrors } from "../../modules/renewal/utils/errors"
import { SUBSCRIPTION_MODULE } from "../../modules/subscription"
import SubscriptionModuleService from "../../modules/subscription/service"
import {
  SubscriptionFrequencyInterval,
  SubscriptionPendingUpdateData,
  SubscriptionStatus,
} from "../../modules/subscription/types"
import { addSubscriptionCadence } from "../../modules/subscription/utils/effective-next-renewal"
import {
  ActivityLogActorType,
  ActivityLogEventType,
} from "../../modules/activity-log/types"
import { normalizeActivityLogEvent } from "../../modules/activity-log/utils/normalize-log-event"
import { persistSubscriptionLogEvent } from "../../modules/activity-log/utils/persist-log-event"
import { emitSubscriptionBusEvent } from "./create-subscription-log-event"
import { ensureNextRenewalCycleWorkflow } from "../ensure-next-renewal-cycle"
import { toISOStringOrNull } from "../utils/date-output"

/**
 * The one place a paid period is settled: mark the cycle `succeeded`, advance
 * the subscription cadence, set `last_renewal_at`, clear the applied pending
 * changes, reset `structural_attempt_count`, ensure the next cycle, and
 * persist + emit `renewal.succeeded`.
 *
 * The cadence is anchored on the cycle's own `scheduled_for`, never on `now`
 * (decision R6). Its documented consequence is a catch-up charge when a period
 * is recovered days late: the next period lands one cadence after the original
 * anchor — possibly in the past — so the scheduler bills it on the next pass
 * instead of letting the billing date drift by the recovery delay. Do not
 * "improve" this to `max(now, scheduled_for)`: that is
 * `complete-manual-renewal`'s rule for a different reason (a manual payment
 * can arrive arbitrarily late), and mixing the two would make the anchor
 * depend on which rail paid. `complete-manual-renewal` therefore keeps its own
 * anchor rule until it consumes this step; any path that settles a period
 * through here (the automatic renewal path today, dunning recovery and the
 * stuck-cycle reconciliation later) shares the `scheduled_for` anchor and must
 * be pinned to it by test.
 */
export type FinalizeRenewalPeriodCycle = {
  id: string
  status: RenewalCycleStatus
  scheduled_for: Date
  attempt_count: number
  processed_at: Date | null
  generated_order_id: string | null
  last_error: string | null
}

export type FinalizeRenewalPeriodSubscription = {
  id: string
  reference: string
  status: SubscriptionStatus
  customer_id: string
  variant_id: string
  frequency_interval: SubscriptionFrequencyInterval
  frequency_value: number
  skip_next_cycle: boolean
  free_cycles_remaining: number | null
  pending_update_data: SubscriptionPendingUpdateData | null
  customer_snapshot: {
    email?: string
    full_name?: string | null
  } | null
  product_snapshot: {
    product_id: string
    product_title: string
    variant_id: string
    variant_title: string
    sku: string | null
  }
}

/**
 * Who settled the period, as the activity-log event reports it. The automatic
 * path derives `source`/`actor_type` from its trigger type; dunning recovery
 * (Task 6) will pass its own.
 */
export type FinalizeRenewalPeriodTrigger = {
  source: string
  trigger_type: string
  actor_type: ActivityLogActorType
  actor_id: string | null
  correlation_id: string
}

export type FinalizeRenewalPeriodInput = {
  cycle: FinalizeRenewalPeriodCycle
  subscription: FinalizeRenewalPeriodSubscription
  applied_pending_changes: RenewalAppliedPendingUpdateData | null
  generated_order_id: string | null
  trigger: FinalizeRenewalPeriodTrigger
  /**
   * Why the period was settled the way it was, recorded verbatim in the
   * `renewal.succeeded` activity-log event. The automatic path has no reason;
   * operator-driven paths (stuck-cycle reconciliation, Task 9's route) pass
   * the reason the operator gave.
   */
  reason?: string | null
  /** The renewal attempt to close as `succeeded`, when the caller tracks one. */
  attempt_id?: string
  /**
   * Defaults to true. The automatic path passes false because its workflow
   * runs `ensureNextRenewalCycleStep` after this step: inside the step an
   * ensure failure would fall into the step's failure handler and re-mark an
   * already-settled (paid) period as failed, while outside the step the same
   * failure only fails the workflow and the settlement stands.
   */
  ensure_next_cycle?: boolean
}

/**
 * Settles a paid period. Callers own the settle-eligibility decision (the
 * cycle must actually be the one the order paid); this function owns the
 * settlement writes and their event. The return carries the updated cycle and
 * the next period's anchor (`FinalizeRenewalPeriodResult`).
 */
export async function finalizeRenewalPeriod(
  container: MedusaContainer,
  input: FinalizeRenewalPeriodInput
) {
  const renewalModule = container.resolve<RenewalModuleService>(RENEWAL_MODULE)
  const subscriptionModule =
    container.resolve<SubscriptionModuleService>(SUBSCRIPTION_MODULE)

  const { cycle, subscription } = input
  const appliedPendingChanges = input.applied_pending_changes
  const generatedOrderId = input.generated_order_id
  const trigger = input.trigger
  const finishedAt = new Date()

  // Decision R6: anchored on the period's own date — see the header comment.
  const nextInterval =
    appliedPendingChanges?.frequency_interval ?? subscription.frequency_interval
  const nextValue =
    appliedPendingChanges?.frequency_value ?? subscription.frequency_value
  const nextRenewalAt = addSubscriptionCadence(
    new Date(cycle.scheduled_for),
    nextInterval,
    nextValue
  )

  const isFreeCycle =
    subscription.skip_next_cycle ||
    (subscription.free_cycles_remaining ?? 0) > 0

  const nextProductSnapshot = appliedPendingChanges
    ? {
        ...subscription.product_snapshot,
        variant_id: appliedPendingChanges.variant_id,
        variant_title: appliedPendingChanges.variant_title,
        sku: subscription.pending_update_data?.sku ?? subscription.product_snapshot.sku,
      }
    : subscription.product_snapshot

  await subscriptionModule.updateSubscriptions({
    id: subscription.id,
    // A settled period recovers a past-due subscription.
    status: SubscriptionStatus.ACTIVE,
    variant_id:
      appliedPendingChanges?.variant_id ?? subscription.variant_id,
    frequency_interval: nextInterval,
    frequency_value: nextValue,
    product_snapshot: nextProductSnapshot,
    next_renewal_at: nextRenewalAt,
    last_renewal_at: finishedAt,
    skip_next_cycle: false,
    free_cycles_remaining: isFreeCycle && !subscription.skip_next_cycle
      ? (subscription.free_cycles_remaining ?? 0) - 1
      : subscription.free_cycles_remaining ?? 0,
    pending_update_data: appliedPendingChanges ? null : subscription.pending_update_data,
  })

  const updatedCycle = await renewalModule.updateRenewalCycles({
    id: cycle.id,
    status: RenewalCycleStatus.SUCCEEDED,
    processed_at: finishedAt,
    generated_order_id: generatedOrderId,
    last_error: null,
    last_failure_kind: null,
    // A settled period starts its next one with a clean structural slate.
    structural_attempt_count: 0,
  })

  if (input.attempt_id) {
    await renewalModule.updateRenewalAttempts({
      id: input.attempt_id,
      status: RenewalAttemptStatus.SUCCEEDED,
      finished_at: finishedAt,
      order_id: generatedOrderId,
      error_code: null,
      error_message: null,
    })
  }

  const renewalLogEvent = normalizeActivityLogEvent({
    subscription_id: subscription.id,
    customer_id: subscription.customer_id,
    event_type: ActivityLogEventType.RENEWAL_SUCCEEDED,
    actor_type: trigger.actor_type,
    actor_id: trigger.actor_id,
    display: {
      subscription_reference: subscription.reference,
      customer_name: subscription.customer_snapshot?.full_name ?? null,
      product_title: subscription.product_snapshot.product_title ?? null,
      variant_title:
        appliedPendingChanges?.variant_title ??
        subscription.product_snapshot.variant_title ??
        null,
    },
    previous_state: {
      status: cycle.status,
      attempt_count: cycle.attempt_count,
      processed_at: toISOStringOrNull(cycle.processed_at),
      generated_order_id: cycle.generated_order_id,
      last_error: cycle.last_error,
    },
    new_state: {
      status: updatedCycle.status,
      attempt_count: updatedCycle.attempt_count,
      processed_at: toISOStringOrNull(updatedCycle.processed_at),
      generated_order_id: updatedCycle.generated_order_id,
      last_error: updatedCycle.last_error,
      applied_pending_update_data: appliedPendingChanges,
    },
    reason: input.reason ?? null,
    metadata: {
      source: trigger.source,
      renewal_cycle_id: cycle.id,
      order_id: generatedOrderId,
      trigger_type: trigger.trigger_type,
      scheduled_for: toISOStringOrNull(cycle.scheduled_for),
    },
    correlation_id: trigger.correlation_id,
    dedupe: {
      scope: "renewal",
      target_id: cycle.id,
      qualifier: toISOStringOrNull(updatedCycle.processed_at),
    },
  })

  await persistSubscriptionLogEvent(container, renewalLogEvent)

  // There is no checkout-time order to settle auto-renewals against (renewal
  // orders carry no plan in metadata), so renewal.succeeded is the only
  // signal the SaaS site mirrors into its D1 entitlement.
  await emitSubscriptionBusEvent(container, renewalLogEvent)

  if (input.ensure_next_cycle !== false) {
    await ensureNextRenewalCycleWorkflow(container).run({
      input: {
        subscription_id: subscription.id,
      },
    })
  }

  return {
    renewal_cycle: updatedCycle,
    next_renewal_at: nextRenewalAt,
  }
}

export type FinalizeRenewalPeriodResult = Awaited<
  ReturnType<typeof finalizeRenewalPeriod>
>

export type FinalizeRenewalPeriodStepInput = {
  renewal_cycle_id: string
  /** The order that actually paid the period, when one exists (free cycles settle with null). */
  generated_order_id: string | null
  trigger: FinalizeRenewalPeriodTrigger
  /**
   * The crashed attempt to close as `succeeded`, for reconciliation-style
   * callers (stuck-cycle reconciliation, Task 8): the run that captured the
   * payment did crash, but the payment did go through, so its attempt row is
   * closed succeeded alongside the settlement.
   */
  attempt_id?: string
  /** Recorded verbatim in the `renewal.succeeded` activity-log event. */
  reason?: string | null
}

type PersistedFinalizeRenewalPeriodCycle = FinalizeRenewalPeriodCycle & {
  subscription_id: string
  applied_pending_update_data: RenewalAppliedPendingUpdateData | null
}

/**
 * The standalone form of the settlement, for paths that hold only ids: the
 * dunning recovery path and the stuck-cycle reconciliation (Tasks 6 and 8).
 * Callers own the settled-cycle guard — a cycle that already reads
 * `succeeded` or `abandoned` must be refused before this step runs.
 */
export const finalizeRenewalPeriodStep = createStep(
  "finalize-renewal-period",
  async function (
    input: FinalizeRenewalPeriodStepInput,
    { container }: { container: MedusaContainer }
  ) {
    const renewalModule =
      container.resolve<RenewalModuleService>(RENEWAL_MODULE)
    const subscriptionModule =
      container.resolve<SubscriptionModuleService>(SUBSCRIPTION_MODULE)

    let cycle: PersistedFinalizeRenewalPeriodCycle

    try {
      cycle = (await renewalModule.retrieveRenewalCycle(
        input.renewal_cycle_id
      )) as unknown as PersistedFinalizeRenewalPeriodCycle
    } catch {
      throw renewalErrors.notFound("RenewalCycle", input.renewal_cycle_id)
    }

    let subscription: FinalizeRenewalPeriodSubscription

    try {
      subscription = (await subscriptionModule.retrieveSubscription(
        cycle.subscription_id
      )) as unknown as FinalizeRenewalPeriodSubscription
    } catch {
      throw renewalErrors.notFound("Subscription", cycle.subscription_id)
    }

    return new StepResponse(
      await finalizeRenewalPeriod(container, {
        cycle,
        subscription,
        applied_pending_changes: cycle.applied_pending_update_data,
        generated_order_id: input.generated_order_id,
        trigger: input.trigger,
        attempt_id: input.attempt_id,
        reason: input.reason,
      })
    )
  }
)
