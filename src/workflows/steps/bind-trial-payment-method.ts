import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import {
  MedusaError,
  Modules,
} from "@medusajs/framework/utils"
import type { MedusaContainer } from "@medusajs/framework/types"
import { SUBSCRIPTION_MODULE } from "../../modules/subscription"
import SubscriptionModuleService from "../../modules/subscription/service"
import {
  SubscriptionPaymentContext,
  SubscriptionStatus,
} from "../../modules/subscription/types"
import { isNativeSubscriptionReference } from "../../modules/subscription/utils/native-subscription"
import { TRIAL_CLAIM_MODULE } from "../../modules/trial-claim"
import TrialClaimModuleService from "../../modules/trial-claim/service"
import { TrialClaimBindingMethod } from "../../modules/trial-claim/types"
import { resolveProductSubscriptionConfig } from "../../modules/plan-offer/utils/effective-config"
import { buildPaymentModeFields } from "../utils/payment-mode-mechanism"
import {
  findPaypalPaymentProviderId,
  isApprovedVaultStatus,
  resolvePaypalVaultBindingCapability,
} from "../utils/paypal-vault-binding"

/**
 * Phase 14, plan Task 22: binding a payment method to a claimed trial without
 * charging anything. The PayPal Vault v3 calls themselves are medusa-paypal's
 * work (Tasks P1–P2 of `.agents/specs/2026-09-28-paypal-vault-binding-plan.md`)
 * and are only consumed here, through the duck-typed capability in
 * `src/workflows/utils/paypal-vault-binding.ts`.
 *
 * Two phases, because the customer leaves for PayPal and comes back:
 * - **start** — `startVaultApproval` returns the payer-approval link; the
 *   setup token id is stored as a *pending binding* on the subscription's
 *   metadata and the approve_url goes back to the caller. Nothing chargeable
 *   is created or changed.
 * - **complete** — the customer returns from PayPal; the approval is exchanged
 *   for a vault id, and the reorder-side binding lands in one pass: a real
 *   `payment_provider_id` + `payment_method_reference` (both, per T7's charge
 *   gate), `payment_mode: auto`, the trial extended **anchored on
 *   `started_at`**, `next_renewal_at` kept equal to the new `trial_ends_at`,
 *   and the ledger's `binding_method` flipped to `vault`. The open scheduled
 *   cycle is moved by `ensureNextRenewalCycleStep`, never by a direct
 *   `scheduled_for` write — the workflow after this step runs it.
 */

export type TrialBindAction = "start" | "complete"

export type ResolveTrialBindContextStepInput = {
  action: TrialBindAction
  subscription_id: string
  customer_id: string
  /** The complete phase only: the setup token id the customer returned with. */
  setup_token_id?: string
}

/** The pending binding stored on the subscription's metadata at start. */
export type PendingTrialBinding = {
  setup_token_id: string
  approval_started_at: string
}

export type TrialBindContext = {
  subscription_id: string
  customer_id: string
  product_id: string
  variant_id: string
  reference: string
  started_at: string
  trial_ends_at: string
  payment_context: Partial<SubscriptionPaymentContext>
  metadata: Record<string, unknown>
}

const TRIAL_BINDING_METADATA_KEY = "trial_binding"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function readStoredMetadata(value: unknown): Record<string, unknown> {
  return isRecord(value) ? { ...value } : {}
}

/**
 * `payment_context` is a nullable jsonb column, so every reader picks a shape.
 * The stored object is spread into the next write (never written over on the
 * assumption the DAL merges — it merges on one path only), and the fields this
 * workflow is responsible for are set explicitly on top.
 */
function readStoredPaymentContext(value: unknown): Partial<SubscriptionPaymentContext> {
  return isRecord(value)
    ? (value as Partial<SubscriptionPaymentContext>)
    : {}
}

function readPendingBinding(metadata: Record<string, unknown>): PendingTrialBinding | null {
  const pending = metadata[TRIAL_BINDING_METADATA_KEY]

  if (
    !isRecord(pending) ||
    typeof pending.setup_token_id !== "string" ||
    typeof pending.approval_started_at !== "string"
  ) {
    return null
  }

  return {
    setup_token_id: pending.setup_token_id,
    approval_started_at: pending.approval_started_at,
  }
}

export const resolveTrialBindContextStep = createStep(
  "resolve-trial-bind-context",
  async function (
    input: ResolveTrialBindContextStepInput,
    { container }
  ) {
    const subscriptionModule =
      container.resolve<SubscriptionModuleService>(SUBSCRIPTION_MODULE)

    // Ownership like every other /store/customers/me/* action: the row must
    // carry the authenticated customer's id, or it does not exist at all.
    const owned = await subscriptionModule.listSubscriptions({
      id: input.subscription_id,
      customer_id: input.customer_id,
    })
    const subscription = owned[0]

    if (!subscription) {
      throw new MedusaError(
        MedusaError.Types.NOT_FOUND,
        `Subscription '${input.subscription_id}' was not found for the authenticated customer.`
      )
    }

    if (!subscription.is_trial) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "Only a trial subscription can bind a payment method this way."
      )
    }

    if (
      subscription.cancelled_at !== null ||
      subscription.status !== SubscriptionStatus.ACTIVE
    ) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "Only an active trial subscription can bind a payment method."
      )
    }

    if (isNativeSubscriptionReference(subscription.reference)) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "A provider-managed subscription is billed by its provider and cannot bind a reorder payment method."
      )
    }

    const metadata = readStoredMetadata(subscription.metadata)
    const paymentContext = readStoredPaymentContext(subscription.payment_context)

    if (input.action === "start") {
      if (typeof paymentContext.payment_method_reference === "string") {
        throw new MedusaError(
          MedusaError.Types.INVALID_DATA,
          "This trial already has a bound payment method."
        )
      }
      // A pending approval may be replaced: a customer who abandons PayPal and
      // starts again gets a fresh setup token, and the newest one wins. The
      // bound state above is the only state that locks the trial.
    } else {
      const pending = readPendingBinding(metadata)

      if (!pending) {
        throw new MedusaError(
          MedusaError.Types.INVALID_DATA,
          "This trial has no pending payment-method approval. Start the binding first."
        )
      }

      // The token id was minted by this trial's own start call; a value the
      // caller produced elsewhere is not this approval's return.
      if (!input.setup_token_id || pending.setup_token_id !== input.setup_token_id) {
        throw new MedusaError(
          MedusaError.Types.INVALID_DATA,
          "The setup token does not match the pending approval for this trial. Start the binding again."
        )
      }
    }

    if (!subscription.started_at) {
      throw new MedusaError(
        MedusaError.Types.UNEXPECTED_STATE,
        `Trial subscription '${subscription.id}' has no started_at anchor.`
      )
    }
    if (!subscription.trial_ends_at) {
      throw new MedusaError(
        MedusaError.Types.UNEXPECTED_STATE,
        `Trial subscription '${subscription.id}' has no trial_ends_at anchor.`
      )
    }

    const context: TrialBindContext = {
      subscription_id: subscription.id,
      customer_id: subscription.customer_id,
      product_id: subscription.product_id,
      variant_id: subscription.variant_id,
      reference: subscription.reference,
      started_at: new Date(subscription.started_at).toISOString(),
      trial_ends_at: new Date(subscription.trial_ends_at).toISOString(),
      payment_context: paymentContext,
      metadata,
    }

    // The step decides; it writes nothing, so there is nothing to compensate.
    return new StepResponse(context, null)
  }
)

export type StartTrialVaultApprovalStepOutput = {
  setup_token_id: string
  approve_url: string
}

/**
 * Phase (a): call the provider's `startVaultApproval` and park the setup token
 * id on the subscription as the pending binding. When the installed provider
 * predates the capability, the step refuses before anything is stored — the
 * trial stays exactly as the claim created it.
 */
export const startTrialVaultApprovalStep = createStep(
  "start-trial-vault-approval",
  async function (
    input: {
      context: TrialBindContext
      return_url: string
      cancel_url: string
    },
    { container }
  ) {
    const capability = resolvePaypalVaultBindingCapability(container)

    if (!capability) {
      throw new MedusaError(
        MedusaError.Types.NOT_ALLOWED,
        "Binding a payment method is not supported: the installed PayPal provider does not provide the vault approval capability. Update the medusa-paypal plugin and try again."
      )
    }

    const approval = await capability.startVaultApproval({
      customer_id: input.context.customer_id,
      return_url: input.return_url,
      cancel_url: input.cancel_url,
    })

    if (
      typeof approval?.setup_token_id !== "string" ||
      typeof approval?.approve_url !== "string"
    ) {
      throw new MedusaError(
        MedusaError.Types.UNEXPECTED_STATE,
        "The PayPal provider returned an incomplete vault approval."
      )
    }

    const subscriptionModule =
      container.resolve<SubscriptionModuleService>(SUBSCRIPTION_MODULE)

    // Re-read and spread: a jsonb write must carry the whole stored object.
    const subscription = await subscriptionModule.retrieveSubscription(
      input.context.subscription_id
    )
    const previousMetadata = readStoredMetadata(subscription.metadata)
    const nextMetadata: Record<string, unknown> = {
      ...previousMetadata,
      [TRIAL_BINDING_METADATA_KEY]: {
        setup_token_id: approval.setup_token_id,
        approval_started_at: new Date().toISOString(),
      } satisfies PendingTrialBinding,
    }

    await subscriptionModule.updateSubscriptions({
      id: input.context.subscription_id,
      metadata: nextMetadata,
    } as never)

    return new StepResponse<
      StartTrialVaultApprovalStepOutput,
      { subscription_id: string; previous_metadata: Record<string, unknown> } | null
    >(
      {
        setup_token_id: approval.setup_token_id,
        approve_url: approval.approve_url,
      },
      {
        subscription_id: input.context.subscription_id,
        previous_metadata: previousMetadata,
      }
    )
  },
  async function (compensation, { container }) {
    if (!compensation) {
      return
    }

    const subscriptionModule =
      container.resolve<SubscriptionModuleService>(SUBSCRIPTION_MODULE)

    // Drop the pending binding the start wrote; the trial is card-free again.
    await subscriptionModule.updateSubscriptions({
      id: compensation.subscription_id,
      metadata: {
        ...compensation.previous_metadata,
        // The merge-on-write path keeps keys that the payload omits, so a
        // pre-start absence must be written as an explicit null.
        ...(TRIAL_BINDING_METADATA_KEY in compensation.previous_metadata
          ? {}
          : { [TRIAL_BINDING_METADATA_KEY]: null }),
      },
    } as never)
  }
)

export type CompleteTrialVaultApprovalStepOutput = {
  status: string
  vault_id: string
}

/**
 * Phase (b), provider half: exchange the approved setup token for a vault id.
 * Accepts `APPROVED`, `VAULTED` **and** `TOKENIZED` — the sandbox measured
 * `VAULTED` after a real approval, and the provider plan's Task P1 Step 3 was
 * corrected for exactly this. A not-yet-approved status is a caller's error
 * (try again later), never a bind.
 */
export const completeTrialVaultApprovalStep = createStep(
  "complete-trial-vault-approval",
  async function (
    input: {
      context: TrialBindContext
      setup_token_id: string
    },
    { container }
  ) {
    const capability = resolvePaypalVaultBindingCapability(container)

    if (!capability) {
      throw new MedusaError(
        MedusaError.Types.NOT_ALLOWED,
        "Binding a payment method is not supported: the installed PayPal provider does not provide the vault approval capability. Update the medusa-paypal plugin and try again."
      )
    }

    const result = await capability.completeVaultApproval({
      setup_token_id: input.setup_token_id,
    })

    if (!isApprovedVaultStatus(result?.status)) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `The payment method approval is not complete yet (status '${String(
          result?.status ?? "unknown"
        )}'). Approve the setup token in PayPal and try again.`
      )
    }

    if (typeof result?.vault_id !== "string" || result.vault_id.length === 0) {
      throw new MedusaError(
        MedusaError.Types.UNEXPECTED_STATE,
        "The PayPal provider approved the setup token but returned no vault id."
      )
    }

    return new StepResponse<CompleteTrialVaultApprovalStepOutput, null>(
      {
        status: result.status,
        vault_id: result.vault_id,
      },
      null
    )
  }
)

export type BindTrialPaymentMethodStepOutput = {
  payment_provider_id: string
  payment_method_reference: string
  trial_ends_at: string
  next_renewal_at: string
  bonus_days_applied: number
}

type BindStepCompensation = {
  subscription_id: string
  payment_context: Partial<SubscriptionPaymentContext>
  trial_ends_at: string | null
  next_renewal_at: string | null
  metadata: Record<string, unknown>
}

/**
 * The bonus days the extension grants, as the trial recorded them at claim
 * time (`trial_bonus_days` on the subscription's metadata — the value the
 * offer carried when the customer actually claimed, or the batch's own
 * configuration on the redemption door). A trial whose metadata predates that
 * write falls back to the offer's current rule; no recorded value anywhere
 * means no bonus.
 */
async function resolveBonusDays(
  container: MedusaContainer,
  context: TrialBindContext
): Promise<number> {
  const recorded = context.metadata["trial_bonus_days"]

  if (typeof recorded === "number" && Number.isFinite(recorded) && recorded > 0) {
    return recorded
  }

  try {
    const config = await resolveProductSubscriptionConfig(container, {
      product_id: context.product_id,
      variant_id: context.variant_id,
    })

    return typeof config.rules?.trial_bonus_days === "number" &&
      config.rules.trial_bonus_days > 0
      ? config.rules.trial_bonus_days
      : 0
  } catch {
    // An unreadable offer must not block the binding: the fallback is no
    // bonus, which keeps trial_ends_at on the trial's own anchor.
    return 0
  }
}

/**
 * The reorder-side bind (plan Step 3): store the vault id AND the real
 * registered provider id — both are required by the charge gate (T7) — switch
 * the row to `payment_mode: auto`, extend the trial **anchored on
 * `started_at`** (binding on day 5 must land on the same date as binding on
 * day 1), keep `next_renewal_at` equal to the new `trial_ends_at`, and clear
 * the pending binding. The cycle is moved by `ensureNextRenewalCycleStep`
 * after this step, never by a direct `scheduled_for` write here.
 */
export const bindTrialPaymentMethodStep = createStep(
  "bind-trial-payment-method",
  async function (
    input: {
      context: TrialBindContext
      setup_token_id: string
      vault_id: string
    },
    { container }
  ) {
    const paymentModule = container.resolve(Modules.PAYMENT)
    const providerId = findPaypalPaymentProviderId(paymentModule)

    if (!providerId) {
      throw new MedusaError(
        MedusaError.Types.NOT_ALLOWED,
        "The PayPal payment provider is not declared on the payment module, so the bound method could never be charged. Register the PayPal provider and try again."
      )
    }

    const bonusDays = await resolveBonusDays(container, input.context)

    // The extension is arithmetic on the row's own anchors, never on `now`:
    // original span (trial_ends_at - started_at, i.e. the trial_days the
    // customer was granted) plus the bonus days, measured from started_at.
    const startedAtMs = new Date(input.context.started_at).getTime()
    const originalEndMs = new Date(input.context.trial_ends_at).getTime()
    const trialSpanMs = Math.max(originalEndMs - startedAtMs, 0)
    const extendedTrialEndsAt = new Date(
      startedAtMs + trialSpanMs + bonusDays * 86_400_000
    )

    const subscriptionModule =
      container.resolve<SubscriptionModuleService>(SUBSCRIPTION_MODULE)

    // Re-read and spread on both jsonb columns: the write carries the whole
    // stored objects (the DAL merges on one path only).
    const subscription = await subscriptionModule.retrieveSubscription(
      input.context.subscription_id
    )
    const previousMetadata = readStoredMetadata(subscription.metadata)
    const previousContext = readStoredPaymentContext(subscription.payment_context)

    const nextMetadata: Record<string, unknown> = {
      ...previousMetadata,
      binding: "vault",
      // Tombstone, not delete: the single-row update path MERGES jsonb
      // objects, so an omitted key survives the write. A null ends the
      // pending approval (readPendingBinding treats it as absent).
      [TRIAL_BINDING_METADATA_KEY]: null,
    }

    const nextPaymentContext: SubscriptionPaymentContext = {
      payment_provider_id: providerId,
      source_payment_collection_id:
        previousContext.source_payment_collection_id ?? null,
      source_payment_session_id: previousContext.source_payment_session_id ?? null,
      payment_method_reference: input.vault_id,
      customer_payment_reference: previousContext.customer_payment_reference ?? null,
      ...buildPaymentModeFields("auto"),
    }

    await subscriptionModule.updateSubscriptions({
      id: input.context.subscription_id,
      payment_context: nextPaymentContext,
      trial_ends_at: extendedTrialEndsAt,
      next_renewal_at: extendedTrialEndsAt,
      metadata: nextMetadata,
    } as never)

    return new StepResponse<BindTrialPaymentMethodStepOutput, BindStepCompensation>(
      {
        payment_provider_id: providerId,
        payment_method_reference: input.vault_id,
        trial_ends_at: extendedTrialEndsAt.toISOString(),
        next_renewal_at: extendedTrialEndsAt.toISOString(),
        bonus_days_applied: bonusDays,
      },
      {
        subscription_id: input.context.subscription_id,
        payment_context: previousContext,
        trial_ends_at:
          subscription.trial_ends_at !== null
            ? new Date(subscription.trial_ends_at).toISOString()
            : null,
        next_renewal_at:
          subscription.next_renewal_at !== null
            ? new Date(subscription.next_renewal_at).toISOString()
            : null,
        metadata: previousMetadata,
      }
    )
  },
  async function (compensation, { container }) {
    if (!compensation) {
      return
    }

    const subscriptionModule =
      container.resolve<SubscriptionModuleService>(SUBSCRIPTION_MODULE)

    await subscriptionModule.updateSubscriptions({
      id: compensation.subscription_id,
      // The stored value is exactly what the column held before the bind, so
      // writing it back whole (jsonb updates replace, they do not merge)
      // restores the pre-bind state byte for byte.
      payment_context: compensation.payment_context,
      trial_ends_at:
        compensation.trial_ends_at !== null
          ? new Date(compensation.trial_ends_at)
          : null,
      next_renewal_at:
        compensation.next_renewal_at !== null
          ? new Date(compensation.next_renewal_at)
          : null,
      metadata: compensation.metadata,
    } as never)
  }
)

export type MarkTrialClaimVaultBoundStepOutput = {
  ledger_updated: boolean
}

type LedgerCompensation = {
  subscription_id: string
  previous_binding_method: TrialClaimBindingMethod
} | null

/**
 * The ledger's `binding_method` moves to `vault` when the vault id actually
 * landed on the subscription (plan Step 3, last clause). No ledger row means
 * nothing to update: the ledger records bindings, it does not gate them.
 */
export const markTrialClaimVaultBoundStep = createStep(
  "mark-trial-claim-vault-bound",
  async function (
    input: { subscription_id: string },
    { container }
  ): Promise<
    StepResponse<MarkTrialClaimVaultBoundStepOutput, LedgerCompensation>
  > {
    const trialClaimModule = container.resolve<TrialClaimModuleService>(
      TRIAL_CLAIM_MODULE
    )

    const existing = await trialClaimModule.listTrialClaims(
      { subscription_id: input.subscription_id },
      { select: ["id", "binding_method"], take: 1 }
    )
    const claim = existing[0]

    if (!claim) {
      return new StepResponse<MarkTrialClaimVaultBoundStepOutput, LedgerCompensation>(
        { ledger_updated: false },
        null
      )
    }

    await trialClaimModule.updateBindingMethod(
      input.subscription_id,
      TrialClaimBindingMethod.VAULT
    )

    return new StepResponse<MarkTrialClaimVaultBoundStepOutput, LedgerCompensation>(
      { ledger_updated: true },
      {
        subscription_id: input.subscription_id,
        previous_binding_method: claim.binding_method,
      }
    )
  },
  async function (compensation, { container }) {
    if (!compensation) {
      return
    }

    const trialClaimModule = container.resolve<TrialClaimModuleService>(
      TRIAL_CLAIM_MODULE
    )

    await trialClaimModule.updateBindingMethod(
      compensation.subscription_id,
      compensation.previous_binding_method
    )
  }
)
