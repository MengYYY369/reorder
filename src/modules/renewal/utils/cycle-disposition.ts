import { DunningCaseStatus } from "../../dunning/types"
import {
  SubscriptionPaymentMode,
  SubscriptionStatus,
} from "../../subscription/types"
import { isNativeSubscriptionReference } from "../../subscription/utils/native-subscription"
import { RenewalCycleStatus } from "../types"

/**
 * What may — and what may not — still happen to a renewal cycle.
 *
 * This is the one disposition predicate both the scheduler's due query
 * (`listDueRenewalCyclesForProcessing`) and the `process-renewal-cycle` step
 * consume, so the scheduler's exclusions and the step's defensive guards
 * cannot drift apart: ownership of a cycle is decided here and nowhere else.
 */
export type RenewalCycleDisposition =
  /** The cycle's outcome is decided (succeeded, abandoned, awaiting manual
   * resolution) — neither the scheduler nor the step may reopen it. */
  | "settled"
  /** The subscription lifecycle or the billing rail forbids execution:
   * the subscription is not active/past_due, the cancellation is already
   * effective for this cycle, the row mirrors a provider-owned (native)
   * recurrence, or it is manual-mode outside the trial-end carve-out. */
  | "not_chargeable"
  /** An open dunning case owns this cycle's recovery. */
  | "dunning_owns"
  /** Manual-mode trial whose cycle is at or after `trial_ends_at` — the one
   * manual cycle the scheduler may pick up, so the trial-end branch can end
   * the subscription on time. That branch never charges. */
  | "trial_end"
  /** The normal off-session charge path. */
  | "charge"

/**
 * The dunning case statuses under which the case — not the scheduler — owns
 * the cycle's next move. Read from the dunning module's enum; never hardcode
 * the strings at a call site.
 */
export const OPEN_DUNNING_CASE_STATUSES: readonly DunningCaseStatus[] = [
  DunningCaseStatus.OPEN,
  DunningCaseStatus.RETRY_SCHEDULED,
  DunningCaseStatus.RETRYING,
  DunningCaseStatus.AWAITING_MANUAL_RESOLUTION,
]

/** The narrow slice of a renewal cycle the disposition decides on. */
export type DispositionRenewalCycle = {
  status: RenewalCycleStatus
  scheduled_for: Date | string
}

/** The narrow slice of a subscription the disposition decides on. */
export type DispositionSubscription = {
  reference: string
  status: SubscriptionStatus
  cancel_effective_at: Date | string | null
  is_trial: boolean
  trial_ends_at: Date | string | null
  payment_context: DispositionPaymentContext | null
  /** Free periods left on the grant; `null` when the column never held one. */
  free_cycles_remaining?: number | null
  /** Whether the next period was explicitly skipped. */
  skip_next_cycle?: boolean
}

/** The narrow slice of a dunning case the disposition decides on. */
export type DispositionDunningCase = {
  status: DunningCaseStatus
}

/**
 * `payment_context` is a nullable jsonb column, so callers hold differently
 * typed views of it (the subscription DTO may not carry `payment_mode` at
 * all). The index signature keeps every such view assignable while the
 * disposition only ever reads the one key it needs.
 */
export type DispositionPaymentContext = {
  payment_mode?: SubscriptionPaymentMode
  [key: string]: unknown
}

const CHARGEABLE_SUBSCRIPTION_STATUSES = new Set<SubscriptionStatus>([
  SubscriptionStatus.ACTIVE,
  SubscriptionStatus.PAST_DUE,
])

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value)
}

function isManualTrialEndCycle(
  subscription: DispositionSubscription,
  scheduledFor: Date
): boolean {
  if (!subscription.is_trial || subscription.trial_ends_at === null) {
    return false
  }

  return scheduledFor >= toDate(subscription.trial_ends_at)
}

/**
 * Whether the cycle about to be processed is a free period: the same predicate
 * the `process-renewal-cycle` step applies (`isFreeCycle`) and the only reason
 * the generalized free-cycle branch exists. That branch never builds an order
 * and never touches payment, so a manual-mode row it serves stays unchargeable
 * in effect — redemption grants (manual rows with free periods, item 9) keep
 * advancing without this carve-out ever charging one.
 */
function carriesFreeCyclePeriod(subscription: DispositionSubscription): boolean {
  return (
    subscription.skip_next_cycle === true ||
    (subscription.free_cycles_remaining ?? 0) > 0
  )
}

/**
 * Resolve who owns a renewal cycle's next move.
 *
 * Evaluated top to bottom; the first matching disposition wins:
 *
 * 1. a terminal cycle status is "settled" — `processing` is deliberately not
 *    adjudicated here: it is in-flight state owned by the workflow lock and
 *    the step's own guard;
 * 2. a subscription that is not `active`/`past_due`, or whose cancellation is
 *    effective at or before the cycle's `scheduled_for`, is "not_chargeable";
 * 3. native mirror rows (provider charges the recurrence itself) and
 *    manual-mode subscriptions are "not_chargeable" — except the manual
 *    trial-end cycle, which is "trial_end" so it stays processable;
 * 4. an open dunning case outranks the scheduler ("dunning_owns");
 * 5. anything else is "charge".
 */
export function resolveCycleDisposition(
  cycle: DispositionRenewalCycle,
  subscription: DispositionSubscription,
  openDunningCase: DispositionDunningCase | null
): RenewalCycleDisposition {
  if (
    cycle.status === RenewalCycleStatus.SUCCEEDED ||
    cycle.status === RenewalCycleStatus.ABANDONED ||
    cycle.status === RenewalCycleStatus.AWAITING_MANUAL_RESOLUTION
  ) {
    return "settled"
  }

  if (!CHARGEABLE_SUBSCRIPTION_STATUSES.has(subscription.status)) {
    return "not_chargeable"
  }

  if (
    subscription.cancel_effective_at !== null &&
    toDate(subscription.cancel_effective_at) <= toDate(cycle.scheduled_for)
  ) {
    return "not_chargeable"
  }

  if (isNativeSubscriptionReference(subscription.reference)) {
    return "not_chargeable"
  }

  if (subscription.payment_context?.payment_mode === "manual") {
    if (isManualTrialEndCycle(subscription, toDate(cycle.scheduled_for))) {
      return "trial_end"
    }

    // Free periods of a manual row (a redemption grant) stay processable: the
    // free-cycle branch they reach never charges (docstring of
    // `carriesFreeCyclePeriod`).
    if (carriesFreeCyclePeriod(subscription)) {
      return "charge"
    }

    return "not_chargeable"
  }

  if (
    openDunningCase !== null &&
    OPEN_DUNNING_CASE_STATUSES.includes(openDunningCase.status)
  ) {
    return "dunning_owns"
  }

  return "charge"
}
