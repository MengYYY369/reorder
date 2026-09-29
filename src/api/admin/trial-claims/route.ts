import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http"
import { TRIAL_CLAIM_MODULE } from "../../../modules/trial-claim"
import TrialClaimModuleService from "../../../modules/trial-claim/service"
import {
  TrialClaimBindingMethod,
  TrialClaimSource,
} from "../../../modules/trial-claim/types"
import type { GetAdminTrialClaimsSchemaType } from "./validators"

/**
 * Read-only Admin visibility for the trial-claim ledger (spec Q15). The
 * eligibility RULE stays in the module service and the workflows; this route
 * only filters and formats.
 */
function toTrialClaimDto(claim: {
  id: string
  customer_id: string
  product_id: string
  variant_id: string
  claimed_at: Date | string
  trial_ends_at: Date | string | null
  source: TrialClaimSource
  subscription_id: string
  binding_method: TrialClaimBindingMethod
}) {
  return {
    id: claim.id,
    customer_id: claim.customer_id,
    product_id: claim.product_id,
    variant_id: claim.variant_id,
    claimed_at: new Date(claim.claimed_at).toISOString(),
    trial_ends_at: claim.trial_ends_at
      ? new Date(claim.trial_ends_at).toISOString()
      : null,
    source: claim.source,
    subscription_id: claim.subscription_id,
    binding_method: claim.binding_method,
  }
}

export const GET = async (
  req: AuthenticatedMedusaRequest<unknown, GetAdminTrialClaimsSchemaType>,
  res: MedusaResponse
) => {
  const trialClaimModuleService = req.scope.resolve<TrialClaimModuleService>(
    TRIAL_CLAIM_MODULE
  )

  const filters = {
    ...(req.validatedQuery.customer_id ? { customer_id: req.validatedQuery.customer_id } : {}),
    ...(req.validatedQuery.product_id ? { product_id: req.validatedQuery.product_id } : {}),
    ...(req.validatedQuery.source ? { source: req.validatedQuery.source } : {}),
  }

  const [claims, count] = await trialClaimModuleService.listAndCountTrialClaims(
    filters,
    {
      order: { claimed_at: req.validatedQuery.direction === "asc" ? "ASC" : "DESC" },
      take: req.validatedQuery.limit,
      skip: req.validatedQuery.offset,
    }
  )

  res.status(200).json({
    trial_claims: claims.map(toTrialClaimDto),
    count,
    limit: req.validatedQuery.limit,
    offset: req.validatedQuery.offset,
  })
}
