import { createWorkflow, WorkflowResponse } from "@medusajs/framework/workflows-sdk"
import {
  deleteRenewalAttemptStep,
  deleteRenewalCycleStep,
  type DeleteRenewalAttemptStepOutput,
  type DeleteRenewalCycleStepOutput,
} from "./steps/delete-renewal-records"

export type DeleteRenewalCycleWorkflowInput = { id: string }

/**
 * Hard-deletes one terminal renewal cycle with its attempts (ticket 12). The
 * terminal-only gate lives in the step so every caller shares one rule.
 */
export const deleteRenewalCycleWorkflow = createWorkflow(
  "delete-renewal-cycle",
  function (input: DeleteRenewalCycleWorkflowInput) {
    const result: DeleteRenewalCycleStepOutput = deleteRenewalCycleStep(input)
    return new WorkflowResponse(result)
  }
)

export type DeleteRenewalAttemptWorkflowInput = {
  renewal_cycle_id: string
  attempt_id: string
}

/**
 * Hard-deletes one terminal attempt of a terminal renewal cycle (ticket 12).
 */
export const deleteRenewalAttemptWorkflow = createWorkflow(
  "delete-renewal-attempt",
  function (input: DeleteRenewalAttemptWorkflowInput) {
    const result: DeleteRenewalAttemptStepOutput = deleteRenewalAttemptStep(
      input
    )
    return new WorkflowResponse(result)
  }
)
