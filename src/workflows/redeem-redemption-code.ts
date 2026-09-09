import {
  createWorkflow,
  transform,
  when,
  WorkflowResponse,
} from "@medusajs/framework/workflows-sdk"
import { acquireLockStep, releaseLockStep } from "@medusajs/medusa/core-flows"
import {
  redeemCreateSubscriptionStep,
  redeemExtendSubscriptionStep,
  linkRedemptionSubscriptionEntitiesStep,
  resolveRedemptionCodeStep,
  type RedeemCreateStepOutput,
  type RedeemExtendStepOutput,
  type RedemptionResolution,
} from "./steps/redeem-redemption-code"
import { ActivityLogEventType, ActivityLogActorType } from "../modules/activity-log/types"
import { normalizeActivityLogEvent } from "../modules/activity-log/utils/normalize-log-event"
import { createSubscriptionLogEventStep } from "./steps/create-subscription-log-event"
import { ensureNextRenewalCycleStep } from "./steps/ensure-next-renewal-cycle"

type RedeemOutput = RedeemCreateStepOutput & {
  outcome: "subscription_created" | "subscription_extended"
  free_cycles_remaining?: number
  dunning_recovered?: boolean
}

/**
 * Redeems a code for a logged-in customer. The code lock serializes
 * concurrent redemptions of the same code so the limit and per-customer
 * checks hold. Auto-resolving: extends an existing ACTIVE/PAST_DUE
 * subscription of the batch variant, otherwise creates a payment-free
 * subscription that terminates at the end of its free period.
 */
export const redeemRedemptionCodeWorkflow = createWorkflow(
  "redeem-redemption-code",
  function (input: {
    code: string
    customer_id: string
    subscription_id?: string | null
  }) {
    const lockKey = transform({ input }, function ({ input }) {
      return `redemption-code:${input.code.toUpperCase()}`
    })

    acquireLockStep({
      key: lockKey,
      timeout: 10,
      ttl: 120,
    })

    const resolution: RedemptionResolution = resolveRedemptionCodeStep({
      code: input.code,
      customer_id: input.customer_id,
      subscription_id: input.subscription_id ?? null,
      mode: "redeem",
    })

    const createdOutput = when(
      { resolution },
      ({ resolution }) => resolution.kind === "create"
    ).then(() => {
      const created: RedeemCreateStepOutput = redeemCreateSubscriptionStep({
        resolution,
      })

      linkRedemptionSubscriptionEntitiesStep({
        subscription_id: created.subscription_id,
        customer_id: input.customer_id,
        product_id: resolution.grant.product_id,
        variant_id: resolution.grant.variant_id,
      })

      const ensureInput = transform({ created }, ({ created }) => ({
        subscription_id: created.subscription_id,
      }))
      ensureNextRenewalCycleStep(ensureInput).config({
        name: "create-redemption-initial-renewal-cycle",
      })

      return created
    })

    const extendedOutput = when(
      { resolution },
      ({ resolution }) => resolution.kind === "extend"
    ).then(() => {
      return redeemExtendSubscriptionStep({ resolution })
    })

    const result = transform(
      { createdOutput, extendedOutput, resolution },
      ({ createdOutput, extendedOutput, resolution }) => {
        if (resolution.kind === "create") {
          return {
            ...createdOutput,
            outcome: "subscription_created" as const,
          }
        }
        return {
          subscription_id: extendedOutput!.subscription_id,
          subscription_reference: extendedOutput!.subscription_reference,
          record_id: extendedOutput!.record_id,
          outcome: "subscription_extended" as const,
          free_cycles_remaining: extendedOutput!.free_cycles_remaining,
          dunning_recovered: extendedOutput!.dunning_recovered,
        }
      }
    )

    const logInput = transform(
      { resolution, result, input },
      ({ resolution, result, input }) => {
        return {
          log_event: normalizeActivityLogEvent({
            subscription_id: result.subscription_id,
            customer_id: input.customer_id,
            event_type: ActivityLogEventType.REDEMPTION_REDEEMED,
            actor_type: ActivityLogActorType.CUSTOMER,
            actor_id: input.customer_id,
            display: {
              subscription_reference: result.subscription_reference,
              product_title: resolution.grant.product_title,
              variant_title: resolution.grant.variant_title,
            },
            previous_state: null,
            new_state: {
              outcome: result.outcome,
              free_cycles: resolution.grant.free_cycles,
              code: resolution.code.code,
              batch_id: resolution.batch.id,
              dunning_recovered: result.dunning_recovered ?? false,
            },
            metadata: {
              redemption_code_id: resolution.code.id,
              redemption_batch_id: resolution.batch.id,
              source: "redemption",
            },
            dedupe: {
              scope: "redemption_record",
              target_id: result.record_id,
            },
          }),
        }
      }
    )

    createSubscriptionLogEventStep(logInput).config({
      name: "create-redemption-redeemed-log-event",
    })

    releaseLockStep({
      key: lockKey,
    })

    return new WorkflowResponse(result)
  }
)

export default redeemRedemptionCodeWorkflow
