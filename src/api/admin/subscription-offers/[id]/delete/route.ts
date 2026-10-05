import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http"
import { deletePlanOfferWorkflow } from "../../../../../workflows/delete-plan-offer"

/**
 * Hard-deletes one disabled plan offer. The workflow refuses enabled offers
 * with a 409; a 404 means the id never existed or is already gone.
 */
export const POST = async (
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) => {
  const { result } = await deletePlanOfferWorkflow(req.scope).run({
    input: { id: req.params.id },
  })

  res.status(200).json({
    id: result.plan_offer_id,
    deleted: true,
  })
}
