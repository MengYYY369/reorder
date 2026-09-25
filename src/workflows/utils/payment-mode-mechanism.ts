import type {
  SubscriptionPaymentMechanism,
  SubscriptionPaymentMode,
} from "../../modules/subscription/types"

/**
 * The single write-side rule for the `payment_mode` / `mechanism` pair.
 *
 * `payment_mode` is the field the schedulers read (auto = charge the stored
 * method off-session, manual = wait for an interactive cashier payment) and
 * `mechanism` is the label that says the same thing to whoever reads the row.
 * They are one decision, so they are written together: a mode-only update can
 * be observed as a row the scheduler charges while its own record still says
 * `manual`, which is what the toggle used to do.
 *
 * The pair is derived from the mode being committed and never carried over from
 * the stored annotation, so a label that drifted from the mode is corrected by
 * the next write instead of surviving it.
 *
 * Provider-owned (`native`) rows are the one case where the label must not
 * follow reorder's mode. Nothing that changes a stored mode can reach one: both
 * callers of this function test the `NATIVE-` reference prefix before they write
 * (`isNativeSubscriptionReference`,
 * `src/modules/subscription/utils/native-subscription.ts`; the guards at
 * `src/workflows/steps/set-subscription-auto-renew.ts:105` and
 * `src/workflows/steps/update-subscription-payment-method.ts:68`), and so does
 * the third writer that changes a mode — the consent flip, which writes the pair
 * without this helper (`src/modules/subscription/utils/consent-flip.ts:208-209`).
 * The three paths that mint a row's first `payment_context` do not test the
 * prefix, and they re-label nothing: checkout
 * (`src/workflows/steps/validate-subscription-cart.ts:489-537`), the redemption
 * create constant (`src/workflows/steps/redeem-redemption-code.ts:287-305`, whose
 * extend branch writes no `payment_context` at all, `:502-513`), and the mirror
 * writer itself, which is the only place `native` is ever labelled
 * (`src/modules/subscription/utils/native-mirror-sync.ts:75-83`).
 * `mechanism` itself stays a human-readable annotation and is never a query
 * predicate, exactly as `native-subscription.ts` documents.
 */
export type PaymentModeFields = {
  payment_mode: SubscriptionPaymentMode
  mechanism: SubscriptionPaymentMechanism
}

export function buildPaymentModeFields(
  mode: SubscriptionPaymentMode
): PaymentModeFields {
  return {
    payment_mode: mode,
    mechanism: mode === "auto" ? "reorder_auto" : "manual",
  }
}

/**
 * The mode a stored `payment_context` declares, or `fallback` when the column
 * is absent, unreadable or says something else. `payment_context` is a nullable
 * jsonb column, so every reader has to pick a default and the callers differ on
 * purpose: a row with no mode is only overdue once the customer opted into
 * auto, while the payment-method update treats it as the pre-existing
 * auto-by-default shape.
 */
export function readStoredPaymentMode(
  paymentContext: unknown,
  fallback: SubscriptionPaymentMode
): SubscriptionPaymentMode {
  if (typeof paymentContext !== "object" || paymentContext === null) {
    return fallback
  }

  const mode = (paymentContext as { payment_mode?: unknown }).payment_mode

  return mode === "auto" || mode === "manual" ? mode : fallback
}
