import {
  RenewalApprovalStatus,
  RenewalCycleStatus,
} from "../types"
import { SubscriptionRenewalBehavior } from "../../settings/types"
import { SubscriptionPendingUpdateData, SubscriptionStatus } from "../../subscription/types"

export type UpcomingRenewalSubscriptionRecord = {
  id: string
  status: SubscriptionStatus
  next_renewal_at: Date | null
  cancelled_at: Date | null
  cancel_effective_at: Date | null
  pending_update_data: SubscriptionPendingUpdateData | null
}

export type UpcomingRenewalCycleRecord = {
  id: string
  subscription_id: string
  scheduled_for: Date
  processed_at: Date | null
  status: RenewalCycleStatus
  approval_required: boolean
  approval_status: RenewalApprovalStatus | null
  approval_decided_at: Date | null
  approval_decided_by: string | null
  approval_reason: string | null
  generated_order_id: string | null
  applied_pending_update_data: Record<string, unknown> | null
  last_error: string | null
  attempt_count: number
  metadata: Record<string, unknown> | null
}

/**
 * The four things the upcoming-cycle step can do with the rows a subscription
 * already carries. See `resolveUpcomingCycle` for the decision rules.
 */
export type UpcomingCycleResolution =
  | { action: "match"; cycle: UpcomingRenewalCycleRecord }
  | { action: "adopt"; cycle: UpcomingRenewalCycleRecord }
  | { action: "defer"; cycle: UpcomingRenewalCycleRecord }
  | { action: "create" }

/**
 * Every column a reconciliation write is allowed to put on an existing upcoming
 * cycle row: `match` re-derives the approval state and the settings policy,
 * `adopt` also moves the row onto the entitlement date. Declaring the set once
 * is what keeps a rollback from drifting behind the write it has to undo.
 */
export type UpcomingCycleReconcilePatch = {
  scheduled_for?: Date
  approval_required: boolean
  approval_status: RenewalApprovalStatus | null
  approval_decided_at: Date | null
  approval_decided_by: string | null
  approval_reason: string | null
  metadata: Record<string, unknown> | null
}

/**
 * The pre-write value of every field of `UpcomingCycleReconcilePatch`, derived
 * from that same type: adding a column to the write without adding it here is a
 * type error, not a row that comes back half-repaired.
 */
export type UpcomingCycleReconcileRestore = {
  [TField in keyof UpcomingCycleReconcilePatch]-?: UpcomingCycleReconcilePatch[TField]
}

export function shouldSubscriptionHaveUpcomingRenewalCycle(
  subscription: UpcomingRenewalSubscriptionRecord
) {
  if (
    subscription.status !== SubscriptionStatus.ACTIVE &&
    subscription.status !== SubscriptionStatus.PAST_DUE
  ) {
    return false
  }

  if (!subscription.next_renewal_at) {
    return false
  }

  if (subscription.cancelled_at) {
    return false
  }

  if (
    subscription.cancel_effective_at &&
    subscription.cancel_effective_at <= subscription.next_renewal_at
  ) {
    return false
  }

  return true
}

export function deriveUpcomingRenewalApprovalState(
  subscription: UpcomingRenewalSubscriptionRecord,
  scheduledFor: Date,
  behavior = SubscriptionRenewalBehavior.REQUIRE_REVIEW_FOR_PENDING_CHANGES
) {
  const pendingUpdateApplicable = isPendingUpdateApplicable(
    scheduledFor,
    subscription.pending_update_data
  )
  const requiresApproval =
    behavior ===
      SubscriptionRenewalBehavior.REQUIRE_REVIEW_FOR_PENDING_CHANGES &&
    pendingUpdateApplicable

  return {
    approval_required: requiresApproval,
    approval_status: requiresApproval ? RenewalApprovalStatus.PENDING : null,
    approval_decided_at: null,
    approval_decided_by: null,
    approval_reason: null,
  }
}

/**
 * Snapshot the compensation has to roll a reconciliation write back with. The
 * step writes the patch and hands this back in the same statement, so an
 * `adopted` rollback that restored only `scheduled_for` could not silently
 * leave the approval state and the settings policy it also overwrote behind.
 */
export function restoreForUpcomingCycleReconcile(
  cycle: UpcomingRenewalCycleRecord
): UpcomingCycleReconcileRestore {
  return {
    scheduled_for: cycle.scheduled_for,
    approval_required: cycle.approval_required,
    approval_status: cycle.approval_status,
    approval_decided_at: cycle.approval_decided_at,
    approval_decided_by: cycle.approval_decided_by,
    approval_reason: cycle.approval_reason,
    metadata: cycle.metadata,
  }
}

export function findUpcomingRenewalCycle(
  cycles: UpcomingRenewalCycleRecord[],
  scheduledFor: Date
) {
  return cycles.find((cycle) => {
    return cycle.scheduled_for.getTime() === scheduledFor.getTime()
  })
}

/**
 * Rows that can still stand for the upcoming renewal: `scheduled` waits for the
 * scheduler, `processing` is mid-flight. `succeeded` and `failed` belong to a
 * period that already ended and must never be dragged along the entitlement
 * date (`failed` on purpose: `scheduler-query.ts` re-arms failed rows, so
 * rewriting one would resurrect a past attempt).
 */
function isOpenUpcomingCycle(cycle: UpcomingRenewalCycleRecord) {
  return (
    cycle.status === RenewalCycleStatus.SCHEDULED ||
    cycle.status === RenewalCycleStatus.PROCESSING
  )
}

/**
 * A row whose money is already in motion. `create-manual-renewal` reuses a due
 * `scheduled` row without touching its status and only stamps
 * `generated_order_id`, so an order can sit unpaid on a row that still reads
 * `scheduled`; moving that row's date would re-arm a cycle that is already
 * billed. A `processing` row is mid-flight for the same reason.
 */
function hasInFlightRenewal(cycle: UpcomingRenewalCycleRecord) {
  return (
    cycle.status === RenewalCycleStatus.PROCESSING ||
    cycle.generated_order_id != null
  )
}

/**
 * Deterministic candidate pick, independent of the order rows come back in:
 * the latest date wins, identical dates fall back to the smaller id.
 */
function preferLaterCycle(
  left: UpcomingRenewalCycleRecord,
  right: UpcomingRenewalCycleRecord
) {
  const delta = left.scheduled_for.getTime() - right.scheduled_for.getTime()

  if (delta !== 0) {
    return delta > 0 ? left : right
  }

  return left.id <= right.id ? left : right
}

/**
 * Decide how the subscription's existing rows relate to the entitlement date
 * (`subscription.next_renewal_at`), so the step reconciles one row instead of
 * appending a second future `scheduled` row: a stacked purchase extends the
 * cadence and leaves the previous cycle behind, which the scheduler would then
 * charge a second time.
 *
 * - `match`     a row already sits on the entitlement date (any status): today's
 *               approval-state update
 * - `adopt`     an open row sits elsewhere and is free to follow the entitlement
 *               date, past-dated included: `process-renewal-cycle` moves
 *               anything it works on to `processing`, so an untouched
 *               `scheduled` row is by definition still unclaimed
 * - `defer`     the row that would be adopted has an in-flight renewal order:
 *               leave every row alone and let the operator resolve the overlap
 * - `create`    no open row at all: the next period starts a fresh cycle
 *
 * `match` outranks `adopt` for every status, pinned contract (see the `match`
 * block below and its spec cases).
 *
 * Deliberately unaware of the persistence boundary: when drift left more than
 * one live `scheduled` row, the candidate pick keeps the invariant repair
 * local, and `renewal_cycle_one_scheduled_per_subscription` rejects the write
 * that would tolerate the duplicate instead of surfacing it.
 */
export function resolveUpcomingCycle(
  cycles: UpcomingRenewalCycleRecord[],
  scheduledFor: Date
): UpcomingCycleResolution {
  const exactMatch = findUpcomingRenewalCycle(cycles, scheduledFor)

  /**
   * Pinned contract: an exact-date hit wins even when it is terminal, so a
   * stale live `scheduled` row sitting behind a `succeeded` or `failed` row on
   * the entitlement date is reported as `match`, not adopted. Both halves of
   * the invariant are then restored by the constraint, not by this selector:
   * adopting that stale row would put a second chargeable cycle on a period a
   * terminal row already settled (a double charge), and the same seam exists
   * for an exact-date `scheduled` hit with a stale `scheduled` sibling, which
   * no reordering here can repair either. The state needs the step to delete a
   * row it does not own, and the normalize migration plus
   * `renewal_cycle_one_scheduled_per_subscription` make it unreachable for new
   * writes: the duplicate cycle a stacked purchase used to append is exactly
   * what `adopt` now prevents.
   */
  if (exactMatch) {
    return { action: "match", cycle: exactMatch }
  }

  const candidate = cycles
    .filter(isOpenUpcomingCycle)
    .reduce<UpcomingRenewalCycleRecord | null>(
      (best, cycle) => (best ? preferLaterCycle(best, cycle) : cycle),
      null
    )

  if (!candidate) {
    return { action: "create" }
  }

  return hasInFlightRenewal(candidate)
    ? { action: "defer", cycle: candidate }
    : { action: "adopt", cycle: candidate }
}

export function isPendingUpdateApplicable(
  scheduledFor: Date,
  pendingUpdateData: SubscriptionPendingUpdateData | null
) {
  if (!pendingUpdateData) {
    return false
  }

  if (!pendingUpdateData.effective_at) {
    return true
  }

  return new Date(pendingUpdateData.effective_at) <= scheduledFor
}
