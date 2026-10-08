import {
  createWorkflow,
  transform,
  WorkflowResponse,
} from "@medusajs/framework/workflows-sdk"
import { ensureNextRenewalCycleStep } from "./steps/ensure-next-renewal-cycle"
import {
  bindTrialPaymentMethodStep,
  completeTrialVaultApprovalStep,
  markTrialClaimVaultBoundStep,
  resolveReusableTrialMethodStep,
  resolveTrialBindContextStep,
  startTrialVaultApprovalStep,
  type BindTrialPaymentMethodStepOutput,
  type CompleteTrialVaultApprovalStepOutput,
  type MarkTrialClaimVaultBoundStepOutput,
  type ResolveReusableTrialMethodStepOutput,
  type StartTrialVaultApprovalStepOutput,
  type TrialBindContext,
} from "./steps/bind-trial-payment-method"

/**
 * Phase 14 (`vault` binding, plan Task 22): a claimed trial gains extra days
 * when the customer binds a payment method — a provider setup token approved in
 * a redirect, exchanged for a vault id, never charged. The provider half is the
 * provider package's; the capability is consumed by duck-typing
 * (`workflows/utils/payment-method-binding.ts`), and a provider that predates it
 * makes both workflows refuse before anything is created.
 *
 * The flow is two-phase because the customer leaves for PayPal and returns:
 * - `startTrialPaymentMethodBindingWorkflow` — phase (a): store the pending
 *   binding, return the `approve_url`.
 * - `bindTrialPaymentMethodWorkflow` — phase (b): exchange the returned setup
 *   token, write the bound state, and move the pending renewal cycle through
 *   `ensureNextRenewalCycleStep` (a partial unique index makes a second
 *   `SCHEDULED` cycle impossible; the step adopts and re-points the open one
 *   — see the plan's Step 4 for the stale-cycle failure mode this avoids).
 */

export type StartTrialPaymentMethodBindingWorkflowInput = {
  subscription_id: string
  customer_id: string
  /** Where PayPal sends the buyer back on approval. Caller-owned route. */
  return_url: string
  /** Where PayPal sends the buyer back on cancel. Caller-owned route. */
  cancel_url: string
}

export type StartTrialPaymentMethodBindingWorkflowOutput = {
  subscription_id: string
  setup_token_id: string
  approve_url: string
  /** The trial's current end date — not yet extended. */
  trial_ends_at: string
}

export const startTrialPaymentMethodBindingWorkflow = createWorkflow(
  "start-trial-payment-method-binding",
  function (input: StartTrialPaymentMethodBindingWorkflowInput) {
    const context: TrialBindContext = resolveTrialBindContextStep({
      action: "start",
      subscription_id: input.subscription_id,
      customer_id: input.customer_id,
    })

    const approval: StartTrialVaultApprovalStepOutput =
      startTrialVaultApprovalStep({
        context,
        return_url: input.return_url,
        cancel_url: input.cancel_url,
      })

    return new WorkflowResponse<StartTrialPaymentMethodBindingWorkflowOutput>({
      subscription_id: context.subscription_id,
      setup_token_id: approval.setup_token_id,
      approve_url: approval.approve_url,
      trial_ends_at: context.trial_ends_at,
    })
  }
)

export type BindTrialPaymentMethodWorkflowInput = {
  subscription_id: string
  customer_id: string
  /** The setup token id the customer returned from PayPal with. */
  setup_token_id: string
}

export type BindTrialPaymentMethodWorkflowOutput = {
  subscription_id: string
  payment_provider_id: string
  payment_method_reference: string
  /** The extended end date, anchored on the trial's own `started_at`. */
  trial_ends_at: string
  /** Kept equal to the extended `trial_ends_at`. */
  next_renewal_at: string
  bonus_days_applied: number
  ledger_updated: boolean
}

export const bindTrialPaymentMethodWorkflow = createWorkflow(
  "bind-trial-payment-method",
  function (input: BindTrialPaymentMethodWorkflowInput) {
    const context: TrialBindContext = resolveTrialBindContextStep({
      action: "complete",
      subscription_id: input.subscription_id,
      customer_id: input.customer_id,
      setup_token_id: input.setup_token_id,
    })

    const approval: CompleteTrialVaultApprovalStepOutput =
      completeTrialVaultApprovalStep({
        context,
        setup_token_id: input.setup_token_id,
      })

    const bound: BindTrialPaymentMethodStepOutput = bindTrialPaymentMethodStep({
      context,
      setup_token_id: input.setup_token_id,
      vault_id: approval.vault_id,
      provider_id: approval.provider_id,
    })

    // Runs after the subscription write: the step reconciles against the row's
    // (now extended) `next_renewal_at` and adopts the open scheduled cycle.
    ensureNextRenewalCycleStep({
      subscription_id: context.subscription_id,
    }).config({ name: "re-point-bound-trial-renewal-cycle" })

    const ledger: MarkTrialClaimVaultBoundStepOutput =
      markTrialClaimVaultBoundStep({
        subscription_id: context.subscription_id,
      })

    const result = transform(
      { context, bound, ledger },
      function ({
        context,
        bound,
        ledger,
      }: {
        context: TrialBindContext
        bound: BindTrialPaymentMethodStepOutput
        ledger: MarkTrialClaimVaultBoundStepOutput
      }) {
        return {
          subscription_id: context.subscription_id,
          payment_provider_id: bound.payment_provider_id,
          payment_method_reference: bound.payment_method_reference,
          trial_ends_at: bound.trial_ends_at,
          next_renewal_at: bound.next_renewal_at,
          bonus_days_applied: bound.bonus_days_applied,
          ledger_updated: ledger.ledger_updated,
        }
      }
    )

    return new WorkflowResponse<BindTrialPaymentMethodWorkflowOutput>(result)
  }
)

export type ReuseTrialPaymentMethodWorkflowInput = {
  subscription_id: string
  customer_id: string
}

/**
 * The one-shot alternative to the two-phase binding: the customer already owns
 * a payment method this trial can charge through, so nothing has to be approved
 * at the provider and the whole binding happens in a single request.
 *
 * This exists because the payment-methods plugin dedups **one method per
 * provider** and answers 409 `already_bound` from `startBinding` — by design,
 * so a second approval cannot mint a second identical wallet. The plugin's
 * message tells the caller exactly what to do ("use the existing one"), and
 * this workflow is that path. The route runs it only after the provider's own
 * `startBinding` refused, so a customer with no usable method keeps the
 * provider's answer.
 *
 * The bonus days still apply: the offer's consideration is "a payment method is
 * on file for this subscription", not "you completed an approval".
 */
export const reuseTrialPaymentMethodWorkflow = createWorkflow(
  "reuse-trial-payment-method",
  function (input: ReuseTrialPaymentMethodWorkflowInput) {
    // The start action's guards: ownership, still an active trial, not native,
    // and not already bound — the same refusals the approval path answers with.
    const context: TrialBindContext = resolveTrialBindContextStep({
      action: "start",
      subscription_id: input.subscription_id,
      customer_id: input.customer_id,
    })

    const reusable: ResolveReusableTrialMethodStepOutput =
      resolveReusableTrialMethodStep({ context })

    const bound: BindTrialPaymentMethodStepOutput = bindTrialPaymentMethodStep({
      context,
      vault_id: reusable.vault_id,
      provider_id: reusable.provider_id,
    })

    ensureNextRenewalCycleStep({
      subscription_id: context.subscription_id,
    }).config({ name: "re-point-reused-trial-renewal-cycle" })

    const ledger: MarkTrialClaimVaultBoundStepOutput =
      markTrialClaimVaultBoundStep({
        subscription_id: context.subscription_id,
      })

    const result = transform(
      { context, bound, ledger },
      function ({
        context,
        bound,
        ledger,
      }: {
        context: TrialBindContext
        bound: BindTrialPaymentMethodStepOutput
        ledger: MarkTrialClaimVaultBoundStepOutput
      }) {
        return {
          subscription_id: context.subscription_id,
          payment_provider_id: bound.payment_provider_id,
          payment_method_reference: bound.payment_method_reference,
          trial_ends_at: bound.trial_ends_at,
          next_renewal_at: bound.next_renewal_at,
          bonus_days_applied: bound.bonus_days_applied,
          ledger_updated: ledger.ledger_updated,
        }
      }
    )

    return new WorkflowResponse<BindTrialPaymentMethodWorkflowOutput>(result)
  }
)
