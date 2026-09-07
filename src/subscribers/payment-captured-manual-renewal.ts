import type {
  SubscriberArgs,
  SubscriberConfig,
} from "@medusajs/framework"
import {
  ContainerRegistrationKeys,
  Modules,
} from "@medusajs/framework/utils"
import type {
  IPaymentModuleService,
  IWorkflowEngineService,
  RemoteQueryFunction,
} from "@medusajs/framework/types"

type PaymentCapturedPayload = {
  id: string
}

/**
 * Finalizes manual renewals: when a payment capture lands on a payment
 * collection whose order is a manual renewal order (metadata.renewal_cycle_id
 * + renewal_trigger="manual"), the manual renewal chain advances
 * (cycle -> SUCCEEDED, cadence anchored per D20).
 *
 * The workflow is invoked BY NAME via the engine — same registration
 * constraint as the other reorder workflows (see create-manual-renewal.ts).
 */
export default async function paymentCapturedManualRenewalHandler({
  event,
  container,
}: SubscriberArgs<PaymentCapturedPayload>) {
  const paymentId = event.data?.id

  if (!paymentId) {
    return
  }

  const logger = container.resolve("logger") as {
    info: (msg: string) => void
    error: (msg: string) => void
  }

  try {
    const paymentModule = container.resolve<IPaymentModuleService>(
      Modules.PAYMENT
    )

    const payment = await paymentModule.retrievePayment(paymentId, {
      relations: ["payment_collection"],
    })

    const paymentCollectionId = (
      payment as unknown as {
        payment_collection_id?: string | null
        payment_collection?: { id?: string } | null
      }
    ).payment_collection_id

    if (!paymentCollectionId) {
      return
    }

    const orderId = await findOrderIdForCollection(
      container,
      paymentCollectionId
    )

    if (!orderId) {
      return
    }

    const orderModule = container.resolve<{
      retrieveOrder: (
        id: string,
        config?: Record<string, unknown>
      ) => Promise<{ metadata?: Record<string, unknown> | null }>
    }>(Modules.ORDER)

    const order = await orderModule.retrieveOrder(orderId)
    const metadata = order?.metadata ?? {}

    if (
      metadata.renewal_trigger !== "manual" ||
      typeof metadata.renewal_cycle_id !== "string"
    ) {
      return
    }

    const engine = container.resolve<IWorkflowEngineService>(
      Modules.WORKFLOW_ENGINE
    )

    await engine.run("complete-manual-renewal", {
      input: { renewal_order_id: orderId },
      throwOnError: true,
    })

    logger.info(
      `[reorder] manual renewal order '${orderId}' paid and finalized (cycle ${String(metadata.renewal_cycle_id)})`
    )
  } catch (error) {
    logger.error(
      `[reorder] Failed to finalize manual renewal for payment '${paymentId}': ${
        error instanceof Error ? error.message : String(error)
      }`
    )
  }
}

async function findOrderIdForCollection(
  container: SubscriberArgs<PaymentCapturedPayload>["container"],
  paymentCollectionId: string
): Promise<string | null> {
  const query = container.resolve<RemoteQueryFunction>(
    ContainerRegistrationKeys.QUERY
  )

  const { data } = await query.graph({
    entity: "order_payment_collection",
    fields: ["order_id", "payment_collection_id"],
    filters: { payment_collection_id: paymentCollectionId },
  })

  return (data as Array<{ order_id?: string }>)[0]?.order_id ?? null
}
