import type {
  SubscriberArgs,
  SubscriberConfig,
} from "@medusajs/framework"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import type { MedusaContainer } from "@medusajs/framework/types"
import { SAAS_BRIDGE_MODULE } from "../modules/saas-bridge"
import type SaasBridgeModuleService from "../modules/saas-bridge/service"
import { tryRequireWebhooksWorkflows } from "../modules/saas-bridge/service"
import { forwardEvent } from "../modules/saas-bridge/forward"

/**
 * Forwards whitelisted lifecycle events into the medusa-webhooks fan-out.
 * Registered statically on all ten lifecycle events; the runtime
 * `subscriptions` whitelist (from the saas_bridge option) decides what is
 * actually forwarded — with saas_bridge unconfigured, nothing is.
 *
 * The optional peer @mengyyy369/medusa-webhooks is resolved lazily inside
 * forwardEvent, never at the top level: module discovery loads subscriber
 * files even when saas_bridge is unconfigured, and installing the plugin
 * without the peer must work.
 */
export default async function forwardSaasEventsHandler({
  event,
  container,
}: SubscriberArgs<Record<string, unknown>>) {
  const service = container.resolve<SaasBridgeModuleService>(SAAS_BRIDGE_MODULE)
  const config = service.getConfig()
  const logger = container.resolve<{
    info: (msg: string) => void
    error: (msg: string) => void
  }>(ContainerRegistrationKeys.LOGGER)

  await forwardEvent({
    container: container as MedusaContainer,
    config,
    eventName: event.name,
    eventData: event.data ?? {},
    logger,
    resolveFanOut: tryRequireWebhooksWorkflows,
  })
}

export const config: SubscriberConfig = {
  event: [
    "order.placed",
    "order.updated",
    "payment.captured",
    "subscription.created",
    "subscription.paused",
    "subscription.resumed",
    "subscription.canceled",
    "subscription.plan_change_scheduled",
    "renewal.succeeded",
    "renewal.failed",
  ],
}
