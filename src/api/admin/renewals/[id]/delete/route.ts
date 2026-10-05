import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http"
import { deleteRenewalCycleWorkflow } from "../../../../../workflows/delete-renewal-records"

/**
 * Hard-deletes one terminal renewal cycle together with its attempts. The
 * workflow refuses non-terminal cycles (scheduled, processing, awaiting
 * manual resolution) with a 409.
 */
export const POST = async (
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) => {
  const { result } = await deleteRenewalCycleWorkflow(req.scope).run({
    input: { id: req.params.id },
  })

  res.status(200).json({
    id: result.renewal_cycle_id,
    deleted: true,
    deleted_attempts: result.deleted_attempts,
  })
}
