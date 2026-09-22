import type { PlanOfferConsentSource } from "../../plan-offer/types"
import type {
  SubscriptionPaymentMechanism,
  SubscriptionPaymentMode,
} from "../types"

/**
 * Consent-to-auto flip, decided as a pure function.
 *
 * The storefront used to poll a "did the vault token land yet" endpoint and
 * write `payment_mode: auto` itself, which meant the flip could be lost between
 * polls or replayed. It now happens where the token is first observed — the
 * `payment.captured` subscriber — and the decision of *whether* the session
 * proves consent is this file.
 *
 * Consent is only ever read from a field the offer names explicitly
 * (`rules.consent_from_session`). Presence of the field in the payment session
 * is the proof: the storefront is expected to populate it only after the
 * customer ticked the auto-renew box.
 */

/** Session fields the plugin knows how to read consent from. */
const CONSENT_SESSION_FIELDS: Record<PlanOfferConsentSource, string> = {
  customer_id: "customer_id",
}

export type ConsentFlipInput = {
  consent_from_session: PlanOfferConsentSource | null
  payment_context: Record<string, unknown> | null | undefined
  session_data: Record<string, unknown> | null | undefined
}

export type ConsentFlipDecision = {
  flip: boolean
  payment_mode: SubscriptionPaymentMode
  mechanism: SubscriptionPaymentMechanism | undefined
  /** Field the proof came from, for the activity-log record. */
  consent_field: string | null
  skip_reason: string | null
}

export function resolveConsentFlip(input: ConsentFlipInput): ConsentFlipDecision {
  const context = input.payment_context ?? null
  const paymentMode = readPaymentMode(context)
  const mechanism = readMechanism(context)
  const consentField =
    input.consent_from_session === null || input.consent_from_session === undefined
      ? null
      : CONSENT_SESSION_FIELDS[input.consent_from_session] ?? null

  const unchanged = (skip_reason: string): ConsentFlipDecision => ({
    flip: false,
    payment_mode: paymentMode,
    mechanism,
    consent_field: consentField,
    skip_reason,
  })

  if (!consentField) {
    return unchanged("consent_from_session_disabled")
  }

  if (mechanism === "native") {
    // A provider-owned recurrence is never switched to plugin charging, no
    // matter what the session carries: two systems billing the same product is
    // exactly the failure this sequence exists to prevent.
    return unchanged("native_mechanism")
  }

  if (paymentMode === "auto") {
    return unchanged("already_auto")
  }

  if (!hasSessionValue(input.session_data, consentField)) {
    return unchanged("consent_field_missing")
  }

  return {
    flip: true,
    payment_mode: "auto",
    mechanism: "reorder_auto",
    consent_field: consentField,
    skip_reason: null,
  }
}

function hasSessionValue(
  data: Record<string, unknown> | null | undefined,
  field: string
): boolean {
  if (!data) {
    return false
  }

  const value = data[field]

  if (typeof value === "string") {
    return value.trim().length > 0
  }

  return value !== null && value !== undefined
}

function readPaymentMode(
  context: Record<string, unknown> | null
): SubscriptionPaymentMode {
  return context?.payment_mode === "auto" ? "auto" : "manual"
}

function readMechanism(
  context: Record<string, unknown> | null
): SubscriptionPaymentMechanism | undefined {
  const value = context?.mechanism

  return value === "manual" || value === "reorder_auto" || value === "native"
    ? value
    : undefined
}

/**
 * The merged `payment_context` after a decision. Mode and mechanism are written
 * by the same update so a row can never be observed with a stored method but a
 * mode that still says manual.
 */
export function applyConsentFlip(
  context: Record<string, unknown> | null,
  decision: ConsentFlipDecision
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...(context ?? {}) }

  if (!decision.flip) {
    return next
  }

  next.payment_mode = decision.payment_mode
  next.mechanism = decision.mechanism ?? "reorder_auto"

  return next
}
