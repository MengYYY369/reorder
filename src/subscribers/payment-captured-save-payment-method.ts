import type {
  SubscriberArgs,
  SubscriberConfig,
} from "@medusajs/framework"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import type {
  IPaymentModuleService,
  RemoteQueryFunction,
} from "@medusajs/framework/types"
import { SUBSCRIPTION_MODULE } from "../modules/subscription"
import type SubscriptionModuleService from "../modules/subscription/service"

type PaymentCapturedPayload = {
  id: string
}

type SubscriptionRecord = {
  id: string
  cart_id: string | null
  payment_context: Record<string, unknown> | null
}

/**
 * Persists the PayPal vault token after the first successful capture onto
 * the subscription's payment_context.payment_method_reference. The vendored
 * paypal provider (0.3.x) requests vault storage on checkout (storeInVault
 * ON_SUCCESS + merchantCustomerId from the session customer_id) and writes
 * the returned token as `payment_method` in the payment session data.
 *
 * Storing the token does NOT authorize charging: payment_mode stays
 * "manual" until the customer opts in via the SaaS auto-renew switch (D40
 * consent), which is the only gate that flips it to "auto" for the
 * off-session scheduler. Idempotent: a reference already equal to the token
 * is left untouched, so replays and multi-capture orders collapse.
 */
export default async function paymentCapturedSavePaymentMethodHandler({
  event,
  container,
}: SubscriberArgs<PaymentCapturedPayload>) {
  const paymentId = event.data?.id

  if (!paymentId) {
    return
  }

  const logger = container.resolve("logger") as {
    info: (msg: string) => void
    warn: (msg: string) => void
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

    const query = container.resolve<RemoteQueryFunction>(
      ContainerRegistrationKeys.QUERY
    )

    const { data } = await query.graph({
      entity: "payment_collection",
      fields: [
        "id",
        "orders.id",
        "orders.cart_id",
        "payment_sessions.id",
        "payment_sessions.provider_id",
        "payment_sessions.data",
      ],
      filters: { id: paymentCollectionId },
    })

    const order = (data as Array<{
      orders?: Array<{ id: string; cart_id?: string | null }>
      payment_sessions?: Array<{
        provider_id?: string | null
        data?: Record<string, unknown> | null
      }>
    }>)[0]

    const cartId = order?.orders?.[0]?.cart_id ?? null
    if (!cartId) {
      // Manual-renewal orders and non-checkout orders carry no cart.
      return
    }

    const subscriptionModule = container.resolve<SubscriptionModuleService>(
      SUBSCRIPTION_MODULE
    )

    const subscriptions = await subscriptionModule.listSubscriptions({
      cart_id: cartId,
    })
    const subscription = subscriptions[0] as unknown as
      | SubscriptionRecord
      | undefined

    if (!subscription) {
      return
    }

    const providerId = subscription.payment_context?.payment_provider_id
    const session = order?.payment_sessions?.find(
      (entry) => entry.provider_id === providerId
    )
    const token =
      typeof session?.data?.payment_method === "string" &&
      session.data.payment_method.trim()
        ? session.data.payment_method.trim()
        : null

    if (!token) {
      // Provider never vaulted this wallet (sandbox without vault consent,
      // declined payment, or a non-vaulting provider) — nothing to save.
      return
    }

    const current =
      typeof subscription.payment_context?.payment_method_reference ===
      "string"
        ? (subscription.payment_context.payment_method_reference as string)
        : null

    if (current === token) {
      return
    }

    await subscriptionModule.updateSubscriptions({
      id: subscription.id,
      payment_context: {
        ...(subscription.payment_context ?? {}),
        payment_method_reference: token,
      },
    })

    logger.info(
      `[reorder] saved PayPal payment method '${token}' on subscription '${subscription.id}' (cart '${cartId}'); mode stays manual until the auto-renew switch opts in`
    )
  } catch (error) {
    logger.warn(
      `[reorder] failed to save payment method from capture '${paymentId}': ${
        error instanceof Error ? error.message : String(error)
      }`
    )
  }
}

export const config: SubscriberConfig = {
  event: "payment.captured",
}
