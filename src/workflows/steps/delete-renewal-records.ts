import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { RENEWAL_MODULE } from "../../modules/renewal"
import { RenewalAttemptStatus, RenewalCycleStatus } from "../../modules/renewal/types"
import { renewalErrors } from "../../modules/renewal/utils/errors"

/**
 * A cycle is deletable only once nothing will ever run for it again:
 * scheduled and processing rows belong to the scheduler, and a row awaiting
 * manual resolution must first be settled through resolve-stuck. The same
 * split applies to attempts.
 */
const TERMINAL_CYCLE_STATUSES: ReadonlySet<string> = new Set([
  RenewalCycleStatus.SUCCEEDED,
  RenewalCycleStatus.FAILED,
  RenewalCycleStatus.ABANDONED,
])

const TERMINAL_ATTEMPT_STATUSES: ReadonlySet<string> = new Set([
  RenewalAttemptStatus.SUCCEEDED,
  RenewalAttemptStatus.FAILED,
])

export type DeleteRenewalCycleStepOutput = {
  renewal_cycle_id: string
  deleted_attempts: number
}

/**
 * Hard-deletes one terminal renewal cycle together with its attempts
 * (attempts first, so the belong-to foreign key never dangles).
 *
 * No compensation on purpose: the rows are gone.
 */
export const deleteRenewalCycleStep = createStep(
  "delete-renewal-cycle",
  async function (input: { id: string }, { container }) {
    const renewalModule = container.resolve(RENEWAL_MODULE) as {
      retrieveRenewalCycle: (
        id: string,
        config?: Record<string, unknown>
      ) => Promise<{ id: string; status: string }>
      listRenewalAttempts: (
        selector: Record<string, unknown>,
        config?: Record<string, unknown>
      ) => Promise<Array<{ id: string }>>
      deleteRenewalAttempts: (ids: string | string[]) => Promise<unknown>
      deleteRenewalCycles: (ids: string | string[]) => Promise<unknown>
    }

    const cycle = await renewalModule
      .retrieveRenewalCycle(input.id)
      .catch(() => {
        throw renewalErrors.notFound("RenewalCycle", input.id)
      })

    if (!TERMINAL_CYCLE_STATUSES.has(cycle.status)) {
      throw renewalErrors.conflict(
        `Renewal cycle '${input.id}' is '${cycle.status}'; only terminal cycles (succeeded, failed, abandoned) can be deleted`
      )
    }

    const attempts = await renewalModule.listRenewalAttempts({
      renewal_cycle_id: cycle.id,
    })
    if (attempts.length > 0) {
      await renewalModule.deleteRenewalAttempts(
        attempts.map((attempt) => attempt.id)
      )
    }
    await renewalModule.deleteRenewalCycles(cycle.id)

    const output: DeleteRenewalCycleStepOutput = {
      renewal_cycle_id: cycle.id,
      deleted_attempts: attempts.length,
    }

    return new StepResponse(output)
  }
)

export type DeleteRenewalAttemptStepOutput = {
  renewal_attempt_id: string
  renewal_cycle_id: string
}

/**
 * Hard-deletes one attempt of a terminal cycle. Both gates matter: a
 * processing attempt belongs to a live run, and deleting an attempt out of a
 * scheduled cycle would corrupt the cycle's attempt bookkeeping.
 */
export const deleteRenewalAttemptStep = createStep(
  "delete-renewal-attempt",
  async function (
    input: { renewal_cycle_id: string; attempt_id: string },
    { container }
  ) {
    const renewalModule = container.resolve(RENEWAL_MODULE) as {
      retrieveRenewalCycle: (
        id: string,
        config?: Record<string, unknown>
      ) => Promise<{ id: string; status: string }>
      retrieveRenewalAttempt: (
        id: string,
        config?: Record<string, unknown>
      ) => Promise<{ id: string; status: string; renewal_cycle_id: string }>
      deleteRenewalAttempts: (ids: string | string[]) => Promise<unknown>
    }

    const cycle = await renewalModule
      .retrieveRenewalCycle(input.renewal_cycle_id)
      .catch(() => {
        throw renewalErrors.notFound("RenewalCycle", input.renewal_cycle_id)
      })

    if (!TERMINAL_CYCLE_STATUSES.has(cycle.status)) {
      throw renewalErrors.conflict(
        `Renewal cycle '${input.renewal_cycle_id}' is '${cycle.status}'; attempts can only be deleted on terminal cycles`
      )
    }

    const attempt = await renewalModule
      .retrieveRenewalAttempt(input.attempt_id)
      .catch(() => {
        throw renewalErrors.notFound("RenewalAttempt", input.attempt_id)
      })

    if (attempt.renewal_cycle_id !== cycle.id) {
      throw renewalErrors.notFound("RenewalAttempt", input.attempt_id)
    }
    if (!TERMINAL_ATTEMPT_STATUSES.has(attempt.status)) {
      throw renewalErrors.conflict(
        `Renewal attempt '${input.attempt_id}' is '${attempt.status}'; only terminal attempts (succeeded, failed) can be deleted`
      )
    }

    await renewalModule.deleteRenewalAttempts(attempt.id)

    const output: DeleteRenewalAttemptStepOutput = {
      renewal_attempt_id: attempt.id,
      renewal_cycle_id: cycle.id,
    }

    return new StepResponse(output)
  }
)
