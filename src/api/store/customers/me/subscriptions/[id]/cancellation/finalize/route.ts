import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http"
import { ContainerRegistrationKeys, MedusaError } from "@medusajs/framework/utils"
import { finalizeCancellationWorkflow } from "../../../../../../../../workflows"
import { finalizeCancellationStep } from "../../../../../../../../workflows/steps/finalize-cancellation"
import {
  classifyStepFailure,
  logUnquotedStepFailure,
  type CustomerRefusal,
  type StepFailureCopy,
  type StepFailureLogger,
} from "../../../../../../../../workflows/utils/store-step-failure"
import {
  getActiveCancellationCase,
  retrieveOwnedSubscription,
  sendStoreJson,
} from "../../../utils"

/**
 * The refusals the finalize workflow authors for the caller, each with its
 * exact text. Same ownership rule as `TRIAL_CLAIM_CUSTOMER_REFUSALS`: the
 * route that discloses a failure must not be the place that decides which
 * step may speak. These are `finalizeCancellationStep`'s own business
 * rejections (`cancellationErrors` / `subscriptionErrors`); every other
 * failure — infrastructure, driver, deserialized engine faults — is answered
 * with the route's fixed texts below.
 */
const FINALIZE_STEP = finalizeCancellationStep.__step__

const STORE_FINALIZE_CANCELLATION_CUSTOMER_REFUSALS = [
  {
    step: FINALIZE_STEP,
    type: MedusaError.Types.CONFLICT,
    copy: /^CancellationCase '[^']*' is already finalized with status '[^']*'$/,
  },
  {
    step: FINALIZE_STEP,
    type: MedusaError.Types.CONFLICT,
    copy: /^CancellationCase '[^']*' can't finalize cancellation from status '[^']*'$/,
  },
  {
    step: FINALIZE_STEP,
    type: MedusaError.Types.CONFLICT,
    copy: /^Subscription '[^']*' can't be cancelled from status '[^']*'$/,
  },
  {
    step: FINALIZE_STEP,
    type: MedusaError.Types.INVALID_DATA,
    copy: /^CancellationCase '[^']*' requires a reason before final cancellation$/,
  },
] as const satisfies readonly CustomerRefusal[]

const STORE_FINALIZE_FAILURE_COPY: StepFailureCopy = {
  notFound: "cancellation case not found",
  refused: "cancellation can no longer be finalized",
  failed: "cancellation could not be finalized",
}

/**
 * Finalizes the customer's own open cancellation case (Phase 15, the exit on
 * the vault rail): the subscription becomes `cancelled` immediately, the
 * pending renewal cycle is deleted by the workflow, and the case is closed as
 * `canceled`.
 *
 * Ownership is decided before the workflow runs: the subscription must belong
 * to the authenticated customer (`retrieveOwnedSubscription`, the same helper
 * every other `/store/customers/me/subscriptions/[id]/*` route uses), and the
 * case to finalize is the open case resolved from *that* subscription — never
 * from a caller-supplied case id. A customer therefore cannot address another
 * customer's case, and a subscription with no open case answers 404.
 *
 * The route is keyed by subscription id while the workflow takes a
 * `cancellation_case_id`; the resolution above is the bridge, and the
 * retention entry (`POST .../cancellation`) is untouched — finalizing is a
 * separate, explicit step the customer may take after opening a case.
 *
 * No request body: the reason recorded on the case is reused by the workflow.
 * Like `skip-next-delivery`, the route needs no middleware entry — customer
 * auth already applies through the `/store/customers/me/subscriptions*`
 * matcher, and there is no body to validate.
 */
export const POST = async (
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) => {
  const subscriptionId = req.params.id

  const subscription = await retrieveOwnedSubscription(req, subscriptionId)

  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)
  const openCase = await getActiveCancellationCase(query, subscription.id)

  if (!openCase) {
    throw new MedusaError(
      MedusaError.Types.NOT_FOUND,
      `Subscription '${subscriptionId}' has no open cancellation case to finalize.`
    )
  }

  const { result, errors } = await finalizeCancellationWorkflow(req.scope).run({
    input: {
      cancellation_case_id: openCase.id,
      finalized_by: req.auth_context?.actor_id ?? null,
    },
    throwOnError: false,
  })

  if (errors?.length) {
    const failure = classifyStepFailure({
      errors,
      refusals: STORE_FINALIZE_CANCELLATION_CUSTOMER_REFUSALS,
      copy: STORE_FINALIZE_FAILURE_COPY,
      preserveQuotedStatus: true,
    })

    if (!failure.quoted) {
      logUnquotedStepFailure(
        req.scope.resolve<StepFailureLogger>(ContainerRegistrationKeys.LOGGER),
        "store-cancellation-finalize",
        failure
      )
    }

    throw new MedusaError(failure.type, failure.message)
  }

  if (!result?.cancellation_case_id) {
    throw new MedusaError(
      MedusaError.Types.UNEXPECTED_STATE,
      STORE_FINALIZE_FAILURE_COPY.failed
    )
  }

  return sendStoreJson(res, {
    cancellation_case: {
      id: result.cancellation_case_id,
      subscription_id: result.subscription_id,
      status: result.case_status,
      final_outcome: result.final_outcome,
      cancellation_effective_at: result.cancel_effective_at,
    },
  })
}
