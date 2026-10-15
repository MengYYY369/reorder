import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http"
import {
  ContainerRegistrationKeys,
  MedusaError,
} from "@medusajs/framework/utils"
import {
  AUTO_RENEW_CUSTOMER_REFUSALS,
  setSubscriptionAutoRenewWorkflow,
} from "../../../../../../../workflows/set-subscription-auto-renew"
import {
  classifyStepFailure,
  logUnquotedStepFailure,
  type StepFailureCopy,
  type StepFailureLogger,
} from "../../../../../../../workflows/utils/store-step-failure"
import type { SubscriptionPaymentMode } from "../../../../../../../modules/subscription/types"
import { retrieveOwnedSubscription } from "../../utils"

/**
 * The response texts for a failure that is not one of the guards' refusals.
 * They are ours, fixed, and say nothing about the cause: the cause goes to the
 * log. `refused` and `failed` are deliberately the same sentence — which status
 * class a non-refusal failure keeps is the caller's business, not its wording.
 */
const AUTO_RENEW_FAILURE_COPY: StepFailureCopy = {
  notFound: "subscription not found",
  refused: "auto-renewal could not be updated",
  failed: "auto-renewal could not be updated",
}

/**
 * POST /store/customers/me/subscriptions/:id/auto-renew
 * Body: { enabled: boolean }
 * → { subscription_id, payment_mode }
 *
 * This route replaced the retired tenant bridge's `POST /store/saas/auto-renew`
 * on 2026-10-14: the subscription is addressed by path and owned by the caller,
 * so the request needs neither a tenant id nor a shared secret. It runs the
 * same workflow — the same write side the payment-method update uses, so
 * `payment_mode` and its `mechanism` annotation always change together.
 *
 * AUTHORIZATION: the middleware mounted on `/store/customers/me/subscriptions*`
 * authenticates the customer; the ownership read below filters by
 * `customer_id`, so another customer's subscription is answered exactly like a
 * subscription that does not exist (404, existence not leaked).
 *
 * FAILURE DISCLOSURE: the one guard owned by the workflow — a mirror of a
 * provider-owned recurrence — answers 400 with its own message before anything
 * is written. No other failure is quoted: it keeps the HTTP semantics of the
 * `MedusaError` it was thrown as (a vanished row is a 404, a conflict a 409) or
 * becomes a 500, and its text is replaced by ours while the cause is logged.
 * See `src/workflows/utils/store-step-failure.ts`.
 */
export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  // Authentication and ownership first: `retrieveOwnedSubscription` requires an
  // authenticated customer and filters by `customer_id`, so a row that is not
  // the caller's is not told apart from a row that is not there.
  const subscription = await retrieveOwnedSubscription(req, req.params.id)

  const { enabled } = (req.body ?? {}) as { enabled?: boolean }

  if (typeof enabled !== "boolean") {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      "body.enabled must be a boolean"
    )
  }

  const logger = req.scope.resolve<StepFailureLogger>(
    ContainerRegistrationKeys.LOGGER
  )

  const { errors, result } = await setSubscriptionAutoRenewWorkflow(
    req.scope
  ).run({
    input: {
      subscription_id: subscription.id,
      enabled,
    },
    throwOnError: false,
  })

  if (errors?.length) {
    const failure = classifyStepFailure({
      errors,
      refusals: AUTO_RENEW_CUSTOMER_REFUSALS,
      copy: AUTO_RENEW_FAILURE_COPY,
      // A customer-scoped route has no byte-compatibility promise with the
      // bridge, so a quoted refusal keeps the status the step threw it with.
      preserveQuotedStatus: true,
    })

    if (!failure.quoted) {
      // Everything that is not a guard refusal is either a fault of ours or a
      // refusal phrased in someone else's words. Wrapping it in a 400 would
      // hide the status the caller needs to retry, and quoting it would put
      // internal text (`connect ECONNREFUSED …`, a driver's `table`/`detail`)
      // in front of a customer reading it as a permanent refusal — so the cause
      // is logged and the response carries only our own wording.
      logUnquotedStepFailure(logger, "auto-renew toggle", failure)
    }

    throw new MedusaError(failure.type, failure.message)
  }

  const updated = (result ?? {}) as {
    subscription_id?: string
    payment_mode?: SubscriptionPaymentMode
  }

  if (!updated.subscription_id || !updated.payment_mode) {
    // Same shape as the other workflow-backed routes: a workflow that reports
    // neither an error nor a usable result must not answer 200 with an empty
    // body.
    throw new MedusaError(
      MedusaError.Types.UNEXPECTED_STATE,
      "auto-renewal toggle returned no payment mode"
    )
  }

  res.json({
    subscription_id: updated.subscription_id,
    payment_mode: updated.payment_mode,
  })
}
