import { MedusaContainer } from "@medusajs/framework/types"
import {
  listStuckProcessingRenewalCycles,
  type StuckRenewalCycleRecord,
} from "../modules/renewal/utils/scheduler-query"
import {
  classifyRenewalFailure,
  createRenewalCorrelationId,
  getRenewalErrorMessage,
  isAlertableRenewalFailure,
  logRenewalEvent,
} from "../modules/renewal/utils/observability"
import { reconcileStuckRenewalCycleWorkflow } from "../workflows/reconcile-stuck-renewal-cycle"

const JOB_NAME = "recover-stuck-renewal-cycles"
const DEFAULT_BATCH_SIZE = 50
/**
 * Safety net for the discovery loop: each reconciled cycle leaves the
 * `processing` set, so the fixed-page re-query shrinks to empty on healthy
 * runs; a cycle whose reconciliation keeps throwing would otherwise be
 * re-discovered forever. The cap bounds the run to `MAX_DISCOVERY_PASSES *
 * DEFAULT_BATCH_SIZE` cycles — far beyond any realistic stuck backlog — and
 * lets the next hourly pass retry the failures.
 */
const MAX_DISCOVERY_PASSES = 20

function getLogger(container: MedusaContainer) {
  return container.resolve("logger")
}

async function reconcileCycle(
  container: MedusaContainer,
  logger: ReturnType<typeof getLogger>,
  cycle: StuckRenewalCycleRecord,
  jobCorrelationId: string
) {
  const cycleCorrelationId = `${jobCorrelationId}:${cycle.id}`
  const startedAt = Date.now()

  try {
    // No outcome_override: the job applies the three-row decision table and
    // never guesses. Overrides belong to the operator route (Task 9).
    await reconcileStuckRenewalCycleWorkflow(container).run({
      input: {
        renewal_cycle_id: cycle.id,
        trigger_type: "scheduler",
        correlation_id: cycleCorrelationId,
      },
    })

    logRenewalEvent(logger, "info", {
      event: "renewal.reconciliation.job.cycle",
      job_name: JOB_NAME,
      outcome: "succeeded",
      correlation_id: cycleCorrelationId,
      renewal_cycle_id: cycle.id,
      subscription_id: cycle.subscription_id,
      duration_ms: Date.now() - startedAt,
      success_count: 1,
      failure_count: 0,
      message: "Stuck renewal cycle reconciled",
    })

    return "succeeded" as const
  } catch (error) {
    const message = getRenewalErrorMessage(error)
    const failureKind = classifyRenewalFailure(error)

    logRenewalEvent(logger, "error", {
      event: "renewal.reconciliation.job.cycle",
      job_name: JOB_NAME,
      outcome: "failed",
      correlation_id: cycleCorrelationId,
      renewal_cycle_id: cycle.id,
      subscription_id: cycle.subscription_id,
      duration_ms: Date.now() - startedAt,
      success_count: 0,
      failure_count: 1,
      failure_kind: failureKind,
      alertable: isAlertableRenewalFailure(failureKind),
      message,
    })

    return "failed" as const
  }
}

/**
 * Hourly reconciliation of stuck `processing` renewal cycles (hardening plan
 * Task 8). A cycle still `processing` and untouched for longer than
 * `STUCK_RENEWAL_CYCLE_THRESHOLD_MINUTES` (30 — chosen to exceed any
 * legitimate provider call, so the row means a crashed run, not a slow one)
 * has no owner left: this job hands it to
 * `reconcileStuckRenewalCycleWorkflow`, which applies the decision table —
 * finalize a confirmed-captured payment, revert a confirmed-uncharged cycle
 * to `failed`, park anything ambiguous for a human.
 */
export default async function recoverStuckRenewalCyclesJob(
  container: MedusaContainer
) {
  const logger = getLogger(container)
  const startedAt = Date.now()
  const batchSize = DEFAULT_BATCH_SIZE
  const jobCorrelationId = createRenewalCorrelationId(JOB_NAME)

  logRenewalEvent(logger, "info", {
    event: "renewal.reconciliation.job",
    job_name: JOB_NAME,
    outcome: "started",
    correlation_id: jobCorrelationId,
    batch_size: batchSize,
  })

  try {
    let scanned = 0
    let succeeded = 0
    let failed = 0
    // The fixed-page re-query: processed cycles leave the `processing` set, so
    // offset 0 always surfaces the next unowned row. Ids already attempted in
    // this run are skipped — a reconciliation that threw would otherwise be
    // re-discovered and re-run forever.
    const attempted = new Set<string>()
    let passes = 0
    let hitPassCap = false

    while (passes < MAX_DISCOVERY_PASSES) {
      passes += 1

      const result = await listStuckProcessingRenewalCycles(container, {
        limit: batchSize,
        offset: 0,
      })

      if (passes === 1) {
        logRenewalEvent(logger, "info", {
          event: "renewal.reconciliation.job.discovery",
          job_name: JOB_NAME,
          outcome: "completed",
          correlation_id: jobCorrelationId,
          batch_size: batchSize,
          scanned_count: result.count,
          message:
            "Discovered stuck processing renewal cycles for reconciliation",
        })
      }

      const fresh = result.cycles.filter((cycle) => !attempted.has(cycle.id))

      if (!fresh.length) {
        break
      }

      if (passes === MAX_DISCOVERY_PASSES) {
        hitPassCap = true
      }

      for (const cycle of fresh) {
        attempted.add(cycle.id)
        scanned += 1

        const outcome = await reconcileCycle(
          container,
          logger,
          cycle,
          jobCorrelationId
        )

        if (outcome === "succeeded") {
          succeeded += 1
        } else {
          failed += 1
        }
      }
    }

    if (hitPassCap) {
      logRenewalEvent(logger, "error", {
        event: "renewal.reconciliation.job",
        job_name: JOB_NAME,
        outcome: "completed",
        correlation_id: jobCorrelationId,
        alertable: true,
        scanned_count: scanned,
        success_count: succeeded,
        failure_count: failed,
        message:
          "Reconciliation discovery loop hit its pass cap; leftover cycles are retried on the next run",
      })
    }

    logRenewalEvent(logger, "info", {
      event: "renewal.reconciliation.job",
      job_name: JOB_NAME,
      outcome: "completed",
      correlation_id: jobCorrelationId,
      duration_ms: Date.now() - startedAt,
      batch_size: batchSize,
      scanned_count: scanned,
      success_count: succeeded,
      failure_count: failed,
      message: "Stuck renewal cycle reconciliation completed",
    })
  } catch (error) {
    const message = getRenewalErrorMessage(error)

    logRenewalEvent(logger, "error", {
      event: "renewal.reconciliation.job",
      job_name: JOB_NAME,
      outcome: "failed",
      correlation_id: jobCorrelationId,
      duration_ms: Date.now() - startedAt,
      batch_size: batchSize,
      alertable: true,
      failure_kind: "unexpected_error",
      message,
    })
  }
}

export const config = {
  name: JOB_NAME,
  // Hourly. The 30-minute staleness threshold means a crashed cycle is caught
  // on the first pass after it ages out, at most ~90 minutes after the crash.
  schedule: "0 * * * *",
}
