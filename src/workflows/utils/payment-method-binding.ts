/**
 * The runtime contract with `@mengyyy369/medusa-payment-methods`' **binding**
 * surface (0.2.0, plan 0.9.3 ticket 01 / B6): the plugin starts and completes
 * a payment-method binding and returns the ledger method it created.
 *
 * **The contract is consumed by duck-typing, on purpose** — the same mechanism
 * the capability view uses for the provider side (`provider-capabilities.ts`). reorder compiles
 * against the published package's reader surface (`ensureCustomerAccountHolder`,
 * the container key, the row types); the binding methods arrived in 0.2.0 with
 * a **breaking** signature change (`container` moved to the first argument of
 * `startBinding`), so a name check alone cannot tell the versions apart. The
 * discriminator is the arity: 0.2.0's `startBinding(container, input)` reports
 * `length === 2`, while the pre-0.2.0 `startBinding(input)` reports `1`. A
 * module that predates the container-first signature resolves to `null` and
 * every consumer refuses before anything is created.
 *
 * The two methods reorder consumes:
 *
 * - `startBinding(container, { customerId, returnUrl, cancelUrl, scope? })`
 *     → `{ approvalUrl, state }` — 409 `already_bound` when the customer
 *       already owns a method of the provider (provider-dedup layer 1), and
 *       the `state` it returns is the ownership anchor `completeBinding`
 *       verifies.
 * - `completeBinding(container, { customerId, state, scope? })`
 *     → `{ method: PaymentMethodRow }` — only completes a state this plugin
 *       issued to the calling customer (session gate), replays an already
 *       completed session idempotently, and returns the **ledger method
 *       reference** (`method.id`) that is authoritative from the moment the
 *       provider minted it (defect D1 — never re-verified by listing).
 *
 * When `scope` is given it must be one the site adapter reports or a
 * plugin-owned scope; `PLUGIN_TRIAL_PAYMENT_SCOPE` below mirrors the plugin's
 * own `TRIAL_PAYMENT_SCOPE` constant ("trial"), which `withPluginScopes`
 * merges into every customer's scope list, so the trial bind validates end to
 * end. A scope on `completeBinding` also makes the fresh method that scope's
 * preferred method — which is exactly how the auto-renew bind flow (ticket
 * 01③) lands the customer's card on the subscription's product scope.
 */

/** The container registration key of the plugin's module. */
export const PAYMENT_METHODS_BINDING_MODULE_KEY = "paymentMethods"

/**
 * Mirrors `TRIAL_PAYMENT_SCOPE` from @mengyyy369/medusa-payment-methods 0.2.0
 * (the published package this repo compiles against predates it). Keep in
 * step with the plugin contract: the value is part of the wire contract the
 * plugin validates scopes against.
 */
export const PLUGIN_TRIAL_PAYMENT_SCOPE = "trial"

/** The row the plugin's complete returns, narrowed to what reorder reads. */
export type BoundPaymentMethod = {
  id: string
  provider_id: string
}

export type StartPaymentMethodBindingInput = {
  customerId: string
  /** The provider registration key; omit it when a single binder is registered. */
  providerId?: string | null
  returnUrl: string
  cancelUrl: string
  /** A plugin- or site-owned scope id (the trial bind sends `"trial"`). */
  scope?: string | null
}

export type StartPaymentMethodBindingResult = {
  approvalUrl: string
  state: string
}

export type CompletePaymentMethodBindingInput = {
  customerId: string
  providerId?: string | null
  /** The opaque handle the start returned (PayPal: the setup token id). */
  state: string
  scope?: string | null
}

export type CompletePaymentMethodBindingResult = {
  method: BoundPaymentMethod
}

/**
 * The structural type of the resolved 0.2.0 module service, narrowed to the
 * two binding methods. The container is an explicit first argument — that is
 * both the contract and the version discriminator.
 */
export type PaymentMethodBindingCapability = {
  startBinding: (
    container: unknown,
    input: StartPaymentMethodBindingInput
  ) => Promise<StartPaymentMethodBindingResult>
  completeBinding: (
    container: unknown,
    input: CompletePaymentMethodBindingInput
  ) => Promise<CompletePaymentMethodBindingResult>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

/**
 * Resolve the binding capability out of the caller's container.
 *
 * Returns `null` — never throws — when the payment-methods module is not
 * registered at all, or the installed version predates the container-first
 * binding surface (arity check above). Callers turn `null` into their own
 * refusal; nothing is ever created on the `null` path.
 */
export function resolvePaymentMethodBindingCapability(container: {
  resolve: (key: string) => unknown
}): PaymentMethodBindingCapability | null {
  let resolved: unknown

  try {
    resolved = container.resolve(PAYMENT_METHODS_BINDING_MODULE_KEY)
  } catch {
    return null
  }

  if (!isRecord(resolved)) {
    return null
  }

  const candidate = resolved as Record<string, unknown>

  if (
    typeof candidate.startBinding !== "function" ||
    typeof candidate.completeBinding !== "function" ||
    // 0.2.0 took the container as the first argument; the pre-0.2.0
    // startBinding(input) has arity 1 and cannot be called safely.
    candidate.startBinding.length < 2 ||
    candidate.completeBinding.length < 2
  ) {
    return null
  }

  return {
    startBinding: candidate.startBinding.bind(resolved) as PaymentMethodBindingCapability["startBinding"],
    completeBinding: candidate.completeBinding.bind(resolved) as PaymentMethodBindingCapability["completeBinding"],
  }
}
