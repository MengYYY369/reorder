import { createWorkflow, WorkflowResponse } from "@medusajs/framework/workflows-sdk"
import {
  deleteSubscriptionChainStep,
  validateSubscriptionDeletableStep,
  type DeleteSubscriptionStepOutput,
} from "./steps/delete-subscription"

export type DeleteSubscriptionWorkflowInput = { id: string }

/**
 * Hard-deletes one cancelled subscription with its full row chain (ticket
 * 12): renewal cycles/attempts, activity log, metrics, trial claims,
 * cancellation/dunning/retention rows, then the subscription row. The
 * cancelled-only gate runs before anything is touched.
 */
export const deleteSubscriptionWorkflow = createWorkflow(
  "delete-subscription",
  function (input: DeleteSubscriptionWorkflowInput) {
    validateSubscriptionDeletableStep(input)

    const counts: DeleteSubscriptionStepOutput = deleteSubscriptionChainStep(
      input
    )

    return new WorkflowResponse(counts)
  }
)

export default deleteSubscriptionWorkflow
