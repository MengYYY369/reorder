import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import type { RemoteQueryFunction } from "@medusajs/framework/types"
import {
  createOrderWorkflow,
  createOrUpdateOrderPaymentCollectionWorkflow,
  createPaymentSessionsWorkflow,
} from "@medusajs/medusa/core-flows"
import { RENEWAL_MODULE } from "../../modules/renewal"
import type RenewalModuleService from "../../modules/renewal/service"
import {
  RenewalAttemptStatus,
  RenewalCycleStatus,
} from "../../modules/renewal/types"
import { renewalErrors } from "../../modules/renewal/utils/errors"
import { SUBSCRIPTION_MODULE } from "../../modules/subscription"
import type SubscriptionModuleService from "../../modules/subscription/service"
import { SubscriptionStatus } from "../../modules/subscription/types"

export type CreateManualRenewalStepInput = {
  subscription_id: string
  /** Optional admin/user actor for the audit trail. */
  triggered_by?: string | null
  reason?: string | null
}

export type CreateManualRenewalStepOutput = {
  subscription_id: string
  renewal_cycle_id: string
  renewal_order_id: string
  total: number
  currency_code: string
  payment_provider_id: string | null
  redirect_url: string | null
  /** true when an already-outstanding renewal order was reused. */
  reused?: boolean
}

type SubscriptionRecord = {
  id: string
  status: SubscriptionStatus
  customer_id: string
  cart_id: string | null
  frequency_interval: "week" | "month" | "year"
  frequency_value: number
  next_renewal_at: Date | null
  payment_context: {
    payment_provider_id: string | null
    payment_mode?: string | null
    payment_method_reference: string | null
  } | null
  product_snapshot: Record<string, unknown> | null
  pending_update_data: Record<string, unknown> | null
  metadata: Record<string, unknown> | null
}

type CycleRecord = {
  id: string
  subscription_id: string
  scheduled_for: string | Date
  status: RenewalCycleStatus
  generated_order_id?: string | null
}

type CartRecord = {
  id: string
  region_id: string | null
  sales_channel_id: string | null
  currency_code: string
  email: string | null
  shipping_address: Record<string, unknown> | null
  billing_address: Record<string, unknown> | null
  items?: Array<{
    title?: string | null
    quantity?: number | null
    unit_price?: number | null
    requires_shipping?: boolean | null
    is_discountable?: boolean | null
    variant_sku?: string | null
  }> | null
  shipping_methods?: Array<Record<string, unknown>> | null
}

/**
 * Mints the next renewal order for a manual-mode subscription WITHOUT
 * confirming payment: the order gets a payment collection + an unconfirmed
 * payment session (whose `data.redirect_url` the caller surfaces as the
 * cashier link). Payment completion is handled by the payment.captured
 * subscriber (complete-manual-renewal), which marks the cycle succeeded and
 * advances the subscription cadence.
 *
 * Anchor semantics match D20: an in-good-standing subscription renews from
 * its existing next_renewal_at; an expired-but-active one renews from now.
 */
export const createManualRenewalStep = createStep(
  "create-manual-renewal",
  async function (
    input: CreateManualRenewalStepInput,
    { container }
  ) {
    const logger = container.resolve("logger") as {
      warn: (msg: string) => void
    }
    const renewalModule =
      container.resolve<RenewalModuleService>(RENEWAL_MODULE)
    const subscriptionModule =
      container.resolve<SubscriptionModuleService>(SUBSCRIPTION_MODULE)

    const subscriptions = await subscriptionModule.listSubscriptions({
      id: [input.subscription_id],
    })
    const subscription = subscriptions[0] as unknown as
      | SubscriptionRecord
      | undefined

    if (!subscription) {
      throw renewalErrors.notFound("Subscription", input.subscription_id)
    }

    if ((subscription.payment_context?.payment_mode ?? "auto") !== "manual") {
      throw renewalErrors.invalidData(
        `Subscription '${subscription.id}' is not in manual payment mode; use the standard renewal flow`
      )
    }

    if (subscription.status !== SubscriptionStatus.ACTIVE) {
      throw renewalErrors.invalidData(
        `Subscription '${subscription.id}' is '${subscription.status}'; only active subscriptions can be manually renewed`
      )
    }

    if (!subscription.cart_id) {
      throw renewalErrors.invalidData(
        `Subscription '${subscription.id}' is missing 'cart_id' required for renewal order creation`
      )
    }

    // Reuse-or-create the current due cycle so /renew is idempotent while a
    // renewal order is outstanding (no duplicate renewal orders per period).
    const existingDue = await findOpenCycle(
      container,
      subscription.id
    )

    if (existingDue?.generated_order_id) {
      // A renewal order is already outstanding for this period: return its
      // cashier link instead of minting a duplicate order.
      const redirectUrl = await findOutstandingRedirectUrl(
        container,
        existingDue.generated_order_id
      )

      const existingTotal = await loadOrderTotal(
        container,
        existingDue.generated_order_id
      )
      const existingCurrency = await loadOrderCurrency(
        container,
        existingDue.generated_order_id
      )

      logger.warn(
        `[reorder] reusing outstanding manual renewal order '${existingDue.generated_order_id}' for subscription '${subscription.id}'`
      )

      return new StepResponse<CreateManualRenewalStepOutput, string>(
        {
          subscription_id: subscription.id,
          renewal_cycle_id: existingDue.id,
          renewal_order_id: existingDue.generated_order_id,
          total: existingTotal,
          currency_code: existingCurrency,
          payment_provider_id:
            subscription.payment_context?.payment_provider_id ?? null,
          redirect_url: redirectUrl,
          reused: true,
        },
        existingDue.generated_order_id
      )
    }

    let cycle: CycleRecord

    if (existingDue) {
      if (existingDue.status === RenewalCycleStatus.PROCESSING) {
        throw renewalErrors.alreadyProcessing(existingDue.id)
      }

      if (existingDue.status === RenewalCycleStatus.SUCCEEDED) {
        throw renewalErrors.invalidData(
          `Renewal cycle '${existingDue.id}' already succeeded; next period has not started yet`
        )
      }

      cycle = existingDue
    } else {
      const anchor =
        subscription.next_renewal_at && subscription.next_renewal_at > new Date()
          ? new Date(subscription.next_renewal_at)
          : new Date()

      cycle = (await renewalModule.createRenewalCycles({
        subscription_id: subscription.id,
        scheduled_for: anchor,
        status: RenewalCycleStatus.PROCESSING,
        approval_required: false,
        approval_status: null,
        processed_at: null,
        generated_order_id: null,
        applied_pending_update_data: null,
        last_error: null,
        attempt_count: 0,
        metadata: {
          trigger_type: "manual",
          triggered_by: input.triggered_by ?? null,
          reason: input.reason ?? null,
        },
      } as never)) as unknown as CycleRecord
    }

    const attempt = await renewalModule.createRenewalAttempts({
      renewal_cycle_id: cycle.id,
      attempt_no: 1,
      started_at: new Date(),
      status: RenewalAttemptStatus.PROCESSING,
      error_code: null,
      error_message: null,
      payment_reference: null,
      order_id: null,
      metadata: {
        trigger_type: "manual",
        triggered_by: input.triggered_by ?? null,
        reason: input.reason ?? null,
      },
    } as never)

    const cart = await loadCart(container, subscription.cart_id)
    const sourceItem = cart.items?.[0] ?? null

    const variantTitle =
      (subscription.pending_update_data as { variant_title?: string } | null)
        ?.variant_title ??
      (subscription.product_snapshot as { variant_title?: string } | null)
        ?.variant_title ??
      "Subscription renewal"

    const orderResult = await createOrderWorkflow(container).run({
      input: {
        region_id: cart.region_id,
        sales_channel_id: cart.sales_channel_id,
        customer_id: subscription.customer_id,
        email: cart.email ?? undefined,
        currency_code: cart.currency_code,
        shipping_address: cart.shipping_address ?? undefined,
        billing_address: cart.billing_address ?? undefined,
        items: [
          {
            title: sourceItem?.title ?? variantTitle,
            quantity: sourceItem?.quantity ?? 1,
            unit_price: sourceItem?.unit_price,
            product_id: subscription.product_snapshot?.product_id,
            product_title: subscription.product_snapshot?.product_title,
            variant_title: variantTitle,
            variant_sku:
              sourceItem?.variant_sku ??
              subscription.product_snapshot?.sku ??
              undefined,
            requires_shipping: false,
            is_discountable: sourceItem?.is_discountable ?? true,
            metadata: {
              renewal_source_cart_id: cart.id,
            },
          },
        ] as any[],
        shipping_methods: [] as any[],
        metadata: {
          renewal_cycle_id: cycle.id,
          subscription_id: subscription.id,
          renewal_trigger: "manual",
        },
      } as never,
    })

    const order = orderResult.result

    const total = await loadOrderTotal(container, order.id)

    let redirectUrl: string | null = null

    if (total > 0) {
      const paymentContext = subscription.payment_context

      if (!paymentContext?.payment_provider_id) {
        throw renewalErrors.renewalOrderCreationFailed(
          cycle.id,
          `Subscription '${subscription.id}' has no payment provider in its payment context`
        )
      }

      const paymentCollections =
        await createOrUpdateOrderPaymentCollectionWorkflow(container).run({
          input: {
            order_id: order.id,
            amount: total,
          },
        })

      const paymentCollection = paymentCollections.result[0]

      if (!paymentCollection) {
        throw renewalErrors.renewalOrderCreationFailed(
          cycle.id,
          `No payment collection was created for renewal order '${order.id}'`
        )
      }

      // Session left UNCONFIRMED: the redirect-only provider returns a
      // cashier URL; the customer pays interactively. Captured payment is
      // finalized by the payment.captured subscriber.
      const sessionResult = await createPaymentSessionsWorkflow(container).run({
        input: {
          payment_collection_id: paymentCollection.id,
          provider_id: paymentContext.payment_provider_id,
          customer_id: subscription.customer_id,
          data: {},
        },
      })

      const sessionData =
        (sessionResult.result.data as Record<string, unknown> | undefined) ?? {}
      redirectUrl =
        typeof sessionData.redirect_url === "string"
          ? sessionData.redirect_url
          : null

      await renewalModule.updateRenewalAttempts({
        id: attempt.id,
        order_id: order.id,
        payment_reference: paymentCollection.id,
      } as never)
    }

    await renewalModule.updateRenewalCycles({
      id: cycle.id,
      generated_order_id: order.id,
    } as never)

    logger.warn(
      `[reorder] manual renewal order '${order.id}' created for subscription '${subscription.id}' (cycle ${cycle.id}); awaiting interactive payment`
    )

    return new StepResponse<CreateManualRenewalStepOutput, string>(
      {
        subscription_id: subscription.id,
        renewal_cycle_id: cycle.id,
        renewal_order_id: order.id,
        total,
        currency_code: cart.currency_code,
        payment_provider_id:
          subscription.payment_context?.payment_provider_id ?? null,
        redirect_url: redirectUrl,
        reused: false,
      },
      order.id
    )
  },
  // Compensation: delete the renewal order so a crashed run leaves no bill
  // behind. The cycle stays PROCESSING and is retried by the next /renew.
  async function (orderId, { container }) {
    if (!orderId) {
      return
    }

    const orderModule = container.resolve<{
      deleteOrders: (orderIds: string[]) => Promise<void>
    }>(Modules.ORDER)

    await orderModule.deleteOrders([orderId])
  }
)

async function findOpenCycle(
  container: { resolve(key: string): unknown },
  subscriptionId: string
): Promise<CycleRecord | null> {
  const query = container.resolve(ContainerRegistrationKeys.QUERY) as {
    graph: (config: Record<string, unknown>) => Promise<{
      data: CycleRecord[]
    }>
  }

  const { data } = await query.graph({
    entity: "renewal_cycle",
    fields: ["id", "subscription_id", "scheduled_for", "status", "generated_order_id"],
    filters: {
      subscription_id: subscriptionId,
      status: [
        RenewalCycleStatus.SCHEDULED,
        RenewalCycleStatus.PROCESSING,
        RenewalCycleStatus.FAILED,
      ],
    },
    pagination: {
      take: 1,
      order: { scheduled_for: "DESC" },
    },
  })

  return data[0] ?? null
}

async function loadCart(
  container: { resolve(key: string): unknown },
  id: string
): Promise<CartRecord> {
  const query = container.resolve(ContainerRegistrationKeys.QUERY) as {
    graph: (config: Record<string, unknown>) => Promise<{
      data: CartRecord[]
    }>
  }

  const { data } = await query.graph({
    entity: "cart",
    fields: [
      "id",
      "region_id",
      "sales_channel_id",
      "currency_code",
      "email",
      "shipping_address.*",
      "billing_address.*",
      "items.*",
    ],
    filters: { id: [id] },
  })

  const cart = data[0]

  if (!cart) {
    throw renewalErrors.notFound("Cart", id)
  }

  return cart
}

async function findOutstandingRedirectUrl(
  container: { resolve<T>(key: string): T },
  orderId: string
): Promise<string | null> {
  const query = container.resolve<RemoteQueryFunction>(
    ContainerRegistrationKeys.QUERY
  )

  const { data } = await query.graph({
    entity: "order",
    fields: [
      "id",
      "payment_collections.id",
      "payment_collections.payment_sessions.id",
      "payment_collections.payment_sessions.data",
    ],
    filters: { id: [orderId] },
  })

  const sessions =
    (data as Array<{
      payment_collections?: Array<{
        payment_sessions?: Array<{ data?: Record<string, unknown> | null }>
      }>
    }>)[0]?.payment_collections?.[0]?.payment_sessions ?? []

  for (const session of sessions) {
    const redirect = session.data?.redirect_url

    if (typeof redirect === "string" && redirect) {
      return redirect
    }
  }

  return null
}

async function loadOrderCurrency(
  container: { resolve<T>(key: string): T },
  orderId: string
): Promise<string> {
  const query = container.resolve<RemoteQueryFunction>(
    ContainerRegistrationKeys.QUERY
  )

  const { data } = await query.graph({
    entity: "order",
    fields: ["id", "currency_code"],
    filters: { id: [orderId] },
  })

  return (data as Array<{ currency_code: string }>)[0]?.currency_code ?? "usd"
}

async function loadOrderTotal(
  container: { resolve(key: string): unknown },
  id: string
): Promise<number> {
  const query = container.resolve(ContainerRegistrationKeys.QUERY) as {
    graph: (config: Record<string, unknown>) => Promise<{
      data: Array<{ id: string; total: number }>
    }>
  }

  const { data } = await query.graph({
    entity: "order",
    fields: ["id", "total"],
    filters: { id: [id] },
  })

  const order = data[0]

  if (!order) {
    throw renewalErrors.notFound("Order", id)
  }

  return Number(order.total ?? 0)
}
