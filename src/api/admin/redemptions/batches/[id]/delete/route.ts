import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http"
import { deleteRedemptionBatchWorkflow } from "../../../../../../workflows/create-redemption-batch"

/**
 * Hard-deletes a disabled batch together with its codes and redemption
 * records. Only disabled batches pass the workflow's gate; the response
 * reports what was removed so the admin UI can audit the destructive action.
 */
export const POST = async (
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) => {
  const { result } = await deleteRedemptionBatchWorkflow(req.scope).run({
    input: { id: req.params.id },
  })

  res.status(200).json({
    id: result.batch_id,
    deleted: true,
    deleted_records: result.deleted_records,
    deleted_codes: result.deleted_codes,
  })
}
