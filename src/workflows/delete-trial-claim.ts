import { createWorkflow, WorkflowResponse } from "@medusajs/framework/workflows-sdk"
import {
  deleteTrialClaimStep,
  type DeleteTrialClaimStepOutput,
} from "./steps/delete-trial-claim"

export type DeleteTrialClaimWorkflowInput = { id: string }

/**
 * Hard-deletes one trial-claim ledger row (ticket 15). The admin cancel of
 * the linked trial subscription, if wanted, goes through the existing
 * cancel-subscription workflow separately.
 */
export const deleteTrialClaimWorkflow = createWorkflow(
  "delete-trial-claim",
  function (input: DeleteTrialClaimWorkflowInput) {
    const result: DeleteTrialClaimStepOutput = deleteTrialClaimStep(input)
    return new WorkflowResponse(result)
  }
)

export default deleteTrialClaimWorkflow
