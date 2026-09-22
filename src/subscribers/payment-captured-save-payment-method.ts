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
import { resolveProductSubscriptionConfig } from "../modules/plan-offer/utils/effective-config"
import { resolvePlanOfferRules } from "../modules/plan-offer/utils/rules"
import {
  applyConsentFlip,
  resolveConsentFlip,
} from "../modules/subscription/utils/consent-flip"
import { normalizeActivityLogEvent } from "../modules/activity-log/utils/normalize-log-event"
import { persistSubscriptionLogEvent } from "../modules/activity-log/utils/persist-log-event"
import {
  ActivityLogActorType,
  ActivityLogEventType,
} from "../modules/activity-log/types"

type PaymentCapturedPayload = {
  id: string
}

type SubscriptionRecord = {
  id: string
  reference: string
  cart_id: string | null
  product_id: string
  variant_id: string
  customer_id: string
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
        // The checkout cart is linked to the collection via cart_payment_collection
        // (orders created from a standalone payment collection are NOT cart-linked).
        "cart.id",
        "payment_sessions.id",
        "payment_sessions.provider_id",
        "payment_sessions.data",
      ],
      filters: { id: paymentCollectionId },
    })

    const record = (data as Array<{
      cart?: { id?: string | null } | null
      payment_sessions?: Array<{
        provider_id?: string | null
        data?: Record<string, unknown> | null
      }>
    }>)[0]

    const cartId = record?.cart?.id ?? null
    if (!cartId) {
      // No linked cart (non-checkout orders) — nothing to attribute.
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
    const session = record?.payment_sessions?.find(
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

    const effectiveConfig = await resolveProductSubscriptionConfig(container, {
      product_id: subscription.product_id,
      variant_id: subscription.variant_id,
    })
    const decision = resolveConsentFlip({
      consent_from_session: resolvePlanOfferRules(effectiveConfig.rules)
        .consent_from_session,
      payment_context: subscription.payment_context,
      session_data: session?.data,
    })

    const paymentContext = applyConsentFlip(
      {
        ...(subscription.payment_context ?? {}),
        payment_method_reference: token,
      },
      decision
    )

    if (
      current === token &&
      !decision.flip &&
      subscription.payment_context?.payment_mode ===
        paymentContext.payment_mode &&
      subscription.payment_context?.mechanism === paymentContext.mechanism
    ) {
      return
    }

    await subscriptionModule.updateSubscriptions({
      id: subscription.id,
      payment_context: paymentContext,
    })

    logger.info(
      `[reorder] saved payment method on subscription '${subscription.id}' (cart '${cartId}'); ` +
        (decision.flip
          ? `payment_mode flipped to auto via consent field '${decision.consent_field}'`
          : `mode stays ${decision.payment_mode}${
              decision.skip_reason ? ` (${decision.skip_reason})` : ""
            } until the auto-renew switch opts in`)
    )

    if (decision.flip) {
      await recordConsentFlip(container, logger, subscription, decision)
    }
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

/**
 * The flip has to be visible in the audit trail: "why is this subscription
 * charging automatically" is the first question support gets, and the answer is
 * a specific offer rule plus a specific session field, not a storefront call.
 */
async function recordConsentFlip(
  container: SubscriberArgs<PaymentCapturedPayload>["container"],
  logger: { warn: (msg: string) => void },
  subscription: SubscriptionRecord,
  decision: ReturnType<typeof resolveConsentFlip>
) {
  try {
    await persistSubscriptionLogEvent(
      container,
      normalizeActivityLogEvent({
        subscription_id: subscription.id,
        customer_id: subscription.customer_id,
        event_type: ActivityLogEventType.SUBSCRIPTION_PAYMENT_METHOD_UPDATED,
        actor_type: ActivityLogActorType.SYSTEM,
        display: {
          subscription_reference: subscription.reference,
        },
        new_state: {
          payment_mode: decision.payment_mode,
          mechanism: decision.mechanism,
        },
        reason: `Auto-renew consent proven by checkout session field '${decision.consent_field}'`,
        metadata: {
          source: "payment_captured",
          trigger_type: "consent_flip",
          reason_code: decision.consent_field,
        },
        dedupe: {
          scope: "subscription",
          target_id: subscription.id,
          qualifier: "consent_flip",
        },
      })
    )
  } catch (error) {
    logger.warn(
      `[reorder] consent flip recorded on subscription '${subscription.id}' but the audit event failed: ${
        error instanceof Error ? error.message : String(error)
      }`
    )
  }
}
