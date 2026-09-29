/**
 * Where a trial claim came from. Every door that can create a trial
 * subscription writes one ledger row with the door it used:
 * - `self_service` — the card-free claim endpoint (Phase 13)
 * - `redemption`   — a trial-enabled redemption code
 * - `admin`        — a manual operator action; no admin subscription-create
 *   route exists today, so no writer uses this value yet (kept so the column
 *   does not need a migration when such a door is built)
 */
export enum TrialClaimSource {
  SELF_SERVICE = "self_service",
  REDEMPTION = "redemption",
  ADMIN = "admin",
}

/**
 * How a payment method is bound to the trial, for the bonus-days flow.
 * A provider-managed (native PayPal) subscription never passes through a
 * door that writes this ledger (Q11), so `vault` is the only bound value a
 * writer can produce today.
 */
export enum TrialClaimBindingMethod {
  NONE = "none",
  VAULT = "vault",
}

export interface RecordTrialClaimInput {
  customer_id: string
  product_id: string
  variant_id: string
  source: TrialClaimSource
  subscription_id: string
  trial_ends_at: Date | null
  binding_method?: TrialClaimBindingMethod
}

export interface TrialClaimDTO {
  id: string
  customer_id: string
  product_id: string
  variant_id: string
  claimed_at: Date
  trial_ends_at: Date | null
  source: TrialClaimSource
  subscription_id: string
  binding_method: TrialClaimBindingMethod
  created_at: Date
  updated_at: Date
}
