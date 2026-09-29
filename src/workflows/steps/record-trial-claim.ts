import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { TRIAL_CLAIM_MODULE } from "../../modules/trial-claim"
import TrialClaimModuleService from "../../modules/trial-claim/service"
import { TrialClaimSource } from "../../modules/trial-claim/types"

export type RecordTrialClaimStepInput = {
  customer_id: string
  product_id: string
  variant_id: string
  source: TrialClaimSource
  /** The subscription the trial door just created; never `pending`. */
  subscription_id: string
  /** ISO string or null; the ledger keeps the trial's end moment. */
  trial_ends_at: string | Date | null
  /**
   * The ledger records trials only. Every door passes its own `is_trial`
   * flag here; the step is a no-op (and its compensation a no-op) when the
   * created subscription is not one, so a door cannot record a claim for a
   * paid or free-cycle grant by accident.
   */
  is_trial: boolean
}

export type RecordTrialClaimStepOutput = {
  recorded: boolean
  claim_id: string | null
}

type RecordTrialClaimStepCompensation = { claim_id: string } | null

/**
 * The shared ledger step every trial door calls (Phase 12, plan Task 20).
 * Doors that can create a trial subscription today:
 * - the redemption workflow (`redeem-redemption-code`, a trial-enabled code),
 * - the self-service claim workflow (Phase 13, `POST /store/customers/me/trials`).
 *
 * There is no third door: no admin subscription-create route exists anywhere
 * (`src/api/admin/subscriptions` ships only per-subscription actions — cancel,
 * pause, resume, schedule-plan-change, update-shipping-address,
 * payment-method — no POST create), so `TrialClaimSource.ADMIN` has no writer
 * yet. The eligibility rule is enforced against two doors until that changes.
 *
 * Uniqueness is anchored by the `trial_claim_customer_product_unique` index
 * inside the service's `record`, so two doors racing the same
 * customer/product cannot both win; the loser surfaces as the service's
 * `TrialClaimIneligibleError`. The compensating delete keeps a downstream
 * failure (the initial renewal cycle, entity links) from leaving a ledger row
 * for a subscription that was rolled back.
 */
export const recordTrialClaimStep = createStep(
  "record-trial-claim",
  async function (
    input: RecordTrialClaimStepInput,
    { container }
  ) {
    if (!input.is_trial) {
      return new StepResponse<
        RecordTrialClaimStepOutput,
        RecordTrialClaimStepCompensation
      >({ recorded: false, claim_id: null }, null)
    }

    const trialClaimModuleService =
      container.resolve<TrialClaimModuleService>(TRIAL_CLAIM_MODULE)
    const claim = await trialClaimModuleService.record({
      customer_id: input.customer_id,
      product_id: input.product_id,
      variant_id: input.variant_id,
      source: input.source,
      subscription_id: input.subscription_id,
      trial_ends_at: input.trial_ends_at ? new Date(input.trial_ends_at) : null,
    })

    return new StepResponse<
      RecordTrialClaimStepOutput,
      RecordTrialClaimStepCompensation
    >(
      { recorded: true, claim_id: claim.id },
      { claim_id: claim.id }
    )
  },
  async function (compensation, { container }) {
    if (!compensation) {
      return
    }
    const trialClaimModuleService =
      container.resolve<TrialClaimModuleService>(TRIAL_CLAIM_MODULE)
    // A hard delete: the row was written moments ago by this same step, and
    // the unique index must free the pair for a retry of the door.
    await trialClaimModuleService.deleteTrialClaims(compensation.claim_id)
  }
)
