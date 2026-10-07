import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http"
import {
  ContainerRegistrationKeys,
  MedusaError,
} from "@medusajs/framework/utils"
import {
  completeAutoRenewBindingWorkflow,
  startAutoRenewBindingWorkflow,
} from "../../../../../../../../workflows/auto-renew-binding"
import {
  completeAutoRenewBindingStep,
  resolveAutoRenewBindContextStep,
  startAutoRenewBindingStep,
} from "../../../../../../../../workflows/steps/auto-renew-binding"
import {
  classifyStepFailure,
  findSerializedPaymentMethodsFailure,
  coreTypeForPaymentMethodsStatus,
  logUnquotedStepFailure,
  type StepFailureCopy,
  type StepFailureLogger,
} from "../../../../../../../../workflows/utils/store-step-failure"
import type { PostStoreAutoRenewBindSchemaType } from "../../../validators"

/**
 * The two-phase bind flow that enables auto-renewal (0.9.3, plan ticket 01③,
 * user ruling Q8/Q13): clicking「开启自动续费」on a cardless subscription
 * starts the SAME plugin binding the trial bind uses (scope = the
 * subscription's product) and only a successful completion flips the flag.
 *
 * `POST /store/customers/me/subscriptions/:id/auto-renew/bind
 *   { action: "start", return_url, cancel_url }` — starts the binding and
 * returns the `approve_url` the customer must visit. A customer whose row
 * already carries a method is refused: they enable auto-renewal directly.
 *
 * `POST /store/customers/me/subscriptions/:id/auto-renew/bind
 *   { action: "complete", setup_token_id }` — the customer returned from
 * PayPal; the plugin exchanges the approval session for its ledger method,
 * the reference lands on the row, and the mode flips to auto through the
 * toggle's own guards. A repeated complete replays idempotently.
 */
const CONTEXT_STEP = resolveAutoRenewBindContextStep.__step__
const START_STEP = startAutoRenewBindingStep.__step__
const COMPLETE_STEP = completeAutoRenewBindingStep.__step__

const CAPABILITY_REFUSAL_COPY =
  /^Enabling auto-renewal is not supported: the installed payment-methods module does not provide the binding capability\. Update @mengyyy369\/medusa-payment-methods and try again\.$/

export const AUTO_RENEW_BIND_CUSTOMER_REFUSALS = [
  {
    step: CONTEXT_STEP,
    type: MedusaError.Types.NOT_FOUND,
    copy: /^Subscription \S+ was not found for the authenticated customer\.$/,
  },
  {
    step: CONTEXT_STEP,
    type: MedusaError.Types.INVALID_DATA,
    copy:
      /^Subscription '[^']*' is a mirror of a provider-managed recurrence; manage auto-renewal at the provider$/,
  },
  {
    step: CONTEXT_STEP,
    type: MedusaError.Types.INVALID_DATA,
    copy:
      /^Only an active subscription can enable auto-renewal by binding a payment method\.$/,
  },
  {
    step: CONTEXT_STEP,
    type: MedusaError.Types.INVALID_DATA,
    copy:
      /^This subscription already has a payment method\. Enable auto-renewal directly\.$/,
  },
  {
    step: CONTEXT_STEP,
    type: MedusaError.Types.INVALID_DATA,
    copy:
      /^This subscription has no pending payment-method approval\. Start the binding first\.$/,
  },
  {
    step: CONTEXT_STEP,
    type: MedusaError.Types.INVALID_DATA,
    copy:
      /^The setup token does not match the pending approval for this subscription\. Start the binding again\.$/,
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
    // The toggle's overdue guard, rethrown by the complete step: the binding
    // succeeded but the surprise-charge protection keeps auto-renewal off
    // until the customer renews manually first.
    step: COMPLETE_STEP,
    type: MedusaError.Types.INVALID_DATA,
    copy:
      /^Subscription '[^']*' is overdue — renew manually before enabling auto-renewal$/,
  },
] as const

const AUTO_RENEW_BIND_FAILURE_COPY: StepFailureCopy = {
  notFound: "subscription not found",
  refused: "auto-renewal binding was refused",
  failed: "auto-renewal binding failed",
}

/**
 * The buyer-facing copy for the plugin's `binding_pending_approval` (422).
 *
 * The plugin's own message for that code is the operator line; this is what the
 * customer reads, and it names the recovery path.
 */
const BINDING_PENDING_APPROVAL_COPY =
  "the payment method is not approved yet — finish the approval at the provider, then retry"

export const POST = async (
  req: AuthenticatedMedusaRequest<PostStoreAutoRenewBindSchemaType>,
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
  const action = body?.action

  if (action !== "start" && action !== "complete") {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      "body.action must be 'start' or 'complete'."
    )
  }

  let response: Record<string, unknown>

  if (action === "start") {
    if (
      typeof body.return_url !== "string" ||
      !body.return_url ||
      typeof body.cancel_url !== "string" ||
      !body.cancel_url
    ) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "return_url and cancel_url are required to start the approval."
      )
    }

    const { result, errors } = await startAutoRenewBindingWorkflow(req.scope).run(
      {
        input: {
          subscription_id: req.params.id,
          customer_id: customerId,
          return_url: body.return_url,
          cancel_url: body.cancel_url,
        },
        throwOnError: false,
      }
    )

    if (errors?.length) {
      throwClassified(req, errors)
    }

    if (!result?.setup_token_id || !result?.approve_url) {
      throw new MedusaError(
        MedusaError.Types.UNEXPECTED_STATE,
        AUTO_RENEW_BIND_FAILURE_COPY.failed
      )
    }

    response = {
      phase: "approval_pending",
      subscription_id: result.subscription_id,
      setup_token_id: result.setup_token_id,
      approve_url: result.approve_url,
    }
  } else {
    if (typeof body.setup_token_id !== "string" || !body.setup_token_id) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "setup_token_id is required to complete the binding."
      )
    }

    const { result, errors } = await completeAutoRenewBindingWorkflow(
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

    if (
      !result?.payment_method_reference ||
      result.payment_mode !== "auto"
    ) {
      throw new MedusaError(
        MedusaError.Types.UNEXPECTED_STATE,
        AUTO_RENEW_BIND_FAILURE_COPY.failed
      )
    }

    response = {
      phase: "enabled",
      subscription_id: result.subscription_id,
      payment_provider_id: result.payment_provider_id,
      payment_method_reference: result.payment_method_reference,
      payment_mode: "auto",
    }
  }

  res.status(200).json({ bind: response })
}

/**
 * One disclosure path for both phases. The plugin's `PaymentMethodsError` keeps
 * its contract status (`already_bound` → 409, …) through
 * `coreTypeForPaymentMethodsStatus`, with two cases that need more than the
 * status and neither needing a name match any more:
 *
 * - `binding_pending_approval` (422) gets **reorder's** copy — the plugin's
 *   message is the operator line, the buyer-facing wording is ours;
 * - a 500 (`unexpected_state`, the credential-environment mismatch) keeps the
 *   plugin's message verbatim — that text names both environments, and it is
 *   what tells an operator what to fix.
 */
function throwClassified(
  req: AuthenticatedMedusaRequest<PostStoreAutoRenewBindSchemaType>,
  errors: unknown
) {
  const failure = classifyStepFailure({
    errors,
    refusals: AUTO_RENEW_BIND_CUSTOMER_REFUSALS,
    copy: AUTO_RENEW_BIND_FAILURE_COPY,
    preserveQuotedStatus: true,
  })

  if (failure.quoted) {
    throw new MedusaError(failure.type, failure.message)
  }

  const pluginFailure = findSerializedPaymentMethodsFailure(errors)

  if (pluginFailure) {
    if (pluginFailure.type === "binding_pending_approval") {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        BINDING_PENDING_APPROVAL_COPY
      )
    }

    const coreType = coreTypeForPaymentMethodsStatus(pluginFailure.status)

    if (coreType) {
      throw new MedusaError(coreType, pluginFailure.message)
    }
  }

  logUnquotedStepFailure(
    req.scope.resolve<StepFailureLogger>(ContainerRegistrationKeys.LOGGER),
    "auto-renew-bind",
    failure
  )

  throw new MedusaError(failure.type, failure.message)
}
