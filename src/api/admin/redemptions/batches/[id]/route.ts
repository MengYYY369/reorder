import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http"
import { getAdminRedemptionBatchDetailResponse } from "../../utils"

export const GET = async (
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) => {
  const response = await getAdminRedemptionBatchDetailResponse(
    req.scope,
    req.params.id
  )

  res.status(200).json(response)
}
