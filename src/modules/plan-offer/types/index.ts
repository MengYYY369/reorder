export enum PlanOfferScope {
  PRODUCT = "product",
  VARIANT = "variant",
}

export enum PlanOfferFrequencyInterval {
  WEEK = "week",
  MONTH = "month",
  YEAR = "year",
}

export enum PlanOfferDiscountType {
  PERCENTAGE = "percentage",
  FIXED = "fixed",
}

export enum PlanOfferStackingPolicy {
  ALLOWED = "allowed",
  DISALLOW_ALL = "disallow_all",
  DISALLOW_SUBSCRIPTION_DISCOUNTS = "disallow_subscription_discounts",
}

/**
 * How a renewal-capable row is extended when the customer buys the same product
 * again. `extend` keeps one row per customer × product and pushes
 * `next_renewal_at`; `allow_multiple` mints a separate row per purchase.
 */
export enum PlanOfferRowStackingPolicy {
  EXTEND = "extend",
  ALLOW_MULTIPLE = "allow_multiple",
}

/**
 * Session field that proves the customer consented to automatic renewals. Only
 * `customer_id` is defined today: the payment session carries it when the
 * storefront collected an explicit opt-in.
 */
export type PlanOfferConsentSource = "customer_id"

export type PlanOfferAllowedFrequency = {
  interval: PlanOfferFrequencyInterval
  value: number
}

export type PlanOfferDiscountPerFrequency = {
  interval: PlanOfferFrequencyInterval
  value: number
  discount_type: PlanOfferDiscountType
  discount_value: number
}

export type PlanOfferRules = {
  minimum_cycles: number | null
  trial_enabled: boolean
  trial_days: number | null
  /** Per-offer toggle, default false, and enforced: at checkout the rule
   *  requires auto payment mode (only an auto-mode checkout vaults a usable
   *  method), the redemption path refuses a trial-enabled code outright (a
   *  code cannot collect a payment method), and a trial that reaches its end
   *  without a usable method ends without charging. The PayPal vault
   *  primitives for actually binding a method — `createSetupToken` /
   *  `createPaymentToken` with `VaultInstructionAction.OnPayerApproval` in the
   *  pinned server SDK — exist and are callable, and the sandbox chain (setup
   *  token → payer approval → VAULTED payment token → exchange → off-session
   *  charge) was verified 2026-09-28; the production account's vault
   *  permission is unverified and stays a pre-launch checklist item. */
  trial_requires_payment_method: boolean
  stacking_policy: PlanOfferStackingPolicy
  /**
   * Rules added in the v1.6.0 sequence. All three are optional on the type
   * because rows persisted before it carry none of these keys; read them
   * through `resolvePlanOfferRules`, which applies the conservative defaults
   * below (= the behavior such rows already have).
   */
  /** Flip a manual-mode subscription to auto when the checkout session proves
   *  consent through this field. `null` keeps the manual mode untouched. */
  consent_from_session?: PlanOfferConsentSource | null
  /** Second purchase of the same product: extend the existing row, or keep a
   *  separate row per purchase. */
  row_stacking_policy?: PlanOfferRowStackingPolicy
  /** Upper bound on accumulated cycles for one row; `null` means unlimited. */
  max_stacking_cycles?: number | null
  /** Extra trial days granted once a payment method is bound to the claimed
   *  trial (the vault rail is the only binding mechanism — Q11). `null`/`0`
   *  disables the bind-and-extend button on the storefront. */
  trial_bonus_days?: number | null
}

export const PLAN_OFFER_RULES_DEFAULTS = {
  consent_from_session: null,
  row_stacking_policy: PlanOfferRowStackingPolicy.EXTEND,
  max_stacking_cycles: null,
  trial_bonus_days: null,
} as const

export type PlanOfferRuntimeRules = {
  consent_from_session: PlanOfferConsentSource | null
  row_stacking_policy: PlanOfferRowStackingPolicy
  max_stacking_cycles: number | null
  trial_bonus_days: number | null
}

export type ProductSubscriptionConfig = {
  product_id: string
  variant_id: string | null
  source_offer_id: string | null
  source_scope: PlanOfferScope | null
  is_enabled: boolean
  allowed_frequencies: PlanOfferAllowedFrequency[]
  discount_per_frequency: PlanOfferDiscountPerFrequency[]
  rules: PlanOfferRules | null
}
