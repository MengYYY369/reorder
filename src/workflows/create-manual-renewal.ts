import {
  createWorkflow,
  transform,
  WorkflowResponse,
} from "@medusajs/framework/workflows-sdk"
import { acquireLockStep, releaseLockStep } from "@medusajs/medusa/core-flows"
import {
  createManualRenewalStep,
  type CreateManualRenewalStepOutput,
} from "./steps/create-manual-renewal"

export type CreateManualRenewalWorkflowInput = {
  subscription_id: string
  triggered_by?: string | null
  reason?: string | null
}

/**
 * Manual renewal for manual-payment-mode subscriptions (redirect-only
 * providers): creates the renewal order + an UNCONFIRMED payment session and
 * returns the cashier URL. The cycle is finalized by complete-manual-renewal
 * once the payment capture lands.
 *
 * Invoke BY NAME through the workflow engine — the workflow is registered by
 * the plugin's workflow loader and must not be imported from host code (its
 * flow graph embeds per-instance random ids; a second registration from a
 * different module graph diverges and throws).
 */
export const createManualRenewalWorkflow = createWorkflow(
  "create-manual-renewal",
  function (input: CreateManualRenewalWorkflowInput) {
    const lockInput = transform({ input }, ({ input }) => ({
      key: `manual-renewal:${input.subscription_id}`,
      timeout: 30,
      ttl: 120,
    }))

    acquireLockStep(lockInput)

    const renewal = createManualRenewalStep({
      subscription_id: input.subscription_id,
      triggered_by: input.triggered_by ?? null,
      reason: input.reason ?? null,
    })

    releaseLockStep(
      transform({ renewal }, ({ renewal }) => ({
        key: `manual-renewal:${renewal.subscription_id}`,
      }))
    )

    return new WorkflowResponse<CreateManualRenewalStepOutput>(renewal)
  }
)

export default createManualRenewalWorkflow
