import { IPaymentModuleService, MedusaContainer } from "@medusajs/framework/types"
import { BigNumberInput } from "@medusajs/types"
import {
  ContainerRegistrationKeys,
  MathBN,
  Modules,
  PaymentCollectionStatus,
} from "@medusajs/framework/utils"

export type ResolvedOrderPaymentCollection = {
  id: string
  status: string
  reused: boolean
}

export type ResolveOrderPaymentCollectionInput = {
  order_id: string
  /** Charge amount in the order currency's smallest unit. */
  amount: BigNumberInput
  /** Currency used when a new collection has to be created. */
  currency_code: string
}

const CHARGEABLE_FOR_UPDATE_STATUSES = [
  PaymentCollectionStatus.NOT_PAID,
  PaymentCollectionStatus.AWAITING,
]

const RECREATE_STATUSES = [
  PaymentCollectionStatus.AUTHORIZED,
  PaymentCollectionStatus.PARTIALLY_AUTHORIZED,
]

type PaymentCollectionSummary = {
  id: string
  status: string
  captured_amount?: number | string | null
}

type LinkedPaymentRecord = {
  id: string
  captured_at: Date | string | null
}

/**
 * Resolves the payment collection a renewal charge should run against,
 * without ever reading the order summary.
 *
 * Medusa 2.20's order total decoration zeroes `pending_difference` at read
 * time whenever it is at or below the currency epsilon (10^-decimal_digits,
 * e.g. 0.01 for USD/CNY but 1 for JPY/KRW), so the core
 * create-or-update-order-payment-collection workflow rejects fresh renewal
 * orders with "Amount cannot be greater than ...". This helper re-implements
 * the same resolve-or-create semantics from the live order total passed in by
 * the caller:
 *
 * - a linked `not_paid` / `awaiting` collection is reused and its amount
 *   synced to the charge amount;
 * - a linked `authorized` / `partially_authorized` collection is canceled and
 *   replaced (core recreate semantics): only authorized (non-captured)
 *   payments are released, a collection with captured money is never canceled;
 * - otherwise a new collection is created in the given currency and attached
 *   to the order via the order ↔ payment collection remote link.
 *
 * A canceled, failed, or completed collection counts as missing.
 */
export async function resolveOrderPaymentCollection(
  container: MedusaContainer,
  input: ResolveOrderPaymentCollectionInput
): Promise<ResolvedOrderPaymentCollection> {
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const paymentModule = container.resolve<IPaymentModuleService>(Modules.PAYMENT)

  const existing = await findLinkedChargeableCollection(
    query,
    input.order_id
  )

  if (existing && CHARGEABLE_FOR_UPDATE_STATUSES.includes(existing.status as PaymentCollectionStatus)) {
    await paymentModule.updatePaymentCollections(existing.id, {
      amount: input.amount,
    })

    return { id: existing.id, status: existing.status, reused: true }
  }

  if (existing && RECREATE_STATUSES.includes(existing.status as PaymentCollectionStatus)) {
    await releaseAuthorizedPaymentCollection(
      container,
      paymentModule,
      existing
    )
  }

  const created = await paymentModule.createPaymentCollections({
    currency_code: input.currency_code,
    amount: input.amount,
  })

  const link = container.resolve(ContainerRegistrationKeys.LINK)

  await link.create({
    [Modules.ORDER]: {
      order_id: input.order_id,
    },
    [Modules.PAYMENT]: {
      payment_collection_id: created.id,
    },
  })

  return { id: created.id, status: created.status, reused: false }
}

async function findLinkedChargeableCollection(
  query: { graph: (config: Record<string, unknown>) => Promise<{ data: unknown[] }> },
  orderId: string
): Promise<PaymentCollectionSummary | null> {
  const { data: links } = await query.graph({
    entity: "order_payment_collection",
    fields: ["payment_collection_id"],
    filters: { order_id: orderId },
  })

  const collectionIds = (links as Array<{ payment_collection_id: string }>)
    .map((link) => link.payment_collection_id)

  if (!collectionIds.length) {
    return null
  }

  const { data: collections } = await query.graph({
    entity: "payment_collection",
    fields: ["id", "status", "captured_amount"],
    filters: {
      id: collectionIds,
      status: [
        ...CHARGEABLE_FOR_UPDATE_STATUSES,
        ...RECREATE_STATUSES,
      ],
    },
  })

  return ((collections as PaymentCollectionSummary[])[0]) ?? null
}

/**
 * Mirrors the core cancel-payment-collection workflow guards: a completed or
 * already canceled collection is left untouched, only payments without a
 * captured_at are canceled, and a collection holding captured money ends up
 * partially_captured instead of canceled.
 */
async function releaseAuthorizedPaymentCollection(
  container: MedusaContainer,
  paymentModule: IPaymentModuleService,
  collection: PaymentCollectionSummary
): Promise<void> {
  const [record] = (await paymentModule.listPaymentCollections(
    { id: [collection.id] },
    { relations: ["payments"] }
  )) as unknown as Array<{
    id: string
    status: string
    captured_amount?: number | string | null
    payments?: LinkedPaymentRecord[] | null
  }>

  if (
    !record ||
    record.status === PaymentCollectionStatus.COMPLETED ||
    record.status === PaymentCollectionStatus.CANCELED
  ) {
    return
  }

  const logger = container.resolve("logger") as {
    warn: (message: string) => void
  }

  for (const payment of record.payments ?? []) {
    if (payment.captured_at) {
      continue
    }

    try {
      await paymentModule.cancelPayment(payment.id)
    } catch (error) {
      logger.warn(
        `[reorder] Failed to cancel authorized payment '${payment.id}' on payment collection '${record.id}': ${String(error)}`
      )
    }
  }

  const nextStatus = MathBN.gt(record.captured_amount ?? 0, 0)
    ? PaymentCollectionStatus.PARTIALLY_CAPTURED
    : PaymentCollectionStatus.CANCELED

  await paymentModule.updatePaymentCollections(record.id, {
    status: nextStatus,
  })
}
