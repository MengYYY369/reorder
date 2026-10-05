import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { SUBSCRIPTION_MODULE } from "../../modules/subscription"
import { SubscriptionStatus } from "../../modules/subscription/types"
import { subscriptionErrors } from "../../modules/subscription/utils/errors"
import {
  hardDeleteSubscriptionChain,
  type SubscriptionChainDeletionCounts,
} from "../../modules/subscription/utils/subscription-chain-delete"

/**
 * Reachability gate for the destructive path: only a cancelled subscription
 * may be hard-deleted. Active, paused, and past-due rows still carry billing
 * or scheduler obligations.
 */
export const validateSubscriptionDeletableStep = createStep(
  "validate-subscription-deletable",
  async function (input: { id: string }, { container }) {
    const subscriptionModule = container.resolve(SUBSCRIPTION_MODULE) as {
      retrieveSubscription: (
        id: string,
        config?: Record<string, unknown>
      ) => Promise<{ id: string; status: string }>
    }

    const subscription = await subscriptionModule
      .retrieveSubscription(input.id, { select: ["id", "status"] })
      .catch(() => {
        throw subscriptionErrors.notFound("Subscription", input.id)
      })

    if (subscription.status !== SubscriptionStatus.CANCELLED) {
      throw subscriptionErrors.invalidState(
        subscription.id,
        "be deleted",
        subscription.status
      )
    }

    return new StepResponse(subscription.id, null)
  }
)

export type DeleteSubscriptionStepOutput = SubscriptionChainDeletionCounts

/**
 * Runs the shared full-chain hard delete
 * (`src/modules/subscription/utils/subscription-chain-delete.ts`) so the
 * admin action and the `customer.deleted` cascade remove exactly the same
 * rows.
 *
 * No compensation on purpose: the rows are gone.
 */
export const deleteSubscriptionChainStep = createStep(
  "delete-subscription-chain",
  async function (input: { id: string }, { container }) {
    const counts = await hardDeleteSubscriptionChain(container, {
      subscription_id: input.id,
    })

    return new StepResponse<DeleteSubscriptionStepOutput>(counts)
  }
)
