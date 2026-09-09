import { createWorkflow, WorkflowResponse } from "@medusajs/framework/workflows-sdk"
import {
  createRedemptionBatchStep,
  disableRedemptionBatchStep,
  disableRedemptionCodeStep,
  validateRedemptionGrantTargetStep,
  type CreateRedemptionBatchStepOutput,
} from "./steps/redemption-batch"
import {
  CreateRedemptionBatchInput,
  RedemptionBatchDTO,
  RedemptionCodeDTO,
} from "../modules/redemption/types"

export type CreateRedemptionBatchWorkflowInput = CreateRedemptionBatchInput

/**
 * Creates a redemption batch with its code set. Grant-target validation
 * (variant exists, enabled plan-offer, allowed frequency) runs before the
 * batch and codes are persisted.
 */
export const createRedemptionBatchWorkflow = createWorkflow(
  "create-redemption-batch",
  function (input: CreateRedemptionBatchWorkflowInput) {
    validateRedemptionGrantTargetStep({
      variant_id: input.variant_id,
      frequency_interval: input.frequency_interval,
      frequency_value: input.frequency_value,
    })

    const created: CreateRedemptionBatchStepOutput = createRedemptionBatchStep(
      input
    )

    return new WorkflowResponse(created)
  }
)

export type DisableRedemptionEntityInput = { id: string }

export const disableRedemptionBatchWorkflow = createWorkflow(
  "disable-redemption-batch",
  function (input: DisableRedemptionEntityInput) {
    const batchId: string = disableRedemptionBatchStep(input)
    return new WorkflowResponse(batchId)
  }
)

export const disableRedemptionCodeWorkflow = createWorkflow(
  "disable-redemption-code",
  function (input: DisableRedemptionEntityInput) {
    const codeId: string = disableRedemptionCodeStep(input)
    return new WorkflowResponse(codeId)
  }
)

export default createRedemptionBatchWorkflow
