import { IPaymentModuleService, MedusaContainer } from "@medusajs/framework/types"
import { BigNumberInput } from "@medusajs/types"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import {
  createOrderWorkflow,
  createPaymentSessionsWorkflow,
} from "@medusajs/medusa/core-flows"
import { RENEWAL_MODULE } from "../../modules/renewal"
import RenewalModuleService from "../../modules/renewal/service"
import {
  RenewalAppliedPendingUpdateData,
  RenewalApprovalStatus,
  RenewalAttemptStatus,
  RenewalCycleStatus,
} from "../../modules/renewal/types"
import { renewalErrors } from "../../modules/renewal/utils/errors"
import {
  classifyRenewalFailure,
  createRenewalCorrelationId,
  getRenewalErrorMessage,
  isAlertableRenewalFailure,
  logRenewalEvent,
} from "../../modules/renewal/utils/observability"
import { normalizeActivityLogEvent } from "../../modules/activity-log/utils/normalize-log-event"
import {
  ActivityLogActorType,
  ActivityLogEventType,
} from "../../modules/activity-log/types"
import { resolveProductSubscriptionConfig } from "../../modules/plan-offer/utils/effective-config"
import { SUBSCRIPTION_MODULE } from "../../modules/subscription"
import SubscriptionModuleService from "../../modules/subscription/service"
import {
  SubscriptionFrequencyInterval,
  SubscriptionPaymentMode,
  SubscriptionPendingUpdateData,
  SubscriptionStatus,
} from "../../modules/subscription/types"
import { subscriptionErrors } from "../../modules/subscription/utils/errors"
import { finalizeRenewalPeriod } from "./finalize-renewal-period"
import { startDunningWorkflow } from "../start-dunning"
import { DUNNING_MODULE } from "../../modules/dunning"
import type DunningModuleService from "../../modules/dunning/service"
import { DunningCaseStatus } from "../../modules/dunning/types"
import {
  OPEN_DUNNING_CASE_STATUSES,
  resolveCycleDisposition,
} from "../../modules/renewal/utils/cycle-disposition"
import {
  getEffectiveSubscriptionSettings,
} from "../utils/subscription-settings"
import { buildDefaultSubscriptionSettings } from "../../modules/settings/utils/normalize-settings"
import {
  resolveOrderPaymentCollection,
} from "../utils/resolve-order-payment-collection"
import { persistAndEmitSubscriptionLogEvent } from "./create-subscription-log-event"
import { persistRenewalResolutionEvent } from "../utils/renewal-log-event"
import { toISOStringOrNull } from "../utils/date-output"

type CartRecord = {
  id: string
  region_id: string | null
  sales_channel_id: string | null
  currency_code: string
  email: string | null
  customer_id: string | null
  shipping_address: Record<string, unknown> | null
  billing_address: Record<string, unknown> | null
  items?: Array<Record<string, any>>
  shipping_methods?: Array<Record<string, any>>
}

type OrderRecord = {
  id: string
  total?: number | string | null
  currency_code?: string
}

type PaymentSessionRecord = {
  id: string
  context?: Record<string, unknown> | null
}

type PaymentRecord = {
  id: string
  amount: BigNumberInput
}

type SubscriptionRecord = {
  id: string
  reference: string
  status: SubscriptionStatus
  customer_id: string
  cart_id: string | null
  product_id: string
  variant_id: string
  frequency_interval: SubscriptionFrequencyInterval
  frequency_value: number
  next_renewal_at: Date | null
  last_renewal_at: Date | null
  paused_at: Date | null
  cancelled_at: Date | null
  cancel_effective_at: Date | null
  skip_next_cycle: boolean
  free_cycles_remaining: number | null
  is_trial: boolean
  trial_ends_at: Date | null
  customer_snapshot: {
    email?: string
    full_name?: string | null
  } | null
  product_snapshot: {
    product_id: string
    product_title: string
    variant_id: string
    variant_title: string
    sku: string | null
  }
  shipping_address: Record<string, unknown>
  pending_update_data: SubscriptionPendingUpdateData | null
  payment_context: {
    payment_provider_id: string | null
    // Optional because `payment_context` is a nullable jsonb column: rows
    // persisted before the discriminator existed carry no such key (no writer
    // ever stores a null). A missing value resolves to "manual" — see
    // `resolveTrialConversionDecision`.
    payment_mode?: SubscriptionPaymentMode
    source_payment_collection_id: string | null
    source_payment_session_id: string | null
    payment_method_reference: string | null
    customer_payment_reference: string | null
  } | null
  metadata: Record<string, unknown> | null
}

export type ProcessRenewalCycleStepInput = {
  renewal_cycle_id: string
  trigger_type: "scheduler" | "manual"
  triggered_by?: string | null
  reason?: string | null
  correlation_id?: string | null
}

type RenewalCycleRecord = {
  id: string
  subscription_id: string
  scheduled_for: Date
  processed_at: Date | null
  status: RenewalCycleStatus
  approval_required: boolean
  approval_status: RenewalApprovalStatus | null
  approval_decided_at: Date | null
  approval_decided_by: string | null
  approval_reason: string | null
  generated_order_id: string | null
  applied_pending_update_data: RenewalAppliedPendingUpdateData | null
  last_error: string | null
  last_failure_kind: string | null
  attempt_count: number
  structural_attempt_count: number
  metadata: Record<string, unknown> | null
}

type PaymentQualifiedFailureSource =
  | "payment_session"
  | "payment_provider"
  | "payment_capture"

type PaymentQualifiedRenewalError = Error & {
  dunning_payment_failure_source?: PaymentQualifiedFailureSource
  dunning_payment_error_code?: string | null
  dunning_renewal_order_id?: string | null
}

function getRenewalActivityLogActorType(triggerType: "scheduler" | "manual") {
  return triggerType === "manual"
    ? ActivityLogActorType.USER
    : ActivityLogActorType.SCHEDULER
}

function isPendingUpdateApplicable(
  scheduledFor: Date,
  pendingUpdateData: SubscriptionPendingUpdateData | null
) {
  if (!pendingUpdateData) {
    return false
  }

  if (!pendingUpdateData.effective_at) {
    return true
  }

  return new Date(pendingUpdateData.effective_at) <= scheduledFor
}

async function loadCycle(
  container: MedusaContainer,
  id: string
): Promise<RenewalCycleRecord> {
  const renewalModule = container.resolve<RenewalModuleService>(RENEWAL_MODULE)

  try {
    return (await renewalModule.retrieveRenewalCycle(
      id
    )) as unknown as RenewalCycleRecord
  } catch {
    throw renewalErrors.notFound("RenewalCycle", id)
  }
}

async function loadSubscription(
  container: MedusaContainer,
  id: string
): Promise<SubscriptionRecord> {
  const subscriptionModule =
    container.resolve<SubscriptionModuleService>(SUBSCRIPTION_MODULE)

  try {
    return (await subscriptionModule.retrieveSubscription(
      id
    )) as unknown as SubscriptionRecord
  } catch {
    throw subscriptionErrors.notFound("Subscription", id)
  }
}

async function loadOpenDunningCaseForCycle(
  container: MedusaContainer,
  renewalCycleId: string
): Promise<{ id: string; status: DunningCaseStatus } | null> {
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const { data } = await query.graph({
    entity: "dunning_case",
    fields: ["id", "status"],
    filters: {
      renewal_cycle_id: [renewalCycleId],
      status: [...OPEN_DUNNING_CASE_STATUSES],
    },
  })

  return (data as { id: string; status: DunningCaseStatus }[])[0] ?? null
}

/**
 * Q4 race guard: close an open dunning case when the automatic success path
 * settles the period anyway. With the disposition predicate (Task 3), the due
 * query never selects a cycle an open dunning case owns, so this is NOT the
 * main recovery path — it only covers the race where an open case coexists
 * with a settling run: the case is opened after the scheduler's due snapshot
 * (e.g. by a failing concurrent force-run of the same cycle) or the run is a
 * manual force that bypasses the due query entirely. No open case may survive
 * a settled period.
 *
 * The `recovery_reason` distinguishes this path from a dunning-side recovery:
 * the period was paid by the renewal order THIS run created — a later order
 * than the failed one the case was opened for.
 *
 * Callers run this best-effort AFTER `finalizeRenewalPeriod`: the period is
 * already settled, so a closure failure must not fall into the failure
 * handler and re-mark a paid period as failed. If the closure fails, the
 * settled-cycle guard (R2) in `run-dunning-retry` closes the case on the next
 * retry without charging.
 */
async function closeOpenDunningCaseOnRenewalSuccess(
  container: MedusaContainer,
  renewalCycleId: string
): Promise<void> {
  const dunningModule = container.resolve<DunningModuleService>(DUNNING_MODULE)
  const openCase = await loadOpenDunningCaseForCycle(container, renewalCycleId)

  if (!openCase) {
    return
  }

  // Re-read at settlement time rather than reusing the case loaded at the top
  // of the step: a case closed in between must keep its own outcome.
  const closedAt = new Date()

  await dunningModule.updateDunningCases({
    id: openCase.id,
    status: DunningCaseStatus.RECOVERED,
    next_retry_at: null,
    recovered_at: closedAt,
    closed_at: closedAt,
    recovery_reason: "renewal_order_paid",
  } as any)
}

async function loadCart(
  container: MedusaContainer,
  id: string
): Promise<CartRecord> {
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const { data } = await query.graph({
    entity: "cart",
    fields: [
      "id",
      "region_id",
      "sales_channel_id",
      "currency_code",
      "email",
      "customer_id",
      "shipping_address.*",
      "billing_address.*",
      "items.*",
      "shipping_methods.*",
    ],
    filters: {
      id: [id],
    },
  })

  const cart = (data as CartRecord[])[0]

  if (!cart) {
    throw renewalErrors.notFound("Cart", id)
  }

  return cart
}

async function loadOrderCharge(
  container: MedusaContainer,
  id: string
): Promise<{ total: number; currency_code: string }> {
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const { data } = await query.graph({
    entity: "order",
    fields: ["id", "total", "currency_code"],
    filters: {
      id: [id],
    },
  })

  const order = (data as OrderRecord[])[0]

  if (!order) {
    throw renewalErrors.notFound("Order", id)
  }

  return {
    total: Number(order.total ?? 0),
    currency_code: order.currency_code ?? "",
  }
}

async function validateSubscriptionEligibility(
  container: MedusaContainer,
  cycle: RenewalCycleRecord,
  subscription: SubscriptionRecord
) {
  if (
    subscription.status !== SubscriptionStatus.ACTIVE &&
    subscription.status !== SubscriptionStatus.PAST_DUE
  ) {
    throw subscriptionErrors.invalidState(
      subscription.id,
      "renew",
      subscription.status
    )
  }

  if (subscription.paused_at) {
    throw renewalErrors.subscriptionNotEligible(
      subscription.id,
      "subscription is paused"
    )
  }

  if (
    subscription.cancel_effective_at &&
    subscription.cancel_effective_at <= cycle.scheduled_for
  ) {
    throw renewalErrors.subscriptionNotEligible(
      subscription.id,
      `cancel is effective for renewal date '${cycle.scheduled_for.toISOString()}'`
    )
  }

  if (
    subscription.is_trial &&
    subscription.trial_ends_at &&
    cycle.scheduled_for < subscription.trial_ends_at
  ) {
    throw renewalErrors.subscriptionNotEligible(
      subscription.id,
      `subscription is still in trial for renewal date '${cycle.scheduled_for.toISOString()}'`
    )
  }
}

async function resolveAppliedPendingChanges(
  container: MedusaContainer,
  cycle: RenewalCycleRecord,
  subscription: SubscriptionRecord
): Promise<RenewalAppliedPendingUpdateData | null> {
  if (
    !isPendingUpdateApplicable(cycle.scheduled_for, subscription.pending_update_data)
  ) {
    return null
  }

  if (cycle.approval_required) {
    if (cycle.approval_status !== RenewalApprovalStatus.APPROVED) {
      throw renewalErrors.invalidTransition(
        cycle.id,
        `Renewal '${cycle.id}' requires approval before pending changes can be applied`
      )
    }
  }

  const pending = subscription.pending_update_data

  if (!pending) {
    return null
  }

  const effectiveConfig = await resolveProductSubscriptionConfig(container, {
    product_id: subscription.product_id,
    variant_id: pending.variant_id,
  })

  if (!effectiveConfig.is_enabled) {
    throw subscriptionErrors.planChangeNotAllowed(
      subscription.product_id,
      pending.variant_id
    )
  }

  const isAllowedFrequency = effectiveConfig.allowed_frequencies.some(
    (frequency) =>
      String(frequency.interval) === pending.frequency_interval &&
      frequency.value === pending.frequency_value
  )

  if (!isAllowedFrequency) {
    throw subscriptionErrors.planChangeFrequencyNotAllowed(
      pending.frequency_interval,
      pending.frequency_value
    )
  }

  return {
    variant_id: pending.variant_id,
    variant_title: pending.variant_title,
    frequency_interval: pending.frequency_interval,
    frequency_value: pending.frequency_value,
    effective_at: pending.effective_at,
  }
}

function buildOrderItems(
  cart: CartRecord,
  subscription: SubscriptionRecord,
  appliedPendingChanges: RenewalAppliedPendingUpdateData | null
) {
  const sourceItem =
    cart.items?.find((item) => item.variant_id === subscription.variant_id) ??
    cart.items?.[0]

  if (!sourceItem) {
    throw renewalErrors.invalidData(
      `Source cart '${cart.id}' doesn't contain any items for renewal`
    )
  }

  const variantId = appliedPendingChanges?.variant_id ?? subscription.variant_id
  const variantTitle =
    appliedPendingChanges?.variant_title ??
    sourceItem.variant_title ??
    subscription.product_snapshot.variant_title

  return [
    {
      title: sourceItem.title ?? variantTitle,
      quantity: sourceItem.quantity ?? 1,
      product_id: subscription.product_id,
      product_title: subscription.product_snapshot.product_title,
      variant_id: variantId,
      variant_title: variantTitle,
      variant_sku:
        sourceItem.variant_sku ??
        subscription.pending_update_data?.sku ??
        subscription.product_snapshot.sku ??
        undefined,
      requires_shipping: sourceItem.requires_shipping ?? true,
      is_discountable: sourceItem.is_discountable ?? true,
      // No `renewal_source_cart_id` here: the host storefront requests
      // `*items.metadata`, so writing the cart id into the order's line-item
      // metadata hands a live credential to the customer. Nothing reads the
      // field; the order's own metadata carries subscription_id /
      // renewal_cycle_id for tracing.
      metadata: {},
    },
  ] as any[]
}

function buildShippingMethods(cart: CartRecord) {
  return (
    cart.shipping_methods?.map((method) => ({
      name: method.name,
      amount: method.amount,
      is_tax_inclusive: method.is_tax_inclusive,
      shipping_option_id: method.shipping_option_id,
      data: method.data,
    })) ?? []
  ) as any[]
}

/**
 * Whether the renewal order about to be created would carry a charged line.
 *
 * `buildOrderItems` returns no price at all — core prices the variant when the
 * order is created — so the cart's own lines are the only pre-order signal.
 * The order item is priced by the effective variant (the pending variant swap,
 * else the subscription's variant), so the lines that matter are the cart's
 * lines for that variant, read off `cart.items[].unit_price`. When the cart has
 * no line for the effective variant there is no zero-price proof either — core
 * would resolve the variant's price from the region price list — so the answer
 * stays conservative (`true`) and the caller refuses.
 */
function cartCarriesPricedLineAfterSwap(
  cart: CartRecord,
  subscription: SubscriptionRecord,
  appliedPendingChanges: RenewalAppliedPendingUpdateData | null
): boolean {
  const effectiveVariantId =
    appliedPendingChanges?.variant_id ?? subscription.variant_id
  const effectiveLines = (cart.items ?? []).filter(
    (item) => item.variant_id === effectiveVariantId
  )

  if (!effectiveLines.length) {
    return true
  }

  return effectiveLines.some((item) => Number(item.unit_price ?? 0) > 0)
}

async function createRenewalOrder(
  container: MedusaContainer,
  cycle: RenewalCycleRecord,
  subscription: SubscriptionRecord,
  cart: CartRecord,
  appliedPendingChanges: RenewalAppliedPendingUpdateData | null
) {
  if (!cart.region_id) {
    throw renewalErrors.invalidData(
      `Source cart '${cart.id}' is missing 'region_id'`
    )
  }

  if (!cart.sales_channel_id) {
    throw renewalErrors.invalidData(
      `Source cart '${cart.id}' is missing 'sales_channel_id'`
    )
  }

  // T7 pre-order guard. The payment-context check used to sit after
  // `createOrderWorkflow`, inside a step with no compensating function, so a
  // subscription that structurally cannot be charged did not produce one
  // failed cycle — it produced one orphan order per attempt: the order links
  // and the `generated_order_id` write both sit after the post-order guard,
  // so the minted order is never linked and the failure records
  // `generated_order_id: null`. Refuse before anything is created instead.
  //
  // The check is deliberately conservative, and it differs from the
  // authoritative post-order check below in exactly one case, in the safe
  // direction: it reads the cart's own lines rather than the order's real
  // total (which a pre-order decision cannot know — promotions, tax,
  // rounding), so a cart whose order would price to zero through promotions
  // still refuses. A subscription with no payment context is structurally
  // unchargeable and a loud refusal is the intended outcome.
  const paymentContext = subscription.payment_context

  if (
    (!paymentContext?.payment_provider_id ||
      !paymentContext.payment_method_reference) &&
    cartCarriesPricedLineAfterSwap(cart, subscription, appliedPendingChanges)
  ) {
    throw renewalErrors.renewalOrderCreationFailed(
      cycle.id,
      `Subscription '${subscription.id}' is missing renewal payment context`
    )
  }

  const orderResult = await createOrderWorkflow(container).run({
    input: {
      region_id: cart.region_id,
      sales_channel_id: cart.sales_channel_id,
      customer_id: subscription.customer_id,
      email: cart.email ?? subscription.customer_snapshot?.email ?? undefined,
      currency_code: cart.currency_code,
      shipping_address: cart.shipping_address ?? subscription.shipping_address,
      billing_address: cart.billing_address ?? undefined,
      items: buildOrderItems(cart, subscription, appliedPendingChanges),
      shipping_methods: buildShippingMethods(cart),
      metadata: {
        renewal_cycle_id: cycle.id,
        subscription_id: subscription.id,
        renewal_trigger: "automatic",
      },
    } as any,
  })

  const order = orderResult.result
  const { total, currency_code: currencyCode } = await loadOrderCharge(
    container,
    order.id
  )

  if (total > 0) {
    const paymentContext = subscription.payment_context

    // Authoritative payment-context check: this one reads the order's real
    // total, which the hoisted pre-order guard cannot know. It stays the
    // check of record; the pre-order guard only narrows when an order is
    // minted at all.
    if (
      !paymentContext?.payment_provider_id ||
      !paymentContext.payment_method_reference
    ) {
      throw renewalErrors.renewalOrderCreationFailed(
        cycle.id,
        `Subscription '${subscription.id}' is missing renewal payment context`
      )
    }

    let paymentCollection: { id: string }

    try {
      paymentCollection = await resolveOrderPaymentCollection(container, {
        order_id: order.id,
        amount: total,
        currency_code: currencyCode,
      })
    } catch (error) {
      throw createPaymentQualifiedRenewalError(
        error,
        "payment_session",
        order.id
      )
    }

    let paymentSessionResult: { result: PaymentSessionRecord }

    try {
      paymentSessionResult = await createPaymentSessionsWorkflow(container).run({
        input: {
          payment_collection_id: paymentCollection.id,
          provider_id: paymentContext.payment_provider_id,
          customer_id: subscription.customer_id,
          data: {
            payment_method: paymentContext.payment_method_reference,
            off_session: true,
            confirm: true,
            capture_method: "automatic",
          },
        },
      })
    } catch (error) {
      throw createPaymentQualifiedRenewalError(
        error,
        "payment_session",
        order.id
      )
    }

    const paymentModule =
      container.resolve<IPaymentModuleService>(Modules.PAYMENT)
    let payment: PaymentRecord | undefined | null

    try {
      payment = await paymentModule.authorizePaymentSession(
        paymentSessionResult.result.id,
        paymentSessionResult.result.context ?? {}
      )
    } catch (error) {
      throw createPaymentQualifiedRenewalError(
        error,
        "payment_provider",
        order.id
      )
    }

    if (payment?.id) {
      try {
        await paymentModule.capturePayment({
          payment_id: payment.id,
          amount: payment.amount,
        })
      } catch (error) {
        throw createPaymentQualifiedRenewalError(
          error,
          "payment_capture",
          order.id
        )
      }
    }
  }

  const link = container.resolve(ContainerRegistrationKeys.LINK)

  await link.create({
    [RENEWAL_MODULE]: {
      renewal_cycle_id: cycle.id,
    },
    [Modules.ORDER]: {
      order_id: order.id,
    },
  })

  await link.create({
    [SUBSCRIPTION_MODULE]: {
      subscription_id: subscription.id,
    },
    [Modules.ORDER]: {
      order_id: order.id,
    },
  })

  return order
}

function createPaymentQualifiedRenewalError(
  error: unknown,
  source: PaymentQualifiedFailureSource,
  renewalOrderId: string
): PaymentQualifiedRenewalError {
  const message = getRenewalErrorMessage(error)
  const nextError =
    error instanceof Error ? error : new Error(message)

  const typedError = nextError as PaymentQualifiedRenewalError
  typedError.dunning_payment_failure_source = source
  typedError.dunning_payment_error_code = null
  typedError.dunning_renewal_order_id = renewalOrderId

  return typedError
}

function getPaymentQualifiedFailureContext(
  error: unknown
): {
  source: PaymentQualifiedFailureSource
  error_code: string | null
  renewal_order_id: string | null
} | null {
  if (!error || typeof error !== "object") {
    return null
  }

  const typedError = error as PaymentQualifiedRenewalError

  if (!typedError.dunning_payment_failure_source) {
    return null
  }

  return {
    source: typedError.dunning_payment_failure_source,
    error_code: typedError.dunning_payment_error_code ?? null,
    renewal_order_id: typedError.dunning_renewal_order_id ?? null,
  }
}

/**
 * The effective structural-failure cap: how many consecutive structural
 * failures one period may accumulate before the cycle is abandoned. Dunning
 * must never read this as its own retry budget — `attempt_count` also counts
 * payment attempts dunning owns, so capping on it would abandon cycles whose
 * payment retries are still legitimately in flight.
 */
async function resolveRenewalMaxAttempts(
  container: MedusaContainer
): Promise<number> {
  // A settings read failure must not escalate a renewal failure into a cycle
  // stuck in `processing` (this runs inside the failure handler): fall back
  // to the shipped default cap.
  try {
    const settings = await getEffectiveSubscriptionSettings(container)

    return settings.renewal_max_attempts
  } catch {
    return buildDefaultSubscriptionSettings().renewal_max_attempts
  }
}

/**
 * The next structural-failure state for a cycle: the consecutive structural
 * count increments, and at or above `renewal_max_attempts` the cycle is
 * abandoned instead of being re-armed for the five-minute scheduler loop.
 * `attempt_count` is deliberately not consulted — see
 * `resolveRenewalMaxAttempts` for why it cannot express this cap.
 */
function resolveStructuralFailureOutcome(
  cycle: RenewalCycleRecord,
  renewalMaxAttempts: number
): {
  status: RenewalCycleStatus.FAILED | RenewalCycleStatus.ABANDONED
  structural_attempt_count: number
} {
  const structuralAttemptCount = (cycle.structural_attempt_count ?? 0) + 1

  return {
    status:
      structuralAttemptCount >= renewalMaxAttempts
        ? RenewalCycleStatus.ABANDONED
        : RenewalCycleStatus.FAILED,
    structural_attempt_count: structuralAttemptCount,
  }
}

/**
 * Why a trial's trial-end cycle converts or ends (Task 14 of the billing
 * hardening plan), evaluated in the plan's order:
 *
 * 1. auto mode **and** a usable payment method reference — both a stored
 *    `payment_provider_id` and a `payment_method_reference`, the same test the
 *    hoisted pre-order guard applies — → "convert": the cycle falls through to
 *    the normal order/charge path for the period anchored on the cycle's own
 *    `scheduled_for`. The subscription's cart is a hard prerequisite of that
 *    path (T6): when it is missing, the path's own guard refuses before any
 *    order is minted or charged. A payment-qualified failure on this path
 *    starts dunning, so the customer can repair their card.
 * 2. anything not auto — manual mode, or rows persisted before
 *    `payment_mode` existed, which the subscription domain's own mode reader
 *    (`readPaymentMode` in `src/modules/subscription/utils/consent-flip.ts`)
 *    also resolves to manual — → "end", with a reason naming the manual rail.
 *    The scheduler's manual-trial carve-out (Task 3) is what delivers this row
 *    on time; this branch adds no second mechanism for it.
 * 3. auto mode without a usable method reference → "end" with an alertable
 *    reason: expected when the offer's `trial_requires_payment_method` rule
 *    is on, a configuration gap when it is off.
 */
type TrialConversionDecision =
  | { action: "convert" }
  | {
      action: "end"
      reason_code: "manual_mode_trial_ended" | "trial_without_payment_method"
      reason: string
    }

function resolveTrialConversionDecision(
  subscription: SubscriptionRecord
): TrialConversionDecision {
  const paymentContext = subscription.payment_context

  if (paymentContext?.payment_mode !== "auto") {
    return {
      action: "end",
      reason_code: "manual_mode_trial_ended",
      reason:
        "Trial ended on the manual payment rail: manual mode never converts automatically",
    }
  }

  const hasUsablePaymentMethod = Boolean(
    paymentContext.payment_provider_id && paymentContext.payment_method_reference
  )

  if (!hasUsablePaymentMethod) {
    return {
      action: "end",
      reason_code: "trial_without_payment_method",
      reason:
        "Trial ended in auto mode without a usable payment method reference: expected when the offer's trial_requires_payment_method rule is on, a configuration gap when it is off",
    }
  }

  return { action: "convert" }
}

export const processRenewalCycleStep = createStep(
  "process-renewal-cycle",
  async function (
    input: ProcessRenewalCycleStepInput,
    { container }
  ) {
    const logger = container.resolve("logger")
    const renewalModule = container.resolve<RenewalModuleService>(RENEWAL_MODULE)
    const subscriptionModule =
      container.resolve<SubscriptionModuleService>(SUBSCRIPTION_MODULE)
    const operationStartedAt = Date.now()
    const correlationId =
      input.correlation_id ??
      createRenewalCorrelationId(`renewal-${input.trigger_type}`)

    const cycle = await loadCycle(container, input.renewal_cycle_id)

    if (cycle.status === RenewalCycleStatus.PROCESSING) {
      throw renewalErrors.alreadyProcessing(cycle.id)
    }

    if (cycle.status === RenewalCycleStatus.SUCCEEDED) {
      throw renewalErrors.duplicateExecutionBlocked(cycle.id)
    }

    const subscription = await loadSubscription(container, cycle.subscription_id)

    // Defensive terminal-state guard: the due query already excludes abandoned
    // and awaiting_manual_resolution cycles, but manual force runs bypass that
    // query. resolveCycleDisposition is the one owner of what may still be
    // executed; "settled" can only name a terminal status here (succeeded was
    // already rejected above), so anything it returns must not re-execute. The
    // other dispositions are deliberately not enforced on this path:
    // "not_chargeable" is rejected later by the eligibility checks with the
    // pinned errors, and "dunning_owns" must not block an operator force-run.
    const openDunningCase = await loadOpenDunningCaseForCycle(
      container,
      cycle.id
    )

    if (
      resolveCycleDisposition(
        { status: cycle.status, scheduled_for: cycle.scheduled_for },
        subscription,
        openDunningCase
      ) === "settled"
    ) {
      throw renewalErrors.invalidTransition(
        cycle.id,
        `Renewal '${cycle.id}' is '${cycle.status}' and can no longer be processed`
      )
    }

    logRenewalEvent(logger, "info", {
      event: "renewal.execution",
      outcome: "started",
      correlation_id: correlationId,
      renewal_cycle_id: cycle.id,
      subscription_id: subscription.id,
      trigger_type: input.trigger_type,
      triggered_by: input.triggered_by ?? null,
      metadata: {
        scheduled_for: cycle.scheduled_for.toISOString(),
        approval_required: cycle.approval_required,
        approval_status: cycle.approval_status,
      },
    })

    let appliedPendingChanges: RenewalAppliedPendingUpdateData | null = null

    try {
      await validateSubscriptionEligibility(container, cycle, subscription)

      appliedPendingChanges = await resolveAppliedPendingChanges(
        container,
        cycle,
        subscription
      )
    } catch (error) {
      const failureKind = classifyRenewalFailure(error)

      logRenewalEvent(logger, "warn", {
        event: "renewal.execution",
        outcome: "blocked",
        correlation_id: correlationId,
        renewal_cycle_id: cycle.id,
        subscription_id: subscription.id,
        trigger_type: input.trigger_type,
        triggered_by: input.triggered_by ?? null,
        duration_ms: Date.now() - operationStartedAt,
        failure_kind: failureKind,
        alertable: isAlertableRenewalFailure(failureKind),
        message: getRenewalErrorMessage(error),
      })

      throw error
    }

    const attemptNo = cycle.attempt_count + 1
    const startedAt = new Date()

    const attempt = await renewalModule.createRenewalAttempts({
      renewal_cycle_id: cycle.id,
      attempt_no: attemptNo,
      started_at: startedAt,
      status: RenewalAttemptStatus.PROCESSING,
      error_code: null,
      error_message: null,
      payment_reference: null,
      order_id: null,
      metadata: {
        trigger_type: input.trigger_type,
        triggered_by: input.triggered_by ?? null,
        reason: input.reason ?? null,
      },
    })

    await renewalModule.updateRenewalCycles({
      id: cycle.id,
      status: RenewalCycleStatus.PROCESSING,
      attempt_count: attemptNo,
      last_error: null,
      applied_pending_update_data: appliedPendingChanges,
      metadata: {
        ...(cycle.metadata ?? {}),
        last_trigger_type: input.trigger_type,
        last_triggered_by: input.triggered_by ?? null,
        last_trigger_reason: input.reason ?? null,
        last_correlation_id: correlationId,
      },
    })

    try {
      let generatedOrderId: string | null = null

      // Trial end as a three-way decision (Task 14 of the billing hardening
      // plan). The eligibility gate above already rejected cycles still
      // inside the trial period, so a trial cycle reaching this branch sits
      // at or after trial_ends_at. "convert" falls through to the normal
      // order/charge path below — a payment-qualified failure there starts
      // dunning so the customer can repair their card. "end" finishes the
      // subscription cleanly: no order, no charge, and NO renewal.succeeded
      // bus event (the SaaS site must not mirror an extension; entitlements
      // expire naturally).
      if (subscription.is_trial) {
        const trialDecision = resolveTrialConversionDecision(subscription)

        if (trialDecision.action === "end") {
          const endedAt = new Date()
          const endedAtAnchor = subscription.trial_ends_at ?? endedAt

          await subscriptionModule.updateSubscriptions({
            id: subscription.id,
            status: SubscriptionStatus.CANCELLED,
            cancelled_at: endedAt,
            cancel_effective_at: endedAtAnchor,
            next_renewal_at: endedAtAnchor,
          })

          const finishedCycle = await renewalModule.updateRenewalCycles({
            id: cycle.id,
            status: RenewalCycleStatus.SUCCEEDED,
            processed_at: endedAt,
            generated_order_id: null,
            last_error: null,
            last_failure_kind: null,
            structural_attempt_count: 0,
          })

          await renewalModule.updateRenewalAttempts({
            id: attempt.id,
            status: RenewalAttemptStatus.SUCCEEDED,
            finished_at: endedAt,
            order_id: null,
            error_code: null,
            error_message: null,
          })

          // Persisted AND emitted through the shared funnel: the host's
          // saas-email-expired subscriber waits on this bus event, which the
          // trial-end branch previously only persisted (live defect fixed in
          // Task 11 of the billing hardening plan). The dedupe key keeps the
          // emission exactly-once per cycle; the reason names the rail and
          // the gap that ended the trial.
          await persistAndEmitSubscriptionLogEvent(
            container,
            normalizeActivityLogEvent({
              subscription_id: subscription.id,
              customer_id: subscription.customer_id,
              event_type: ActivityLogEventType.SUBSCRIPTION_EXPIRED,
              actor_type: getRenewalActivityLogActorType(input.trigger_type),
              actor_id: input.triggered_by ?? null,
              display: {
                subscription_reference: subscription.reference,
                customer_name: subscription.customer_snapshot?.full_name ?? null,
                product_title:
                  subscription.product_snapshot.product_title ?? null,
                variant_title:
                  subscription.product_snapshot.variant_title ?? null,
              },
              previous_state: {
                status: cycle.status,
                attempt_count: cycle.attempt_count,
                processed_at: toISOStringOrNull(cycle.processed_at),
                generated_order_id: cycle.generated_order_id,
                last_error: cycle.last_error,
              },
              new_state: {
                status: finishedCycle.status,
                attempt_count: finishedCycle.attempt_count,
                processed_at: toISOStringOrNull(finishedCycle.processed_at),
                generated_order_id: finishedCycle.generated_order_id,
                last_error: finishedCycle.last_error,
              },
              reason: trialDecision.reason,
              metadata: {
                source: input.trigger_type === "manual" ? "admin" : "scheduler",
                renewal_cycle_id: cycle.id,
                order_id: null,
                trigger_type: input.trigger_type,
                reason_code: trialDecision.reason_code,
                scheduled_for: toISOStringOrNull(cycle.scheduled_for),
                trial_ended_at: toISOStringOrNull(endedAtAnchor),
              },
              correlation_id: correlationId,
              dedupe: {
                scope: "renewal",
                target_id: cycle.id,
                qualifier: toISOStringOrNull(finishedCycle.processed_at),
              },
            })
          )

          return new StepResponse({
            renewal_cycle: finishedCycle,
            subscription_id: subscription.id,
            attempt_id: attempt.id,
            generated_order_id: null,
          })
        }
        // trialDecision.action === "convert": fall through to the normal
        // order/charge path. The subscription's cart is a hard prerequisite
        // (T6) — when it is missing, that path's own guard refuses before
        // anything is created or charged.
      }

      const isFreeCycle =
        subscription.skip_next_cycle ||
        (subscription.free_cycles_remaining ?? 0) > 0

      if (!isFreeCycle) {
        if (!subscription.cart_id) {
          throw renewalErrors.invalidData(
            `Subscription '${subscription.id}' is missing 'cart_id' required for renewal order creation`
          )
        }

        const cart = await loadCart(container, subscription.cart_id)
        const order = await createRenewalOrder(
          container,
          cycle,
          subscription,
          cart,
          appliedPendingChanges
        )

        generatedOrderId = order.id
      }

      // The shared period-finalization step (Task 5): marks the cycle
      // succeeded, advances the cadence anchored on `scheduled_for` (R6),
      // sets `last_renewal_at`, clears the applied pending changes, resets
      // `structural_attempt_count`, and persists + emits `renewal.succeeded`.
      const finalized = await finalizeRenewalPeriod(container, {
        cycle,
        subscription,
        applied_pending_changes: appliedPendingChanges,
        generated_order_id: generatedOrderId,
        trigger: {
          source: input.trigger_type === "manual" ? "admin" : "scheduler",
          trigger_type: input.trigger_type,
          actor_type: getRenewalActivityLogActorType(input.trigger_type),
          actor_id: input.triggered_by ?? null,
          correlation_id: correlationId,
        },
        attempt_id: attempt.id,
        // The next cycle is ensured by the workflow wrapper AFTER this step
        // (ensureNextRenewalCycleStep): an ensure failure inside the step
        // would fall into the failure handler below and re-mark an already
        // settled (paid) period as failed, while outside the step the same
        // failure only fails the workflow and the settlement stands.
        ensure_next_cycle: false,
      })

      // Q4 race guard (Task 7): no open case may survive a settled period.
      // Best-effort by contract — the period is already paid, so a closure
      // failure must not fall into the failure handler below and re-mark the
      // paid period as failed; the settled-cycle guard (R2) in
      // `run-dunning-retry` closes the case on the next retry without
      // charging.
      try {
        await closeOpenDunningCaseOnRenewalSuccess(container, cycle.id)
      } catch (caseCloseError) {
        logRenewalEvent(logger, "warn", {
          event: "renewal.execution",
          outcome: "succeeded",
          alertable: true,
          correlation_id: correlationId,
          renewal_cycle_id: cycle.id,
          subscription_id: subscription.id,
          trigger_type: input.trigger_type,
          triggered_by: input.triggered_by ?? null,
          attempt_no: attemptNo,
          duration_ms: Date.now() - operationStartedAt,
          success_count: 1,
          failure_count: 0,
          message: `Failed to close the open dunning case after renewal success: ${getRenewalErrorMessage(
            caseCloseError
          )}`,
        })
      }

      logRenewalEvent(logger, "info", {
        event: "renewal.execution",
        outcome: "succeeded",
        correlation_id: correlationId,
        renewal_cycle_id: cycle.id,
        subscription_id: subscription.id,
        trigger_type: input.trigger_type,
        triggered_by: input.triggered_by ?? null,
        attempt_no: attemptNo,
        duration_ms: Date.now() - operationStartedAt,
        success_count: 1,
        failure_count: 0,
        metadata: {
          generated_order_id: generatedOrderId,
          applied_pending_changes: Boolean(appliedPendingChanges),
        },
      })

      return new StepResponse({
        renewal_cycle: finalized.renewal_cycle,
        subscription_id: subscription.id,
        attempt_id: attempt.id,
        generated_order_id: generatedOrderId,
      })
    } catch (error) {
      const finishedAt = new Date()
      const message = getRenewalErrorMessage(error)
      const failureKind = classifyRenewalFailure(error)
      const paymentFailure = getPaymentQualifiedFailureContext(error)

      await renewalModule.updateRenewalAttempts({
        id: attempt.id,
        status: RenewalAttemptStatus.FAILED,
        finished_at: finishedAt,
        error_code: "renewal_failed",
        error_message: message,
        order_id: paymentFailure?.renewal_order_id ?? null,
      })

      // Failure bookkeeping. A "blocked" outcome (`already_processing` /
      // `duplicate_execution` — the set `isAlertableRenewalFailure` already
      // encodes) is not a failure of the attempt: nothing ran twice, so it
      // must not increment either counter. A payment-qualified failure hands
      // its retries to dunning (started below), so it is structural only when
      // that handoff itself fails — handled after the dunning attempt. Every
      // other failure reaching this handler is structural: it will reproduce
      // deterministically on the next scheduler pass, so it counts toward
      // `renewal_max_attempts`.
      const blockedKind = !isAlertableRenewalFailure(failureKind)
      const structuralOutcome =
        !blockedKind && !paymentFailure
          ? resolveStructuralFailureOutcome(
              cycle,
              await resolveRenewalMaxAttempts(container)
            )
          : null

      await renewalModule.updateRenewalCycles({
        id: cycle.id,
        status: structuralOutcome?.status ?? RenewalCycleStatus.FAILED,
        processed_at: finishedAt,
        generated_order_id: paymentFailure?.renewal_order_id ?? null,
        last_error: message,
        last_failure_kind: failureKind,
        structural_attempt_count:
          structuralOutcome?.structural_attempt_count ??
          (cycle.structural_attempt_count ?? 0),
      })

      // Emission point (Tasks 11/12): when the cap above turned the cycle
      // `abandoned`, the abandonment is persisted AND emitted through the
      // shared funnel exactly where the write landed. R3: the host receives
      // `renewal.abandoned` and decides what happens to the past-due
      // subscription; this plugin must not cancel it as a side effect.
      if (structuralOutcome?.status === RenewalCycleStatus.ABANDONED) {
        await persistRenewalResolutionEvent(container, {
          event_type: ActivityLogEventType.RENEWAL_ABANDONED,
          subscription_id: subscription.id,
          renewal_cycle_id: cycle.id,
          subscription_display: {
            customer_id: subscription.customer_id,
            reference: subscription.reference,
            customer_name: subscription.customer_snapshot?.full_name ?? null,
            product_title: subscription.product_snapshot.product_title ?? null,
            variant_title:
              appliedPendingChanges?.variant_title ??
              subscription.product_snapshot.variant_title ??
              null,
          },
          previous_state: {
            status: cycle.status,
            attempt_count: cycle.attempt_count,
            processed_at: toISOStringOrNull(cycle.processed_at),
            generated_order_id: cycle.generated_order_id,
            last_error: cycle.last_error,
          },
          new_state: {
            status: structuralOutcome.status,
            attempt_count: attemptNo,
            processed_at: toISOStringOrNull(finishedAt),
            generated_order_id: paymentFailure?.renewal_order_id ?? null,
            last_error: message,
            last_failure_kind: failureKind,
            structural_attempt_count: structuralOutcome.structural_attempt_count,
          },
          reason: message,
          reason_code: failureKind,
          actor_type: getRenewalActivityLogActorType(input.trigger_type),
          actor_id: input.triggered_by ?? null,
          trigger_type: input.trigger_type,
          source: input.trigger_type === "manual" ? "admin" : "scheduler",
          order_id: paymentFailure?.renewal_order_id ?? null,
          attempt_no: attemptNo,
          correlation_id: correlationId,
        })
      }

      // Persisted AND emitted through the shared funnel: the host's
      // saas-email-renewal-failed subscriber declares `renewal.failed` but the
      // event was previously only persisted, so that customer email never sent
      // (live defect fixed in Task 11 of the billing hardening plan).
      await persistAndEmitSubscriptionLogEvent(container, normalizeActivityLogEvent({
        subscription_id: subscription.id,
        customer_id: subscription.customer_id,
        event_type: ActivityLogEventType.RENEWAL_FAILED,
        actor_type: getRenewalActivityLogActorType(input.trigger_type),
        actor_id: input.triggered_by ?? null,
        display: {
          subscription_reference: subscription.reference,
          customer_name: subscription.customer_snapshot?.full_name ?? null,
          product_title: subscription.product_snapshot.product_title ?? null,
          variant_title:
            appliedPendingChanges?.variant_title ??
            subscription.product_snapshot.variant_title ??
            null,
        },
        previous_state: {
          status: cycle.status,
          attempt_count: cycle.attempt_count,
          processed_at: toISOStringOrNull(cycle.processed_at),
          generated_order_id: cycle.generated_order_id,
          last_error: cycle.last_error,
        },
        new_state: {
          status: structuralOutcome?.status ?? RenewalCycleStatus.FAILED,
          attempt_count: attemptNo,
          processed_at: toISOStringOrNull(finishedAt),
          generated_order_id: paymentFailure?.renewal_order_id ?? null,
          last_error: message,
          last_failure_kind: failureKind,
          structural_attempt_count:
            structuralOutcome?.structural_attempt_count ??
            (cycle.structural_attempt_count ?? 0),
          applied_pending_update_data: appliedPendingChanges,
        },
        reason: input.reason ?? null,
        metadata: {
          source: input.trigger_type === "manual" ? "admin" : "scheduler",
          renewal_cycle_id: cycle.id,
          order_id: paymentFailure?.renewal_order_id ?? null,
          trigger_type: input.trigger_type,
          reason_code: failureKind,
          scheduled_for: toISOStringOrNull(cycle.scheduled_for),
        },
        correlation_id: correlationId,
        dedupe: {
          scope: "renewal",
          target_id: cycle.id,
          qualifier: toISOStringOrNull(finishedAt),
        },
      }))

      if (paymentFailure) {
        try {
          await startDunningWorkflow(container).run({
            input: {
              subscription_id: subscription.id,
              renewal_cycle_id: cycle.id,
              renewal_order_id: paymentFailure.renewal_order_id,
              payment_failure_source: paymentFailure.source,
              payment_error_code: paymentFailure.error_code,
              payment_error_message: message,
              failed_at: finishedAt,
              triggered_by: input.triggered_by ?? null,
              reason: input.reason ?? null,
              metadata: {
                renewal_trigger_type: input.trigger_type,
                renewal_attempt_id: attempt.id,
                renewal_attempt_no: attemptNo,
                renewal_correlation_id: correlationId,
              },
            },
          })
        } catch (dunningError) {
          logRenewalEvent(logger, "warn", {
            event: "renewal.dunning",
            outcome: "failed",
            correlation_id: correlationId,
            renewal_cycle_id: cycle.id,
            subscription_id: subscription.id,
            trigger_type: input.trigger_type,
            triggered_by: input.triggered_by ?? null,
            duration_ms: Date.now() - operationStartedAt,
            failure_kind: failureKind,
            alertable: true,
            message: `Failed to start dunning after renewal failure: ${getRenewalErrorMessage(
              dunningError
            )}`,
          })

          // R1: the payment failure's recovery machinery could not start, so
          // dunning does NOT own the retries and the five-minute loop would
          // otherwise resume silently with no case in existence. The failure
          // is therefore structural: it counts toward `renewal_max_attempts`
          // exactly like a non-payment failure.
          const structuralOutcome = resolveStructuralFailureOutcome(
            cycle,
            await resolveRenewalMaxAttempts(container)
          )

          // Second emission point (Tasks 11/12), mirroring the one above the
          // first `updateRenewalCycles` call in this handler: when the cap
          // turns the cycle `abandoned` here, the abandonment is persisted
          // AND emitted exactly where this write lands.
          await renewalModule.updateRenewalCycles({
            id: cycle.id,
            status: structuralOutcome.status,
            processed_at: finishedAt,
            generated_order_id: paymentFailure.renewal_order_id ?? null,
            last_error: message,
            last_failure_kind: failureKind,
            structural_attempt_count: structuralOutcome.structural_attempt_count,
          })

          if (structuralOutcome.status === RenewalCycleStatus.ABANDONED) {
            await persistRenewalResolutionEvent(container, {
              event_type: ActivityLogEventType.RENEWAL_ABANDONED,
              subscription_id: subscription.id,
              renewal_cycle_id: cycle.id,
              subscription_display: {
                customer_id: subscription.customer_id,
                reference: subscription.reference,
                customer_name: subscription.customer_snapshot?.full_name ?? null,
                product_title:
                  subscription.product_snapshot.product_title ?? null,
                variant_title:
                  appliedPendingChanges?.variant_title ??
                  subscription.product_snapshot.variant_title ??
                  null,
              },
              previous_state: {
                status: cycle.status,
                attempt_count: cycle.attempt_count,
                processed_at: toISOStringOrNull(cycle.processed_at),
                generated_order_id: cycle.generated_order_id,
                last_error: cycle.last_error,
              },
              new_state: {
                status: structuralOutcome.status,
                attempt_count: attemptNo,
                processed_at: toISOStringOrNull(finishedAt),
                generated_order_id: paymentFailure.renewal_order_id ?? null,
                last_error: message,
                last_failure_kind: failureKind,
                structural_attempt_count:
                  structuralOutcome.structural_attempt_count,
              },
              reason: message,
              reason_code: failureKind,
              actor_type: getRenewalActivityLogActorType(input.trigger_type),
              actor_id: input.triggered_by ?? null,
              trigger_type: input.trigger_type,
              source: input.trigger_type === "manual" ? "admin" : "scheduler",
              order_id: paymentFailure.renewal_order_id ?? null,
              attempt_no: attemptNo,
              correlation_id: correlationId,
            })
          }
        }
      }

      logRenewalEvent(logger, "error", {
        event: "renewal.execution",
        outcome: "failed",
        correlation_id: correlationId,
        renewal_cycle_id: cycle.id,
        subscription_id: subscription.id,
        trigger_type: input.trigger_type,
        triggered_by: input.triggered_by ?? null,
        attempt_no: attemptNo,
        duration_ms: Date.now() - operationStartedAt,
        success_count: 0,
        failure_count: 1,
        failure_kind: failureKind,
        alertable: isAlertableRenewalFailure(failureKind),
        message,
      })

      throw error
    }
  }
)
