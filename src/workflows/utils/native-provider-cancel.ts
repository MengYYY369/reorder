/**
 * The runtime contract with medusa-paypal's subscription-lifecycle surface,
 * used to cancel a provider-owned recurrence when a native mirror row is
 * cancelled on the Medusa side (2026-10-02 walkthrough plan, T04).
 *
 * Native rows mirror a PayPal-managed subscription: PayPal charges the payer
 * itself, so a local status change alone never stops the billing. The
 * cancellation path therefore has to hand the cancel to the provider.
 *
 * The contract is duck-typed on purpose - this plugin has no dependency on
 * medusa-paypal. The resolved `paypalSubscription` service is used only when
 * it exposes both methods:
 *
 * - `listSubscriptions({ paypal_subscription_id })` -> `[rows, count]`
 * - `requestLifecycleAction(rowId, "cancel")` -> the transitioned row
 *
 * Every failure is contained: the caller gets an outcome object, never a
 * throw, because a failed provider cancel must not roll back the local
 * cancellation. The outcome is recorded in the row's `cancel_context`
 * metadata, and the operator can retry from the PayPal admin page.
 */
import {
  isNativeSubscriptionReference,
  NATIVE_SUBSCRIPTION_REFERENCE_PREFIX,
} from "../../modules/subscription/utils/native-subscription"

/** The container key medusa-paypal registers its subscription module under. */
export const PAYPAL_SUBSCRIPTION_MODULE_KEY = "paypalSubscription"

export type PaypalNativeCancelCapability = {
  listSubscriptions: (
    filters: Record<string, unknown>
  ) => Promise<[Array<{ id: string }>, number]>
  requestLifecycleAction: (id: string, action: "cancel") => Promise<unknown>
}

/**
 * The provider subscription id of a native mirror row, or null when the row
 * is not a native mirror (or carries no id after the prefix).
 */
export function paypalSubscriptionIdFromReference(
  reference: unknown
): string | null {
  if (!isNativeSubscriptionReference(reference)) {
    return null
  }

  const id = (reference as string)
    .slice(NATIVE_SUBSCRIPTION_REFERENCE_PREFIX.length)
    .trim()

  return id || null
}

/**
 * Resolve the lifecycle capability out of the caller's container. Returns
 * `null` - never throws - when the PayPal plugin is not installed or the
 * installed version predates the surface.
 */
export function resolvePaypalNativeCancelCapability(container: {
  resolve: (key: string) => unknown
}): PaypalNativeCancelCapability | null {
  let resolved: unknown

  try {
    resolved = container.resolve(PAYPAL_SUBSCRIPTION_MODULE_KEY)
  } catch {
    return null
  }

  if (!resolved || typeof resolved !== "object") {
    return null
  }

  const candidate = resolved as Record<string, unknown>

  if (
    typeof candidate.listSubscriptions !== "function" ||
    typeof candidate.requestLifecycleAction !== "function"
  ) {
    return null
  }

  return resolved as PaypalNativeCancelCapability
}

export type NativeProviderCancelOutcome =
  | {
      status: "skipped"
      reason: "not_native" | "capability_absent" | "provider_row_missing"
    }
  | {
      status: "cancelled"
      paypal_subscription_id: string
      provider_row_id: string
    }
  | { status: "failed"; paypal_subscription_id: string; error: string }

/**
 * Cancel the provider side of a native mirror row. Idempotent by
 * construction: the provider treats a repeat cancel as converged, and a
 * missing capability or row is a recorded skip rather than an error.
 */
export async function cancelNativeProviderSubscription(
  container: { resolve: (key: string) => unknown },
  reference: unknown
): Promise<NativeProviderCancelOutcome> {
  const paypalSubscriptionId = paypalSubscriptionIdFromReference(reference)

  if (!paypalSubscriptionId) {
    return { status: "skipped", reason: "not_native" }
  }

  const capability = resolvePaypalNativeCancelCapability(container)

  if (!capability) {
    return { status: "skipped", reason: "capability_absent" }
  }

  try {
    const [rows] = await capability.listSubscriptions({
      paypal_subscription_id: paypalSubscriptionId,
    })
    const providerRow = rows?.[0]

    if (!providerRow?.id) {
      return { status: "skipped", reason: "provider_row_missing" }
    }

    await capability.requestLifecycleAction(providerRow.id, "cancel")

    return {
      status: "cancelled",
      paypal_subscription_id: paypalSubscriptionId,
      provider_row_id: providerRow.id,
    }
  } catch (error) {
    return {
      status: "failed",
      paypal_subscription_id: paypalSubscriptionId,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}
