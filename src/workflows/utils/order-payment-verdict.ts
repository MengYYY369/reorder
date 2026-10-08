import { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import type { OrderPaymentVerdict } from "../../modules/renewal/types"

/**
 * The verdict type lives in the renewal module because the upcoming-cycle
 * decision module reads it too, and a module may not import from `workflows`.
 * Re-exported here so a caller of this reader does not have to reach across the
 * boundary for the type of the value it just got back.
 */
export type { OrderPaymentVerdict }

/**
 * Confirms what happened to an order's payment. Every branch below answers
 * only from positively readable state; anything it cannot settle on is
 * `ambiguous`, which parks the cycle (decision R5: "we do not know" must not
 * be recorded as "there is no hope").
 */
export async function readOrderPaymentVerdict(
  container: MedusaContainer,
  orderId: string
): Promise<OrderPaymentVerdict> {
  const query = container.resolve(ContainerRegistrationKeys.QUERY)

  try {
    const { data: collectionLinks } = await query.graph({
      entity: "order_payment_collection",
      fields: ["payment_collection_id"],
      filters: {
        order_id: orderId,
      },
    })

    const paymentCollectionId = (
      collectionLinks as Array<{ payment_collection_id?: string }>
    )[0]?.payment_collection_id

    // No collection linked to the order: the payment-collection step never
    // completed. Capture requires an authorized payment record against a
    // linked collection, so no money moved and no webhook can move it later.
    if (!paymentCollectionId) {
      return "not_captured"
    }

    const { data: collections } = await query.graph({
      entity: "payment_collection",
      fields: ["status", "payments.status"],
      filters: {
        id: paymentCollectionId,
      },
    })

    const collection = (
      collections as unknown as Array<{
        status?: string
        payments?: Array<{ status?: string }> | null
      }>
    )[0]

    if (!collection) {
      return "ambiguous"
    }

    const paymentStatuses =
      collection.payments?.map((payment) => payment.status) ?? []

    // Money was taken and then returned: the period is neither cleanly paid
    // nor cleanly uncharged. Park.
    if (
      paymentStatuses.includes("refunded") ||
      paymentStatuses.includes("partially_refunded")
    ) {
      return "ambiguous"
    }

    if (
      paymentStatuses.includes("captured") ||
      collection.status === "completed"
    ) {
      return "captured"
    }

    const everyPaymentCanceled =
      paymentStatuses.length > 0 &&
      paymentStatuses.every((status) => status === "canceled")

    // Canceled payments or a canceled collection are positively "nothing was
    // charged". The same holds for a collection with NO payment record at all
    // (`not_paid`, or `awaiting` with a session that was never authorized):
    // capture acts on an authorized payment record, so zero records means
    // zero authorizations and no webhook can capture on its own — and a
    // retried attempt reuses not_paid/awaiting collections instead of
    // creating a second order (`resolveOrderPaymentCollection`).
    if (
      everyPaymentCanceled ||
      collection.status === "canceled" ||
      (paymentStatuses.length === 0 &&
        (collection.status === "not_paid" || collection.status === "awaiting"))
    ) {
      return "not_captured"
    }

    // authorized / awaiting / partially_authorized / requires_action /
    // pending payments / unrecognized statuses: money may still be captured
    // by a late webhook. Park.
    return "ambiguous"
  } catch {
    // Unreadable payment state parks the cycle — never reverts it.
    return "ambiguous"
  }
}

/**
 * The verdict of every id given, as the map the decision modules read.
 *
 * Read once each: a subscription's cycles can point at the same order, and the
 * reader costs a query per call. Ordering is preserved by `Map`, but nothing
 * depends on it.
 */
export async function readOrderPaymentVerdicts(
  container: MedusaContainer,
  orderIds: string[]
): Promise<Map<string, OrderPaymentVerdict>> {
  const verdicts = new Map<string, OrderPaymentVerdict>()

  for (const orderId of new Set(orderIds)) {
    verdicts.set(orderId, await readOrderPaymentVerdict(container, orderId))
  }

  return verdicts
}
