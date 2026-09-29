import {
  createWorkflow,
  transform,
  when,
  WorkflowResponse,
} from "@medusajs/framework/workflows-sdk"
import { acquireLockStep, releaseLockStep } from "@medusajs/medusa/core-flows"
import { finalizeRenewalPeriodStep } from "./steps/finalize-renewal-period"
import {
  applyStuckRenewalResolutionStep,
  resolveStuckRenewalOutcomeStep,
  type ReconcileStuckRenewalCycleStepInput,
} from "./steps/reconcile-stuck-renewal-cycle"

/**
 * Reconciles one stuck `renewal_cycle` — a row whose processing run crashed or
 * was killed before it could settle, fail, or park itself (Task 8).
 *
 * The decision is the three-row table from the hardening plan:
 *
 * | observed state of the crashed attempt | action |
 * | --- | --- |
 * | linked order's payment confirmed captured | finalize via `finalizeRenewalPeriodStep`, attempt closed `succeeded`, `renewal.succeeded` emitted by the shared step |
 * | no linked order, or payment confirmed not captured | cycle returned to `failed` with an explanatory `last_error`; normal retry ownership (scheduler + dunning) resumes |
 * | anything else (authorized but not captured, refunded, unreadable, ambiguous) | cycle parked as `awaiting_manual_resolution` with a reason; subscription untouched; alertable log line |
 *
 * Decision R5 governs the third row: "we do not know" must not be recorded as
 * "there is no hope" — an ambiguous cycle is parked, never collapsed into
 * `abandoned`.
 *
 * `outcome_override` is the operator edge (Task 9's `POST /admin/renewals/:id/
 * resolve-stuck` consumes it). Without an override the table is applied and
 * nothing is guessed; with one, the operator's decision replaces the table and
 * the reason they gave is what the cycle and the log record.
 *
 * Accepted cycle statuses are `processing` (the job's scan target) and
 * `awaiting_manual_resolution` (an operator may re-decide a parked cycle);
 * anything else is refused so an already-settled, already-failed, or
 * already-abandoned row can never be touched twice.
 */
export const reconcileStuckRenewalCycleWorkflow = createWorkflow(
  "reconcile-stuck-renewal-cycle",
  function (input: ReconcileStuckRenewalCycleStepInput) {
    // The same lock family the five-minute scheduler holds, so a reconciliation
    // can never overlap a live processing run on the same cycle.
    const lockKey = transform({ input }, function ({ input }) {
      return `renewal:${input.renewal_cycle_id}`
    })

    acquireLockStep({
      key: lockKey,
      timeout: 10,
      ttl: 120,
    })

    const decision = resolveStuckRenewalOutcomeStep(input)

    // Row 1 (and the operator's `succeeded`): the shared settlement step —
    // cycle succeeded, cadence anchored on `scheduled_for` (R6),
    // `structural_attempt_count` reset, next cycle ensured, and the
    // `renewal.succeeded` persist + emit.
    when({ decision }, function ({ decision }) {
      return decision.outcome === "finalize"
    }).then(() => {
      return finalizeRenewalPeriodStep({
        renewal_cycle_id: decision.renewal_cycle_id,
        generated_order_id: decision.generated_order_id,
        attempt_id: decision.stuck_attempt_id ?? undefined,
        trigger: decision.trigger,
        // The operator's reason (or the table's own verdict) is what the
        // `renewal.succeeded` activity-log event records alongside the actor.
        reason: decision.reason,
      })
    })

    const resolution = applyStuckRenewalResolutionStep(decision)

    releaseLockStep({
      key: lockKey,
    })

    return new WorkflowResponse(resolution)
  }
)

export default reconcileStuckRenewalCycleWorkflow
