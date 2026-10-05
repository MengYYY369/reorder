import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http"
import { MedusaError } from "@medusajs/framework/utils"
import { renewNowWorkflow } from "../../../../../../../workflows/renew-now"

/**
 * The on-demand renewal the storefront's「立即续费」button calls (0.9.3, plan
 * ticket 01④, user item 8). The step decides the rail once: a usable method
 * (plugin preferred for the product, else the row's own) charges off-session
 * through the engine's own `process-renewal-cycle`; no method falls back to
 * the PayPal-approval manual renewal and returns its cashier link.
 *
 * All guard refusals (ownership, mirror rows, status, in-progress renewal,
 * no renewable cycle) are MedusaErrors the step throws with their own types,
 * so the serialized failures are rethrown verbatim — the type decides the
 * status code, the message stays the step's own words.
 *
 * `POST /store/customers/me/subscriptions/:id/renew-now` (no body)
 * → `{ renew: { mode, subscription_id, renewal_cycle_id, order_id, total,
 *      currency_code, redirect_url } }` — `mode: "charged"` for the
 *      off-session rail, `"manual_link"` with `redirect_url` for the
 *      approval rail.
 */
export const POST = async (
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) => {
  const customerId = req.auth_context?.actor_id

  if (!customerId) {
    throw new MedusaError(
      MedusaError.Types.UNAUTHORIZED,
      "Customer authentication is required."
    )
  }

  const { result, errors } = await renewNowWorkflow(req.scope).run({
    input: {
      subscription_id: req.params.id,
      customer_id: customerId,
    },
    throwOnError: false,
  })

  if (errors?.length) {
    // The step only ever throws MedusaError (its own guards, or a classified
    // refusal from a delegated workflow, rethrown with its original type).
    const serialized = errors[0] as {
      error?: { type?: string; message?: string }
    }
    const type = (
      Object.values(MedusaError.Types) as string[]
    ).includes(serialized.error?.type ?? "")
      ? (serialized.error!.type as string)
      : MedusaError.Types.UNEXPECTED_STATE

    throw new MedusaError(
      type,
      serialized.error?.message ?? `Renew-now failed for the subscription.`
    )
  }

  res.status(200).json({ renew: result })
}
