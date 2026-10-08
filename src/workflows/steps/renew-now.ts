import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { ContainerRegistrationKeys, MedusaError } from "@medusajs/framework/utils"
import { SUBSCRIPTION_MODULE } from "../../modules/subscription"
import SubscriptionModuleService from "../../modules/subscription/service"
import {
  SubscriptionStatus,
  type SubscriptionPaymentMode,
} from "../../modules/subscription/types"
import { isNativeSubscriptionReference } from "../../modules/subscription/utils/native-subscription"
import { resolveRenewalPaymentContext } from "../../modules/subscription/utils/preferred-payment-method"
import { RENEWAL_MODULE } from "../../modules/renewal"
import type RenewalModuleService from "../../modules/renewal/service"
import { RenewalCycleStatus } from "../../modules/renewal/types"
import { processRenewalCycleWorkflow } from "../process-renewal-cycle"
import {
  createManualRenewalWorkflow,
  RENEW_CUSTOMER_REFUSALS,
} from "../create-manual-renewal"
import { classifyStepFailure, logUnquotedStepFailure, type StepFailureLogger } from "../utils/store-step-failure"

/**
 * The on-demand "renew now" path (0.9.3, plan ticket 01④, user item 8): the
 * store endpoint the storefront's Renew-now button calls. One flow, two
 * rails, no parallel ledger:
 *
 * - **a usable payment method** (the plugin's preferred method for the
 *   subscription's product, else the row's own reference — the exact
 *   resolution the renewal engine uses) → the subscription's open renewal
 *   cycle runs through `processRenewalCycleWorkflow`: order, off-session
 *   charge of that method, period finalization, next cycle. Nothing new is
 *   invented; the attempt/recording machinery is the engine's own.
 * - **no usable method** → `createManualRenewalWorkflow`, the existing
 *   PayPal-approval (cashier link) manual renewal flow; the cycle is
 *   finalized by the payment capture, exactly as the storefront's manual
 *   renewal always worked.
 *
 * Which rail applies is decided once, in this step, before anything runs. A
 * trial subscription is refused (it renews by conversion), a provider-owned
 * mirror is refused, and a renewal already in progress is a conflict.
 */

export type RenewNowStepInput = {
  subscription_id: string
  customer_id: string
}

export type RenewNowStepOutput = {
  mode: "charged" | "manual_link"
  subscription_id: string
  renewal_cycle_id: string | null
  order_id: string | null
  total: number | null
  currency_code: string | null
  redirect_url: string | null
}

type SubscriptionRow = {
  id: string
  reference: string
  status: SubscriptionStatus
  customer_id: string
  product_id: string
  payment_context: {
    payment_provider_id?: string | null
    payment_method_reference?: string | null
  } | null
}

type CycleRow = {
  id: string
  status: RenewalCycleStatus
  scheduled_for: Date | string
}

export const renewNowStep = createStep(
  "renew-now",
  async function (input: RenewNowStepInput, { container }) {
    const subscriptionModule =
      container.resolve<SubscriptionModuleService>(SUBSCRIPTION_MODULE)

    // Ownership like every other /store/customers/me/* action.
    const owned = await subscriptionModule.listSubscriptions({
      id: input.subscription_id,
      customer_id: input.customer_id,
    })
    const subscription = owned[0] as unknown as SubscriptionRow | undefined

    if (!subscription) {
      throw new MedusaError(
        MedusaError.Types.NOT_FOUND,
        `Subscription '${input.subscription_id}' was not found for the authenticated customer.`
      )
    }

    if (isNativeSubscriptionReference(subscription.reference)) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `Subscription '${subscription.id}' is a mirror of a provider-managed recurrence and cannot be renewed here`
      )
    }

    const renewalModule = container.resolve<RenewalModuleService>(RENEWAL_MODULE)
    const cycles = (await renewalModule.listRenewalCycles({
      subscription_id: subscription.id,
    } as Record<string, unknown>)) as unknown as CycleRow[]

    if (
      cycles.some((cycle) => cycle.status === RenewalCycleStatus.PROCESSING)
    ) {
      throw new MedusaError(
        MedusaError.Types.CONFLICT,
        `Subscription '${subscription.id}' already has a renewal in progress.`
      )
    }

    const byScheduled = (left: CycleRow, right: CycleRow) =>
      new Date(left.scheduled_for).getTime() -
      new Date(right.scheduled_for).getTime()
    const scheduled = cycles
      .filter((cycle) => cycle.status === RenewalCycleStatus.SCHEDULED)
      .sort(byScheduled)
    const failed = cycles
      .filter((cycle) => cycle.status === RenewalCycleStatus.FAILED)
      .sort(byScheduled)

    // The next scheduled period, else a failed one (retry semantics).
    const cycle = scheduled[0] ?? failed[0]

    if (!cycle) {
      throw new MedusaError(
        MedusaError.Types.CONFLICT,
        `Subscription '${subscription.id}' has no renewable renewal cycle.`
      )
    }

    if (
      subscription.status !== SubscriptionStatus.ACTIVE &&
      subscription.status !== SubscriptionStatus.PAST_DUE
    ) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `Subscription '${subscription.id}' is '${subscription.status}'; only active or past-due subscriptions can be renewed now`
      )
    }

    // The method the charge would use — the same resolution the renewal
    // engine applies (plugin preferred method for the product, else the row).
    const paymentContext = await resolveRenewalPaymentContext(container, {
      customerId: subscription.customer_id,
      scope: subscription.product_id,
      fallback: {
        payment_provider_id: subscription.payment_context?.payment_provider_id ?? null,
        payment_method_reference:
          subscription.payment_context?.payment_method_reference ?? null,
      },
    })
    const hasUsableMethod = Boolean(
      paymentContext.providerId && paymentContext.reference
    )

    if (hasUsableMethod) {
      // The engine path: order, off-session charge of the resolved method,
      // period finalization, next cycle — the renewal attempt/recording
      // machinery is the engine's own.
      const { result } = await processRenewalCycleWorkflow(container).run({
        input: {
          renewal_cycle_id: cycle.id,
          trigger_type: "manual",
          triggered_by: input.customer_id,
          reason: "storefront renew now",
        },
      })

      return new StepResponse<RenewNowStepOutput, null>(
        {
          mode: "charged",
          subscription_id: subscription.id,
          renewal_cycle_id: result.renewal_cycle.id,
          order_id: result.generated_order_id ?? null,
          total: null,
          currency_code: null,
          redirect_url: null,
        },
        null
      )
    }

    // The approval path: the existing manual renewal flow returns the cashier
    // link; its declared refusals are rethrown in its own words.
    const { result, errors } = await createManualRenewalWorkflow(container).run({
      input: {
        subscription_id: subscription.id,
        triggered_by: input.customer_id,
        reason: "storefront renew now",
      },
      throwOnError: false,
    })

    if (errors?.length || !result) {
      const refusal = classifyStepFailure({
        errors,
        refusals: RENEW_CUSTOMER_REFUSALS,
        copy: {
          notFound: "subscription not found",
          refused: "manual renewal was refused",
          failed: "manual renewal failed",
        },
        preserveQuotedStatus: true,
      })

      if (refusal.quoted) {
        throw new MedusaError(refusal.type, refusal.message)
      }

      // A failure outside the workflow's declared refusals is an operator
      // problem, not a customer one: the step answers with one fixed sentence
      // so nothing internal leaks, which means this log is the only place the
      // real cause is ever written down. Without it a broken renewal reads as
      // "unexpected_state" in the HTTP log and nowhere else — which is exactly
      // how a unique-constraint collision on `renewal_attempt` stayed invisible.
      logUnquotedStepFailure(
        container.resolve<StepFailureLogger>(ContainerRegistrationKeys.LOGGER),
        "renew-now",
        refusal
      )

      throw new MedusaError(
        MedusaError.Types.UNEXPECTED_STATE,
        `Renew-now failed for subscription '${subscription.id}'.`
      )
    }

    return new StepResponse<RenewNowStepOutput, null>(
      {
        mode: "manual_link",
        subscription_id: subscription.id,
        renewal_cycle_id: result.renewal_cycle_id,
        order_id: result.renewal_order_id,
        total: result.total,
        currency_code: result.currency_code,
        redirect_url: result.redirect_url,
      },
      null
    )
  }
)
