import { MedusaError } from "@medusajs/framework/utils"
import { Modules } from "@medusajs/framework/utils"
import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import type { RemoteQueryFunction } from "@medusajs/framework/types"
import { currentTenant } from "../../../../modules/saas-bridge/auth"
import { snapshot } from "../../../../modules/saas-bridge/snapshot"
import type { SubscriptionRecord } from "../../../../modules/saas-bridge/types"

type OrderRecord = {
  id: string
  currency_code: string
  total: number
  customer_id: string | null
  metadata: Record<string, unknown> | null
}

type CustomerModule = {
  retrieveCustomer: (
    id: string,
    config?: Record<string, unknown>
  ) => Promise<{ id: string; metadata?: Record<string, unknown> | null }>
}

/**
 * GET-style POST /store/saas/reconcile — authoritative state pulls for the
 * SaaS webhook receiver (webhook lost / out of order / pending row missing).
 *
 * TENANT ISOLATION: every lookup passes through the order/subscription's
 * customer, whose metadata.tenant_id must match the calling tenant.
 * Foreign resources answer 404 (existence is not leaked).
 *
 * Body (exactly one key):
 *   { order_id }         → { order: {...} }
 *   { subscription_id }  → { subscription: {...snapshot} }
 *   { customer_id }      → { subscriptions: [ ...snapshots ] }
 */
export async function POST(
  req: MedusaRequest,
  res: MedusaResponse
) {
  const tenant = currentTenant(req)
  const customerModule = req.scope.resolve<CustomerModule>(Modules.CUSTOMER)

  const body = (req.body ?? {}) as {
    order_id?: string
    subscription_id?: string
    customer_id?: string
  }

  const provided = [
    body.order_id,
    body.subscription_id,
    body.customer_id,
  ].filter(Boolean)

  if (provided.length !== 1) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      "provide exactly one of order_id | subscription_id | customer_id"
    )
  }

  const query = req.scope.resolve<RemoteQueryFunction>("query")

  /** Tenant check via the resource's customer metadata. */
  async function assertTenantOwned(customerId: string | null): Promise<void> {
    if (!customerId) {
      throw new MedusaError(
        MedusaError.Types.NOT_FOUND,
        "resource has no customer"
      )
    }

    const customer = await customerModule.retrieveCustomer(customerId)
    const ownerTenant = (customer.metadata as Record<string, unknown> | null)
      ?.tenant_id

    if (ownerTenant !== tenant.tenant_id) {
      // Deliberately 404 — do not leak the existence of foreign resources.
      throw new MedusaError(
        MedusaError.Types.NOT_FOUND,
        "resource not found for this tenant"
      )
    }
  }

  if (body.order_id) {
    // NOTE: v2.20 dropped the payment_status column on the order entity —
    // requesting it via query.graph is silently ignored. Payment state lives
    // on the payment module: order → payment_collection → payments.status.
    const [orderResult, payLink] = await Promise.all([
      query.graph({
        entity: "order",
        fields: ["id", "currency_code", "total", "customer_id", "metadata"],
        filters: { id: body.order_id },
      }),
      query.graph({
        entity: "order_payment_collection",
        fields: ["payment_collection_id"],
        filters: { order_id: body.order_id },
      }),
    ])

    const order = (orderResult.data as unknown as OrderRecord[])[0]

    if (!order) {
      throw new MedusaError(
        MedusaError.Types.NOT_FOUND,
        `Order '${body.order_id}' not found`
      )
    }

    await assertTenantOwned(order.customer_id)

    const paymentCollectionId = (
      payLink.data as Array<{ payment_collection_id?: string }>
    )[0]?.payment_collection_id
    let paymentStatus: string | null = null
    if (paymentCollectionId) {
      const { data: collections } = await query.graph({
        entity: "payment_collection",
        fields: ["status", "payments.status"],
        filters: { id: paymentCollectionId },
      })
      const collection = (
        collections as unknown as Array<{
          status?: string
          payments?: Array<{ status?: string }> | null
        }>
      )[0]
      const statuses = collection?.payments?.map((p) => p.status) ?? []
      // v2.20: capture finalizes the collection to `completed`; individual
      // payments flip authorized → captured. Map both onto the legacy
      // order.payment_status vocabulary the SaaS worker expects.
      const collectionStatus = collection?.status
      paymentStatus =
        collectionStatus === "completed" || statuses.includes("captured")
          ? "captured"
          : statuses.includes("authorized") ||
              collectionStatus === "awaiting" ||
              collectionStatus === "partially_authorized"
            ? "authorized"
          : statuses.includes("canceled") || collectionStatus === "canceled"
            ? "canceled"
            : "pending"
    }

    // Cart and subscription identities live in LINK tables, not order
    // columns: order_cart (core) and subscription_order (reorder fork).
    const cartLink = await query.graph({
      entity: "order_cart",
      fields: ["cart_id"],
      filters: { order_id: body.order_id },
    })
    const subLink = await query.graph({
      entity: "subscription_order",
      fields: ["subscription_id"],
      filters: { order_id: body.order_id },
    })
    const cartId =
      (cartLink.data as Array<{ cart_id?: string }>)[0]?.cart_id ?? null

    // Cart snapshot for consumers that derive the quoted line amount from
    // items (the SaaS worker's reconcile path): currency + unit prices.
    let cart: { currency_code?: string; items: Array<{ unit_price?: number; quantity?: number }> } | null =
      null
    if (cartId) {
      const { data: carts } = await query.graph({
        entity: "cart",
        fields: ["id", "currency_code", "items.unit_price", "items.quantity"],
        filters: { id: cartId },
      })
      const cartRecord = (
        carts as unknown as Array<{
          currency_code?: string
          items?: Array<{ unit_price?: number; quantity?: number }> | null
        }>
      )[0]
      if (cartRecord) {
        cart = {
          currency_code: cartRecord.currency_code,
          items: (cartRecord.items ?? []).map((i) => ({
            unit_price: i.unit_price,
            quantity: i.quantity,
          })),
        }
      }
    }

    res.json({
      order: {
        orderId: order.id,
        paymentStatus,
        currencyCode: order.currency_code,
        total: Number(order.total ?? 0),
        customerId: order.customer_id,
        cartId,
        cart,
        subscriptionId:
          (subLink.data as Array<{ subscription_id?: string }>)[0]
            ?.subscription_id ?? null,
        metadata: order.metadata,
      },
    })
    return
  }

  if (body.subscription_id) {
    const { data } = await query.graph({
      entity: "subscription",
      fields: [
        "id",
        "reference",
        "status",
        "frequency_interval",
        "frequency_value",
        "next_renewal_at",
        "cancel_effective_at",
        "customer_id",
        "payment_context",
        "metadata",
      ],
      filters: { id: body.subscription_id },
    })

    const subscription = (data as unknown as SubscriptionRecord[])[0]

    if (!subscription) {
      throw new MedusaError(
        MedusaError.Types.NOT_FOUND,
        `Subscription '${body.subscription_id}' not found`
      )
    }

    await assertTenantOwned(subscription.customer_id)

    res.json({ subscription: snapshot(subscription) })
    return
  }

  // customer_id branch: the requested customer itself must belong to the
  // tenant, otherwise its subscription list would leak across tenants.
  const { data: customerData } = await query.graph({
    entity: "customer",
    fields: ["id", "metadata"],
    filters: { id: body.customer_id as string },
  })

  const customer = customerData[0] as
    | { id: string; metadata?: Record<string, unknown> | null }
    | undefined

  if (
    !customer ||
    (customer.metadata as Record<string, unknown> | null)?.tenant_id !==
      tenant.tenant_id
  ) {
    res.json({ subscriptions: [] })
    return
  }

  const { data } = await query.graph({
    entity: "subscription",
    fields: [
      "id",
      "reference",
      "status",
      "frequency_interval",
      "frequency_value",
      "next_renewal_at",
      "cancel_effective_at",
      "customer_id",
      "payment_context",
      "metadata",
    ],
    filters: { customer_id: body.customer_id as string },
  })

  const subscriptions = (data as unknown as SubscriptionRecord[]) ?? []

  res.json({ subscriptions: subscriptions.map(snapshot) })
}
