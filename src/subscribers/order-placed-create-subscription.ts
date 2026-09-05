import type {
  SubscriberArgs,
  SubscriberConfig,
} from "@medusajs/framework"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import type {
  IWorkflowEngineService,
  RemoteQueryFunction,
} from "@medusajs/framework/types"

type OrderPlacedPayload = {
  id: string
}

/**
 * Creates subscription records for orders whose subscription line item went
 * through the normal checkout (redirect-based payment providers settle
 * asynchronously, so the order must exist first). The workflow is invoked by
 * name through the workflow engine — importing the workflow here would
 * register a second module-instance copy of it (workflow graphs are not
 * deterministic across module graphs; see create-subscription-from-order.ts).
 *
 * Idempotent: orders already linked to a subscription are skipped by the
 * workflow itself.
 */
export default async function orderPlacedSubscriptionHandler({
  event,
  container,
}: SubscriberArgs<OrderPlacedPayload>) {
  const orderId = event.data?.id

  if (!orderId) {
    return
  }

  const logger = container.resolve("logger")

  try {
    const isSubscriptionOrder = await hasSubscriptionLineItem(container, orderId)

    if (!isSubscriptionOrder) {
      return
    }

    const engine = container.resolve<IWorkflowEngineService>(
      Modules.WORKFLOW_ENGINE
    )

    await engine.run("create-subscription-from-order", {
      input: { order_id: orderId },
      throwOnError: true,
    })
  } catch (error) {
    logger.error(
      `[reorder] Failed to create subscription from order '${orderId}': ${
        error instanceof Error ? error.message : String(error)
      }`
    )
  }
}

export const config: SubscriberConfig = {
  event: "order.placed",
}

async function hasSubscriptionLineItem(
  container: SubscriberArgs<OrderPlacedPayload>["container"],
  orderId: string
) {
  const query = container.resolve<RemoteQueryFunction>(
    ContainerRegistrationKeys.QUERY
  )

  const { data } = await query.graph({
    entity: "order",
    fields: ["items.metadata"],
    filters: { id: orderId },
  })

  const order = (data as Array<{
    items?: Array<{ metadata?: Record<string, unknown> | null } | null>
  }>)[0]

  if (!order?.items?.length) {
    return false
  }

  return order.items.some((item) => {
    const isSubscription = item?.metadata?.is_subscription

    return isSubscription === true || isSubscription === "true"
  })
}
