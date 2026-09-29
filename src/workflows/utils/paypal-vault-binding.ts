/**
 * The runtime contract with medusa-paypal's vault-binding capability (Phase 14,
 * plan Task 22), and the two lookups every consumer of that capability needs.
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
 * The sandbox verification of 2026-09-28 (medusa-paypal
 * `.scratch/paypal-subscriptions/issues/07-sandbox-verification-and-docs.md`)
 * proved the whole chain works off-session and corrected one detail this side
 * must honor: after the buyer approves, the setup token reads back
 * **`VAULTED`**, not `APPROVED` — so the accepted post-approval statuses are
 * `APPROVED`, `VAULTED` and `TOKENIZED`, treated as exchangeable.
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

/**
 * The setup-token statuses that mean "the buyer approved; exchange it now".
 * The sandbox measured `VAULTED` after a real approval (`APPROVED` was never
 * observed), and the provider plan's Task P1 Step 3 was corrected to treat the
 * three as exchangeable — waiting for `APPROVED` alone stalls after every
 * real approval.
 */
export const APPROVED_VAULT_STATUSES = ["APPROVED", "VAULTED", "TOKENIZED"] as const

export type ApprovedVaultStatus = (typeof APPROVED_VAULT_STATUSES)[number]

export function isApprovedVaultStatus(status: unknown): status is ApprovedVaultStatus {
  return (
    typeof status === "string" &&
    (APPROVED_VAULT_STATUSES as readonly string[]).includes(status)
  )
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

/**
 * The payment provider id the bound method must be charged through later.
 *
 * Read from the **payment module's own provider declaration**, the way
 * medusa-paypal's `findPaypalProviderDeclaration` does — not from a hardcoded
 * literal. `native-mirror-sync.ts` writes `"pp_paypal_paypal"` and that
 * literal is exactly what this function must not copy: a host that registers
 * the provider with a different declaration `id` gets a different registration
 * key, and a guessed one charges nothing (or fails the payment session).
 *
 * The key shape is Medusa's own: the payment module loader registers each
 * provider under `` `pp_${klass.identifier}${id ? `_${id}` : ""}` ``
 * (`@medusajs/payment/dist/loaders/providers.js:45`), and the PayPal provider's
 * service class carries the static identifier `paypal` — which is why the
 * reference derivation in medusa-paypal (`src/api/lib/paypal.ts`,
 * `findPaypalProviderDeclaration`) builds `pp_paypal` plus the declaration's
 * `id`. The same two facts are reproduced here, from the declaration the
 * running app actually loaded: in tests the fake provider's declaration is the
 * truth, in production the host's `medusa-config.ts` is.
 *
 * Returns `null` when the payment module declares no PayPal-shaped provider
 * (`id === "paypal"` or a `resolve` path containing "paypal", the same
 * predicate the reference implementation uses).
 */
export function findPaypalPaymentProviderId(paymentModule: unknown): string | null {
  if (!isRecord(paymentModule) || !isRecord(paymentModule.moduleDeclaration)) {
    return null
  }

  const providers = paymentModule.moduleDeclaration.providers

  if (!Array.isArray(providers)) {
    return null
  }

  for (const provider of providers) {
    if (!isRecord(provider)) {
      continue
    }

    const declarationId =
      typeof provider.id === "string" && provider.id.length > 0
        ? provider.id
        : undefined
    const resolvePath =
      typeof provider.resolve === "string"
        ? provider.resolve.toLowerCase()
        : ""

    const isPaypal = declarationId === "paypal" || resolvePath.includes("paypal")

    if (isPaypal) {
      return `pp_paypal${declarationId ? `_${declarationId}` : ""}`
    }
  }

  return null
}
