import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { PLAN_OFFER_MODULE } from "../../modules/plan-offer"
import PlanOfferModuleService from "../../modules/plan-offer/service"
import { planOfferErrors } from "../../modules/plan-offer/utils/errors"
import { getPlanOfferRecordById } from "./shared-plan-offer"

export type DeletePlanOfferStepOutput = {
  plan_offer_id: string
}

/**
 * Hard-deletes one plan offer. Only a disabled offer may be deleted: an
 * enabled one is live pricing surface. Nothing references a plan offer by
 * foreign key (redemption batches reference the variant), so the row goes
 * alone.
 *
 * No compensation on purpose: the row is gone.
 */
export const deletePlanOfferStep = createStep(
  "delete-plan-offer",
  async function (input: { id: string }, { container }) {
    const existing = await getPlanOfferRecordById(container, input.id)

    if (!existing) {
      throw planOfferErrors.notFound("PlanOffer", input.id)
    }
    if (existing.is_enabled) {
      throw planOfferErrors.conflict(
        `PlanOffer '${input.id}' is enabled; only disabled plan offers can be deleted`
      )
    }

    const planOfferModuleService = container.resolve<PlanOfferModuleService>(
      PLAN_OFFER_MODULE
    )
    await planOfferModuleService.deletePlanOffers(input.id)

    const output: DeletePlanOfferStepOutput = { plan_offer_id: input.id }

    return new StepResponse(output)
  }
)
