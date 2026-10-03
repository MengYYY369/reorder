import { IPaymentModuleService, MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { BigNumberInput } from "@medusajs/types"
import { createPaymentSessionsWorkflow } from "@medusajs/medusa/core-flows"
import { resolveOrderPaymentCollection } from "../utils/resolve-order-payment-collection"
import { DUNNING_MODULE } from "../../modules/dunning"
import type DunningModuleService from "../../modules/dunning/service"
import {
  DunningAttemptStatus,
  DunningCaseStatus,
  type DunningRetrySchedule,
} from "../../modules/dunning/types"
import { dunningErrors } from "../../modules/dunning/utils/errors"
import {
  classifyDunningFailure,
  createDunningCorrelationId,
  getDunningErrorMessage,
  isAlertableDunningFailure,
  logDunningEvent,
} from "../../modules/dunning/utils/observability"
import { calculateNextRetryAt } from "../../modules/dunning/utils/retry-schedule"
import { SUBSCRIPTION_MODULE } from "../../modules/subscription"
import type SubscriptionModuleService from "../../modules/subscription/service"
import { SubscriptionStatus } from "../../modules/subscription/types"
import { subscriptionErrors } from "../../modules/subscription/utils/errors"
import { isNativeSubscriptionReference } from "../../modules/subscription/utils/native-subscription"
import { resolveRenewalPaymentContext } from "../../modules/subscription/utils/preferred-payment-method"
import { RENEWAL_MODULE } from "../../modules/renewal"
import type RenewalModuleService from "../../modules/renewal/service"
import {
  RenewalCycleStatus,
  type RenewalAppliedPendingUpdateData,
} from "../../modules/renewal/types"
import { ActivityLogActorType, ActivityLogEventType } from "../../modules/activity-log/types"
import {
  persistDunningLifecycleEvent,
  type DunningLogEventSubscriptionDisplay,
} from "../utils/dunning-log-event"
import { persistRenewalResolutionEvent } from "../utils/renewal-log-event"
import { toISOStringOrNull } from "../utils/date-output"
import {
  finalizeRenewalPeriod,
  type FinalizeRenewalPeriodSubscription,
} from "./finalize-renewal-period"

type SubscriptionRecord = {
  id: string
  reference: string
  status: SubscriptionStatus
  customer_id: string
  product_id: string
  customer_snapshot: { full_name?: string | null } | null
  product_snapshot: {
    product_title?: string | null
    variant_title?: string | null
  } | null
  payment_context: {
    payment_provider_id: string | null
    payment_mode?: string | null
    payment_method_reference: string | null
  } | null
}

type DunningCaseRecord = {
  id: string
  subscription_id: string
  renewal_cycle_id: string
  renewal_order_id: string | null
  status: DunningCaseStatus
  attempt_count: number
  max_attempts: number
  retry_schedule: DunningRetrySchedule | null
  next_retry_at: Date | null
  last_payment_error_code: string | null
  last_payment_error_message: string | null
  last_attempt_at: Date | null
  recovered_at: Date | null
  closed_at: Date | null
  recovery_reason: string | null
  metadata: Record<string, unknown> | null
  created_at?: Date | string
}

type DunningAttemptRecord = {
  id: string
  dunning_case_id: string
  attempt_no: number
  started_at: Date
  finished_at: Date | null
  status: DunningAttemptStatus
  error_code: string | null
  error_message: string | null
  payment_reference: string | null
  metadata: Record<string, unknown> | null
}

type RetryTransitionSnapshot = {
  status: DunningCaseStatus
  attempt_count: number
  next_retry_at: Date | null
  last_attempt_at: Date | null
  metadata: Record<string, unknown> | null
}

type OrderRecord = {
  id: string
  total?: number | string | null
  currency_code?: string
}

/**
 * The cycle a dunning case recovers, as the retry step reads it: the fields
 * the settled-cycle guard (R2) decides on plus everything the shared
 * period-finalization step needs to settle the period on recovery.
 */
type DunningRetryCycleRecord = {
  id: string
  subscription_id: string
  status: RenewalCycleStatus
  scheduled_for: Date
  attempt_count: number
  processed_at: Date | null
  generated_order_id: string | null
  last_error: string | null
  applied_pending_update_data: RenewalAppliedPendingUpdateData | null
}

type PaymentSessionRecord = {
  id: string
  status?: string | null
  context?: Record<string, unknown> | null
}

type PaymentRecord = {
  id: string
  amount: BigNumberInput
}

type PaymentRetryOutcome =
  | {
      kind: "recovery"
      payment_reference: string | null
      error_code: null
      error_message: null
    }
  | {
      kind: "temporary_failure" | "permanent_failure"
      payment_reference: string | null
      error_code: string
      error_message: string
    }

export type RunDunningRetryStepInput = {
  dunning_case_id: string
  now?: string | Date | null
  ignore_schedule?: boolean
  triggered_by?: string | null
  reason?: string | null
  correlation_id?: string | null
}

type RunDunningRetryStepOutput = {
  dunning_case_id: string
  /** Null when the retry closed the case without executing a payment attempt. */
  dunning_attempt_id: string | null
  /** `parked` leaves the case open as `awaiting_manual_resolution`. */
  outcome: "recovered" | "retry_scheduled" | "unrecovered" | "parked"
  /** Absent when the retry closed out before loading the subscription. */
  subscription_status?: SubscriptionStatus
  correlation_id: string
  attempt_no: number
  time_to_recover_ms?: number | null
}

function appendRetryAuditMetadata(
  metadata: Record<string, unknown> | null,
  input: RunDunningRetryStepInput,
  at: string
) {
  const nextMetadata: Record<string, unknown> = {
    ...(metadata ?? {}),
    last_retry_triggered_by: input.triggered_by ?? null,
    last_retry_reason: input.reason ?? null,
  }

  if (!input.ignore_schedule) {
    return nextMetadata
  }

  const existing = Array.isArray(metadata?.manual_actions)
    ? [...(metadata?.manual_actions as Record<string, unknown>[])]
    : []

  existing.push({
    action: "retry_now",
    who: input.triggered_by ?? null,
    when: at,
    reason: input.reason ?? null,
  })

  return {
    ...nextMetadata,
    manual_actions: existing,
    last_manual_action: existing[existing.length - 1],
  }
}

function normalizeNow(now?: string | Date | null) {
  if (!now) {
    return new Date()
  }

  const normalized = now instanceof Date ? now : new Date(now)

  if (Number.isNaN(normalized.getTime())) {
    throw dunningErrors.invalidData("Dunning retry 'now' must be a valid date")
  }

  return normalized
}

/**
 * Display snapshot for a dunning lifecycle event, from a subscription the step
 * has already loaded. The settled-cycle guard closes cases before the
 * subscription is ever read, so those events pass null instead.
 */
function subscriptionDisplay(
  subscription: SubscriptionRecord | null
): DunningLogEventSubscriptionDisplay {
  if (!subscription) {
    return null
  }

  return {
    customer_id: subscription.customer_id,
    reference: subscription.reference,
    customer_name: subscription.customer_snapshot?.full_name ?? null,
    product_title: subscription.product_snapshot?.product_title ?? null,
    variant_title: subscription.product_snapshot?.variant_title ?? null,
  }
}

async function loadDunningCase(
  container: MedusaContainer,
  id: string
): Promise<DunningCaseRecord> {
  const dunningModule = container.resolve<DunningModuleService>(DUNNING_MODULE)

  try {
    return (await dunningModule.retrieveDunningCase(id)) as DunningCaseRecord
  } catch {
    throw dunningErrors.notFound("DunningCase", id)
  }
}

async function loadSubscription(
  container: MedusaContainer,
  id: string
): Promise<SubscriptionRecord> {
  const subscriptionModule =
    container.resolve<SubscriptionModuleService>(SUBSCRIPTION_MODULE)

  try {
    return (await subscriptionModule.retrieveSubscription(id)) as SubscriptionRecord
  } catch {
    throw subscriptionErrors.notFound("Subscription", id)
  }
}

async function loadRenewalCycleForRetry(
  container: MedusaContainer,
  id: string
): Promise<DunningRetryCycleRecord> {
  const renewalModule = container.resolve<RenewalModuleService>(RENEWAL_MODULE)

  try {
    return (await renewalModule.retrieveRenewalCycle(
      id
    )) as unknown as DunningRetryCycleRecord
  } catch {
    throw dunningErrors.notFound("RenewalCycle", id)
  }
}

/**
 * Exhaustion abandons the originating cycle (decision R3): when the case
 * closes as `unrecovered`, the period it recovers is written off into Task
 * 1's terminal `abandoned` status. This is the inverse of the settled-cycle
 * guard (R2) at the top of the retry step, which closes cases whose cycle is
 * ALREADY settled — here the case exhausts first, so the cycle settles into
 * the other terminal state instead.
 *
 * Ordering: the cycle write lands BEFORE the case closes (the same discipline
 * recovery follows — finalize before close). A crash in between leaves an
 * `abandoned` cycle behind an open case, which the settled-cycle guard then
 * closes without charging; the reverse window would leave a `failed` cycle
 * behind a closed case that the due query is free to select and charge again.
 *
 * Decision R3: the subscription is left `past_due` and this plugin must NOT
 * cancel it. Cancelling a customer relationship is not a side effect a
 * background job performs; the host receives the abandonment signal and
 * decides what happens to the relationship.
 *
 * Emission point (Tasks 11/12): the abandonment event (`renewal.abandoned`)
 * is persisted AND emitted through the shared funnel exactly where the write
 * below lands, carrying the cycle id and the exhaustion reason. Emission only
 * happens when the write happened — the terminal guards above return first.
 */
async function abandonCycleOnDunningExhaustion(
  container: MedusaContainer,
  renewalCycleId: string,
  exhaustionReason: string,
  errorMessage: string,
  emission: {
    dunning_case_id: string
    subscription_id: string
    renewal_order_id: string | null
    subscription_display: DunningLogEventSubscriptionDisplay
    trigger_type: string
    attempt_no: number
    correlation_id: string
    triggered_by: string | null
  }
): Promise<void> {
  const renewalModule = container.resolve<RenewalModuleService>(RENEWAL_MODULE)

  // Re-read at write time: the payment attempt ran after the step loaded the
  // cycle, and a concurrent settling run (e.g. an operator force-run) may
  // have succeeded in between. A `succeeded` period is never overwritten
  // with `abandoned` — that would un-settle a paid period — and an already
  // `abandoned` cycle makes this write a no-op.
  const renewalCycle = await loadRenewalCycleForRetry(container, renewalCycleId)

  if (
    renewalCycle.status === RenewalCycleStatus.SUCCEEDED ||
    renewalCycle.status === RenewalCycleStatus.ABANDONED
  ) {
    return
  }

  const exhaustionError = `Dunning exhausted (${exhaustionReason}): ${errorMessage}`

  await renewalModule.updateRenewalCycles({
    id: renewalCycle.id,
    status: RenewalCycleStatus.ABANDONED,
    last_error: exhaustionError,
  })

  await persistRenewalResolutionEvent(container, {
    event_type: ActivityLogEventType.RENEWAL_ABANDONED,
    subscription_id: emission.subscription_id,
    renewal_cycle_id: renewalCycle.id,
    subscription_display: emission.subscription_display,
    previous_state: {
      status: renewalCycle.status,
      attempt_count: renewalCycle.attempt_count,
      generated_order_id: renewalCycle.generated_order_id,
      last_error: renewalCycle.last_error,
    },
    new_state: {
      status: RenewalCycleStatus.ABANDONED,
      last_error: exhaustionError,
    },
    reason: exhaustionError,
    reason_code: exhaustionReason,
    actor_type: emission.triggered_by
      ? ActivityLogActorType.USER
      : ActivityLogActorType.SYSTEM,
    actor_id: emission.triggered_by,
    trigger_type: emission.trigger_type,
    source: "dunning",
    dunning_case_id: emission.dunning_case_id,
    order_id: emission.renewal_order_id,
    attempt_no: emission.attempt_no,
    correlation_id: emission.correlation_id,
  })
}

/**
 * Moves a due case the retry cannot even start out of the due set while
 * keeping it open for manual resolution: `retry-now`, both mark-* workflows,
 * and `update-dunning-retry-schedule` all accept
 * `awaiting_manual_resolution`. `next_retry_at` is cleared — the stale past
 * value is what kept re-selecting the case — and the park reason lands in
 * `recovery_reason`, the field the Admin detail payload surfaces for why a
 * case sits where it does.
 */
async function parkDunningCase(
  container: MedusaContainer,
  dunningCaseId: string,
  parkReason: string
): Promise<void> {
  const dunningModule = container.resolve<DunningModuleService>(DUNNING_MODULE)

  await dunningModule.updateDunningCases({
    id: dunningCaseId,
    status: DunningCaseStatus.AWAITING_MANUAL_RESOLUTION,
    next_retry_at: null,
    recovery_reason: parkReason,
  } as any)
}

async function getNextAttemptNo(
  container: MedusaContainer,
  dunningCase: DunningCaseRecord
) {
  const dunningModule = container.resolve<DunningModuleService>(DUNNING_MODULE)
  const attempts = (await dunningModule.listDunningAttempts({
    dunning_case_id: dunningCase.id,
  } as any)) as DunningAttemptRecord[]

  const highestAttemptNo = attempts.reduce((max, attempt) => {
    return Math.max(max, attempt.attempt_no ?? 0)
  }, 0)

  return Math.max(dunningCase.attempt_count, highestAttemptNo) + 1
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
    throw dunningErrors.notFound("Order", id)
  }

  return {
    total: Number(order.total ?? 0),
    currency_code: order.currency_code ?? "",
  }
}

/**
 * Pre-transition retry guards, returned as dispositions. A case the scheduler
 * selects (status `retry_scheduled`, `next_retry_at` in the past) can be
 * impossible to even start: the case lost its order or schedule, the retry
 * budget is already spent, or the subscription is no longer chargeable (e.g.
 * it was cancelled or paused while the case was pending). Before the
 * disposition split these guards THREW before the RETRYING transition below,
 * so the case kept its stale past `next_retry_at`, stayed in the due set, and
 * was re-selected — and re-thrown — by every scheduler run forever, holding
 * the job lock with it. The park/exhaust dispositions instead transition the
 * case out of the due set in the same run that selected it:
 *
 * - `park` → `awaiting_manual_resolution` with a reason (`parkDunningCase`);
 *   the case stays open and resolvable.
 * - `exhaust` → `unrecovered`; the retry budget is spent, so the case closes
 *   the same way the post-payment exhaustion does (decision R3: the cycle
 *   settles `abandoned` first, the subscription is never cancelled).
 *
 * The remaining refusals still throw, on purpose: terminal statuses and
 * `retrying` are never selected by the scheduler's due query, and `not_due`
 * means the case was not in the due set to begin with — none of them can wedge
 * the loop.
 */
type PreTransitionDisposition =
  | { kind: "ok" }
  | { kind: "park"; reason: string; message: string }
  | { kind: "exhaust"; message: string }

function resolveRetryDisposition(
  dunningCase: DunningCaseRecord,
  subscription: SubscriptionRecord,
  now: Date,
  ignoreSchedule?: boolean
): PreTransitionDisposition {
  if (dunningCase.status === DunningCaseStatus.RECOVERED) {
    throw dunningErrors.alreadyRecovered(dunningCase.id)
  }

  if (dunningCase.status === DunningCaseStatus.UNRECOVERED) {
    throw dunningErrors.alreadyUnrecovered(dunningCase.id)
  }

  if (dunningCase.status === DunningCaseStatus.RETRYING) {
    throw dunningErrors.retryAlreadyProcessing(dunningCase.id)
  }

  if (!dunningCase.renewal_order_id) {
    return {
      kind: "park",
      reason: "missing_renewal_order",
      message: `DunningCase '${dunningCase.id}' is missing renewal_order_id`,
    }
  }

  if (!dunningCase.retry_schedule) {
    return {
      kind: "park",
      reason: "missing_retry_schedule",
      message: `DunningCase '${dunningCase.id}' is missing retry_schedule`,
    }
  }

  if (!ignoreSchedule && !dunningCase.next_retry_at) {
    throw dunningErrors.retryNotDue(dunningCase.id)
  }

  if (!ignoreSchedule && dunningCase.next_retry_at && dunningCase.next_retry_at > now) {
    throw dunningErrors.retryNotDue(dunningCase.id)
  }

  if (dunningCase.attempt_count >= dunningCase.max_attempts) {
    return {
      kind: "exhaust",
      message: `DunningCase '${dunningCase.id}' reached max_attempts (${dunningCase.max_attempts}) without recovery`,
    }
  }

  if (
    subscription.status !== SubscriptionStatus.PAST_DUE &&
    subscription.status !== SubscriptionStatus.ACTIVE
  ) {
    return {
      kind: "park",
      reason: "subscription_not_chargeable",
      message: `Subscription '${subscription.id}' can't run dunning retry from status '${subscription.status}'`,
    }
  }

  return { kind: "ok" }
}

function classifyPaymentRetryFailure(
  error: unknown,
  paymentSessionStatus?: string | null
): PaymentRetryOutcome {
  const message =
    error instanceof Error ? error.message : "Dunning payment retry failed"
  const normalizedMessage = message.toLowerCase()
  const normalizedStatus = String(paymentSessionStatus ?? "").toLowerCase()
  const normalizedErrorCode = readPaymentErrorCode(error)

  if (
    normalizedStatus === "requires_more" ||
    normalizedStatus === "canceled" ||
    normalizedStatus === "cancelled"
  ) {
    return {
      kind: "permanent_failure",
      payment_reference: null,
      error_code: normalizedStatus || "payment_requires_manual_action",
      error_message: message,
    }
  }

  if (
    normalizedErrorCode === "insufficient_funds" ||
    normalizedErrorCode === "generic_decline" ||
    normalizedErrorCode === "do_not_honor"
  ) {
    return {
      kind: "temporary_failure",
      payment_reference: null,
      error_code: normalizedErrorCode,
      error_message: message,
    }
  }

  if (
    normalizedMessage.includes("missing payment retry context") ||
    normalizedMessage.includes("doesn't have a collectible total") ||
    normalizedMessage.includes("no payment collection is available") ||
    normalizedMessage.includes("expired") ||
    normalizedMessage.includes("declined") ||
    normalizedMessage.includes("requires payment method") ||
    normalizedMessage.includes("requires more")
  ) {
    return {
      kind: "permanent_failure",
      payment_reference: null,
      error_code: normalizedStatus || "payment_declined",
      error_message: message,
    }
  }

  if (
    normalizedStatus === "pending" ||
    normalizedStatus === "error" ||
    normalizedMessage.includes("insufficient") ||
    normalizedMessage.includes("generic_decline") ||
    normalizedMessage.includes("do_not_honor") ||
    normalizedMessage.includes("timeout") ||
    normalizedMessage.includes("temporar") ||
    normalizedMessage.includes("network") ||
    normalizedMessage.includes("unavailable")
  ) {
    return {
      kind: "temporary_failure",
      payment_reference: null,
      error_code: normalizedStatus || "payment_retryable_error",
      error_message: message,
    }
  }

  return {
    kind: "temporary_failure",
    payment_reference: null,
    error_code:
      normalizedErrorCode || normalizedStatus || "payment_retry_failed",
    error_message: message,
  }
}

function readPaymentErrorCode(error: unknown) {
  if (!error || typeof error !== "object") {
    return null
  }

  const record = error as Record<string, unknown>
  const candidates = [
    record.code,
    record.decline_code,
    (record.cause as Record<string, unknown> | undefined)?.code,
    (record.cause as Record<string, unknown> | undefined)?.decline_code,
    (record.payment_intent as Record<string, unknown> | undefined)?.last_payment_error,
    (record.raw as Record<string, unknown> | undefined)?.code,
    (record.raw as Record<string, unknown> | undefined)?.decline_code,
  ]

  for (const candidate of candidates) {
    const value = readNestedErrorCode(candidate)

    if (value) {
      return value
    }
  }

  return null
}

function readNestedErrorCode(value: unknown): string | null {
  if (!value) {
    return null
  }

  if (typeof value === "string" && value.trim()) {
    return value.trim().toLowerCase()
  }

  if (typeof value === "object") {
    const record = value as Record<string, unknown>
    const candidates = [record.code, record.decline_code]

    for (const candidate of candidates) {
      if (typeof candidate === "string" && candidate.trim()) {
        return candidate.trim().toLowerCase()
      }
    }
  }

  return null
}

async function executePaymentRetry(
  container: MedusaContainer,
  subscription: SubscriptionRecord,
  renewalOrderId: string
): Promise<PaymentRetryOutcome> {
  let paymentSession: PaymentSessionRecord | null = null

  try {
    const paymentContext = subscription.payment_context

    if (isNativeSubscriptionReference(subscription.reference)) {
      // Dunning is not a shared queue here: PayPal retries its own failed
      // recurrence, and a retry from this side would double-charge. The
      // `payment_mode === "manual"` short-circuit below is what currently
      // keeps native rows out of this path — this guard makes that explicit so
      // the immunity does not depend on how the mirror row happens to be
      // labelled.
      return {
        kind: "permanent_failure",
        payment_reference: null,
        error_code: "native_subscription",
        error_message:
          "Subscription mirrors a provider-owned recurrence; the provider retries it",
      }
    }

    if (paymentContext?.payment_mode === "manual") {
      // Manual subscriptions are paid via the interactive manual renewal flow;
      // off-session retries would always fail without a method reference.
      return {
        kind: "permanent_failure",
        payment_reference: null,
        error_code: "manual_payment_mode",
        error_message:
          "Subscription is in manual payment mode; pay via the manual renewal flow",
      }
    }

    // The method this retry charges with (D10): the customer's preferred
    // method for the subscription's product when the payment-methods plugin has
    // one, else the subscription row's own reference. Fail-open, read-only.
    const renewalPaymentContext = await resolveRenewalPaymentContext(container, {
      customerId: subscription.customer_id,
      scope: subscription.product_id,
      fallback: {
        payment_provider_id: paymentContext?.payment_provider_id ?? null,
        payment_method_reference:
          paymentContext?.payment_method_reference ?? null,
      },
    })

    if (!renewalPaymentContext.providerId || !renewalPaymentContext.reference) {
      throw dunningErrors.invalidData(
        `Subscription '${subscription.id}' is missing payment retry context`
      )
    }

    const { total, currency_code: currencyCode } = await loadOrderCharge(
      container,
      renewalOrderId
    )

    if (total <= 0) {
      throw dunningErrors.invalidData(
        `Renewal order '${renewalOrderId}' doesn't have a collectible total`
      )
    }

    const paymentCollection = await resolveOrderPaymentCollection(container, {
      order_id: renewalOrderId,
      amount: total,
      currency_code: currencyCode,
    })

    const paymentSessionResult = await createPaymentSessionsWorkflow(container).run({
      input: {
        payment_collection_id: paymentCollection.id,
        provider_id: renewalPaymentContext.providerId,
        customer_id: subscription.customer_id,
        data: {
          payment_method: renewalPaymentContext.reference,
          off_session: true,
          confirm: true,
          capture_method: "automatic",
        },
      },
    })

    paymentSession = paymentSessionResult.result as PaymentSessionRecord

    const paymentModule =
      container.resolve<IPaymentModuleService>(Modules.PAYMENT)
    const payment = (await paymentModule.authorizePaymentSession(
      paymentSession.id,
      paymentSession.context ?? {}
    )) as PaymentRecord | null

    if (!payment?.id) {
      return {
        kind: "temporary_failure",
        payment_reference: paymentSession.id,
        error_code: "payment_authorization_missing",
        error_message: "Payment authorization did not return a payment reference",
      }
    }

    await paymentModule.capturePayment({
      payment_id: payment.id,
      amount: payment.amount,
    })

    return {
      kind: "recovery",
      payment_reference: payment.id,
      error_code: null,
      error_message: null,
    }
  } catch (error) {
    let paymentSessionStatus: string | null = paymentSession?.status ?? null

    if (paymentSession?.id) {
      const paymentModule =
        container.resolve<IPaymentModuleService>(Modules.PAYMENT)
      const sessions = (await paymentModule.listPaymentSessions({
        id: [paymentSession.id],
      })) as PaymentSessionRecord[]

      paymentSessionStatus = sessions[0]?.status ?? paymentSessionStatus
    }

    const outcome = classifyPaymentRetryFailure(error, paymentSessionStatus)

    return {
      ...outcome,
      payment_reference: paymentSession?.id ?? outcome.payment_reference,
    }
  }
}

export const runDunningRetryStep = createStep(
  "run-dunning-retry",
  async function (
    input: RunDunningRetryStepInput,
    { container }
  ) {
    const logger = container.resolve("logger")
    const dunningModule = container.resolve<DunningModuleService>(DUNNING_MODULE)
    const subscriptionModule =
      container.resolve<SubscriptionModuleService>(SUBSCRIPTION_MODULE)
    const now = normalizeNow(input.now)
    const startedAtMs = Date.now()
    const correlationId =
      input.correlation_id ??
      createDunningCorrelationId(`dunning-retry-${input.ignore_schedule ? "manual" : "scheduled"}`)

    const dunningCase = await loadDunningCase(container, input.dunning_case_id)
    const attemptNo = await getNextAttemptNo(container, dunningCase)
    const transitionSnapshot: RetryTransitionSnapshot = {
      status: dunningCase.status,
      attempt_count: dunningCase.attempt_count,
      next_retry_at: dunningCase.next_retry_at,
      last_attempt_at: dunningCase.last_attempt_at,
      metadata: dunningCase.metadata ?? null,
    }
    let transitionedToRetrying = false

    logDunningEvent(logger, "info", {
      event: "dunning.retry",
      outcome: "started",
      correlation_id: correlationId,
      dunning_case_id: dunningCase.id,
      subscription_id: dunningCase.subscription_id,
      renewal_cycle_id: dunningCase.renewal_cycle_id,
      attempt_no: attemptNo,
      metadata: {
        triggered_by: input.triggered_by ?? null,
        reason: input.reason ?? null,
        ignore_schedule: Boolean(input.ignore_schedule),
      },
    })

    try {
      // Settled-cycle guard (decision R2). Load the cycle before anything can
      // charge: when its period is already settled (`succeeded`) or written
      // off (`abandoned`), close the case instead of charging — a second
      // charge for one period is the one outcome this step must never
      // produce. This is what makes the recovery write order stop being
      // load-bearing: recovery finalizes the period BEFORE it closes the
      // case, so a crash between the two writes leaves a settled cycle behind
      // an open case, and this guard closes it without charging. Writing in
      // the opposite order would strand a `failed` cycle behind a closed case
      // that the scheduler is then free to charge again. Terminal cases
        // (`recovered` / `unrecovered`) fall through to the existing refusals in
        // `resolveRetryDisposition` — the guard only closes cases a retry could
        // still charge from.
      const renewalCycle = await loadRenewalCycleForRetry(
        container,
        dunningCase.renewal_cycle_id
      )
      const cycleIsSettled =
        renewalCycle.status === RenewalCycleStatus.SUCCEEDED ||
        renewalCycle.status === RenewalCycleStatus.ABANDONED
      const caseIsClosed =
        dunningCase.status === DunningCaseStatus.RECOVERED ||
        dunningCase.status === DunningCaseStatus.UNRECOVERED

      if (cycleIsSettled && !caseIsClosed) {
        const cyclePaid = renewalCycle.status === RenewalCycleStatus.SUCCEEDED
        const closedAt = new Date()

        await dunningModule.updateDunningCases({
          id: dunningCase.id,
          status: cyclePaid
            ? DunningCaseStatus.RECOVERED
            : DunningCaseStatus.UNRECOVERED,
          next_retry_at: null,
          recovered_at: cyclePaid ? closedAt : null,
          closed_at: closedAt,
          recovery_reason: cyclePaid
            ? "cycle_already_succeeded"
            : "cycle_abandoned",
        } as any)

        logDunningEvent(logger, "warn", {
          event: "dunning.retry",
          outcome: "blocked",
          correlation_id: correlationId,
          dunning_case_id: dunningCase.id,
          subscription_id: dunningCase.subscription_id,
          renewal_cycle_id: dunningCase.renewal_cycle_id,
          attempt_no: attemptNo,
          duration_ms: Date.now() - startedAtMs,
          failure_count: 0,
          alertable: false,
          message: `Renewal cycle is already ${renewalCycle.status}; the case is closed without a charge`,
          metadata: {
            retry_outcome: cyclePaid
              ? "settled_cycle_recovered"
              : "settled_cycle_abandoned",
            cycle_status: renewalCycle.status,
          },
        })

        // Lifecycle event (Task 11): the case closed here counts as a real
        // recovery/write-off occurrence even though no payment attempt ran.
        // The subscription row is deliberately not read on this path, so the
        // event carries only the subscription_id it is centered on.
        await persistDunningLifecycleEvent(container, {
          event_type: cyclePaid
            ? ActivityLogEventType.DUNNING_RECOVERED
            : ActivityLogEventType.DUNNING_UNRECOVERED,
          dunning_case_id: dunningCase.id,
          subscription_id: dunningCase.subscription_id,
          renewal_cycle_id: dunningCase.renewal_cycle_id,
          renewal_order_id: dunningCase.renewal_order_id,
          subscription_display: null,
          previous_state: {
            status: dunningCase.status,
            attempt_count: dunningCase.attempt_count,
            next_retry_at: toISOStringOrNull(dunningCase.next_retry_at),
          },
          new_state: {
            status: cyclePaid
              ? DunningCaseStatus.RECOVERED
              : DunningCaseStatus.UNRECOVERED,
            attempt_count: dunningCase.attempt_count,
            next_retry_at: null,
            recovery_reason: cyclePaid
              ? "cycle_already_succeeded"
              : "cycle_abandoned",
          },
          actor_type: input.triggered_by
            ? ActivityLogActorType.USER
            : ActivityLogActorType.SYSTEM,
          actor_id: input.triggered_by ?? null,
          trigger_type: input.ignore_schedule ? "manual_retry" : "scheduled_retry",
          reason: input.reason ?? null,
          correlation_id: correlationId,
          dedupe_qualifier: toISOStringOrNull(closedAt),
        })

        return new StepResponse<RunDunningRetryStepOutput>({
          dunning_case_id: dunningCase.id,
          dunning_attempt_id: null,
          outcome: cyclePaid ? "recovered" : "unrecovered",
          correlation_id: correlationId,
          attempt_no: attemptNo,
        })
      }

      const subscription = await loadSubscription(
        container,
        dunningCase.subscription_id
      )

      // Pre-transition wedge guards (see `resolveRetryDisposition`): park or
      // close the case instead of throwing, so a case the scheduler selected
      // always leaves the due set in the run that selected it.
      const disposition = resolveRetryDisposition(
        dunningCase,
        subscription,
        now,
        input.ignore_schedule
      )

      if (disposition.kind === "park") {
        await parkDunningCase(container, dunningCase.id, disposition.reason)

        logDunningEvent(logger, "warn", {
          event: "dunning.retry",
          outcome: "blocked",
          correlation_id: correlationId,
          dunning_case_id: dunningCase.id,
          subscription_id: dunningCase.subscription_id,
          renewal_cycle_id: dunningCase.renewal_cycle_id,
          attempt_no: attemptNo,
          duration_ms: Date.now() - startedAtMs,
          blocked_count: 1,
          failure_kind: "invalid_transition",
          alertable: true,
          message: disposition.message,
          metadata: {
            retry_outcome: "parked",
            park_reason: disposition.reason,
          },
        })

        return new StepResponse<RunDunningRetryStepOutput>({
          dunning_case_id: dunningCase.id,
          dunning_attempt_id: null,
          outcome: "parked",
          correlation_id: correlationId,
          attempt_no: attemptNo,
        })
      }

      if (disposition.kind === "exhaust") {
        // The retry budget was spent before this run. Close the case the same
        // way the post-payment exhaustion does: settle the cycle `abandoned`
        // first (R3), then close the case `unrecovered`. No attempt row is
        // written — this run executed no payment attempt.
        const finishedAt = new Date()

        await abandonCycleOnDunningExhaustion(
          container,
          renewalCycle.id,
          "retry_limit_exhausted",
          disposition.message,
          {
            dunning_case_id: dunningCase.id,
            subscription_id: dunningCase.subscription_id,
            renewal_order_id: dunningCase.renewal_order_id,
            subscription_display: subscriptionDisplay(subscription),
            trigger_type: input.ignore_schedule ? "manual_retry" : "scheduled_retry",
            attempt_no: attemptNo,
            correlation_id: correlationId,
            triggered_by: input.triggered_by ?? null,
          }
        )

        const updatedCase = await dunningModule.updateDunningCases({
          id: dunningCase.id,
          status: DunningCaseStatus.UNRECOVERED,
          next_retry_at: null,
          closed_at: finishedAt,
          recovery_reason: "retry_limit_exhausted",
        } as any)

        logDunningEvent(logger, "warn", {
          event: "dunning.retry",
          outcome: "failed",
          correlation_id: correlationId,
          dunning_case_id: updatedCase.id,
          subscription_id: updatedCase.subscription_id,
          renewal_cycle_id: updatedCase.renewal_cycle_id,
          attempt_no: attemptNo,
          duration_ms: Date.now() - startedAtMs,
          failure_count: 1,
          unrecovered_count: 1,
          avg_attempts: attemptNo,
          failure_kind: "retry_exhausted",
          alertable: false,
          message: disposition.message,
          metadata: {
            retry_outcome: "unrecovered",
          },
        })

        // Lifecycle event (Task 11): the budget was spent before this run, so
        // the case closed without executing a payment attempt — no
        // dunning.retry_executed here, only the unrecovered closure.
        await persistDunningLifecycleEvent(container, {
          event_type: ActivityLogEventType.DUNNING_UNRECOVERED,
          dunning_case_id: updatedCase.id,
          subscription_id: updatedCase.subscription_id,
          renewal_cycle_id: updatedCase.renewal_cycle_id,
          renewal_order_id: updatedCase.renewal_order_id,
          subscription_display: subscriptionDisplay(subscription),
          previous_state: {
            status: dunningCase.status,
            attempt_count: dunningCase.attempt_count,
            next_retry_at: toISOStringOrNull(dunningCase.next_retry_at),
          },
          new_state: {
            status: DunningCaseStatus.UNRECOVERED,
            attempt_count: dunningCase.attempt_count,
            next_retry_at: null,
            recovery_reason: "retry_limit_exhausted",
          },
          actor_type: input.triggered_by
            ? ActivityLogActorType.USER
            : ActivityLogActorType.SYSTEM,
          actor_id: input.triggered_by ?? null,
          trigger_type: input.ignore_schedule ? "manual_retry" : "scheduled_retry",
          reason: input.reason ?? null,
          correlation_id: correlationId,
          dedupe_qualifier: toISOStringOrNull(finishedAt),
        })

        return new StepResponse<RunDunningRetryStepOutput>({
          dunning_case_id: updatedCase.id,
          dunning_attempt_id: null,
          outcome: "unrecovered",
          correlation_id: correlationId,
          attempt_no: attemptNo,
        })
      }

      const startedAt = now

      await dunningModule.updateDunningCases({
        id: dunningCase.id,
        status: DunningCaseStatus.RETRYING,
        attempt_count: attemptNo,
        next_retry_at: null,
        last_attempt_at: startedAt,
        metadata: appendRetryAuditMetadata(
          dunningCase.metadata,
          input,
          startedAt.toISOString()
        ),
      } as any)
      transitionedToRetrying = true

      const attempt = (await dunningModule.createDunningAttempts({
        dunning_case_id: dunningCase.id,
        attempt_no: attemptNo,
        started_at: startedAt,
        finished_at: null,
        status: DunningAttemptStatus.PROCESSING,
        error_code: null,
        error_message: null,
        payment_reference: null,
        metadata: {
          triggered_by: input.triggered_by ?? null,
          reason: input.reason ?? null,
          correlation_id: correlationId,
        },
      } as any)) as DunningAttemptRecord

      const outcome = await executePaymentRetry(
        container,
        subscription,
        dunningCase.renewal_order_id!
      )
      const finishedAt = new Date()

      if (outcome.kind === "recovery") {
        await dunningModule.updateDunningAttempts({
          id: attempt.id,
          finished_at: finishedAt,
          status: DunningAttemptStatus.SUCCEEDED,
          error_code: null,
          error_message: null,
          payment_reference: outcome.payment_reference,
        } as any)

        // Lifecycle event (Task 11): one dunning.retry_executed per payment
        // attempt that actually ran, persisted and emitted as soon as the
        // attempt row closes.
        await persistDunningLifecycleEvent(container, {
          event_type: ActivityLogEventType.DUNNING_RETRY_EXECUTED,
          dunning_case_id: dunningCase.id,
          subscription_id: dunningCase.subscription_id,
          renewal_cycle_id: dunningCase.renewal_cycle_id,
          renewal_order_id: dunningCase.renewal_order_id,
          subscription_display: subscriptionDisplay(subscription),
          previous_state: {
            status: dunningCase.status,
            attempt_count: dunningCase.attempt_count,
            next_retry_at: toISOStringOrNull(dunningCase.next_retry_at),
          },
          new_state: {
            status: DunningCaseStatus.RETRYING,
            attempt_count: attemptNo,
            attempt_status: "succeeded",
            error_code: null,
          },
          actor_type: input.triggered_by
            ? ActivityLogActorType.USER
            : ActivityLogActorType.SYSTEM,
          actor_id: input.triggered_by ?? null,
          trigger_type: input.ignore_schedule ? "manual_retry" : "scheduled_retry",
          attempt_no: attemptNo,
          reason: input.reason ?? null,
          correlation_id: correlationId,
          dedupe_qualifier: attemptNo,
        })

        // Finalize the period through the shared period-finalization step:
        // the retry charged the case's own renewal order, so that order is
        // the one that paid the period. The cycle becomes `succeeded`, the
        // cadence advances anchored on `scheduled_for` (R6), `last_renewal_at`
        // is set, applied pending changes clear, `structural_attempt_count`
        // resets, the next cycle is ensured, and `renewal.succeeded` is
        // persisted and emitted — the same core semantics as the automatic
        // success path. This runs BEFORE the case closes as `recovered`:
        // together with the settled-cycle guard above, a crash between the
        // two writes leaves a settled cycle behind an open case, which the
        // next retry closes without charging, instead of a `failed` cycle
        // behind a closed case that the scheduler would charge again.
        const finalizeSubscription = (await subscriptionModule.retrieveSubscription(
          subscription.id
        )) as unknown as FinalizeRenewalPeriodSubscription

        await finalizeRenewalPeriod(container, {
          cycle: renewalCycle,
          subscription: finalizeSubscription,
          applied_pending_changes: renewalCycle.applied_pending_update_data,
          generated_order_id: dunningCase.renewal_order_id,
          trigger: {
            source: "dunning",
            trigger_type: "dunning_recovery",
            actor_type: input.triggered_by
              ? ActivityLogActorType.USER
              : ActivityLogActorType.SYSTEM,
            actor_id: input.triggered_by ?? null,
            correlation_id: correlationId,
          },
        })

        const updatedCase = await dunningModule.updateDunningCases({
          id: dunningCase.id,
          status: DunningCaseStatus.RECOVERED,
          next_retry_at: null,
          last_attempt_at: finishedAt,
          last_payment_error_code: null,
          last_payment_error_message: null,
          recovered_at: finishedAt,
          closed_at: finishedAt,
          recovery_reason: "payment_recovered",
        } as any)

        if (subscription.status === SubscriptionStatus.PAST_DUE) {
          await subscriptionModule.updateSubscriptions({
            id: subscription.id,
            status: SubscriptionStatus.ACTIVE,
          })
        }

        // Lifecycle event (Task 11): the payment-side recovery closed the
        // case; the period settlement itself already emitted renewal.succeeded
        // through finalizeRenewalPeriod above.
        await persistDunningLifecycleEvent(container, {
          event_type: ActivityLogEventType.DUNNING_RECOVERED,
          dunning_case_id: updatedCase.id,
          subscription_id: updatedCase.subscription_id,
          renewal_cycle_id: updatedCase.renewal_cycle_id,
          renewal_order_id: updatedCase.renewal_order_id,
          subscription_display: subscriptionDisplay(subscription),
          previous_state: {
            status: dunningCase.status,
            attempt_count: dunningCase.attempt_count,
            next_retry_at: toISOStringOrNull(dunningCase.next_retry_at),
          },
          new_state: {
            status: DunningCaseStatus.RECOVERED,
            attempt_count: attemptNo,
            next_retry_at: null,
            recovery_reason: "payment_recovered",
          },
          actor_type: input.triggered_by
            ? ActivityLogActorType.USER
            : ActivityLogActorType.SYSTEM,
          actor_id: input.triggered_by ?? null,
          trigger_type: input.ignore_schedule ? "manual_retry" : "scheduled_retry",
          attempt_no: attemptNo,
          reason: input.reason ?? null,
          correlation_id: correlationId,
          dedupe_qualifier: toISOStringOrNull(finishedAt),
        })

        const createdAt = updatedCase.created_at
          ? new Date(updatedCase.created_at)
          : dunningCase.created_at
            ? new Date(dunningCase.created_at)
            : null
        const timeToRecoverMs = createdAt
          ? finishedAt.getTime() - createdAt.getTime()
          : null

        logDunningEvent(logger, "info", {
          event: "dunning.retry",
          outcome: "succeeded",
          correlation_id: correlationId,
          dunning_case_id: updatedCase.id,
          subscription_id: updatedCase.subscription_id,
          renewal_cycle_id: updatedCase.renewal_cycle_id,
          attempt_no: attemptNo,
          duration_ms: Date.now() - startedAtMs,
          success_count: 1,
          recovered_count: 1,
          avg_attempts: attemptNo,
          avg_time_to_recover_ms: timeToRecoverMs ?? undefined,
          metadata: {
            retry_outcome: "recovered",
            payment_reference: outcome.payment_reference,
          },
        })

        return new StepResponse<RunDunningRetryStepOutput>({
          dunning_case_id: updatedCase.id,
          dunning_attempt_id: attempt.id,
          outcome: "recovered",
          subscription_status: SubscriptionStatus.ACTIVE,
          correlation_id: correlationId,
          attempt_no: attemptNo,
          time_to_recover_ms: timeToRecoverMs,
        })
      }

      await dunningModule.updateDunningAttempts({
        id: attempt.id,
        finished_at: finishedAt,
        status: DunningAttemptStatus.FAILED,
        error_code: outcome.error_code,
        error_message: outcome.error_message,
        payment_reference: outcome.payment_reference,
      } as any)

      // Lifecycle event (Task 11): one dunning.retry_executed per payment
      // attempt that actually ran, whether the case then re-arms or closes —
      // the closure itself carries its own dunning.unrecovered event.
      await persistDunningLifecycleEvent(container, {
        event_type: ActivityLogEventType.DUNNING_RETRY_EXECUTED,
        dunning_case_id: dunningCase.id,
        subscription_id: dunningCase.subscription_id,
        renewal_cycle_id: dunningCase.renewal_cycle_id,
        renewal_order_id: dunningCase.renewal_order_id,
        subscription_display: subscriptionDisplay(subscription),
        previous_state: {
          status: dunningCase.status,
          attempt_count: dunningCase.attempt_count,
          next_retry_at: toISOStringOrNull(dunningCase.next_retry_at),
        },
        new_state: {
          status: DunningCaseStatus.RETRYING,
          attempt_count: attemptNo,
          attempt_status: "failed",
          error_code: outcome.error_code,
        },
        actor_type: input.triggered_by
          ? ActivityLogActorType.USER
          : ActivityLogActorType.SYSTEM,
        actor_id: input.triggered_by ?? null,
        trigger_type: input.ignore_schedule ? "manual_retry" : "scheduled_retry",
        attempt_no: attemptNo,
        reason: input.reason ?? null,
        correlation_id: correlationId,
        dedupe_qualifier: attemptNo,
      })

      const shouldCloseAsUnrecovered =
        outcome.kind === "permanent_failure" ||
        attemptNo >= dunningCase.max_attempts

      if (shouldCloseAsUnrecovered) {
        const recoveryReason =
          outcome.kind === "permanent_failure"
            ? "permanent_payment_failure"
            : "retry_limit_exhausted"

        // Exhaustion settles the cycle `abandoned` before the case closes —
        // see `abandonCycleOnDunningExhaustion` for the ordering and the R3
        // no-cancellation rule.
        await abandonCycleOnDunningExhaustion(
          container,
          renewalCycle.id,
          recoveryReason,
          outcome.error_message,
          {
            dunning_case_id: dunningCase.id,
            subscription_id: dunningCase.subscription_id,
            renewal_order_id: dunningCase.renewal_order_id,
            subscription_display: subscriptionDisplay(subscription),
            trigger_type: input.ignore_schedule ? "manual_retry" : "scheduled_retry",
            attempt_no: attemptNo,
            correlation_id: correlationId,
            triggered_by: input.triggered_by ?? null,
          }
        )

        const updatedCase = await dunningModule.updateDunningCases({
          id: dunningCase.id,
          status: DunningCaseStatus.UNRECOVERED,
          next_retry_at: null,
          last_attempt_at: finishedAt,
          last_payment_error_code: outcome.error_code,
          last_payment_error_message: outcome.error_message,
          closed_at: finishedAt,
          recovery_reason: recoveryReason,
        } as any)

        logDunningEvent(logger, "warn", {
          event: "dunning.retry",
          outcome: "failed",
          correlation_id: correlationId,
          dunning_case_id: updatedCase.id,
          subscription_id: updatedCase.subscription_id,
          renewal_cycle_id: updatedCase.renewal_cycle_id,
          attempt_no: attemptNo,
          duration_ms: Date.now() - startedAtMs,
          failure_count: 1,
          unrecovered_count: 1,
          avg_attempts: attemptNo,
          failure_kind: "retry_exhausted",
          alertable: outcome.kind === "permanent_failure",
          message: outcome.error_message,
          metadata: {
            retry_outcome: "unrecovered",
            error_code: outcome.error_code,
            payment_reference: outcome.payment_reference,
          },
        })

        // Lifecycle event (Task 11): post-payment exhaustion (permanent
        // failure or spent budget) closed the case as unrecovered.
        await persistDunningLifecycleEvent(container, {
          event_type: ActivityLogEventType.DUNNING_UNRECOVERED,
          dunning_case_id: updatedCase.id,
          subscription_id: updatedCase.subscription_id,
          renewal_cycle_id: updatedCase.renewal_cycle_id,
          renewal_order_id: updatedCase.renewal_order_id,
          subscription_display: subscriptionDisplay(subscription),
          previous_state: {
            status: dunningCase.status,
            attempt_count: dunningCase.attempt_count,
            next_retry_at: toISOStringOrNull(dunningCase.next_retry_at),
          },
          new_state: {
            status: DunningCaseStatus.UNRECOVERED,
            attempt_count: attemptNo,
            next_retry_at: null,
            recovery_reason: recoveryReason,
          },
          actor_type: input.triggered_by
            ? ActivityLogActorType.USER
            : ActivityLogActorType.SYSTEM,
          actor_id: input.triggered_by ?? null,
          trigger_type: input.ignore_schedule ? "manual_retry" : "scheduled_retry",
          attempt_no: attemptNo,
          reason: input.reason ?? null,
          correlation_id: correlationId,
          dedupe_qualifier: toISOStringOrNull(finishedAt),
        })

        return new StepResponse<RunDunningRetryStepOutput>({
          dunning_case_id: updatedCase.id,
          dunning_attempt_id: attempt.id,
          outcome: "unrecovered",
          subscription_status: subscription.status,
          correlation_id: correlationId,
          attempt_no: attemptNo,
        })
      }

      const nextRetryAt = calculateNextRetryAt(
        dunningCase.retry_schedule!,
        attemptNo,
        finishedAt
      )

      if (!nextRetryAt) {
        // Same exhaustion settlement as above: the schedule has no interval
        // left, so the cycle is written off before the case closes.
        await abandonCycleOnDunningExhaustion(
          container,
          renewalCycle.id,
          "retry_schedule_exhausted",
          outcome.error_message,
          {
            dunning_case_id: dunningCase.id,
            subscription_id: dunningCase.subscription_id,
            renewal_order_id: dunningCase.renewal_order_id,
            subscription_display: subscriptionDisplay(subscription),
            trigger_type: input.ignore_schedule ? "manual_retry" : "scheduled_retry",
            attempt_no: attemptNo,
            correlation_id: correlationId,
            triggered_by: input.triggered_by ?? null,
          }
        )

        const updatedCase = await dunningModule.updateDunningCases({
          id: dunningCase.id,
          status: DunningCaseStatus.UNRECOVERED,
          next_retry_at: null,
          last_attempt_at: finishedAt,
          last_payment_error_code: outcome.error_code,
          last_payment_error_message: outcome.error_message,
          closed_at: finishedAt,
          recovery_reason: "retry_schedule_exhausted",
        } as any)

        logDunningEvent(logger, "warn", {
          event: "dunning.retry",
          outcome: "failed",
          correlation_id: correlationId,
          dunning_case_id: updatedCase.id,
          subscription_id: updatedCase.subscription_id,
          renewal_cycle_id: updatedCase.renewal_cycle_id,
          attempt_no: attemptNo,
          duration_ms: Date.now() - startedAtMs,
          failure_count: 1,
          unrecovered_count: 1,
          avg_attempts: attemptNo,
          failure_kind: "retry_exhausted",
          alertable: false,
          message: outcome.error_message,
          metadata: {
            retry_outcome: "unrecovered",
            error_code: outcome.error_code,
            payment_reference: outcome.payment_reference,
          },
        })

        // Lifecycle event (Task 11): the retry schedule had no interval left,
        // so the case closed as unrecovered after the executed attempt.
        await persistDunningLifecycleEvent(container, {
          event_type: ActivityLogEventType.DUNNING_UNRECOVERED,
          dunning_case_id: updatedCase.id,
          subscription_id: updatedCase.subscription_id,
          renewal_cycle_id: updatedCase.renewal_cycle_id,
          renewal_order_id: updatedCase.renewal_order_id,
          subscription_display: subscriptionDisplay(subscription),
          previous_state: {
            status: dunningCase.status,
            attempt_count: dunningCase.attempt_count,
            next_retry_at: toISOStringOrNull(dunningCase.next_retry_at),
          },
          new_state: {
            status: DunningCaseStatus.UNRECOVERED,
            attempt_count: attemptNo,
            next_retry_at: null,
            recovery_reason: "retry_schedule_exhausted",
          },
          actor_type: input.triggered_by
            ? ActivityLogActorType.USER
            : ActivityLogActorType.SYSTEM,
          actor_id: input.triggered_by ?? null,
          trigger_type: input.ignore_schedule ? "manual_retry" : "scheduled_retry",
          attempt_no: attemptNo,
          reason: input.reason ?? null,
          correlation_id: correlationId,
          dedupe_qualifier: toISOStringOrNull(finishedAt),
        })

        return new StepResponse<RunDunningRetryStepOutput>({
          dunning_case_id: updatedCase.id,
          dunning_attempt_id: attempt.id,
          outcome: "unrecovered",
          subscription_status: subscription.status,
          correlation_id: correlationId,
          attempt_no: attemptNo,
        })
      }

      const updatedCase = await dunningModule.updateDunningCases({
        id: dunningCase.id,
        status: DunningCaseStatus.RETRY_SCHEDULED,
        next_retry_at: nextRetryAt,
        last_attempt_at: finishedAt,
        last_payment_error_code: outcome.error_code,
        last_payment_error_message: outcome.error_message,
        recovered_at: null,
        closed_at: null,
        recovery_reason: null,
      } as any)

      logDunningEvent(logger, "warn", {
        event: "dunning.retry",
        outcome: "failed",
        correlation_id: correlationId,
        dunning_case_id: updatedCase.id,
        subscription_id: updatedCase.subscription_id,
        renewal_cycle_id: updatedCase.renewal_cycle_id,
        attempt_no: attemptNo,
        duration_ms: Date.now() - startedAtMs,
        failure_count: 1,
        rescheduled_count: 1,
        avg_attempts: attemptNo,
        failure_kind: "unexpected_error",
        alertable: outcome.kind === "temporary_failure",
        message: outcome.error_message,
        metadata: {
          retry_outcome: "retry_scheduled",
          error_code: outcome.error_code,
          payment_reference: outcome.payment_reference,
          next_retry_at: nextRetryAt.toISOString(),
        },
      })

      return new StepResponse<RunDunningRetryStepOutput>({
        dunning_case_id: updatedCase.id,
        dunning_attempt_id: attempt.id,
        outcome: "retry_scheduled",
        subscription_status: subscription.status,
        correlation_id: correlationId,
        attempt_no: attemptNo,
      })
    } catch (error) {
      const failureKind = classifyDunningFailure(error)
      logDunningEvent(logger, isAlertableDunningFailure(failureKind) ? "error" : "warn", {
        event: "dunning.retry",
        outcome: isAlertableDunningFailure(failureKind) ? "failed" : "blocked",
        correlation_id: correlationId,
        dunning_case_id: dunningCase.id,
        subscription_id: dunningCase.subscription_id,
        renewal_cycle_id: dunningCase.renewal_cycle_id,
        attempt_no: attemptNo,
        duration_ms: Date.now() - startedAtMs,
        failure_count: 1,
        failure_kind: failureKind,
        alertable: isAlertableDunningFailure(failureKind),
        message: getDunningErrorMessage(error),
        metadata: {
          triggered_by: input.triggered_by ?? null,
          reason: input.reason ?? null,
          ignore_schedule: Boolean(input.ignore_schedule),
        },
      })

      if (transitionedToRetrying) {
        await dunningModule.updateDunningCases({
          id: dunningCase.id,
          status: transitionSnapshot.status,
          attempt_count: transitionSnapshot.attempt_count,
          next_retry_at: transitionSnapshot.next_retry_at,
          last_attempt_at: transitionSnapshot.last_attempt_at,
          metadata: transitionSnapshot.metadata,
        } as any)
      }

      throw error
    }
  }
)
