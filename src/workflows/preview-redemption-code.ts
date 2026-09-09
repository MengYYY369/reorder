import { createWorkflow, WorkflowResponse } from "@medusajs/framework/workflows-sdk"
import { resolveRedemptionCodeStep } from "./steps/redeem-redemption-code"
import type { RedemptionResolution } from "./steps/redeem-redemption-code"

/**
 * Read-only preview of a redemption code: runs the same validation and
 * target resolution as redeem without consuming anything.
 */
export const previewRedemptionCodeWorkflow = createWorkflow(
  "preview-redemption-code",
  function (input: {
    code: string
    customer_id: string
    subscription_id?: string | null
  }) {
    const resolution: RedemptionResolution = resolveRedemptionCodeStep({
      code: input.code,
      customer_id: input.customer_id,
      subscription_id: input.subscription_id ?? null,
      mode: "preview",
    })

    return new WorkflowResponse(resolution)
  }
)

export default previewRedemptionCodeWorkflow
