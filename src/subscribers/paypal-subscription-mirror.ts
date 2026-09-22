import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import type { MedusaContainer } from "@medusajs/framework/types"
import {
  PAYPAL_SUBSCRIPTION_EVENT_NAMES,
  buildNativeMirrorFields,
  type NativeSubscriptionEventPayload,
} from "../modules/subscription/utils/native-mirror"
import { upsertNativeMirrorSubscription } from "../modules/subscription/utils/native-mirror-sync"

type Logger = {
  info: (msg: string) => void
  warn: (msg: string) => void
}

/**
 * Mirrors provider-owned subscriptions into this plugin's `subscription` table.
 *
 * A PayPal recurrence is otherwise invisible to reorder, so the exclusivity
 * checks in checkout would have to ask the provider — and "does this customer
 * already have a subscription for this product" is exactly the question that
 * must be answered locally, on the request path, before money moves. Upserting
 * on the `NATIVE-{paypal_subscription_id}` reference makes replays and
 * out-of-order delivery harmless.
 *
 * A mirror row never acquires a renewal cycle, never enters dunning, and is
 * excluded from every charge path; see `native-subscription.ts`.
 *
 * Loading this subscriber is harmless when medusa-paypal is not installed: the
 * events simply never arrive.
 */
export default async function paypalSubscriptionMirrorHandler({
  event,
  container,
}: SubscriberArgs<NativeSubscriptionEventPayload>) {
  const logger = container.resolve<Logger>(ContainerRegistrationKeys.LOGGER)
  const eventName = event.name

  const built = buildNativeMirrorFields(eventName, event.data ?? {})

  if (!built.ok) {
    // Skipping is the safe half of the contract: a mirror row built from a
    // partial payload would look like a live recurrence to checkout and reject
    // a purchase that should have gone through.
    logger.warn(
      `[reorder] ignored '${eventName}': ${built.reason} (no mirror row written)`
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
  event: [...PAYPAL_SUBSCRIPTION_EVENT_NAMES],
}
