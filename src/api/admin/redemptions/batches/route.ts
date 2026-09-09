import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http"
import type { PostAdminCreateRedemptionBatchSchemaType } from "./validators"
import { createRedemptionBatchWorkflow } from "../../../../workflows/create-redemption-batch"
import type { RedemptionFrequencyInterval } from "../../../../modules/redemption/types"
import { getAdminRedemptionBatchDetailResponse } from "../utils"
import { listAdminRedemptionBatchesResponse } from "../utils"

export const GET = async (
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) => {
  const response = await listAdminRedemptionBatchesResponse(
    req.scope,
    req.validatedQuery,
    req.queryConfig?.pagination?.skip,
    req.queryConfig?.pagination?.take
  )

  res.status(200).json(response)
}

export const POST = async (
  req: AuthenticatedMedusaRequest<PostAdminCreateRedemptionBatchSchemaType>,
  res: MedusaResponse
) => {
  const { result } = await createRedemptionBatchWorkflow(req.scope).run({
    input: {
      ...req.validatedBody,
      frequency_interval: req.validatedBody.frequency_interval as RedemptionFrequencyInterval,
    },
  })

  const response = await getAdminRedemptionBatchDetailResponse(
    req.scope,
    result.batch.id
  )

  res.status(200).json(response)
}
