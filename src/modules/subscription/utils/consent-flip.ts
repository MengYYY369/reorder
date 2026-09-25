import type { PlanOfferConsentSource } from "../../plan-offer/types"
import type {
  SubscriptionPaymentMechanism,
  SubscriptionPaymentMode,
} from "../types"
import { isNativeSubscriptionReference } from "./native-subscription"

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
 *
 * Whether a row is provider-owned is decided the same way everywhere else in
 * the plugin: the `NATIVE-` reference prefix (see `native-subscription.ts`). The
 * `mechanism` value inside `payment_context` is deliberately **not** consulted
 * here — it is a jsonb field rows predating the discriminator never carried, and
 * a guard built on it silently lets exactly those rows through, which on this
 * path means reorder starts charging a recurrence PayPal is already charging.
 *
 * The same reasoning applies one level down: a reference which is not there at
 * all (`undefined`) says nothing about ownership either, and treating it as
 * "not native" would repeat the exact bug on a wider input. A row that cannot be
 * read is left manual, with its own skip reason.
 */

/** Session fields the plugin knows how to read consent from. */
const CONSENT_SESSION_FIELDS: Record<PlanOfferConsentSource, string> = {
  customer_id: "customer_id",
}

export type ConsentFlipInput = {
  /**
   * The subscription row's unique reference, which is what decides native-ness.
   *
   * Required, and required of every caller: the failure this guard exists for is
   * a flip onto a recurrence the provider is already charging, and an omitted
   * field degrades to "not native" — the one answer that must never be reached
   * by silence. A caller that has no row to name is still reachable and says so
   * with an explicit `null`; forgetting the argument is a compile error.
   *
   * The compile error is the first line of defence and not the only one. This
   * value arrives through container resolves which are untyped at the boundary
   * (`payment-captured-save-payment-method.ts:126-128` still casts its read), so
   * a projection which stops selecting the column yields `undefined` at runtime
   * while every caller still names the property. `resolveConsentFlip` therefore
   * refuses to answer the native question for a reference which is neither a
   * string nor `null` — see `reference_undecidable` below. That makes the guard
   * hold in a tree where nobody ran the typechecker, which is this repo: there is
   * no CI workflow, so a build failure is only a defence once someone builds.
   */
  reference: string | null
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
  /**
   * Why the row was left alone; null when it was flipped. One of
   * `consent_from_session_disabled`, `reference_undecidable` (the caller named no
   * readable row, so ownership was never established), `native_reference`,
   * `already_auto`, `consent_field_missing`. The subscriber logs it verbatim.
   */
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

  if (!isDecidableReference(input.reference)) {
    // Fail closed on the absence of evidence rather than reading it as evidence
    // of the safe case. `isNativeSubscriptionReference` answers `false` for
    // anything that is not a string, which is exactly the answer that lets the
    // flip through, so an unreadable reference must be settled here instead of
    // by the predicate's default. Deliberately before the native test and the
    // mode test: this row is not being classified, it is being refused one, and
    // the distinct reason is what a merchant and the activity log get to read.
    return unchanged("reference_undecidable")
  }

  if (isNativeSubscriptionReference(input.reference)) {
    // A provider-owned recurrence is never switched to plugin charging, no
    // matter what the session carries: two systems billing the same product is
    // exactly the failure this sequence exists to prevent.
    return unchanged("native_reference")
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

/**
 * Whether a reference carries information at all.
 *
 * Every string is decidable, because the native test is a prefix test: a string
 * either starts with `NATIVE-` or provably does not, `""` included. `null` is
 * decidable too — it is a caller's explicit statement that no row is in question,
 * and no row can be a mirror of one. Anything else (`undefined` from a projection
 * which dropped the column, or a value that never was a reference) decides
 * nothing, and the caller is told so instead of being handed the flip.
 *
 * Returns a plain boolean on purpose: as a type predicate it would narrow the
 * rejected branch and report the surviving type as `never` wherever the caller
 * still reads the row.
 */
function isDecidableReference(reference: ConsentFlipInput["reference"]): boolean {
  return reference === null || typeof reference === "string"
}

function readPaymentMode(
  context: Record<string, unknown> | null
): SubscriptionPaymentMode {
  return context?.payment_mode === "auto" ? "auto" : "manual"
}

/**
 * The mechanism annotation already on the row, read only to be carried forward
 * unchanged by a non-flip decision. It must not decide anything here — see the
 * file header; native-ness is the reference.
 */
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
