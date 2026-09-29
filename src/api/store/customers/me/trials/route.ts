import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http"
import { ContainerRegistrationKeys, MedusaError } from "@medusajs/framework/utils"
import type { PostStoreTrialClaimSchemaType } from "./validators"
import { createTrialSubscriptionWorkflow } from "../../../../../workflows/create-trial-subscription"
import {
  resolveTrialClaimContextStep,
} from "../../../../../workflows/steps/create-trial-subscription"
import {
  classifyStepFailure,
  logUnquotedStepFailure,
  type StepFailureCopy,
  type StepFailureLogger,
} from "../../../../../workflows/utils/store-step-failure"

/**
 * The refusals the claim workflow authors for the caller, each with its exact
 * text. Same ownership rule as `REDEEM_CUSTOMER_REFUSALS`: the route that
 * discloses a failure must not be the place that decides which step may
 * speak. The eligibility refusal is `TrialClaimModuleService.assertEligible`'s
 * (the fixed text the ledger's 23505 mapping rethrows for a concurrent race);
 * the rest are the claim context step's typed refusals (Q19: the ineligible
 * claim creates nothing and there is no degradation branch).
 */
const CONTEXT_STEP = resolveTrialClaimContextStep.__step__

export const TRIAL_CLAIM_CUSTOMER_REFUSALS = [
  {
    step: CONTEXT_STEP,
    type: MedusaError.Types.INVALID_DATA,
    copy: /^Trial has already been claimed for customer \S+ and product \S+$/,
  },
  {
    step: CONTEXT_STEP,
    type: MedusaError.Types.INVALID_DATA,
    copy: /^This product does not offer a trial\.$/,
  },
  {
    step: CONTEXT_STEP,
    type: MedusaError.Types.INVALID_DATA,
    copy:
      /^This trial requires binding a payment method\. Send binding: "vault" to claim it\.$/,
  },
  {
    step: CONTEXT_STEP,
    type: MedusaError.Types.INVALID_DATA,
    copy: /^This trial is not available in the selected region '\S+'\.$/,
  },
  {
    step: CONTEXT_STEP,
    type: MedusaError.Types.INVALID_DATA,
    copy:
      /^This product's subscription has no configured renewal frequency\.$/,
  },
  {
    step: CONTEXT_STEP,
    type: MedusaError.Types.NOT_FOUND,
    copy: /^Variant '\S+' was not found\.$/,
  },
  {
    step: CONTEXT_STEP,
    type: MedusaError.Types.INVALID_DATA,
    copy: /^Region '\S+' was not found\.$/,
  },
] as const

const TRIAL_CLAIM_FAILURE_COPY: StepFailureCopy = {
  notFound: "trial offer not found",
  refused: "trial claim was refused",
  failed: "trial claim failed",
}

/**
 * Claims a trial for the authenticated customer: a payment-free subscription
 * whose renewal order source is a completed template cart, with the claim
 * written to the `trial_claim` ledger. The customer is taken from the auth
 * context only — never from the body.
 */
export const POST = async (
  req: AuthenticatedMedusaRequest<PostStoreTrialClaimSchemaType>,
  res: MedusaResponse
) => {
  const customerId = req.auth_context?.actor_id

  if (!customerId) {
    throw new MedusaError(
      MedusaError.Types.UNAUTHORIZED,
      "Customer authentication is required."
    )
  }

  const { result, errors } = await createTrialSubscriptionWorkflow(
    req.scope
  ).run({
    input: {
      customer_id: customerId,
      variant_id: req.validatedBody.variant_id,
      region_id: req.validatedBody.region_id,
      binding: req.validatedBody.binding ?? "none",
    },
    throwOnError: false,
  })

  if (errors?.length) {
    const failure = classifyStepFailure({
      errors,
      refusals: TRIAL_CLAIM_CUSTOMER_REFUSALS,
      copy: TRIAL_CLAIM_FAILURE_COPY,
      preserveQuotedStatus: true,
    })

    if (!failure.quoted) {
      logUnquotedStepFailure(
        req.scope.resolve<StepFailureLogger>(ContainerRegistrationKeys.LOGGER),
        "trial-claim",
        failure
      )
    }

    throw new MedusaError(failure.type, failure.message)
  }

  if (!result?.subscription_id) {
    throw new MedusaError(
      MedusaError.Types.UNEXPECTED_STATE,
      TRIAL_CLAIM_FAILURE_COPY.failed
    )
  }

  res.status(201).json({
    trial: {
      subscription_id: result.subscription_id,
      subscription_reference: result.subscription_reference,
      trial_ends_at: result.trial_ends_at,
      cart_id: result.cart_id,
      claim_recorded: result.claim_recorded,
    },
  })
}
