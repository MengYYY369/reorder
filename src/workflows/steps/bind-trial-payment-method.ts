import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { MedusaError } from "@medusajs/framework/utils"
import type { MedusaContainer } from "@medusajs/framework/types"
import { ensureCustomerAccountHolder } from "@mengyyy369/medusa-payment-methods"
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
  resolvePaymentMethodBindingCapability,
  PLUGIN_TRIAL_PAYMENT_SCOPE,
} from "../utils/payment-method-binding"

/**
 * Phase 14, plan Task 22 — binding a payment method to a claimed trial
 * without charging anything — since 0.9.3 (B6, plan ticket 01) **delegates the
 * provider half to the payment-methods plugin**. The endpoint's external
 * request/response shape is unchanged; internally:
 *
 * - **start** calls the plugin's `startBinding` with the plugin-owned
 *   `trial` scope and returns the approval URL. The plugin records the
 *   binding-session ledger row (`bind.start`), which is the ownership anchor
 *   the completion verifies; reorder parks the returned `state` on the
 *   subscription's metadata as the *pending binding*. Nothing chargeable is
 *   created or changed.
 * - **complete** calls the plugin's `completeBinding` with the same scope.
 *   The plugin only accepts a state it issued to the calling customer (a
 *   cross-customer state is a 409 and the provider is never called), replays
 *   an already-completed session idempotently, and returns the ledger method
 *   whose `id` — the plugin's own reference, no longer a raw PayPal
 *   setup-token/vault id living outside the ledger — lands in the trial row's
 *   `payment_context.payment_method_reference`. The scope also makes the
 *   fresh method the trial scope's preferred method.
 *
 * Trial rows bound before the delegation keep their setup-token references
 * and their read-side behavior; nothing is backfilled.
 */

export type TrialBindAction = "start" | "complete"

export type ResolveTrialBindContextStepInput = {
  action: TrialBindAction
  subscription_id: string
  customer_id: string
  /** The complete phase only: the state (setup token id) the caller carried back. */
  setup_token_id?: string
}

/** The pending binding stored on the subscription's metadata at start. */
export type PendingTrialBinding = {
  /** The plugin's approval-session handle (PayPal: the setup token id). */
  state: string
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
  /**
   * True when the trial is already bound and the complete call has no pending
   * approval: the request passes through to the plugin, whose session gate
   * replays the completed session (200) or refuses an unknown state (409).
   * This is what makes a repeated complete idempotent.
   */
  replay: boolean
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
    typeof pending.approval_started_at !== "string" ||
    (typeof pending.state !== "string" &&
      // Rows whose pending approval was stored by the pre-delegation flow
      // carry the raw setup token id instead of `state`; it is the same
      // handle the completion carries back, so it is honoured as the state.
      typeof pending.setup_token_id !== "string")
  ) {
    return null
  }

  return {
    state:
      typeof pending.state === "string"
        ? pending.state
        : (pending.setup_token_id as string),
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
    const alreadyBound =
      typeof paymentContext.payment_method_reference === "string"

    if (input.action === "start") {
      if (alreadyBound) {
        throw new MedusaError(
          MedusaError.Types.INVALID_DATA,
          "This trial already has a bound payment method."
        )
      }
      // A pending approval may be replaced: a customer who abandons PayPal and
      // starts again gets a fresh session, and the newest one wins. The bound
      // state above is the only state that locks the trial.
    } else {
      const pending = readPendingBinding(metadata)

      if (pending) {
        // The state was minted by this trial's own start call; a value the
        // caller produced elsewhere is not this approval's return.
        if (
          !input.setup_token_id ||
          pending.state !== input.setup_token_id
        ) {
          throw new MedusaError(
            MedusaError.Types.INVALID_DATA,
            "The setup token does not match the pending approval for this trial. Start the binding again."
          )
        }
      } else if (!alreadyBound) {
        throw new MedusaError(
          MedusaError.Types.INVALID_DATA,
          "This trial has no pending payment-method approval. Start the binding first."
        )
      }
      // No pending approval but an already-bound trial: a repeated complete.
      // The request passes through and the plugin's session gate answers —
      // a replay of the same session (200) or a refusal for anything else.
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
      replay: input.action === "complete" && alreadyBound,
    }

    // The step decides; it writes nothing, so there is nothing to compensate.
    return new StepResponse(context, null)
  }
)

export type StartTrialVaultApprovalStepOutput = {
  /** The plugin's approval-session handle (PayPal: the setup token id). */
  setup_token_id: string
  approve_url: string
}

/**
 * Phase (a): the plugin starts the binding (session ledger row, provider
 * approval URL) and reorder parks the returned state as the pending binding.
 * A missing or outdated payment-methods module refuses before anything is
 * stored — the trial stays exactly as the claim created it.
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
    const capability = resolvePaymentMethodBindingCapability(container)

    if (!capability) {
      throw new MedusaError(
        MedusaError.Types.NOT_ALLOWED,
        "Binding a payment method is not supported: the installed payment-methods module does not provide the binding capability. Update @mengyyy369/medusa-payment-methods and try again."
      )
    }

    const approval = await capability.startBinding(container, {
      customerId: input.context.customer_id,
      returnUrl: input.return_url,
      cancelUrl: input.cancel_url,
      scope: PLUGIN_TRIAL_PAYMENT_SCOPE,
    })

    if (
      typeof approval?.approvalUrl !== "string" ||
      typeof approval?.state !== "string"
    ) {
      throw new MedusaError(
        MedusaError.Types.UNEXPECTED_STATE,
        "The payment-methods module returned an incomplete binding session."
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
        state: approval.state,
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
        setup_token_id: approval.state,
        approve_url: approval.approvalUrl,
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
    // The plugin's bind.start ledger row stays — it is the audit of an
    // approval that was offered, and the session gate makes it harmless.
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
  /** The plugin ledger's method reference (the authoritative vault id). */
  vault_id: string
  /** The provider registration key the method was bound under. */
  provider_id: string
}

/**
 * Phase (b), provider half: the plugin exchanges the approved session for its
 * ledger method. Ownership is proven by the plugin's own session ledger, so a
 * state issued to another customer is a 409 and the provider is never called;
 * a repeated complete of the same approval session replays the existing
 * method. A not-yet-approved status surfaces as the binder's own
 * `invalid_data` refusal (try again later), never a bind.
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
    const capability = resolvePaymentMethodBindingCapability(container)

    if (!capability) {
      throw new MedusaError(
        MedusaError.Types.NOT_ALLOWED,
        "Binding a payment method is not supported: the installed payment-methods module does not provide the binding capability. Update @mengyyy369/medusa-payment-methods and try again."
      )
    }

    const result = await capability.completeBinding(container, {
      customerId: input.context.customer_id,
      state: input.setup_token_id,
      scope: PLUGIN_TRIAL_PAYMENT_SCOPE,
    })

    if (
      typeof result?.method?.id !== "string" ||
      result.method.id.length === 0 ||
      typeof result?.method?.provider_id !== "string" ||
      result.method.provider_id.length === 0
    ) {
      throw new MedusaError(
        MedusaError.Types.UNEXPECTED_STATE,
        "The payment-methods module completed the binding but returned no usable payment method."
      )
    }

    return new StepResponse<CompleteTrialVaultApprovalStepOutput, null>(
      {
        vault_id: result.method.id,
        provider_id: result.method.provider_id,
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
 * The reorder-side bind (plan Step 3): store the plugin ledger's method
 * reference AND the provider id it came back under — both are required by the
 * charge gate (T7) — switch the row to `payment_mode: auto`, extend the trial
 * **anchored on `started_at`** (binding on day 5 must land on the same date as
 * binding on day 1), keep `next_renewal_at` equal to the new `trial_ends_at`,
 * and clear the pending binding. The cycle is moved by
 * `ensureNextRenewalCycleStep` after this step, never by a direct
 * `scheduled_for` write here.
 *
 * Every write is idempotent for a replayed complete: the extension is
 * arithmetic on the row's own anchors, so recomputing it lands on the same
 * date, and writing the same reference is a no-op.
 */
export const bindTrialPaymentMethodStep = createStep(
  "bind-trial-payment-method",
  async function (
    input: {
      context: TrialBindContext
      setup_token_id: string
      vault_id: string
      provider_id: string
    },
    { container }
  ) {
    const bonusDays = await resolveBonusDays(container, input.context)

    // The extension is arithmetic on the row's own anchors, never on `now`:
    // original span (trial_ends_at - started_at, i.e. the trial_days the
    // customer was granted) plus the bonus days, measured from started_at.
    // A replayed complete skips the arithmetic entirely (see below).
    const startedAtMs = new Date(input.context.started_at).getTime()
    const originalEndMs = new Date(input.context.trial_ends_at).getTime()
    const trialSpanMs = Math.max(originalEndMs - startedAtMs, 0)

    const subscriptionModule =
      container.resolve<SubscriptionModuleService>(SUBSCRIPTION_MODULE)

    // Re-read and spread on both jsonb columns: the write carries the whole
    // stored objects (the DAL merges on one path only).
    const subscription = await subscriptionModule.retrieveSubscription(
      input.context.subscription_id
    )

    // A replayed complete (the trial is already bound) must not extend again:
    // the row's current anchors are already the extended ones, so they are
    // kept as-is and the write below is a no-op on the dates.
    const replayedTrialEndsAt =
      subscription.trial_ends_at !== null
        ? new Date(subscription.trial_ends_at)
        : null
    const extendedTrialEndsAt = input.context.replay
      ? (replayedTrialEndsAt ?? new Date(input.context.trial_ends_at))
      : new Date(startedAtMs + trialSpanMs + bonusDays * 86_400_000)

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
      payment_provider_id: input.provider_id,
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

    // 2026-10-04（走查 09A）：把刚绑的 vault 登记到 payment 模块的账户持有人上——
    // 支付方式页从 account holder 出发列 vault，不登记就永远看不到（item 9）。
    // 0.9.3（B6）起插件的 completeBinding 自己已经 ensure 过一次；这里的调用
    // 保持幂等，只为兼容插件缺位时的直接路径并保持调用点成对。非阻断。
    try {
      await ensureCustomerAccountHolder(container, {
        customer_id: subscription.customer_id,
        provider_id: input.provider_id,
      })
    } catch (error) {
      const logger = container.resolve("logger") as {
        warn: (message: string) => void
      }
      logger.warn(
        `[reorder] trial bind: could not register the payment account holder for customer '${subscription.customer_id}': ${
          error instanceof Error ? error.message : String(error)
        }`
      )
    }

    return new StepResponse<BindTrialPaymentMethodStepOutput, BindStepCompensation>(
      {
        payment_provider_id: input.provider_id,
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
