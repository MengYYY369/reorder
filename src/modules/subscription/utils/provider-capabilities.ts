import type { MedusaContainer } from "@medusajs/framework/types"
import type {
  NativeCancelOutcome,
  ProviderCapabilityView,
} from "@mengyyy369/medusa-payment-methods"
import { readNativeProviderTarget } from "./native-subscription"

/**
 * The plugin's module registration key (`PAYMENT_METHODS_MODULE` in its own
 * package). Resolved by string so a deployment without the plugin degrades
 * quietly instead of failing at import time.
 */
export const PAYMENT_METHODS_MODULE = "paymentMethods"

/**
 * What this deployment's providers can do, in process.
 *
 * Returns an empty list when the plugin is absent, is an older version, or
 * answers nothing usable: a deployment without it simply has no provider rails,
 * which is a normal state here rather than an error. Every caller therefore
 * degrades to "no native capability" instead of failing a request.
 *
 * The view carries the callable operations (the plugin builds them per call),
 * which is why this is the only entry point the mirror, the backfill and the
 * cancel path need — reorder never touches a provider package directly.
 */
export async function resolveProviderCapabilities(
  container: MedusaContainer
): Promise<ProviderCapabilityView[]> {
  try {
    const service = container.resolve(PAYMENT_METHODS_MODULE) as
      | {
          getProviderCapabilities?: (
            container: MedusaContainer,
            input?: { providerId?: string | null; kind?: string | null }
          ) => Promise<ProviderCapabilityView[]>
        }
      | undefined

    if (typeof service?.getProviderCapabilities !== "function") {
      return []
    }

    const capabilities = await service.getProviderCapabilities(container)

    return Array.isArray(capabilities) ? capabilities : []
  } catch {
    return []
  }
}

/** A capability that has a native rail, with the rail's operations narrowed in. */
export type NativeCapability = ProviderCapabilityView & {
  native: NonNullable<ProviderCapabilityView["native"]>
}

export function nativeCapabilities(
  capabilities: ProviderCapabilityView[]
): NativeCapability[] {
  return capabilities.filter(
    (capability): capability is NativeCapability => capability.native !== null
  )
}

/** The native capability of one provider key, or `null`. */
export function findNativeCapability(
  capabilities: ProviderCapabilityView[],
  providerId: string | null | undefined
): NativeCapability | null {
  if (!providerId) {
    return null
  }

  return (
    nativeCapabilities(capabilities).find(
      (capability) => capability.provider_id === providerId
    ) ?? null
  )
}

/** The native capability of one provider family (`paypal`), or `null`. */
export function findNativeCapabilityByKind(
  capabilities: ProviderCapabilityView[],
  kind: string | null | undefined
): NativeCapability | null {
  if (!kind) {
    return null
  }

  return (
    nativeCapabilities(capabilities).find(
      (capability) => capability.kind === kind
    ) ?? null
  )
}

/**
 * Cancel the provider side of one mirror row, reading the provider key and the
 * provider's own subscription id off the row itself.
 *
 * A row that is not a native mirror answers `skipped(not_native)` — the caller
 * is a cascade over *every* row a customer owns, so "this one is ours, not the
 * provider's" is a normal answer rather than a failure.
 */
export async function cancelNativeSubscriptionRow(
  container: MedusaContainer,
  row: { reference?: unknown; payment_context?: unknown }
): Promise<NativeCancelOutcome> {
  const target = readNativeProviderTarget(row)

  if (!target) {
    return { status: "skipped", reason: "not_native" }
  }

  return cancelNativeSubscription(container, target)
}

/**
 * Ask a provider to cancel one of its own subscriptions.
 *
 * `reference` is the provider's own subscription id — reorder reads it from the
 * mirror row's `payment_context.customer_payment_reference`, never by parsing
 * the `NATIVE-…` key. Every answer is a neutral outcome, including "this
 * deployment has no such provider" and "the provider failed": the callers are a
 * customer-deletion cascade and a workflow step, neither of which should have to
 * tell a provider outage apart from a missing capability by catching.
 */
export async function cancelNativeSubscription(
  container: MedusaContainer,
  input: { providerId: string | null | undefined; reference: string | null | undefined }
): Promise<NativeCancelOutcome> {
  const reference = typeof input.reference === "string" ? input.reference.trim() : ""

  if (!reference) {
    return { status: "skipped", reason: "provider_row_missing" }
  }

  const capability = findNativeCapability(
    await resolveProviderCapabilities(container),
    input.providerId
  )

  if (!capability) {
    return { status: "skipped", reason: "capability_absent" }
  }

  try {
    return await capability.native.cancel(container, reference)
  } catch (error) {
    return {
      status: "failed",
      provider_subscription_id: reference,
      provider_row_id: null,
      error: error instanceof Error ? error.message : String(error ?? "unknown error"),
    }
  }
}
