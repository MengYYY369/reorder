import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http"
import { REDEMPTION_MODULE } from "../../../../../../modules/redemption"
import RedemptionModuleService from "../../../../../../modules/redemption/service"
import { disableRedemptionCodeWorkflow } from "../../../../../../workflows/create-redemption-batch"

export const POST = async (
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) => {
  await disableRedemptionCodeWorkflow(req.scope).run({
    input: { id: req.params.id },
  })

  const redemptionModuleService = req.scope.resolve<RedemptionModuleService>(
    REDEMPTION_MODULE
  )
  const code = await redemptionModuleService.retrieveRedemptionCode(
    req.params.id
  )

  res.status(200).json({ code })
}
