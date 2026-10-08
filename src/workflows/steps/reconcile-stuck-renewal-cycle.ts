import { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { RENEWAL_MODULE } from "../../modules/renewal"
import RenewalModuleService from "../../modules/renewal/service"
import {
  ActivityLogActorType,
  ActivityLogEventType,
} from "../../modules/activity-log/types"
import { SUBSCRIPTION_MODULE } from "../../modules/subscription"
import type SubscriptionModuleService from "../../modules/subscription/service"
import {
  persistRenewalResolutionEvent,
  type RenewalLogEventSubscriptionDisplay,
} from "../utils/renewal-log-event"
import {
  readOrderPaymentVerdict,
  type OrderPaymentVerdict,
} from "../utils/order-payment-verdict"
import {
  RenewalAttemptStatus,
  RenewalCycleStatus,
} from "../../modules/renewal/types"
import { renewalErrors } from "../../modules/renewal/utils/errors"
import {
  createRenewalCorrelationId,
  logRenewalEvent,
} from "../../modules/renewal/utils/observability"
import { FinalizeRenewalPeriodTrigger } from "./finalize-renewal-period"

const STEP_NAME = "reconcile-stuck-renewal-cycle"

const STUCK_CYCLE_STATUSES = [
  RenewalCycleStatus.PROCESSING,
  RenewalCycleStatus.AWAITING_MANUAL_RESOLUTION,
]

export type ReconcileStuckRenewalOutcome =
  | "finalize"
  | "revert_failed"
  | "park"
  | "abandoned"

export type ReconcileStuckRenewalCycleStepInput = {
  renewal_cycle_id: string
  /**
   * Operator decision (Task 9's route). Without it the three-row table is
   * applied and nothing is ever guessed.
   */
  outcome_override?: "succeeded" | "failed" | "abandoned"
  /** Operator reason; required by the route, optional at the workflow edge. */
  reason?: string | null
  trigger_type?: "scheduler" | "manual"
  triggered_by?: string | null
  correlation_id?: string | null
}

export type ReconcileStuckRenewalDecision = {
  renewal_cycle_id: string
  /** The subscription the cycle bills for; carried so the apply step can emit
   * the Task 12 alertable events (`renewal.awaiting_manual_resolution` on a
   * park, `renewal.abandoned` on the operator write-off) without re-reading. */
  subscription_id: string
  outcome: ReconcileStuckRenewalOutcome
  reason: string
  /** The order whose payment paid the period, when one was identified. */
  generated_order_id: string | null
  payment_evidence: string
  stuck_attempt_id: string | null
  cycle_status_at_decision: RenewalCycleStatus
  trigger: FinalizeRenewalPeriodTrigger
}

export type ReconcileStuckRenewalResolution = {
  renewal_cycle_id: string
  outcome: ReconcileStuckRenewalOutcome
  cycle_status: RenewalCycleStatus
  reason: string
  generated_order_id: string | null
}

type StuckCycleRecord = {
  id: string
  subscription_id: string
  status: RenewalCycleStatus
}

type StuckAttemptRecord = {
  id: string
  attempt_no: number
  started_at: Date | string
}

/**
 * Display-only projection for the Task 12 alertable events: the park and
 * write-off events read the subscription's labels, but a missing subscription
 * row must not fail the resolution.
 */
type ReconcileSubscriptionDisplayRecord = {
  customer_id: string
  reference: string
  customer_snapshot: { full_name?: string | null } | null
  product_snapshot: {
    product_title?: string | null
    variant_title?: string | null
  } | null
}

function isStuckStatus(status: RenewalCycleStatus): boolean {
  return STUCK_CYCLE_STATUSES.includes(status)
}

async function loadStuckCycle(
  container: MedusaContainer,
  renewalCycleId: string
): Promise<StuckCycleRecord> {
  const renewalModule = container.resolve<RenewalModuleService>(RENEWAL_MODULE)

  let cycle: StuckCycleRecord

  try {
    cycle = (await renewalModule.retrieveRenewalCycle(
      renewalCycleId
    )) as unknown as StuckCycleRecord
  } catch {
    throw renewalErrors.notFound("RenewalCycle", renewalCycleId)
  }

  // The guard that makes re-runs safe: a cycle that already settled, failed
  // back into the retry pool, or was abandoned must not be touched again. The
  // job's scan only selects `processing`, but between the scan and this step
  // the five-minute scheduler, a dunning retry, or an operator can move the
  // row — and Task 9's route re-invokes this workflow for parked cycles too.
  if (!isStuckStatus(cycle.status)) {
    throw renewalErrors.invalidTransition(
      renewalCycleId,
      `Renewal cycle '${renewalCycleId}' is not awaiting reconciliation (status: ${cycle.status})`
    )
  }

  return cycle
}

async function loadStuckAttempt(
  container: MedusaContainer,
  renewalCycleId: string
): Promise<StuckAttemptRecord | null> {
  const renewalModule = container.resolve<RenewalModuleService>(RENEWAL_MODULE)

  const attempts = (await renewalModule.listRenewalAttempts({
    renewal_cycle_id: renewalCycleId,
    status: RenewalAttemptStatus.PROCESSING,
  })) as unknown as StuckAttemptRecord[]

  if (!attempts.length) {
    return null
  }

  // The run that crashed holds the newest processing attempt; concurrent runs
  // are excluded by the workflow lock, so at most one is expected.
  return attempts.reduce((latest, attempt) =>
    new Date(attempt.started_at) > new Date(latest.started_at)
      ? attempt
      : latest
  )
}

/**
 * Orders the crashed attempt created, via the `renewal_cycle` ↔ `order` link
 * registered in `src/links/renewal-order.ts`. `cycle.generated_order_id` is
 * deliberately not consulted: it is only written by the settlement itself,
 * which is precisely the write that did not happen.
 */
async function findLinkedOrderIds(
  container: MedusaContainer,
  renewalCycleId: string
): Promise<string[]> {
  const query = container.resolve(ContainerRegistrationKeys.QUERY)

  const { data: links } = await query.graph({
    entity: "renewal_cycle_order",
    fields: ["renewal_cycle_id", "order_id"],
    filters: {
      renewal_cycle_id: [renewalCycleId],
    },
  })

  return (links as Array<{ order_id?: string }>)
    .map((link) => link.order_id)
    .filter((orderId): orderId is string => Boolean(orderId))
}

/**
 * Crash-window fallback for the window between the charge and the link write:
 * `process-renewal-cycle` captures the payment (`:631`) BEFORE it creates the
 * `renewal_cycle` ↔ `order` link (`:647`), so a run that died exactly there
 * leaves captured money with no link row. Such an order is discoverable only
 * through the metadata the order was created with (`renewal_cycle_id`,
 * `subscription_id` — `:540-543`). Without this read, the decision table would
 * classify that window as "no linked order", return the cycle to `failed`, and
 * the next attempt would charge the customer a second time — the exact failure
 * this reconciliation exists to prevent.
 */
async function findOrphanOrderIds(
  container: MedusaContainer,
  renewalCycleId: string
): Promise<string[]> {
  const query = container.resolve(ContainerRegistrationKeys.QUERY)

  const { data: orders } = await query.graph({
    entity: "order",
    fields: ["id", "metadata"],
    filters: {
      metadata: {
        renewal_cycle_id: renewalCycleId,
      },
    },
  })

  return (orders as Array<{ id: string }>).map((order) => order.id)
}

function buildParkReason(orderId: string): string {
  return `Reconciliation parked the cycle: order '${orderId}' payment state is not decidable (authorized but not captured, refunded, or unreadable); a human must decide — the payment may still be captured by a late webhook`
}

/**
 * Reads the crashed attempt's world and applies the three-row decision table
 * (or the operator override). This step performs NO writes: the settlement
 * goes through `finalizeRenewalPeriodStep` and every other row through
 * `applyStuckRenewalResolutionStep`, so the decision is cheap to re-run.
 */
export const resolveStuckRenewalOutcomeStep = createStep(
  `${STEP_NAME}-resolve`,
  async function (
    input: ReconcileStuckRenewalCycleStepInput,
    { container }: { container: MedusaContainer }
  ): Promise<StepResponse<ReconcileStuckRenewalDecision>> {
    const correlationId =
      input.correlation_id ?? createRenewalCorrelationId(STEP_NAME)
    const cycle = await loadStuckCycle(container, input.renewal_cycle_id)
    const stuckAttempt = await loadStuckAttempt(
      container,
      input.renewal_cycle_id
    )

    const trigger: FinalizeRenewalPeriodTrigger = {
      source: input.trigger_type === "manual" ? "admin" : "scheduler",
      trigger_type: input.trigger_type ?? "scheduler",
      actor_type:
        input.trigger_type === "manual"
          ? ActivityLogActorType.USER
          : ActivityLogActorType.SCHEDULER,
      actor_id: input.triggered_by ?? null,
      correlation_id: correlationId,
    }

    const linkedOrderIds = await findLinkedOrderIds(
      container,
      input.renewal_cycle_id
    )
    const orphanOrderIds = linkedOrderIds.length
      ? []
      : await findOrphanOrderIds(container, input.renewal_cycle_id)
    const candidateOrderIds = [...linkedOrderIds, ...orphanOrderIds]

    const verdicts: Array<{ orderId: string; verdict: OrderPaymentVerdict }> = []
    for (const orderId of candidateOrderIds) {
      verdicts.push({
        orderId,
        verdict: await readOrderPaymentVerdict(container, orderId),
      })
    }

    const captured = verdicts.find(
      (entry): entry is { orderId: string; verdict: "captured" } =>
        entry.verdict === "captured"
    )
    const ambiguous = verdicts.find(
      (entry): entry is { orderId: string; verdict: "ambiguous" } =>
        entry.verdict === "ambiguous"
    )

    let decision: ReconcileStuckRenewalDecision

    if (input.outcome_override) {
      const reason =
        input.reason?.trim() ||
        `Operator override '${input.outcome_override}' applied without a reason`

      if (input.outcome_override === "succeeded") {
        decision = {
          renewal_cycle_id: input.renewal_cycle_id,
          subscription_id: cycle.subscription_id,
          outcome: "finalize",
          reason,
          // The operator asserts the period is settled; the order the crashed
          // attempt created (if any) is the order that names the payment.
          generated_order_id: linkedOrderIds[0] ?? orphanOrderIds[0] ?? null,
          payment_evidence: `override:succeeded${linkedOrderIds.length ? ` linked_order=${linkedOrderIds[0]}` : ""}`,
          stuck_attempt_id: stuckAttempt?.id ?? null,
          cycle_status_at_decision: cycle.status,
          trigger,
        }
      } else {
        decision = {
          renewal_cycle_id: input.renewal_cycle_id,
          subscription_id: cycle.subscription_id,
          outcome:
            input.outcome_override === "failed" ? "revert_failed" : "abandoned",
          reason,
          generated_order_id: null,
          payment_evidence: `override:${input.outcome_override}`,
          stuck_attempt_id: stuckAttempt?.id ?? null,
          cycle_status_at_decision: cycle.status,
          trigger,
        }
      }
    } else if (captured) {
      // Row 1: the payment is confirmed captured — the period is paid, settle
      // it through the shared finalization step (which persists + emits
      // renewal.succeeded) and close the attempt succeeded.
      decision = {
        renewal_cycle_id: input.renewal_cycle_id,
        subscription_id: cycle.subscription_id,
        outcome: "finalize",
        reason: `Reconciled as succeeded: payment on order '${captured.orderId}' is confirmed captured`,
        generated_order_id: captured.orderId,
        payment_evidence: `captured order=${captured.orderId}`,
        stuck_attempt_id: stuckAttempt?.id ?? null,
        cycle_status_at_decision: cycle.status,
        trigger,
      }
    } else if (ambiguous) {
      // Row 3 (R5): anything authorized-but-not-captured, refunded, or
      // unreadable parks the cycle for a human. The subscription is left
      // untouched.
      decision = {
        renewal_cycle_id: input.renewal_cycle_id,
        subscription_id: cycle.subscription_id,
        outcome: "park",
        reason: buildParkReason(ambiguous.orderId),
        generated_order_id: ambiguous.orderId,
        payment_evidence: `ambiguous order=${ambiguous.orderId}`,
        stuck_attempt_id: stuckAttempt?.id ?? null,
        cycle_status_at_decision: cycle.status,
        trigger,
      }
    } else {
      // Row 2: nothing was charged — confirmed by the absence of any candidate
      // order or by positively uncaptured payment state. The cycle returns to
      // `failed`, where normal retry ownership (scheduler + dunning) applies.
      decision = {
        renewal_cycle_id: input.renewal_cycle_id,
        subscription_id: cycle.subscription_id,
        outcome: "revert_failed",
        reason: candidateOrderIds.length
          ? `Reconciled as failed: payment on order '${candidateOrderIds[0]}' is confirmed not captured`
          : "Reconciled as failed: no renewal order was found for the crashed attempt (no linked order and no order carrying this cycle's metadata)",
        generated_order_id: null,
        payment_evidence:
          candidateOrderIds.length === 0
            ? "no candidate orders"
            : `not_captured orders=${candidateOrderIds.join(",")}`,
        stuck_attempt_id: stuckAttempt?.id ?? null,
        cycle_status_at_decision: cycle.status,
        trigger,
      }
    }

    return new StepResponse(decision)
  }
)

const MAX_LOG_MESSAGE_LENGTH = 2000

function truncate(value: string): string {
  return value.length > MAX_LOG_MESSAGE_LENGTH
    ? `${value.slice(0, MAX_LOG_MESSAGE_LENGTH)}…`
    : value
}

/**
 * Applies every non-finalize row of the table plus the operator overrides
 * `failed` / `abandoned`, closes the stuck attempt, and logs the outcome. For
 * `finalize` there is nothing to write — the shared finalization step settled
 * the cycle and closed the attempt — so the step only logs.
 */
export const applyStuckRenewalResolutionStep = createStep(
  `${STEP_NAME}-apply`,
  async function (
    decision: ReconcileStuckRenewalDecision,
    { container }: { container: MedusaContainer }
  ): Promise<StepResponse<ReconcileStuckRenewalResolution>> {
    const renewalModule = container.resolve<RenewalModuleService>(RENEWAL_MODULE)
    const logger = container.resolve("logger") as {
      info: (message: string) => void
      warn: (message: string) => void
      error: (message: string) => void
    }

    const logLine = {
      event: "renewal.reconciliation",
      correlation_id: decision.trigger.correlation_id,
      renewal_cycle_id: decision.renewal_cycle_id,
      cycle_status_at_decision: decision.cycle_status_at_decision,
      reason: decision.reason,
      payment_evidence: decision.payment_evidence,
      metadata: {
        generated_order_id: decision.generated_order_id,
        stuck_attempt_id: decision.stuck_attempt_id,
        trigger_type: decision.trigger.trigger_type,
        triggered_by: decision.trigger.actor_id,
      },
    }

    const finishedAt = new Date()

    if (decision.outcome === "finalize") {
      logRenewalEvent(logger, "info", {
        ...logLine,
        outcome: "succeeded",
        success_count: 1,
        failure_count: 0,
        message:
          "Stuck renewal cycle reconciled as succeeded; renewal.succeeded was emitted by the shared finalization step",
      })
    } else {
      // Display-only read for the Task 12 alertable events: a missing
      // subscription row leaves the labels empty instead of failing the
      // operator's (or scheduler's) resolution.
      const subscriptionModule =
        container.resolve<SubscriptionModuleService>(SUBSCRIPTION_MODULE)

      let subscription: ReconcileSubscriptionDisplayRecord | null = null

      try {
        subscription = (await subscriptionModule.retrieveSubscription(
          decision.subscription_id
        )) as unknown as ReconcileSubscriptionDisplayRecord
      } catch {
        subscription = null
      }

      const subscriptionDisplay: RenewalLogEventSubscriptionDisplay =
        subscription
          ? {
              customer_id: subscription.customer_id,
              reference: subscription.reference,
              customer_name: subscription.customer_snapshot?.full_name ?? null,
              product_title: subscription.product_snapshot?.product_title ?? null,
              variant_title: subscription.product_snapshot?.variant_title ?? null,
            }
          : null

      if (decision.stuck_attempt_id) {
        await renewalModule.updateRenewalAttempts({
          id: decision.stuck_attempt_id,
          status: RenewalAttemptStatus.FAILED,
          finished_at: finishedAt,
          error_code: "renewal_reconciled",
          error_message: truncate(decision.reason),
          order_id: decision.generated_order_id,
        })
      }

      if (decision.outcome === "revert_failed") {
        await renewalModule.updateRenewalCycles({
          id: decision.renewal_cycle_id,
          status: RenewalCycleStatus.FAILED,
          last_error: truncate(decision.reason),
          processed_at: null,
        })

        logRenewalEvent(logger, "info", {
          ...logLine,
          outcome: "succeeded",
          success_count: 1,
          failure_count: 0,
          message:
            "Stuck renewal cycle reconciled as failed: nothing was charged, normal retry ownership resumes",
        })
      } else if (decision.outcome === "park") {
        await renewalModule.updateRenewalCycles({
          id: decision.renewal_cycle_id,
          status: RenewalCycleStatus.AWAITING_MANUAL_RESOLUTION,
          last_error: truncate(decision.reason),
          processed_at: null,
        })

        // Emission point (Tasks 11/12): the alertable park event is persisted
        // AND emitted through the shared funnel exactly where the park write
        // lands, carrying the cycle id and the park reason. A parked cycle is
        // NOT `abandoned`: the period is neither paid nor written off, and the
        // subscription is deliberately left untouched.
        await persistRenewalResolutionEvent(container, {
          event_type: ActivityLogEventType.RENEWAL_AWAITING_MANUAL_RESOLUTION,
          subscription_id: decision.subscription_id,
          renewal_cycle_id: decision.renewal_cycle_id,
          subscription_display: subscriptionDisplay,
          previous_state: {
            status: decision.cycle_status_at_decision,
          },
          new_state: {
            status: RenewalCycleStatus.AWAITING_MANUAL_RESOLUTION,
            last_error: truncate(decision.reason),
            generated_order_id: decision.generated_order_id,
          },
          reason: decision.reason,
          actor_type: decision.trigger.actor_type,
          actor_id: decision.trigger.actor_id,
          trigger_type: decision.trigger.trigger_type,
          source: decision.trigger.source,
          order_id: decision.generated_order_id,
          correlation_id: decision.trigger.correlation_id,
        })

        logRenewalEvent(logger, "warn", {
          ...logLine,
          outcome: "blocked",
          alertable: true,
          success_count: 0,
          failure_count: 0,
          blocked_count: 1,
          message:
            "Stuck renewal cycle parked as awaiting_manual_resolution: payment state is undecidable; manual resolution required",
        })
      } else {
        await renewalModule.updateRenewalCycles({
          id: decision.renewal_cycle_id,
          status: RenewalCycleStatus.ABANDONED,
          last_error: truncate(decision.reason),
          processed_at: null,
        })

        // Emission point (Tasks 11/12): the abandonment event is persisted AND
        // emitted exactly where the write lands. Decision R3: abandonment
        // never cancels the subscription as a side effect of a background
        // write — the host receives `renewal.abandoned` and decides.
        await persistRenewalResolutionEvent(container, {
          event_type: ActivityLogEventType.RENEWAL_ABANDONED,
          subscription_id: decision.subscription_id,
          renewal_cycle_id: decision.renewal_cycle_id,
          subscription_display: subscriptionDisplay,
          previous_state: {
            status: decision.cycle_status_at_decision,
          },
          new_state: {
            status: RenewalCycleStatus.ABANDONED,
            last_error: truncate(decision.reason),
          },
          reason: decision.reason,
          actor_type: decision.trigger.actor_type,
          actor_id: decision.trigger.actor_id,
          trigger_type: decision.trigger.trigger_type,
          source: decision.trigger.source,
          correlation_id: decision.trigger.correlation_id,
        })

        logRenewalEvent(logger, "warn", {
          ...logLine,
          outcome: "failed",
          alertable: true,
          success_count: 0,
          failure_count: 1,
          message:
            "Stuck renewal cycle abandoned by operator override; the subscription is left untouched",
        })
      }
    }

    return new StepResponse({
      renewal_cycle_id: decision.renewal_cycle_id,
      outcome: decision.outcome,
      cycle_status:
        decision.outcome === "finalize"
          ? RenewalCycleStatus.SUCCEEDED
          : decision.outcome === "revert_failed"
            ? RenewalCycleStatus.FAILED
            : decision.outcome === "park"
              ? RenewalCycleStatus.AWAITING_MANUAL_RESOLUTION
              : RenewalCycleStatus.ABANDONED,
      reason: decision.reason,
      generated_order_id: decision.generated_order_id,
    })
  }
)
