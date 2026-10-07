import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { SUBSCRIPTION_MODULE } from "../../modules/subscription"
import SubscriptionModuleService from "../../modules/subscription/service"
import { SubscriptionStatus } from "../../modules/subscription/types"
import { subscriptionErrors } from "../../modules/subscription/utils/errors"
import { asSubscriptionUpdateInput } from "../../modules/subscription/utils/subscription-write-input"
import {
  asSubscriptionWorkflowRecord,
  SubscriptionWorkflowRecord,
  SubscriptionWorkflowStepResult,
} from "./pause-subscription"
import { cancelNativeSubscriptionRow } from "../../modules/subscription/utils/provider-capabilities"

export type CancelSubscriptionStepInput = {
  id: string
  reason?: string
  effective_at?: "immediately" | "end_of_cycle"
  triggered_by?: string | null
}

export const cancelSubscriptionStep = createStep(
  "cancel-subscription",
  async function (input: CancelSubscriptionStepInput, { container }) {
    const subscriptionModuleService: SubscriptionModuleService =
      container.resolve(SUBSCRIPTION_MODULE)

    const subscription = await subscriptionModuleService.retrieveSubscription(
      input.id
    )

    if (
      subscription.status !== SubscriptionStatus.ACTIVE &&
      subscription.status !== SubscriptionStatus.PAUSED &&
      subscription.status !== SubscriptionStatus.PAST_DUE
    ) {
      throw subscriptionErrors.invalidState(
        input.id,
        "be cancelled",
        subscription.status
      )
    }

    const cancelledAt = new Date()
    const cancelEffectiveAt =
      input.effective_at === "end_of_cycle" && subscription.next_renewal_at
        ? subscription.next_renewal_at
        : cancelledAt

    // Native mirror rows are billed by the provider itself: the local status
    // change alone would leave the provider agreement charging the payer. The
    // helper never throws - a failed provider cancel is recorded in the metadata
    // below and the local cancellation still goes through (2026-10-02 plan,
    // T04; the provider's own admin page remains the manual retry path).
    const providerCancel = await cancelNativeSubscriptionRow(
      container,
      subscription
    )

    if (providerCancel.status === "failed") {
      container
        .resolve<{ warn(message: string): void }>(
          ContainerRegistrationKeys.LOGGER
        )
        .warn(
          `cancel-subscription: provider cancel failed for ${String(
            subscription.reference
          )}: ${providerCancel.error}`
        )
    }

    const updated = await subscriptionModuleService.updateSubscriptions({
      id: input.id,
      status: SubscriptionStatus.CANCELLED,
      cancelled_at: cancelledAt,
      cancel_effective_at: cancelEffectiveAt,
      next_renewal_at: null,
      metadata: {
        ...(subscription.metadata ?? {}),
        cancel_context: {
          reason: input.reason ?? null,
          effective_at: input.effective_at ?? "immediately",
          cancelled_at: cancelledAt.toISOString(),
          triggered_by: input.triggered_by ?? null,
          provider_cancel: providerCancel,
        },
      },
    })

    return new StepResponse<SubscriptionWorkflowStepResult, SubscriptionWorkflowRecord>(
      {
        current: asSubscriptionWorkflowRecord(updated),
        previous: asSubscriptionWorkflowRecord(subscription),
      },
      asSubscriptionWorkflowRecord(subscription)
    )
  },
  async function (subscription: SubscriptionWorkflowRecord, { container }) {
    if (!subscription) {
      return
    }

    const subscriptionModuleService: SubscriptionModuleService =
      container.resolve(SUBSCRIPTION_MODULE)

    await subscriptionModuleService.updateSubscriptions(
      asSubscriptionUpdateInput(subscription)
    )
  }
)
