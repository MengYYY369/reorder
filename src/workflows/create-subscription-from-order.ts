import {
  createWorkflow,
  transform,
  when,
  WorkflowResponse,
} from "@medusajs/framework/workflows-sdk"
import {
  acquireLockStep,
  releaseLockStep,
  useQueryGraphStep,
} from "@medusajs/medusa/core-flows"
import { createInitialRenewalCycleStep } from "./steps/create-initial-renewal-cycle"
import { labelSubscriptionOrderAdjustmentsStep } from "./steps/label-subscription-order-adjustments"
import {
  createSubscriptionRecordStep,
  type CreateSubscriptionRecordStepInput,
} from "./steps/create-subscription-record"
import { linkSubscriptionCommerceEntitiesStep } from "./steps/link-subscription-commerce-entities"
import {
  validateSubscriptionCartStep,
  type ValidateSubscriptionCartStepInput,
  type ValidatedSubscriptionCart,
} from "./steps/validate-subscription-cart"
import { createSubscriptionLogEventStep } from "./steps/create-subscription-log-event"
import { loadSubscriptionOrderStep } from "./steps/load-subscription-order"
import { normalizeActivityLogEvent } from "../modules/activity-log/utils/normalize-log-event"
import {
  ActivityLogActorType,
  ActivityLogEventType,
} from "../modules/activity-log/types"

export type CreateSubscriptionFromOrderWorkflowInput = {
  order_id: string
}

export type CreateSubscriptionFromOrderWorkflowOutput = {
  type: "order"
  order: {
    id: string
    display_id?: string | number | null
  } | null
  subscription:
    | (Record<string, unknown> & {
        id: string
      })
    | null
}

type OrderRecord = {
  id: string
  display_id?: string | number | null
  created_at: string | Date
}

const SUBSCRIPTION_ORDER_LINK_ENTRY_POINT = "subscription_order"

/**
 * Creates a subscription record from an order that was already placed through
 * the normal cart completion flow (redirect-based payment providers settle the
 * payment asynchronously, so the order exists before any subscription can be
 * minted). Reuses `validateSubscriptionCartStep` against the completed cart
 * (linked via the core `order_cart` link) so validation, snapshots and payment
 * context stay identical to the checkout flow.
 *
 * Idempotent: re-running against an order that already has a subscription
 * short-circuits and returns the existing record.
 */
export const createSubscriptionFromOrderWorkflow = createWorkflow(
  "create-subscription-from-order",
  function (input: CreateSubscriptionFromOrderWorkflowInput) {
    const lockInput = transform({ input }, ({ input }) => ({
      key: input.order_id,
      timeout: 30,
      ttl: 120,
    }))

    acquireLockStep(lockInput)

    const orderCartLink = useQueryGraphStep({
      entity: "order_cart",
      fields: ["cart_id", "order_id"],
      filters: {
        order_id: input.order_id,
      },
      options: {
        isList: false,
      },
    }).config({
      name: "load-order-cart-link",
    })

    const cartId = transform({ orderCartLink }, ({ orderCartLink }) => {
      const link = orderCartLink.data as { cart_id?: string } | undefined

      if (!link?.cart_id) {
        throw new Error(
          `Order '${input.order_id}' has no linked cart; subscription creation from order requires a cart-based order`
        )
      }

      return link.cart_id
    })

    const validatedCart = validateSubscriptionCartStep(
      transform({ cartId }, ({ cartId }) => {
        return {
          cart_id: cartId,
          allow_completed: true,
          default_payment_mode: "manual",
        } satisfies ValidateSubscriptionCartStepInput
      })
    )

    const orderRecord = loadSubscriptionOrderStep({
      order_id: input.order_id,
    })

    labelSubscriptionOrderAdjustmentsStep({
      order_id: input.order_id,
    })

    const existingLinks = useQueryGraphStep({
      entity: SUBSCRIPTION_ORDER_LINK_ENTRY_POINT,
      fields: ["subscription.id"],
      filters: {
        order_id: input.order_id,
      },
    }).config({
      name: "retrieve-existing-subscription-order-links",
    })

    const existingSubscriptionId = transform(
      { existingLinks },
      ({ existingLinks }) => {
        const first = existingLinks.data?.[0] as
          | {
              subscription?: {
                id?: string | null
              } | null
            }
          | undefined

        return first?.subscription?.id ?? null
      }
    )

    const createSubscriptionInput = transform(
      { validatedCart, orderRecord, input },
      ({ validatedCart, orderRecord, input }) => {
        const order = orderRecord

        if (!order) {
          throw new Error(
            `Order '${input.order_id}' was not found for subscription creation`
          )
        }

        const startedAt = toDate(order.created_at)
        const trialEndsAt =
          validatedCart.trial_days > 0
            ? addDays(startedAt, validatedCart.trial_days)
            : null
        const nextRenewalAt =
          validatedCart.trial_days > 0
            ? trialEndsAt
            : advanceCadence(
                startedAt,
                validatedCart.frequency_interval,
                validatedCart.frequency_value
              )

        if (!nextRenewalAt) {
          throw new Error(
            "Subscription create flow failed to calculate next renewal date"
          )
        }

        return {
          customer_id: validatedCart.customer_id,
          cart_id: validatedCart.cart_id,
          order_id: order.id,
          order_display_id: order.display_id ?? null,
          started_at: startedAt.toISOString(),
          frequency_interval: validatedCart.frequency_interval,
          frequency_value: validatedCart.frequency_value,
          customer_snapshot: validatedCart.customer_snapshot,
          product_snapshot: validatedCart.product_snapshot,
          pricing_snapshot: validatedCart.pricing_snapshot,
          shipping_address: validatedCart.shipping_address,
          payment_context: validatedCart.payment_context,
          is_trial: validatedCart.trial_days > 0,
          trial_ends_at: trialEndsAt ? trialEndsAt.toISOString() : null,
          next_renewal_at: nextRenewalAt.toISOString(),
          metadata_source: "store_order_placed",
          extend_subscription_id: validatedCart.stacking.extend_subscription_id,
          total_cycles: validatedCart.stacking.total_cycles,
          consent_flip: validatedCart.consent_flip,
        } satisfies CreateSubscriptionRecordStepInput
      }
    )

    const createdSubscription = when(
      "create-subscription-if-not-exists",
      { existingSubscriptionId },
      ({ existingSubscriptionId }) => !existingSubscriptionId
    ).then(() => {
      const createdSubscription =
        createSubscriptionRecordStep(createSubscriptionInput)

      const logInput = transform(
        { createdSubscription, createSubscriptionInput },
        ({ createdSubscription, createSubscriptionInput }) => {
          if (!createdSubscription?.id) {
            throw new Error(
              "Subscription create flow did not create a subscription log target"
            )
          }

          return {
            log_event: normalizeActivityLogEvent({
              subscription_id: createdSubscription.id,
              customer_id: createSubscriptionInput.customer_id,
              event_type: ActivityLogEventType.SUBSCRIPTION_CREATED,
              actor_type: ActivityLogActorType.CUSTOMER,
              actor_id: createSubscriptionInput.customer_id,
              display: {
                subscription_reference: buildSubscriptionReference(
                  createSubscriptionInput.order_display_id,
                  createSubscriptionInput.order_id
                ),
                customer_name:
                  createSubscriptionInput.customer_snapshot.full_name ?? null,
                product_title:
                  createSubscriptionInput.product_snapshot.product_title ?? null,
                variant_title:
                  createSubscriptionInput.product_snapshot.variant_title ?? null,
              },
              previous_state: null,
              new_state: {
                status: "active",
                started_at: createSubscriptionInput.started_at,
                next_renewal_at: createSubscriptionInput.next_renewal_at,
                frequency_interval: createSubscriptionInput.frequency_interval,
                frequency_value: createSubscriptionInput.frequency_value,
                is_trial: createSubscriptionInput.is_trial,
                trial_ends_at: createSubscriptionInput.trial_ends_at,
              },
              metadata: {
                order_id: createSubscriptionInput.order_id,
                source: "store",
                trigger_type: createdSubscription.extended
                  ? "order_placed_extend"
                  : "order_placed",
              },
              dedupe: {
                scope: "order",
                target_id: createSubscriptionInput.order_id,
                qualifier: createdSubscription.id,
              },
            }),
          }
        }
      )

      createSubscriptionLogEventStep(logInput).config({
        name: "create-subscription-created-log-event",
      })

      return createdSubscription
    })

    const createdSubscriptionId = transform(
      { createdSubscription },
      ({ createdSubscription }) => createdSubscription?.id ?? null
    )

    when(
      "link-commerce-entities-if-created",
      { createdSubscriptionId, createSubscriptionInput },
      ({ createdSubscriptionId }) => !!createdSubscriptionId
    ).then(() => {
      return linkSubscriptionCommerceEntitiesStep({
        subscription_id: createdSubscriptionId,
        customer_id: createSubscriptionInput.customer_id,
        cart_id: createSubscriptionInput.cart_id,
        order_id: input.order_id,
      }).config({
        name: "create-subscription-commerce-links",
      })
    })

    const subscriptionId = transform(
      { existingSubscriptionId, createdSubscriptionId },
      ({ existingSubscriptionId, createdSubscriptionId }) => {
        const id = existingSubscriptionId ?? createdSubscriptionId

        if (!id) {
          throw new Error(
            "Subscription create flow did not resolve a subscription"
          )
        }

        return id
      }
    )

    createInitialRenewalCycleStep(
      transform({ subscriptionId }, ({ subscriptionId }) => ({
        subscription_id: subscriptionId,
      }))
    )

    const subscriptionQuery = useQueryGraphStep({
      entity: "subscription",
      fields: [
        "id",
        "reference",
        "status",
        "customer_id",
        "cart_id",
        "product_id",
        "variant_id",
        "frequency_interval",
        "frequency_value",
        "started_at",
        "next_renewal_at",
        "last_renewal_at",
        "paused_at",
        "cancelled_at",
        "cancel_effective_at",
        "skip_next_cycle",
        "is_trial",
        "trial_ends_at",
        "customer_snapshot",
        "product_snapshot",
        "pricing_snapshot",
        "shipping_address",
        "payment_context",
        "pending_update_data",
        "metadata",
      ],
      filters: {
        id: [subscriptionId],
      },
      options: {
        isList: false,
      },
    }).config({
      name: "load-created-subscription",
    })

    releaseLockStep(
      transform({ subscriptionQuery, input }, ({ input }) => ({
        key: input.order_id,
      }))
    )

    return new WorkflowResponse({
      type: "order" as const,
      order: (orderRecord as unknown as CreateSubscriptionFromOrderWorkflowOutput["order"]) ??
        null,
      subscription:
        subscriptionQuery.data as CreateSubscriptionFromOrderWorkflowOutput["subscription"],
    })
  }
)

export default createSubscriptionFromOrderWorkflow

function toDate(value: string | Date) {
  return value instanceof Date ? value : new Date(value)
}

function buildSubscriptionReference(
  orderDisplayId: string | number | null,
  orderId: string
) {
  if (orderDisplayId !== null && orderDisplayId !== undefined) {
    return `SUB-${String(orderDisplayId)}`
  }

  return `SUB-${orderId}`
}

function addDays(date: Date, days: number) {
  const next = new Date(date)
  next.setUTCDate(next.getUTCDate() + days)
  return next
}

function advanceCadence(
  date: Date,
  interval: ValidatedSubscriptionCart["frequency_interval"],
  value: number
) {
  const next = new Date(date)

  switch (interval) {
    case "week":
      next.setUTCDate(next.getUTCDate() + value * 7)
      return next
    case "month":
      next.setUTCMonth(next.getUTCMonth() + value)
      return next
    case "year":
      next.setUTCFullYear(next.getUTCFullYear() + value)
      return next
  }
}
