import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import type { MedusaContainer } from "@medusajs/framework/types"
import {
  NATIVE_SUBSCRIPTION_CHANGED_EVENT,
  type NativeSubscriptionChangedPayload,
} from "@mengyyy369/medusa-payment-methods"
import { buildNativeMirrorFieldsFromRecord } from "../modules/subscription/utils/native-mirror"
import {
  readProductIdsForVariants,
  upsertNativeMirrorSubscription,
} from "../modules/subscription/utils/native-mirror-sync"
import {
  findNativeCapabilityByKind,
  resolveProviderCapabilities,
} from "../modules/subscription/utils/provider-capabilities"

type Logger = {
  info: (msg: string) => void
  warn: (msg: string) => void
}

/**
 * Mirrors provider-owned subscriptions into this plugin's `subscription` table.
 *
 * A provider recurrence is otherwise invisible to reorder, so the exclusivity
 * checks in checkout would have to ask the provider — and "does this customer
 * already have a subscription for this product" is exactly the question that
 * must be answered locally, on the request path, before money moves. Upserting
 * on the `NATIVE-{kind}-{provider_subscription_id}` reference makes replays and
 * out-of-order delivery harmless.
 *
 * A mirror row never acquires a renewal cycle, never enters dunning, and is
 * excluded from every charge path; see `native-subscription.ts`.
 *
 * **The event name comes from `medusa-payment-methods`**, which owns it: a
 * provider package never knows it, so exactly one definition exists. Loading
 * this subscriber is harmless when no provider with a native rail is installed:
 * the events simply never arrive.
 */
export default async function nativeSubscriptionMirrorHandler({
  event,
  container,
}: SubscriberArgs<NativeSubscriptionChangedPayload>) {
  const logger = container.resolve<Logger>(ContainerRegistrationKeys.LOGGER)
  const payload = event.data

  if (!payload?.kind || !payload.provider_subscription_id) {
    logger.warn(
      `[reorder] ignored '${event.name}': the payload names no provider kind or subscription`
    )
    return
  }

  // `kind` is the join key: the payload's `provider_id` is the provider's own
  // payment-session echo (often null), while the mirror stores the payment
  // module's registration key — which only the capability view knows.
  const capability = findNativeCapabilityByKind(
    await resolveProviderCapabilities(container),
    payload.kind
  )

  if (!capability) {
    logger.warn(
      `[reorder] ignored '${event.name}': no registered provider has kind '${payload.kind}' (no mirror row written)`
    )
    return
  }

  const variantId = payload.variant_id ?? null
  const productIds = await readProductIdsForVariants(
    container,
    variantId ? [variantId] : []
  )

  const built = buildNativeMirrorFieldsFromRecord(
    {
      kind: payload.kind,
      provider_id: capability.provider_id,
      provider_subscription_id: payload.provider_subscription_id,
      plan_id: payload.plan_id ?? null,
      status: payload.status ?? null,
      customer_id: payload.customer_id ?? null,
      variant_id: variantId,
      interval_unit: payload.interval_unit,
      interval_count: payload.interval_count,
      next_billing_at: payload.next_billing_at ?? null,
      last_billing_at: payload.last_billing_at ?? null,
    },
    variantId ? productIds.get(variantId) ?? null : null
  )

  if (!built.ok) {
    // Skipping is the safe half of the contract: a mirror row built from a
    // partial payload would look like a live recurrence to checkout and reject
    // a purchase that should have gone through.
    logger.warn(
      `[reorder] ignored '${event.name}' (${payload.transition}): ${built.reason} (no mirror row written)`
    )
    return
  }

  await upsertNativeMirrorSubscription(
    container as MedusaContainer,
    built.fields,
    logger
  )
}

export const config: SubscriberConfig = {
  event: [NATIVE_SUBSCRIPTION_CHANGED_EVENT],
}
