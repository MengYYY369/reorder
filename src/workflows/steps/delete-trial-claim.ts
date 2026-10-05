import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { MedusaError } from "@medusajs/framework/utils"
import { TRIAL_CLAIM_MODULE } from "../../modules/trial-claim"

export type DeleteTrialClaimStepOutput = {
  trial_claim_id: string
}

/**
 * Hard-deletes one trial-claim ledger row (admin action, ticket 15). There is
 * no status to gate on: the ledger row is a claim record, and removing it
 * frees the (customer, product) slot the eligibility rule counts.
 *
 * No compensation on purpose: the row is gone.
 */
export const deleteTrialClaimStep = createStep(
  "delete-trial-claim",
  async function (input: { id: string }, { container }) {
    const trialClaimModule = container.resolve(TRIAL_CLAIM_MODULE) as {
      retrieveTrialClaim: (
        id: string,
        config?: Record<string, unknown>
      ) => Promise<{ id: string }>
      deleteTrialClaims: (ids: string | string[]) => Promise<unknown>
    }

    await trialClaimModule.retrieveTrialClaim(input.id).catch(() => {
      throw new MedusaError(
        MedusaError.Types.NOT_FOUND,
        `Trial claim '${input.id}' was not found`
      )
    })

    await trialClaimModule.deleteTrialClaims(input.id)

    return new StepResponse({ trial_claim_id: input.id })
  }
)
