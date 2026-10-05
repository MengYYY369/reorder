/**
 * The runtime contract with medusa-paypal's vault-binding capability (Phase 14,
 * plan Task 22), and the support probe every consumer of that capability needs.
 *
 * **The contract is consumed by duck-typing, on purpose.** This plugin has no
 * dependency on medusa-paypal — no SDK, no client, no credentials, nothing
 * importable — so the capability cannot be named at compile time. It is
 * whatever `container.resolve("paypalSubscription")` answers with, and it is
 * supported exactly when the resolved service exposes both methods:
 *
 * - `startVaultApproval({ customer_id, return_url, cancel_url })`
 *     → `{ setup_token_id, approve_url }`
 * - `completeVaultApproval({ setup_token_id })`
 *     → `{ status, vault_id?, customer_id? }`
 *
 * The provider-side specification lives in
 * `.agents/specs/2026-09-28-paypal-vault-binding-plan.md` (Tasks P1–P2); its
 * exported `PAYPAL_VAULT_BINDING_CAPABILITY` constant is documentation, this
 * duck-type is the mechanism (that plan's Task P2 Step 3 says the same).
 *
 * Since 0.9.3 (B6, plan ticket 01) the trial bind no longer calls this
 * capability directly — the payment-methods plugin drives the provider through
 * its own binder (see `payment-method-binding.ts`). What survives here is
 * `isPaypalVaultBindingSupported`, the store offer DTO's
 * `trial.binding.supported` probe: an installed medusa-paypal that predates
 * the capability answers `false`, and the storefront hides the bind entry.
 */

/** The container key medusa-paypal registers its subscription module under. */
export const PAYPAL_SUBSCRIPTION_MODULE_KEY = "paypalSubscription"

export type PaypalVaultStartApprovalInput = {
  customer_id: string
  return_url: string
  cancel_url: string
}

export type PaypalVaultStartApprovalResult = {
  setup_token_id: string
  approve_url: string
}

export type PaypalVaultCompleteApprovalInput = {
  setup_token_id: string
}

export type PaypalVaultCompleteApprovalResult = {
  status: string
  vault_id?: string | null
  customer_id?: string | null
}

/**
 * The structural type of the resolved `paypalSubscription` service, narrowed
 * to exactly the two methods this plugin consumes. It is a description of a
 * foreign object, not an import: nothing here can drift out of sync with the
 * package because nothing here is compiled against it — which is precisely why
 * every consumer must go through `resolvePaypalVaultBindingCapability` and
 * handle `null` (the guarantee that the methods exist lives at runtime, in the
 * duck-type, not in the compiler).
 */
export type PaypalVaultBindingCapability = {
  startVaultApproval: (
    input: PaypalVaultStartApprovalInput
  ) => Promise<PaypalVaultStartApprovalResult>
  completeVaultApproval: (
    input: PaypalVaultCompleteApprovalInput
  ) => Promise<PaypalVaultCompleteApprovalResult>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

/**
 * Resolve the vault-binding capability out of the caller's container.
 *
 * Returns `null` — never throws — when the PayPal plugin is not installed at
 * all (no registration for the key) or the installed provider predates the
 * capability (either method missing). Callers turn `null` into their own
 * answer: the store offer DTO reports `binding.supported: false`, the bind
 * route refuses with a clear error. Nothing is ever created on the `null`
 * path.
 */
export function resolvePaypalVaultBindingCapability(
  container: { resolve: (key: string) => unknown }
): PaypalVaultBindingCapability | null {
  let resolved: unknown

  try {
    resolved = container.resolve(PAYPAL_SUBSCRIPTION_MODULE_KEY)
  } catch {
    // The medusa-paypal plugin is not installed: no capability to speak of.
    return null
  }

  if (!isRecord(resolved)) {
    return null
  }

  const candidate = resolved as Partial<PaypalVaultBindingCapability>

  if (
    typeof candidate.startVaultApproval !== "function" ||
    typeof candidate.completeVaultApproval !== "function"
  ) {
    return null
  }

  return {
    startVaultApproval:
      candidate.startVaultApproval.bind(resolved) as PaypalVaultBindingCapability["startVaultApproval"],
    completeVaultApproval:
      candidate.completeVaultApproval.bind(resolved) as PaypalVaultBindingCapability["completeVaultApproval"],
  }
}

/**
 * Whether the installed PayPal provider can bind a payment method without
 * charging — the value the store offer DTO reports as
 * `trial.binding.supported`. A missing plugin or an outdated provider answers
 * `false`, and the storefront hides the bound button.
 */
export function isPaypalVaultBindingSupported(scope: {
  resolve: (key: string) => unknown
}): boolean {
  return resolvePaypalVaultBindingCapability(scope) !== null
}
