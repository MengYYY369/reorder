import {
  createWorkflow,
  transform,
  WorkflowResponse,
} from "@medusajs/framework/workflows-sdk"
import {
  clearPendingAutoRenewBindingStep,
  completeAutoRenewBindingStep,
  resolveAutoRenewBindContextStep,
  startAutoRenewBindingStep,
  type AutoRenewBindContext,
  type CompleteAutoRenewBindingStepOutput,
  type StartAutoRenewBindingStepOutput,
} from "./steps/auto-renew-binding"

/**
 * Enabling auto-renewal through the plugin's bind flow (0.9.3, plan ticket
 * 01③, user ruling Q8/Q13): the same two-phase plugin binding the trial bind
 * uses, scoped to the subscription's own product, and the mode flips only
 * after the binding completes — through the toggle's own guards.
 */

export type StartAutoRenewBindingWorkflowInput = {
  subscription_id: string
  customer_id: string
  /** Where PayPal sends the buyer back on approval. Caller-owned route. */
  return_url: string
  /** Where PayPal sends the buyer back on cancel. Caller-owned route. */
  cancel_url: string
}

export type StartAutoRenewBindingWorkflowOutput = {
  subscription_id: string
  setup_token_id: string
  approve_url: string
}

export const startAutoRenewBindingWorkflow = createWorkflow(
  "start-auto-renew-binding",
  function (input: StartAutoRenewBindingWorkflowInput) {
    const context: AutoRenewBindContext = resolveAutoRenewBindContextStep({
      action: "start",
      subscription_id: input.subscription_id,
      customer_id: input.customer_id,
    })

    const approval: StartAutoRenewBindingStepOutput =
      startAutoRenewBindingStep({
        context,
        return_url: input.return_url,
        cancel_url: input.cancel_url,
      })

    return new WorkflowResponse<StartAutoRenewBindingWorkflowOutput>({
      subscription_id: context.subscription_id,
      setup_token_id: approval.setup_token_id,
      approve_url: approval.approve_url,
    })
  }
)

export type CompleteAutoRenewBindingWorkflowInput = {
  subscription_id: string
  customer_id: string
  /** The plugin's approval-session handle the customer returned with. */
  setup_token_id: string
}

export type CompleteAutoRenewBindingWorkflowOutput = {
  subscription_id: string
  payment_provider_id: string
  payment_method_reference: string
  payment_mode: "auto"
}

export const completeAutoRenewBindingWorkflow = createWorkflow(
  "complete-auto-renew-binding",
  function (input: CompleteAutoRenewBindingWorkflowInput) {
    const context: AutoRenewBindContext = resolveAutoRenewBindContextStep({
      action: "complete",
      subscription_id: input.subscription_id,
      customer_id: input.customer_id,
      setup_token_id: input.setup_token_id,
    })

    const approval: CompleteAutoRenewBindingStepOutput =
      completeAutoRenewBindingStep({
        context,
        setup_token_id: input.setup_token_id,
      })

    // Runs last: a failure anywhere above leaves the retryable pending
    // binding intact, exactly like the trial bind's tombstone ordering.
    clearPendingAutoRenewBindingStep({
      subscription_id: context.subscription_id,
    })

    const result = transform(
      { context, approval },
      function ({ context, approval }) {
        return {
          subscription_id: context.subscription_id,
          payment_provider_id: approval.payment_provider_id,
          payment_method_reference: approval.payment_method_reference,
          payment_mode: approval.payment_mode,
        }
      }
    )

    return new WorkflowResponse<CompleteAutoRenewBindingWorkflowOutput>(result)
  }
)
