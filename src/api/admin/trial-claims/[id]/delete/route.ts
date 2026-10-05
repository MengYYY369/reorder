import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http"
import { deleteTrialClaimWorkflow } from "../../../../../workflows/delete-trial-claim"

/**
 * Hard-deletes one trial-claim ledger row (ticket 15). A missing id answers
 * 404; the linked subscription, if any, is untouched.
 */
export const POST = async (
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) => {
  const { result } = await deleteTrialClaimWorkflow(req.scope).run({
    input: { id: req.params.id },
  })

  res.status(200).json({
    id: result.trial_claim_id,
    deleted: true,
  })
}
