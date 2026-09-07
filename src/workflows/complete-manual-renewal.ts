import { createWorkflow, transform, WorkflowResponse } from "@medusajs/framework/workflows-sdk"
import { acquireLockStep, releaseLockStep } from "@medusajs/medusa/core-flows"
import {
  completeManualRenewalStep,
  type CompleteManualRenewalStepOutput,
} from "./steps/complete-manual-renewal"
import { createSubscriptionLogEventStep } from "./steps/create-subscription-log-event"
import { normalizeActivityLogEvent } from "../modules/activity-log/utils/normalize-log-event"
import {
  ActivityLogActorType,
  ActivityLogEventType,
} from "../modules/activity-log/types"

export type CompleteManualRenewalWorkflowInput = {
  renewal_order_id: string
}

/**
 * Finalizes a paid manual renewal: marks the cycle succeeded, advances the
 * cadence (pending frequency changes apply), records the renewal.succeeded
 * activity log (which also emits the bus event, see ticket mc04), and
 * pre-creates the next cycle row. Idempotent on cycle SUCCEEDED.
 *
 * Invoke BY NAME through the workflow engine (see create-manual-renewal.ts).
 */
export const completeManualRenewalWorkflow = createWorkflow(
  "complete-manual-renewal",
  function (input: CompleteManualRenewalWorkflowInput) {
    const lockInput = transform({ input }, ({ input }) => ({
      key: `complete-manual-renewal:${input.renewal_order_id}`,
      timeout: 30,
      ttl: 120,
    }))

    acquireLockStep(lockInput)

    const result = completeManualRenewalStep({
      renewal_order_id: input.renewal_order_id,
    })

    const logInput = transform(
      { result, input },
      ({ result, input }) => {
        return {
          log_event: normalizeActivityLogEvent({
            subscription_id: result.subscription_id,
            customer_id: null,
            event_type: ActivityLogEventType.RENEWAL_SUCCEEDED,
            actor_type: ActivityLogActorType.CUSTOMER,
            actor_id: null,
            display: {
              subscription_reference: `RENEWAL-${input.renewal_order_id}`,
            },
            previous_state: null,
            new_state: {
              status: "active",
              next_renewal_at: result.next_renewal_at,
              renewal_order_id: input.renewal_order_id,
              trigger: "manual",
            },
            metadata: {
              renewal_order_id: input.renewal_order_id,
              renewal_cycle_id: result.renewal_cycle_id,
              source: "store",
              trigger_type: "manual",
            },
            dedupe: {
              scope: "order",
              target_id: input.renewal_order_id,
              qualifier: result.renewal_cycle_id,
            },
          }),
        }
      }
    )

    createSubscriptionLogEventStep(logInput).config({
      name: "create-manual-renewal-succeeded-log-event",
    })

    releaseLockStep(
      transform({ input }, ({ input }) => ({
        key: `complete-manual-renewal:${input.renewal_order_id}`,
      }))
    )

    return new WorkflowResponse<CompleteManualRenewalStepOutput>(result)
  }
)

export default completeManualRenewalWorkflow
