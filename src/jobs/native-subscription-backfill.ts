import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import type { MedusaContainer } from "@medusajs/framework/types"
import { backfillNativeMirrorSubscriptions } from "../modules/subscription/utils/native-mirror-sync"

type Logger = {
  info: (msg: string) => void
  warn: (msg: string) => void
}

/**
 * Reconcile the native mirror set against the provider's own subscriptions.
 *
 * Two jobs, one pass:
 * - backfill: PayPal subscriptions created before this plugin was installed
 *   never re-emit their `activated` event, so without this the mirror set only
 *   covers what arrives from here on, and the checkout exclusivity gate would
 *   not see the rows that matter most.
 * - drift: medusa-paypal emits `paypal.subscription.revised` only from 0.5.0,
 *   so until then this pass is what notices a plan swap.
 *
 * No-op when medusa-paypal is not installed.
 */
export default async function nativeSubscriptionBackfillJob(
  container: MedusaContainer
) {
  const logger = container.resolve<Logger>(ContainerRegistrationKeys.LOGGER)

  const result = await backfillNativeMirrorSubscriptions(container, logger)

  logger.info(
    `[reorder] native subscription reconcile: scanned ${result.scanned}, ` +
      `created ${result.created}, updated ${result.updated}, skipped ${result.skipped.length}`
  )

  for (const skip of result.skipped) {
    logger.warn(
      `[reorder] native subscription reconcile skipped ` +
        `'${skip.reference ?? "unknown"}': ${skip.reason}`
    )
  }
}

export const config = {
  name: "native-subscription-backfill",
  schedule: "17 * * * *", // once an hour, off the hour
}
