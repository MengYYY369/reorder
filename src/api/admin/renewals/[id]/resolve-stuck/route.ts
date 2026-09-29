import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http"
import type { PostAdminResolveStuckRenewalSchemaType } from "../../validators"
import {
  getAdminRenewalDetailResponse,
  mapRenewalAdminRouteError,
} from "../../utils"
import { reconcileStuckRenewalCycleWorkflow } from "../../../../../workflows"
import { createRenewalCorrelationId } from "../../../../../modules/renewal/utils/observability"

/**
 * Operator entry point for a stuck renewal cycle (hardening plan Task 9):
 * resolves a cycle stuck in `processing` or parked in
 * `awaiting_manual_resolution` by delegating to the reconciliation workflow
 * with the operator's override. The route carries no business rules — the
 * workflow owns the decision table, the settlement, and the activity log.
 */
export const POST = async (
  req: AuthenticatedMedusaRequest<PostAdminResolveStuckRenewalSchemaType>,
  res: MedusaResponse
) => {
  const correlationId = createRenewalCorrelationId(
    "renewal-admin-resolve-stuck"
  )

  try {
    await reconcileStuckRenewalCycleWorkflow(req.scope).run({
      input: {
        renewal_cycle_id: req.params.id,
        outcome_override: req.validatedBody.outcome,
        reason: req.validatedBody.reason,
        trigger_type: "manual",
        triggered_by: req.auth_context.actor_id,
        correlation_id: correlationId,
      },
    })
  } catch (error) {
    const mapped = mapRenewalAdminRouteError(error)

    return res.status(mapped.status).json({
      type: mapped.type,
      message: mapped.message,
    })
  }

  const response = await getAdminRenewalDetailResponse(
    req.scope,
    req.params.id
  )

  return res.status(200).json(response)
}
