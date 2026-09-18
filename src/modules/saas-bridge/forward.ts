import type {
  MedusaContainer,
  RemoteQueryFunction,
} from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import type { WebhooksFanOutFactory } from "./service"
import type { SaasBridgeConfig } from "./types"

type BridgeLogger = { info: (msg: string) => void; error: (msg: string) => void }

export type EnrichedPayload = {
  event: string
  data: Record<string, unknown>
  order_id?: string | null
  cart_id?: string | null
  customer_id?: string | null
  email?: string | null
}

export type FanOutResolver = () => {
  fullWebhooksSubscriptionsWorkflow: WebhooksFanOutFactory
} | null

/**
 * Forwards subscribed events into the medusa-webhooks fan-out (which signs
 * deliveries per endpoint). Order-ish events are enriched with
 * customer/email/cart metadata so receivers can route without a round-trip;
 * amounts and authoritative state always come from the reconcile endpoint.
 *
 * The optional peer is resolved LAZILY here — module discovery loads this
 * code even when saas_bridge is unconfigured, so nothing at the top level
 * may touch the peer. Forwarding failures are logged, never thrown into the
 * event pipeline.
 */
export async function forwardEvent({
  container,
  config,
  eventName,
  eventData,
  logger,
  resolveFanOut,
}: {
  container: MedusaContainer
  config: SaasBridgeConfig | null
  eventName: string
  eventData: Record<string, unknown>
  logger: BridgeLogger
  resolveFanOut: FanOutResolver
}): Promise<void> {
  if (!config?.subscriptions.includes(eventName)) {
    return
  }

  try {
    const fanOut = resolveFanOut()
    if (!fanOut) {
      throw new Error(
        "@mengyyy369/medusa-webhooks is not resolvable — it is an optional peer dependency required by the saas_bridge subscriptions whitelist"
      )
    }

    const payload = await buildPayload(container, eventName, eventData)

    await fanOut.fullWebhooksSubscriptionsWorkflow(container).run({
      input: {
        eventName,
        eventData: payload as unknown as Record<string, unknown>,
      },
    })
  } catch (error) {
    logger.error(
      `[saas-bridge] Failed to forward event '${eventName}': ${
        error instanceof Error ? error.message : String(error)
      }`
    )
  }
}

export async function buildPayload(
  container: MedusaContainer,
  eventName: string,
  data: Record<string, unknown>
): Promise<EnrichedPayload> {
  const base: EnrichedPayload = {
    event: eventName,
    data,
  }

  const orderId =
    typeof data.id === "string" && data.id.startsWith("order_")
      ? data.id
      : (data.order_id as string | undefined)

  if (!orderId) {
    // reorder lifecycle events already carry identity fields
    return {
      ...base,
      customer_id: (data.customer_id as string) ?? null,
      email: null,
    }
  }

  const query = container.resolve<RemoteQueryFunction>(
    ContainerRegistrationKeys.QUERY
  )

  const { data: orders } = await query.graph({
    entity: "order",
    fields: [
      "id",
      "display_id",
      "customer_id",
      "email",
      "payment_status",
      "currency_code",
      "total",
      "metadata",
    ],
    filters: { id: orderId },
  })

  const order = orders[0] as
    | {
        id: string
        display_id: number | string | null
        customer_id: string | null
        email: string | null
        payment_status: string
        currency_code: string
        total: number
        metadata: Record<string, unknown> | null
      }
    | undefined

  if (!order) {
    return base
  }

  const cartLink = await query.graph({
    entity: "order_cart",
    fields: ["cart_id"],
    filters: { order_id: orderId },
  })

  return {
    ...base,
    order_id: order.id,
    cart_id:
      (cartLink.data as Array<{ cart_id?: string }>)[0]?.cart_id ?? null,
    customer_id: order.customer_id,
    email: order.email,
    data: {
      ...data,
      display_id: order.display_id ?? null,
      payment_status: order.payment_status,
      currency_code: order.currency_code,
      total: Number(order.total ?? 0),
      metadata: order.metadata ?? null,
    },
  }
}
