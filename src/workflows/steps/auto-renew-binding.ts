import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { MedusaError } from "@medusajs/framework/utils"
import { SUBSCRIPTION_MODULE } from "../../modules/subscription"
import SubscriptionModuleService from "../../modules/subscription/service"
import {
  SubscriptionPaymentContext,
  SubscriptionStatus,
} from "../../modules/subscription/types"
import { isNativeSubscriptionReference } from "../../modules/subscription/utils/native-subscription"
import {
  AUTO_RENEW_CUSTOMER_REFUSALS,
  setSubscriptionAutoRenewWorkflow,
} from "../set-subscription-auto-renew"
import { classifyStepFailure } from "../utils/store-step-failure"
import {
  resolvePaymentMethodBindingCapability,
} from "../utils/payment-method-binding"

/**
 * Enabling auto-renewal on a cardless subscription through the plugin's bind
 * flow (0.9.3, plan ticket 01③, user ruling Q8/Q13): the「开启自动续费」
 * entry never flips the flag directly any more — it runs the SAME two-phase
 * plugin binding the trial bind uses, and only a successful completion turns
 * the flag on. No second setup-token chain exists: the provider half is the
 * plugin's binder, exactly like the trial (B6).
 *
 * The scope is the subscription's **product id** — the regular scope the site
 * adapter reports for a live subscription (the trial scope is for trial rows).
 * `completeBinding` with that scope also makes the fresh method the product
 * scope's preferred method, which is what the renewal engine charges
 * (`resolveRenewalPaymentContext` reads the plugin's `preferredByScope`
 * first). The reference is additionally written onto the row's
 * `payment_context`, mirroring the trial bind so the row's own context stays
 * a valid fallback.
 *
 * Two phases, because the customer leaves for PayPal and returns:
 * - **start** — the plugin mints the approval session (scope validated
 *   against the customer's live subscription products); reorder parks the
 *   returned state as a pending binding in the row's metadata and answers
 *   with the approve URL. Nothing chargeable changes.
 * - **complete** — the plugin exchanges the approved session for its ledger
 *   method (session-gated, idempotent), the reference lands on the row, and
 *   `setSubscriptionAutoRenewWorkflow` flips the mode to auto **through its
 *   own guards** — so a row that is already overdue keeps the
 *   surprise-charge protection (renew manually first) even though the
 *   binding itself succeeded. The bound method stays visible and usable for
 *   manual renewal either way.
 */

const AUTO_RENEW_BINDING_METADATA_KEY = "auto_renew_binding"

export type AutoRenewBindAction = "start" | "complete"

export type AutoRenewBindContext = {
  subscription_id: string
  customer_id: string
  product_id: string
  payment_context: Partial<SubscriptionPaymentContext>
  metadata: Record<string, unknown>
  /**
   * True when the row is already enabled and bound and the complete call has
   * no pending approval: the request passes through to the plugin, whose
   * session gate replays the completed session (200) or refuses an unknown
   * state (409). This is what makes a repeated complete idempotent.
   */
  replay: boolean
}

export type PendingAutoRenewBinding = {
  state: string
  approval_started_at: string
}

export type ResolveAutoRenewBindContextStepInput = {
  action: AutoRenewBindAction
  subscription_id: string
  customer_id: string
  /** The complete phase only: the state (setup token id) the caller carried back. */
  setup_token_id?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function readStoredMetadata(value: unknown): Record<string, unknown> {
  return isRecord(value) ? { ...value } : {}
}

function readStoredPaymentContext(
  value: unknown
): Partial<SubscriptionPaymentContext> {
  return isRecord(value)
    ? (value as Partial<SubscriptionPaymentContext>)
    : {}
}

function readPendingAutoRenewBinding(
  metadata: Record<string, unknown>
): PendingAutoRenewBinding | null {
  const pending = metadata[AUTO_RENEW_BINDING_METADATA_KEY]

  if (
    !isRecord(pending) ||
    typeof pending.state !== "string" ||
    typeof pending.approval_started_at !== "string"
  ) {
    return null
  }

  return {
    state: pending.state,
    approval_started_at: pending.approval_started_at,
  }
}

export const resolveAutoRenewBindContextStep = createStep(
  "resolve-auto-renew-bind-context",
  async function (
    input: ResolveAutoRenewBindContextStepInput,
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

    if (isNativeSubscriptionReference(subscription.reference)) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `Subscription '${subscription.id}' is a mirror of a provider-managed recurrence; manage auto-renewal at the provider`
      )
    }

    if (
      subscription.cancelled_at !== null ||
      (subscription.status !== SubscriptionStatus.ACTIVE &&
        subscription.status !== SubscriptionStatus.PAST_DUE)
    ) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `Only an active subscription can enable auto-renewal by binding a payment method.`
      )
    }

    if (!subscription.product_id) {
      throw new MedusaError(
        MedusaError.Types.UNEXPECTED_STATE,
        `Subscription '${subscription.id}' has no product id to bind the method for.`
      )
    }

    const paymentContext = readStoredPaymentContext(subscription.payment_context)
    const alreadyBound =
      typeof paymentContext.payment_method_reference === "string" &&
      paymentContext.payment_method_reference.length > 0 &&
      typeof paymentContext.payment_provider_id === "string" &&
      paymentContext.payment_provider_id.length > 0

    if (input.action === "start") {
      if (alreadyBound) {
        throw new MedusaError(
          MedusaError.Types.INVALID_DATA,
          "This subscription already has a payment method. Enable auto-renewal directly."
        )
      }
    } else {
      const pending = readPendingAutoRenewBinding(
        readStoredMetadata(subscription.metadata)
      )

      if (pending) {
        // The state was minted by this subscription's own start call; a value
        // the caller produced elsewhere is not this approval's return.
        if (!input.setup_token_id || pending.state !== input.setup_token_id) {
          throw new MedusaError(
            MedusaError.Types.INVALID_DATA,
            "The setup token does not match the pending approval for this subscription. Start the binding again."
          )
        }
      } else if (!alreadyBound) {
        throw new MedusaError(
          MedusaError.Types.INVALID_DATA,
          "This subscription has no pending payment-method approval. Start the binding first."
        )
      }
      // No pending approval but an already-bound row: a repeated complete.
      // The request passes through and the plugin's session gate answers —
      // a replay of the same session (200) or a refusal for anything else.
    }

    const context: AutoRenewBindContext = {
      subscription_id: subscription.id,
      customer_id: subscription.customer_id,
      product_id: subscription.product_id,
      payment_context: paymentContext,
      metadata: readStoredMetadata(subscription.metadata),
      replay: input.action === "complete" && alreadyBound,
    }

    return new StepResponse(context, null)
  }
)

export type StartAutoRenewBindingStepOutput = {
  /** The plugin's approval-session handle (PayPal: the setup token id). */
  setup_token_id: string
  approve_url: string
}

/** Phase (a): start the plugin binding and park the pending session. */
export const startAutoRenewBindingStep = createStep(
  "start-auto-renew-binding",
  async function (
    input: {
      context: AutoRenewBindContext
      return_url: string
      cancel_url: string
    },
    { container }
  ) {
    const capability = resolvePaymentMethodBindingCapability(container)

    if (!capability) {
      throw new MedusaError(
        MedusaError.Types.NOT_ALLOWED,
        "Enabling auto-renewal is not supported: the installed payment-methods module does not provide the binding capability. Update @mengyyy369/medusa-payment-methods and try again."
      )
    }

    const approval = await capability.startBinding(container, {
      customerId: input.context.customer_id,
      returnUrl: input.return_url,
      cancelUrl: input.cancel_url,
      scope: input.context.product_id,
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

    const subscription = await subscriptionModule.retrieveSubscription(
      input.context.subscription_id
    )
    const previousMetadata = readStoredMetadata(subscription.metadata)
    const nextMetadata: Record<string, unknown> = {
      ...previousMetadata,
      [AUTO_RENEW_BINDING_METADATA_KEY]: {
        state: approval.state,
        approval_started_at: new Date().toISOString(),
      } satisfies PendingAutoRenewBinding,
    }

    await subscriptionModule.updateSubscriptions({
      id: input.context.subscription_id,
      metadata: nextMetadata,
    } as never)

    return new StepResponse<
      StartAutoRenewBindingStepOutput,
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

    // Drop the pending binding the start wrote; the subscription is
    // card-free again. The plugin's bind.start ledger row stays — the
    // session gate makes it harmless.
    await subscriptionModule.updateSubscriptions({
      id: compensation.subscription_id,
      metadata: {
        ...compensation.previous_metadata,
        ...(AUTO_RENEW_BINDING_METADATA_KEY in compensation.previous_metadata
          ? {}
          : { [AUTO_RENEW_BINDING_METADATA_KEY]: null }),
      },
    } as never)
  }
)

export type CompleteAutoRenewBindingStepOutput = {
  payment_provider_id: string
  payment_method_reference: string
  payment_mode: "auto"
}

/**
 * Runs last in the complete workflow: the binding succeeded and the mode is
 * on, so the parked pending approval is no longer retryable state. A failure
 * anywhere above leaves the pending binding intact (the customer can retry
 * the complete with the same setup token), which is why this is its own step
 * and not the complete step's tail. No compensation: clearing pending state
 * after success is idempotent and nothing else depends on it.
 */
export const clearPendingAutoRenewBindingStep = createStep(
  "clear-pending-auto-renew-binding",
  async function (input: { subscription_id: string }, { container }) {
    const subscriptionModule =
      container.resolve<SubscriptionModuleService>(SUBSCRIPTION_MODULE)

    const subscription = await subscriptionModule.retrieveSubscription(
      input.subscription_id
    )
    const metadata = readStoredMetadata(subscription.metadata)

    if (!(AUTO_RENEW_BINDING_METADATA_KEY in metadata)) {
      return new StepResponse({ cleared: false })
    }

    const nextMetadata = { ...metadata }
    delete nextMetadata[AUTO_RENEW_BINDING_METADATA_KEY]

    await subscriptionModule.updateSubscriptions({
      id: input.subscription_id,
      metadata: nextMetadata,
    } as never)

    return new StepResponse({ cleared: true })
  }
)

type CompleteStepCompensation = {
  subscription_id: string
  payment_context: Record<string, unknown> | null
} | null

/**
 * Phase (b): the plugin completes the binding, the reference lands on the
 * row, and the mode flips through the toggle's own workflow — its overdue
 * guard keeps protecting the customer now that the row carries a method.
 */
export const completeAutoRenewBindingStep = createStep(
  "complete-auto-renew-binding",
  async function (
    input: {
      context: AutoRenewBindContext
      setup_token_id: string
    },
    { container }
  ) {
    const capability = resolvePaymentMethodBindingCapability(container)

    if (!capability) {
      throw new MedusaError(
        MedusaError.Types.NOT_ALLOWED,
        "Enabling auto-renewal is not supported: the installed payment-methods module does not provide the binding capability. Update @mengyyy369/medusa-payment-methods and try again."
      )
    }

    const result = await capability.completeBinding(container, {
      customerId: input.context.customer_id,
      state: input.setup_token_id,
      scope: input.context.product_id,
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

    const subscriptionModule =
      container.resolve<SubscriptionModuleService>(SUBSCRIPTION_MODULE)

    const subscription = await subscriptionModule.retrieveSubscription(
      input.context.subscription_id
    )
    const previousContext: Record<string, unknown> | null =
      subscription.payment_context ?? null

    // Re-read and spread: the write carries the whole stored object. Only the
    // provider/reference pair is this step's business; the mode flip is the
    // toggle workflow's own write below.
    await subscriptionModule.updateSubscriptions({
      id: input.context.subscription_id,
      payment_context: {
        ...previousContext,
        payment_provider_id: result.method.provider_id,
        payment_method_reference: result.method.id,
      },
    } as never)

    // The flip runs through the toggle's guards with the reference already on
    // the row: a row that is already overdue is refused (renew manually
    // first) even though the binding succeeded — the method stays bound and
    // usable for manual renewal.
    const { result: toggleResult, errors } = await setSubscriptionAutoRenewWorkflow(
      container
    ).run({
      input: {
        subscription_id: input.context.subscription_id,
        enabled: true,
      },
      throwOnError: false,
    })

    if (errors?.length || !toggleResult) {
      // The toggle's declared refusals (the overdue guard above all) are the
      // customer's answer and are rethrown as-is; anything else is our fault
      // and keeps the step's own generic wording. The refusal copy stays
      // owned by the toggle workflow — the route declares it under this
      // step's name.
      const refusal = classifyStepFailure({
        errors,
        refusals: AUTO_RENEW_CUSTOMER_REFUSALS,
        copy: {
          notFound: "subscription not found",
          refused: "auto-renewal could not be enabled",
          failed: "auto-renewal could not be enabled",
        },
      })

      if (refusal.quoted) {
        throw new MedusaError(refusal.type, refusal.message)
      }

      throw new MedusaError(
        MedusaError.Types.UNEXPECTED_STATE,
        `The binding succeeded but enabling auto-renewal failed for subscription '${input.context.subscription_id}'.`
      )
    }

    return new StepResponse<
      CompleteAutoRenewBindingStepOutput,
      CompleteStepCompensation
    >(
      {
        payment_provider_id: result.method.provider_id,
        payment_method_reference: result.method.id,
        payment_mode: "auto",
      },
      {
        subscription_id: input.context.subscription_id,
        payment_context: previousContext,
      }
    )
  },
  async function (compensation: CompleteStepCompensation, { container }) {
    if (!compensation) {
      return
    }

    const subscriptionModule =
      container.resolve<SubscriptionModuleService>(SUBSCRIPTION_MODULE)

    // Restore the row's payment_context exactly as it read before the write.
    // The toggle workflow's own compensation restores the mode; the plugin's
    // ledger method is intentionally not undone (the customer did authorize
    // it — the audit trail is the record of that authorization).
    await subscriptionModule.updateSubscriptions({
      id: compensation.subscription_id,
      payment_context: compensation.payment_context,
    } as never)
  }
)
