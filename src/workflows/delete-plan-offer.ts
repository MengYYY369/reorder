import { createWorkflow, WorkflowResponse } from "@medusajs/framework/workflows-sdk"
import {
  deletePlanOfferStep,
  type DeletePlanOfferStepOutput,
} from "./steps/delete-plan-offer"

export type DeletePlanOfferWorkflowInput = { id: string }

/**
 * Hard-deletes one disabled plan offer (ticket 12). The enabled-only gate
 * lives in the step so every caller shares one rule.
 */
export const deletePlanOfferWorkflow = createWorkflow(
  "delete-plan-offer",
  function (input: DeletePlanOfferWorkflowInput) {
    const result: DeletePlanOfferStepOutput = deletePlanOfferStep(input)
    return new WorkflowResponse(result)
  }
)

export default deletePlanOfferWorkflow
