import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { SUBSCRIPTION_MODULE } from "../../modules/subscription"
import SubscriptionModuleService from "../../modules/subscription/service"
import {
  SubscriptionStatus,
  type SubscriptionPaymentMode,
} from "../../modules/subscription/types"
import { subscriptionErrors } from "../../modules/subscription/utils/errors"
import { isNativeSubscriptionReference } from "../../modules/subscription/utils/native-subscription"
import {
  buildPaymentModeFields,
  readStoredPaymentMode,
} from "../utils/payment-mode-mechanism"

/**
 * How far past `next_renewal_at` a subscription may still opt into automatic
 * renewals. Beyond it the scheduler would charge in the same request that
 * enabled the switch, so the customer is sent to the manual renewal flow first.
 */
export const AUTO_RENEW_OVERDUE_GRACE_MS = 24 * 60 * 60 * 1000

/**
 * Stable step identities. The workflow engine reports a failure as
 * `{ action, handlerType, error }` where `action` is exactly the name the step
 * was created with, and `error` is a *serialized* copy rather than the thrown
 * instance (`.agents/lessons.md`), so a caller that has to tell the guards
 * apart from the write does it by this name and not by `instanceof`. Exported
 * as constants so the name and the check can never drift apart.
 */
export const ASSERT_AUTO_RENEW_NOT_NATIVE_STEP_NAME =
  "assert-subscription-auto-renew-not-native"

export const ASSERT_AUTO_RENEW_NOT_OVERDUE_STEP_NAME =
  "assert-subscription-auto-renew-not-overdue"

export type AutoRenewNativeGuardStepInput = {
  subscription_id: string
}

/**
 * Everything the toggle decides on, read once from the row.
 */
export type AutoRenewSubscriptionState = {
  id: string
  reference: string
  status: SubscriptionStatus
  next_renewal_at: Date | string | null
  current_mode: SubscriptionPaymentMode
}

export type AutoRenewOverdueGuardStepInput = {
  id: string
  status: SubscriptionStatus
  next_renewal_at: Date | string | null
  current_mode: SubscriptionPaymentMode
  enabled: boolean
}

export type AutoRenewOverdueGuardStepResult = {
  payment_mode: SubscriptionPaymentMode
}

export type UpdateSubscriptionPaymentModeStepInput = {
  subscription_id: string
  payment_mode: SubscriptionPaymentMode
}

export type UpdateSubscriptionPaymentModeStepResult = {
  subscription_id: string
  payment_mode: SubscriptionPaymentMode
  previous_mode: SubscriptionPaymentMode
}

type PaymentModeCompensation = {
  id: string
  payment_context: Record<string, unknown> | null
}

/**
 * Write-side guard for the auto-renew switch: the same rule the payment-method
 * update enforces (`update-subscription-payment-method`), expressed with the
 * predicate `isNativeSubscriptionReference` rather than a second copy of it.
 *
 * A mirror row is a local copy of a recurrence the provider already charges.
 * The scheduler's read-side exclusions do not protect it here, because this
 * call flips the very field that makes a row chargeable: one request would turn
 * a row both schedulers ignore into a chargeable one. So the refusal happens
 * before anything is written, and ownership is decided by the `NATIVE-`
 * reference prefix — never by the stored `mechanism` annotation.
 */
export const assertAutoRenewNotNativeStep = createStep(
  ASSERT_AUTO_RENEW_NOT_NATIVE_STEP_NAME,
  async function (input: AutoRenewNativeGuardStepInput, { container }) {
    const subscriptionModuleService: SubscriptionModuleService =
      container.resolve(SUBSCRIPTION_MODULE)

    const subscription = await subscriptionModuleService.retrieveSubscription(
      input.subscription_id
    )

    if (!subscription) {
      throw subscriptionErrors.notFound("Subscription", input.subscription_id)
    }

    if (isNativeSubscriptionReference(subscription.reference)) {
      throw subscriptionErrors.invalidData(
        `Subscription '${input.subscription_id}' is a mirror of a provider-managed recurrence; manage auto-renewal at the provider`
      )
    }

    return new StepResponse<AutoRenewSubscriptionState>({
      id: subscription.id,
      reference: subscription.reference,
      status: subscription.status,
      next_renewal_at: subscription.next_renewal_at ?? null,
      // A row with no stored mode is not charging on its own, so it cannot be
      // reported as switching to auto by a stale renewal date.
      current_mode: readStoredPaymentMode(subscription.payment_context, "manual"),
    })
  }
)

/**
 * Surprise-charge guard: switching a subscription on is refused while it is
 * overdue, and disabling is never refused — turning automatic charging off
 * cannot charge anybody.
 */
export const assertAutoRenewNotOverdueStep = createStep(
  ASSERT_AUTO_RENEW_NOT_OVERDUE_STEP_NAME,
  async function (input: AutoRenewOverdueGuardStepInput) {
    const targetMode: SubscriptionPaymentMode = input.enabled ? "auto" : "manual"

    if (targetMode !== "auto" || input.current_mode === "auto") {
      return new StepResponse<AutoRenewOverdueGuardStepResult>({
        payment_mode: targetMode,
      })
    }

    const nextRenewal = input.next_renewal_at
      ? new Date(input.next_renewal_at).getTime()
      : null

    if (
      input.status === SubscriptionStatus.PAST_DUE ||
      (nextRenewal !== null &&
        Date.now() - nextRenewal > AUTO_RENEW_OVERDUE_GRACE_MS)
    ) {
      throw subscriptionErrors.invalidData(
        `Subscription '${input.id}' is overdue — renew manually before enabling auto-renewal`
      )
    }

    return new StepResponse<AutoRenewOverdueGuardStepResult>({
      payment_mode: targetMode,
    })
  }
)

/**
 * The only write `POST /store/saas/auto-renew` performs.
 *
 * `payment_context` is a jsonb object several paths own, so the update merges
 * the stored object and replaces only the mode and its mechanism annotation
 * (together — see `buildPaymentModeFields`). The row is re-read here rather
 * than reused from the guards: a merge of a stale snapshot would drop whatever
 * another path committed in between.
 */
export const updateSubscriptionPaymentModeStep = createStep(
  "update-subscription-payment-mode",
  async function (
    input: UpdateSubscriptionPaymentModeStepInput,
    { container }
  ) {
    const subscriptionModuleService: SubscriptionModuleService =
      container.resolve(SUBSCRIPTION_MODULE)

    const subscription = await subscriptionModuleService.retrieveSubscription(
      input.subscription_id
    )

    if (!subscription) {
      throw subscriptionErrors.notFound("Subscription", input.subscription_id)
    }

    const previousContext: Record<string, unknown> | null =
      subscription.payment_context ?? null
    const previousMode = readStoredPaymentMode(previousContext, "manual")

    await subscriptionModuleService.updateSubscriptions({
      // MedusaService-generated updater takes the entity object (id included).
      id: subscription.id,
      payment_context: {
        ...previousContext,
        ...buildPaymentModeFields(input.payment_mode),
      },
    })

    return new StepResponse<
      UpdateSubscriptionPaymentModeStepResult,
      PaymentModeCompensation
    >(
      {
        subscription_id: subscription.id,
        payment_mode: input.payment_mode,
        previous_mode: previousMode,
      },
      { id: subscription.id, payment_context: previousContext }
    )
  },
  async function (compensation: PaymentModeCompensation, { container }) {
    if (!compensation) {
      return
    }

    const subscriptionModuleService: SubscriptionModuleService =
      container.resolve(SUBSCRIPTION_MODULE)

    // Not a verbatim restore, and the difference is which branch the DAL takes
    // (`.agents/lessons.md`, "A jsonb Write Merges On One Path Only"): a stored
    // non-object takes the overwriting branch, so a `null` column really does
    // come back cleared, while an object merges and any key another path
    // committed between the read and this write survives it. Restoring the mode
    // and its annotation is the toggle's job; the surviving neighbours belong to
    // whoever wrote them.
    await subscriptionModuleService.updateSubscriptions({
      id: compensation.id,
      payment_context: compensation.payment_context,
    })
  }
)
