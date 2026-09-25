import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http"
import { ContainerRegistrationKeys, MedusaError } from "@medusajs/framework/utils"
import type { PostStoreRedeemCodeSchemaType } from "./validators"
import {
  listStoreCustomerRedemptions,
  requireStoreCustomer,
  resolveQueryConfigOffsetLimit,
} from "./utils"
import {
  REDEEM_CUSTOMER_REFUSALS,
  redeemRedemptionCodeWorkflow,
} from "../../../../../workflows/redeem-redemption-code"
import {
  classifyStepFailure,
  logUnquotedStepFailure,
  type StepFailureCopy,
  type StepFailureLogger,
} from "../../../../../workflows/utils/store-step-failure"

/**
 * The response texts for a failure that is not one of the workflow's declared
 * refusals. Fixed strings, so no internal message, table or column name can
 * reach the customer through this route either.
 */
const REDEMPTION_FAILURE_COPY: StepFailureCopy = {
  notFound: "redemption target not found",
  refused: "redemption was refused",
  failed: "redemption failed",
}

export const GET = async (
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) => {
  const customerId = await requireStoreCustomer(req)
  const { offset, limit } = resolveQueryConfigOffsetLimit(req)

  const response = await listStoreCustomerRedemptions(
    req.scope,
    customerId,
    offset,
    limit
  )

  res.status(200).json(response)
}

export const POST = async (
  req: AuthenticatedMedusaRequest<PostStoreRedeemCodeSchemaType>,
  res: MedusaResponse
) => {
  const customerId = await requireStoreCustomer(req)

  // `throwOnError: false`, because the engine rethrows `errors[0].error`
  // verbatim otherwise (`workflow-orchestrator.js:130-133`) and that value is a
  // *serialized* failure: a driver fault mapped by the DAL survives with `code`,
  // `table` and `detail`, and `formatException` turns them into a 422 that
  // quotes them at the customer.
  const { result, errors } = await redeemRedemptionCodeWorkflow(req.scope).run({
    input: {
      code: req.validatedBody.code,
      customer_id: customerId,
      subscription_id: req.validatedBody.subscription_id ?? null,
    },
    throwOnError: false,
  })

  if (errors?.length) {
    const failure = classifyStepFailure({
      errors,
      refusals: REDEEM_CUSTOMER_REFUSALS,
      copy: REDEMPTION_FAILURE_COPY,
      preserveQuotedStatus: true,
    })

    if (!failure.quoted) {
      logUnquotedStepFailure(
        req.scope.resolve<StepFailureLogger>(ContainerRegistrationKeys.LOGGER),
        "redemption",
        failure
      )
    }

    throw new MedusaError(failure.type, failure.message)
  }

  const redemption = (result ?? {}) as {
    subscription_id?: string
    subscription_reference?: string
    record_id?: string
    outcome?: string
    is_trial?: boolean
    trial_ends_at?: string | null
    free_cycles_remaining?: number
    dunning_recovered?: boolean
  }

  if (!redemption.subscription_id) {
    // Same shape as the bridge routes: a workflow that reports neither an error
    // nor a usable result must not answer 200 with an empty body.
    throw new MedusaError(
      MedusaError.Types.UNEXPECTED_STATE,
      REDEMPTION_FAILURE_COPY.failed
    )
  }

  res.status(200).json({
    subscription_id: redemption.subscription_id,
    subscription_reference: redemption.subscription_reference ?? null,
    redemption_record_id: redemption.record_id ?? null,
    outcome: redemption.outcome,
    is_trial: redemption.is_trial ?? false,
    trial_ends_at: redemption.trial_ends_at ?? null,
    free_cycles_remaining: redemption.free_cycles_remaining,
    dunning_recovered: redemption.dunning_recovered,
  })
}
