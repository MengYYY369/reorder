import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http"
import { deleteRenewalAttemptWorkflow } from "../../../../../../../workflows/delete-renewal-records"

/**
 * Hard-deletes one terminal attempt of a terminal renewal cycle. The workflow
 * enforces both terminal-state gates and that the attempt belongs to the
 * cycle in the path.
 */
export const POST = async (
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) => {
  const { result } = await deleteRenewalAttemptWorkflow(req.scope).run({
    input: {
      renewal_cycle_id: req.params.id,
      attempt_id: req.params.attempt_id,
    },
  })

  res.status(200).json({
    id: result.renewal_attempt_id,
    renewal_cycle_id: result.renewal_cycle_id,
    deleted: true,
  })
}
