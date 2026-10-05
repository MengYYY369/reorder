import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http"
import {
  ContainerRegistrationKeys,
  MedusaError,
} from "@medusajs/framework/utils"
import type { PostStoreTrialBindSchemaType } from "../../validators"
import {
  bindTrialPaymentMethodWorkflow,
  startTrialPaymentMethodBindingWorkflow,
} from "../../../../../../../workflows/bind-trial-payment-method"
import {
  completeTrialVaultApprovalStep,
  resolveTrialBindContextStep,
  startTrialVaultApprovalStep,
} from "../../../../../../../workflows/steps/bind-trial-payment-method"
import {
  classifyStepFailure,
  findSerializedErrorMessageByName,
  findSerializedPaymentMethodsFailure,
  coreTypeForPaymentMethodsStatus,
  logUnquotedStepFailure,
  type StepFailureCopy,
  type StepFailureLogger,
} from "../../../../../../../workflows/utils/store-step-failure"

/**
 * The refusals the binding workflows author for the caller, each with its
 * exact text. Same ownership rule as `TRIAL_CLAIM_CUSTOMER_REFUSALS`: the
 * route that discloses a failure must not be the place that decides which
 * step may speak. They cover the bind context guard (ownership is the same
 * 404 every /store/customers/me/* route answers), the capability guard (the
 * installed payment-methods module predates the binding capability — nothing
 * is created), the not-yet-approved status the sandbox flow actually produces
 * (surfaced from the plugin's binder), and the pending-approval mismatches.
 */
const CONTEXT_STEP = resolveTrialBindContextStep.__step__
const START_STEP = startTrialVaultApprovalStep.__step__
const COMPLETE_STEP = completeTrialVaultApprovalStep.__step__

const CAPABILITY_REFUSAL_COPY =
  /^Binding a payment method is not supported: the installed payment-methods module does not provide the binding capability\. Update @mengyyy369\/medusa-payment-methods and try again\.$/

export const TRIAL_BIND_CUSTOMER_REFUSALS = [
  {
    step: CONTEXT_STEP,
    type: MedusaError.Types.NOT_FOUND,
    copy: /^Subscription \S+ was not found for the authenticated customer\.$/,
  },
  {
    step: CONTEXT_STEP,
    type: MedusaError.Types.INVALID_DATA,
    copy: /^Only a trial subscription can bind a payment method this way\.$/,
  },
  {
    step: CONTEXT_STEP,
    type: MedusaError.Types.INVALID_DATA,
    copy: /^Only an active trial subscription can bind a payment method\.$/,
  },
  {
    step: CONTEXT_STEP,
    type: MedusaError.Types.INVALID_DATA,
    copy:
      /^A provider-managed subscription is billed by its provider and cannot bind a reorder payment method\.$/,
  },
  {
    step: CONTEXT_STEP,
    type: MedusaError.Types.INVALID_DATA,
    copy: /^This trial already has a bound payment method\.$/,
  },
  {
    step: CONTEXT_STEP,
    type: MedusaError.Types.INVALID_DATA,
    copy:
      /^This trial has no pending payment-method approval\. Start the binding first\.$/,
  },
  {
    step: CONTEXT_STEP,
    type: MedusaError.Types.INVALID_DATA,
    copy:
      /^The setup token does not match the pending approval for this trial\. Start the binding again\.$/,
  },
  {
    step: START_STEP,
    type: MedusaError.Types.NOT_ALLOWED,
    copy: CAPABILITY_REFUSAL_COPY,
  },
  {
    step: COMPLETE_STEP,
    type: MedusaError.Types.NOT_ALLOWED,
    copy: CAPABILITY_REFUSAL_COPY,
  },
  {
    // The sandbox's normal pending case: the buyer has not approved yet. The
    // plugin's binder (medusa-paypal) authors this refusal; the delegated
    // step carries it under the complete step's name.
    step: COMPLETE_STEP,
    type: MedusaError.Types.INVALID_DATA,
    copy:
      /^PayPal setup token is not approved \(status: [^)]*\)$/,
  },
] as const

const TRIAL_BIND_FAILURE_COPY: StepFailureCopy = {
  notFound: "trial subscription not found",
  refused: "payment method binding was refused",
  failed: "payment method binding failed",
}

/**
 * The two-phase binding endpoint (Phase 14, plan Task 22; since 0.9.3 the
 * provider half is delegated to the payment-methods plugin — B6, plan
 * ticket 01 — with the external request/response shape unchanged):
 *
 * `POST /store/customers/me/trials/:id/bind { action: "start", return_url,
 * cancel_url }` — starts the binding through the plugin (scope "trial") and
 * returns the `approve_url` the customer must visit. The pending session is
 * stored on the subscription; nothing chargeable changes.
 *
 * `POST /store/customers/me/trials/:id/bind { action: "complete",
 * setup_token_id }` — the customer returned from PayPal; the plugin exchanges
 * the approval session for its ledger method, the trial is bound and extended
 * (anchored on its own `started_at`), and the pending renewal cycle is
 * re-pointed. The stored reference is the plugin ledger's method reference.
 *
 * The subscription is resolved by id under the authenticated customer — never
 * from the body. `trial_requires_payment_method` needs nothing further here:
 * the rule governs claiming without a method, and this endpoint's only
 * outcome is a bound method.
 */
export const POST = async (
  req: AuthenticatedMedusaRequest<PostStoreTrialBindSchemaType>,
  res: MedusaResponse
) => {
  const customerId = req.auth_context?.actor_id

  if (!customerId) {
    throw new MedusaError(
      MedusaError.Types.UNAUTHORIZED,
      "Customer authentication is required."
    )
  }

  const body = req.validatedBody

  let response: Record<string, unknown>

  if (body.action === "start") {
    // The body validator enforces both URLs; the guard keeps the workflow
    // inputs honest even if a future validator change drops the refine.
    if (!body.return_url || !body.cancel_url) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "return_url and cancel_url are required to start the approval."
      )
    }

    const { result, errors } = await startTrialPaymentMethodBindingWorkflow(
      req.scope
    ).run({
      input: {
        subscription_id: req.params.id,
        customer_id: customerId,
        return_url: body.return_url,
        cancel_url: body.cancel_url,
      },
      throwOnError: false,
    })

    if (errors?.length) {
      throwClassified(req, errors)
    }

    if (!result?.setup_token_id || !result?.approve_url) {
      throw new MedusaError(
        MedusaError.Types.UNEXPECTED_STATE,
        TRIAL_BIND_FAILURE_COPY.failed
      )
    }

    response = {
      phase: "approval_pending",
      subscription_id: result.subscription_id,
      setup_token_id: result.setup_token_id,
      approve_url: result.approve_url,
      trial_ends_at: result.trial_ends_at,
    }
  } else {
    if (!body.setup_token_id) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "setup_token_id is required to complete the binding."
      )
    }

    const { result, errors } = await bindTrialPaymentMethodWorkflow(
      req.scope
    ).run({
      input: {
        subscription_id: req.params.id,
        customer_id: customerId,
        setup_token_id: body.setup_token_id,
      },
      throwOnError: false,
    })

    if (errors?.length) {
      throwClassified(req, errors)
    }

    if (!result?.payment_method_reference) {
      throw new MedusaError(
        MedusaError.Types.UNEXPECTED_STATE,
        TRIAL_BIND_FAILURE_COPY.failed
      )
    }

    response = {
      phase: "bound",
      subscription_id: result.subscription_id,
      payment_provider_id: result.payment_provider_id,
      payment_method_reference: result.payment_method_reference,
      trial_ends_at: result.trial_ends_at,
      next_renewal_at: result.next_renewal_at,
      bonus_days_applied: result.bonus_days_applied,
      payment_mode: "auto",
    }
  }

  res.status(200).json({ bind: response })
}

/**
 * One disclosure path for both phases: declared refusals keep their text and
 * status, everything else is logged exactly as the engine serialized it and
 * answered with the route's fixed texts.
 *
 * Two typed escapes run before the fixed-text fallback:
 *
 * - the plugin's own `PaymentMethodsError` (the delegated start/complete
 *   raise them) — its class carries the contract status and a message the
 *   plugin authors as customer copy (`already_bound`, `binding_not_verified`,
 *   …), so it is rethrown under the core type with the same HTTP semantics
 *   instead of collapsing into the route's generic 500;
 * - medusa-paypal's `PaypalCredentialEnvironmentMismatchError` (ticket 03,
 *   #18) — the fail-fast the operator must be able to read; it keeps its own
 *   message as a 500 (`unexpected_state`), never swallowed into
 *   "payment method binding failed".
 */
function throwClassified(
  req: AuthenticatedMedusaRequest<PostStoreTrialBindSchemaType>,
  errors: unknown
) {
  const mismatchMessage = findSerializedErrorMessageByName(
    errors,
    "PaypalCredentialEnvironmentMismatchError"
  )

  if (mismatchMessage) {
    throw new MedusaError(MedusaError.Types.UNEXPECTED_STATE, mismatchMessage)
  }

  const failure = classifyStepFailure({
    errors,
    refusals: TRIAL_BIND_CUSTOMER_REFUSALS,
    copy: TRIAL_BIND_FAILURE_COPY,
    preserveQuotedStatus: true,
  })

  if (failure.quoted) {
    throw new MedusaError(failure.type, failure.message)
  }

  const pluginFailure = findSerializedPaymentMethodsFailure(errors)

  if (pluginFailure) {
    const coreType = coreTypeForPaymentMethodsStatus(pluginFailure.status)

    if (coreType) {
      throw new MedusaError(coreType, pluginFailure.message)
    }
  }

  logUnquotedStepFailure(
    req.scope.resolve<StepFailureLogger>(ContainerRegistrationKeys.LOGGER),
    "trial-bind",
    failure
  )

  throw new MedusaError(failure.type, failure.message)
}
