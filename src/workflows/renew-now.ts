import { createWorkflow, WorkflowResponse } from "@medusajs/framework/workflows-sdk"
import { renewNowStep, type RenewNowStepOutput } from "./steps/renew-now"

export type RenewNowWorkflowInput = {
  subscription_id: string
  customer_id: string
}

export type RenewNowWorkflowOutput = RenewNowStepOutput

/**
 * The storefront's「立即续费」(0.9.3, plan ticket 01④, user item 8) — a thin
 * composition so the store route runs a workflow, not a bare step. No second
 * lock is layered here: both rails inside the step take their own locks
 * (`renewal:<cycle_id>` for the charged rail, `manual-renewal:<subscription>`
 * for the approval rail), and the step's in-progress check refuses a renewal
 * already running before either rail is entered.
 */
export const renewNowWorkflow = createWorkflow(
  "renew-now",
  function (input: RenewNowWorkflowInput) {
    const result: RenewNowStepOutput = renewNowStep({
      subscription_id: input.subscription_id,
      customer_id: input.customer_id,
    })

    return new WorkflowResponse(result)
  }
)
