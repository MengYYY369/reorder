import type {
  SubscriberArgs,
  SubscriberConfig,
} from "@medusajs/framework"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import type {
  IWorkflowEngineService,
  MedusaContainer,
  RemoteQueryFunction,
} from "@medusajs/framework/types"
import {
  ActivityLogActorType,
  ActivityLogEventType,
} from "../modules/activity-log/types"
import { normalizeActivityLogEvent } from "../modules/activity-log/utils/normalize-log-event"
import { persistSubscriptionLogEvent } from "../modules/activity-log/utils/persist-log-event"
import {
  extractFailedStep,
  serializeErrorChain,
  toDedupeQualifier,
} from "../modules/activity-log/utils/serialize-error-chain"

type OrderPlacedPayload = {
  id: string
}

type SubscriptionOrderContext = {
  customer_id: string | null
  product_title: string | null
  variant_title: string | null
}

type WorkflowRunOutcome = {
  acknowledgement?: { hasFailed?: boolean } | null
  errors?: unknown
  thrownError?: unknown
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
 *
 * A failed creation leaves an order without a subscription row, which is
 * invisible to support unless it is recorded: the workflow is run with
 * `throwOnError: false` so the engine reports the failing step and its nested
 * error chain, and both are persisted to `subscription_log` as
 * `subscription.creation_failed`.
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
    const orderContext = await loadSubscriptionOrderContext(container, orderId)

    if (!orderContext) {
      return
    }

    const engine = container.resolve<IWorkflowEngineService>(
      Modules.WORKFLOW_ENGINE
    )

    const outcome: WorkflowRunOutcome = await engine.run(
      "create-subscription-from-order",
      {
        input: { order_id: orderId },
        throwOnError: false,
      }
    )

    const errors = Array.isArray(outcome?.errors) ? outcome.errors : []
    const failed = outcome?.acknowledgement?.hasFailed === true || errors.length > 0

    if (failed) {
      await recordCreationFailure(
        container,
        logger,
        orderId,
        orderContext,
        errors.length ? errors : (outcome?.thrownError ?? outcome)
      )
    }
  } catch (error) {
    await recordCreationFailure(container, logger, orderId, null, error)
  }
}

export const config: SubscriberConfig = {
  event: "order.placed",
}

/**
 * Returns null when the order is not a subscription order (nothing to create,
 * nothing to log).
 */
async function loadSubscriptionOrderContext(
  container: MedusaContainer,
  orderId: string
): Promise<SubscriptionOrderContext | null> {
  const query = container.resolve<RemoteQueryFunction>(
    ContainerRegistrationKeys.QUERY
  )

  const { data } = await query.graph({
    entity: "order",
    fields: [
      "customer_id",
      "items.metadata",
      "items.variant.title",
      "items.variant.product.title",
    ],
    filters: { id: orderId },
  })

  const order = (data as Array<{
    customer_id?: string | null
    items?:
      | Array<{
          metadata?: Record<string, unknown> | null
          variant?: {
            title?: string | null
            product?: { title?: string | null } | null
          } | null
        } | null
      > | null
  }>)[0]

  const items = order?.items ?? []

  if (!items.length) {
    return null
  }

  const subscriptionItem = items.find((item) => {
    const isSubscription = item?.metadata?.is_subscription

    return isSubscription === true || isSubscription === "true"
  })

  if (!subscriptionItem) {
    return null
  }

  return {
    customer_id: order?.customer_id ?? null,
    product_title: subscriptionItem.variant?.product?.title ?? null,
    variant_title: subscriptionItem.variant?.title ?? null,
  }
}

/**
 * Best-effort: recording the failure must never mask or replace the original
 * error, and must never fail the subscriber itself.
 */
async function recordCreationFailure(
  container: MedusaContainer,
  logger: { error(message: string): void },
  orderId: string,
  orderContext: SubscriptionOrderContext | null,
  source: unknown
) {
  const step = extractFailedStep(source)
  const chain = serializeErrorChain(source)
  const reason =
    `[reorder] Failed to create subscription from order '${orderId}' ` +
    `at step '${step ?? "unknown-step"}': ${chain}`

  logger.error(reason)

  try {
    await persistSubscriptionLogEvent(
      container,
      normalizeActivityLogEvent({
        customer_id: orderContext?.customer_id ?? null,
        event_type: ActivityLogEventType.SUBSCRIPTION_CREATION_FAILED,
        actor_type: ActivityLogActorType.SYSTEM,
        display: {
          customer_name: null,
          product_title: orderContext?.product_title ?? null,
          variant_title: orderContext?.variant_title ?? null,
        },
        reason,
        metadata: {
          order_id: orderId,
          source: "store",
          trigger_type: "order_placed",
          reason_code: step ?? "unknown-step",
        },
        dedupe: {
          scope: "order",
          target_id: orderId,
          qualifier: toDedupeQualifier(step),
        },
      })
    )
  } catch (error) {
    logger.error(
      `[reorder] Could not record creation failure for order '${orderId}': ${
        serializeErrorChain(error)
      }`
    )
  }
}
