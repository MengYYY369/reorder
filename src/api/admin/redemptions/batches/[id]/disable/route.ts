import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http"
import { disableRedemptionBatchWorkflow } from "../../../../../../workflows/create-redemption-batch"
import { getAdminRedemptionBatchDetailResponse } from "../../../utils"

export const POST = async (
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) => {
  await disableRedemptionBatchWorkflow(req.scope).run({
    input: { id: req.params.id },
  })

  const response = await getAdminRedemptionBatchDetailResponse(
    req.scope,
    req.params.id
  )

  res.status(200).json(response)
}
