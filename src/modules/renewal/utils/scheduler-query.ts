import { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import {
  RenewalApprovalStatus,
  RenewalCycleStatus,
} from "../types"
import { DunningCaseStatus } from "../../dunning/types"
import { SUBSCRIPTION_MODULE } from "../../subscription"
import type SubscriptionModuleService from "../../subscription/service"
import {
  DispositionPaymentContext,
  OPEN_DUNNING_CASE_STATUSES,
  resolveCycleDisposition,
} from "./cycle-disposition"

export type ListDueRenewalCyclesInput = {
  limit: number
  offset: number
  now?: Date
}

export type DueRenewalCycleRecord = {
  id: string
  subscription_id: string
  scheduled_for: string
  status: RenewalCycleStatus
  approval_required: boolean
  approval_status: RenewalApprovalStatus | null
}

export type DueRenewalCyclesResult = {
  cycles: DueRenewalCycleRecord[]
  count: number
  limit: number
  offset: number
}

const schedulerCycleFields = [
  "id",
  "subscription_id",
  "scheduled_for",
  "status",
  "approval_required",
  "approval_status",
] as const

function isApprovalEligible(record: DueRenewalCycleRecord) {
  if (!record.approval_required) {
    return true
  }

  return record.approval_status === RenewalApprovalStatus.APPROVED
}

// isApprovalEligible runs AFTER pagination, so a page made up entirely of
// approval-blocked rows yields a short (or empty) batch instead of being
// backfilled from the next page. The behaviour stays: the predicate compares
// two of the row's own fields and is not expressible in the graph filter, and
// the manual renewal rework that supersedes this filter is out of scope.

export async function listDueRenewalCyclesForProcessing(
  container: MedusaContainer,
  input: ListDueRenewalCyclesInput
): Promise<DueRenewalCyclesResult> {
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const now = input.now ?? new Date()

  const {
    data,
    metadata: { count = 0, take = input.limit, skip = input.offset } = {},
  } = await query.graph({
    entity: "renewal_cycle",
    fields: [...schedulerCycleFields],
    filters: {
      status: [RenewalCycleStatus.SCHEDULED, RenewalCycleStatus.FAILED],
      scheduled_for: {
        $lte: now,
      },
    },
    pagination: {
      take: input.limit,
      skip: input.offset,
      order: {
        scheduled_for: "ASC",
      },
    },
  })

  const cycles = (data as DueRenewalCycleRecord[]).filter(isApprovalEligible)

  const chargeable = await excludeNonChargeableCycles(container, cycles)

  return {
    cycles: chargeable,
    count,
    limit: take,
    offset: skip,
  }
}

export type StuckRenewalCycleRecord = {
  id: string
  subscription_id: string
  scheduled_for: string
  status: RenewalCycleStatus
  updated_at: string
}

export type ListStuckRenewalCyclesInput = {
  limit: number
  offset: number
  now?: Date
  /** Override for `STUCK_RENEWAL_CYCLE_THRESHOLD_MINUTES` (tests). */
  stale_after_minutes?: number
}

export type StuckRenewalCyclesResult = {
  cycles: StuckRenewalCycleRecord[]
  count: number
  limit: number
  offset: number
}

/**
 * How long a `processing` cycle may stay untouched before the reconciliation
 * job treats it as crashed. 30 minutes is deliberately far beyond any
 * legitimate provider call in the charge path (off-session authorize/capture
 * completes in seconds; the workflow's own steps hold no long waits), so a
 * cycle this old is a crashed or killed run, not a slow one — while staying
 * short enough that the hourly job recovers the period the same day.
 */
export const STUCK_RENEWAL_CYCLE_THRESHOLD_MINUTES = 30

const stuckCycleFields = [
  "id",
  "subscription_id",
  "scheduled_for",
  "status",
  "updated_at",
] as const

/**
 * Cycles stuck in `processing` whose run is presumed crashed: the charge
 * scheduler moves a cycle to `processing` when it starts and only a
 * post-settlement (or post-failure) write moves it out, so a row that is still
 * `processing` and has not been updated past the stale threshold has no owner
 * left. `awaiting_manual_resolution` is deliberately NOT returned here — a
 * parked cycle waits for a human, and re-processing it would undo the park.
 */
export async function listStuckProcessingRenewalCycles(
  container: MedusaContainer,
  input: ListStuckRenewalCyclesInput
): Promise<StuckRenewalCyclesResult> {
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const now = input.now ?? new Date()
  const staleAfterMs =
    (input.stale_after_minutes ?? STUCK_RENEWAL_CYCLE_THRESHOLD_MINUTES) *
    60_000
  const staleBefore = new Date(now.getTime() - staleAfterMs)

  const {
    data,
    metadata: { count = 0, take = input.limit, skip = input.offset } = {},
  } = await query.graph({
    entity: "renewal_cycle",
    fields: [...stuckCycleFields],
    filters: {
      status: [RenewalCycleStatus.PROCESSING],
      updated_at: {
        $lt: staleBefore,
      },
    },
    pagination: {
      take: input.limit,
      skip: input.offset,
      order: {
        updated_at: "ASC",
      },
    },
  })

  return {
    cycles: data as StuckRenewalCycleRecord[],
    count,
    limit: take,
    offset: skip,
  }
}

/**
 * Everything that must never reach the off-session scheduler, decided by the
 * one disposition predicate (`resolveCycleDisposition`) that the
 * `process-renewal-cycle` step also consumes, so the scheduler's exclusions
 * and the step's defensive guards cannot drift:
 *
 * - "not_chargeable": subscriptions whose status is not `active`/`past_due`
 *   (paused and cancelled subscriptions used to loop silently here), cycles
 *   whose cancellation is effective at or before `scheduled_for`, native
 *   mirror rows whose recurrence PayPal charges itself, and manual-mode
 *   subscriptions, which are renewed through the interactive manual renewal
 *   flow instead
 * - "dunning_owns": an open dunning case (open, retry_scheduled, retrying,
 *   awaiting_manual_resolution) owns the cycle's recovery
 *
 * The one carve-out is the manual trial-end cycle ("trial_end"): a manual-mode
 * subscription is excluded except when it is a trial whose cycle is at or
 * after `trial_ends_at` — that cycle stays processable so the trial-end branch
 * in the process step can run on time instead of the subscription lingering
 * until the hygiene cancellation. That branch never charges a manual
 * subscription.
 *
 * Excluded cycles keep their status (so the manual flow can still mark a due
 * manual cycle succeeded on payment) and are dropped here to keep the
 * scheduler from charging or failing them.
 *
 * Open dunning cases are loaded for the page's cycle ids in one query and
 * matched by `renewal_cycle_id` — never one query per cycle.
 *
 * Note: the filter runs after pagination, so a page consisting solely of
 * excluded cycles returns an empty batch until the next offset pass. Volume
 * for manual subscriptions is expected to be small; the manual renewal rework
 * (dedicated cycle lifecycle) supersedes this filter.
 */
type OpenDunningCaseRecord = {
  id: string
  renewal_cycle_id: string
  status: DunningCaseStatus
}

async function excludeNonChargeableCycles(
  container: MedusaContainer,
  cycles: DueRenewalCycleRecord[]
): Promise<DueRenewalCycleRecord[]> {
  if (!cycles.length) {
    return cycles
  }

  const subscriptionModule = container.resolve<SubscriptionModuleService>(
    SUBSCRIPTION_MODULE
  )
  const query = container.resolve(ContainerRegistrationKeys.QUERY)

  const subscriptionIds = Array.from(
    new Set(cycles.map((cycle) => cycle.subscription_id))
  )

  const subscriptions = await subscriptionModule.listSubscriptions({
    id: subscriptionIds,
  })

  const { data: openCaseRows } = await query.graph({
    entity: "dunning_case",
    fields: ["id", "renewal_cycle_id", "status"],
    filters: {
      renewal_cycle_id: cycles.map((cycle) => cycle.id),
      status: [...OPEN_DUNNING_CASE_STATUSES],
    },
  })
  const openCases = openCaseRows as OpenDunningCaseRecord[]

  const subscriptionById = new Map(
    subscriptions.map((subscription) => [subscription.id, subscription])
  )
  const openCaseByCycleId = new Map(
    openCases.map((dunningCase) => [dunningCase.renewal_cycle_id, dunningCase])
  )

  return cycles.filter((cycle) => {
    const subscription = subscriptionById.get(cycle.subscription_id)

    // A cycle whose subscription row cannot be loaded could not be executed
    // by the step either (it fails loading the subscription), so drop it.
    if (!subscription) {
      return false
    }

    const disposition = resolveCycleDisposition(
      cycle,
      {
        reference: subscription.reference,
        status: subscription.status,
        cancel_effective_at: subscription.cancel_effective_at,
        is_trial: subscription.is_trial,
        trial_ends_at: subscription.trial_ends_at,
        payment_context: (subscription.payment_context ??
          null) as DispositionPaymentContext | null,
        free_cycles_remaining: subscription.free_cycles_remaining ?? null,
        skip_next_cycle: subscription.skip_next_cycle,
      },
      openCaseByCycleId.get(cycle.id) ?? null
    )

    return disposition === "charge" || disposition === "trial_end"
  })
}

