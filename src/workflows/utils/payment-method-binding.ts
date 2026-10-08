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
 * `startBinding`), so a name check alone cannot tell the versions apart.
 *
 * **The discriminator is the installed package version**, not the arity — see
 * `installedBindingSupportsContainerArg` below for why the arity test that
 * used to live here was wrong on every real container. A module that predates
 * the container-first signature resolves to `null` and every consumer refuses
 * before anything is created.
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

import { createRequire } from "node:module"

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

/**
 * The first plugin minor that takes the container as `startBinding`'s first
 * argument (0.2.0). Anything below it has the incompatible
 * `startBinding(input)` signature.
 */
const CONTAINER_FIRST_SIGNATURE_MINOR = 2

/**
 * Whether the installed plugin exposes the container-first binding surface.
 *
 * **Why this is a version check and not an arity check.** The obvious
 * discriminator is `startBinding.length`: 0.2.0 declares
 * `startBinding(container, input)` (arity 2) while pre-0.2.0 declares
 * `startBinding(input)` (arity 1). That is what this module used to do — and it
 * was **always false on a real container**, so the capability resolved to
 * `null` for every version and the whole binding surface was silently dead in
 * production. Measured 2026-10-08 against the live backend with a diagnostic
 * patch:
 *
 * ```
 * [diag-g0] resolving: paymentMethods | registrations? true
 * [diag-g0] candidate keys: bindRateLimiter_ | startBinding: function 0 | completeBinding: function 0
 * ```
 *
 * Medusa resolves module services through a wrapper whose methods report
 * `length === 0`, so the arity carries **no information** about which signature
 * the plugin declares. Do not restore that check.
 *
 * Returns `null` when the version cannot be determined at all (the package is
 * not resolvable from here, or its `version` is not parseable). The caller
 * decides what to do with that — see the fail-open note in
 * `resolvePaymentMethodBindingCapability`.
 */
function installedBindingSupportsContainerArg(): boolean | null {
  let rawVersion: string

  try {
    const requireFromHere = createRequire(__filename)
    const pkg = requireFromHere(
      "@mengyyy369/medusa-payment-methods/package.json"
    ) as { version?: unknown }
    if (typeof pkg.version !== "string") return null
    rawVersion = pkg.version
  } catch {
    return null
  }

  const [major, minor] = rawVersion.split(".").map((part) => {
    const parsed = Number.parseInt(part, 10)
    return Number.isNaN(parsed) ? null : parsed
  })

  if (major === null || major === undefined) return null

  if (major > 0) return true
  if (minor === null || minor === undefined) return null
  return minor >= CONTAINER_FIRST_SIGNATURE_MINOR
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

/**
 * Resolve the binding capability out of the caller's container.
 *
 * Returns `null` — never throws — when the payment-methods module is not
 * registered at all, or the installed version is known to predate the
 * container-first binding surface. Callers turn `null` into their own refusal;
 * nothing is ever created on the `null` path.
 *
 * **Fails open when the version is unknown** (user decision, 2026-10-08 spec
 * `2026-10-08-binding-capability-discriminator.md`): if both methods are present
 * but the version lookup failed, the capability is returned anyway. A false
 * negative here disables the whole binding surface with no signal to anyone —
 * which is exactly how the arity bug survived to production. A false positive
 * surfaces as a runtime error at call time and creates nothing.
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
    typeof candidate.completeBinding !== "function"
  ) {
    return null
  }

  // `false` = we positively identified a pre-0.2.0 plugin, whose
  // `startBinding(input)` would receive the container as its input.
  // `null` = unknown version → fail open (see the doc comment).
  if (installedBindingSupportsContainerArg() === false) {
    return null
  }

  return {
    startBinding: candidate.startBinding.bind(resolved) as PaymentMethodBindingCapability["startBinding"],
    completeBinding: candidate.completeBinding.bind(resolved) as PaymentMethodBindingCapability["completeBinding"],
  }
}
