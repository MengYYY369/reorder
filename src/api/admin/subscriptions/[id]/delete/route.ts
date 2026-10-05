import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http"
import { deleteSubscriptionWorkflow } from "../../../../../workflows/delete-subscription"

/**
 * Hard-deletes one cancelled subscription with its full row chain. The
 * workflow refuses anything but a cancelled subscription with a 409; the
 * response reports the per-table counts the chain delete removed.
 */
export const POST = async (
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) => {
  const { result } = await deleteSubscriptionWorkflow(req.scope).run({
    input: { id: req.params.id },
  })

  res.status(200).json({
    id: req.params.id,
    deleted: true,
    counts: {
      subscription: result.subscription,
      renewal_cycles: result.renewal_cycles,
      renewal_attempts: result.renewal_attempts,
      subscription_logs: result.subscription_logs,
      metrics_daily: result.metrics_daily,
      trial_claims: result.trial_claims,
      cancellation_cases: result.cancellation_cases,
      retention_offer_events: result.retention_offer_events,
      dunning_cases: result.dunning_cases,
      dunning_attempts: result.dunning_attempts,
    },
  })
}
