import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import type {
  ICartModuleService,
  IOrderModuleService,
  IPaymentModuleService,
  MedusaContainer,
} from "@medusajs/framework/types"
import {
  PlanOfferFrequencyInterval,
  PlanOfferScope,
} from "../../src/modules/plan-offer/types"
import { createPlanOfferSeed } from "./plan-offer-fixtures"
import { createProductWithVariant } from "./subscription-fixtures"

/**
 * The link module's `create` as this helper uses it. `ILinkModuleService` is not
 * exported by the pinned `@medusajs/framework/types`, so the one method called
 * here is named directly.
 */
type LinkModuleService = {
  create(links: unknown): Promise<unknown>
}

export type SeededCheckout = {
  product_id: string
  variant_id: string
  cart_id: string
  order_id: string
  payment_collection_id: string
}

/**
 * A completed subscription checkout for an existing customer: cart with a
 * subscription line item, its order, and the payment collection behind it.
 *
 * Shared by the two native-exclusivity guards, which both need a real purchase
 * to refuse and a known product to hang a provider recurrence off. When
 * `product` is given, no plan offer is created for it — the caller has already
 * configured that product.
 */
export async function seedSubscriptionCheckoutCart(
  container: MedusaContainer,
  customer: { id: string; email: string | null },
  product?: { product_id: string; variant_id: string },
  options?: {
    /**
     * Data written onto the checkout's payment session. The `payment.captured`
     * subscriber reads the vault token from `data.payment_method`, so a case
     * that drives it seeds the token here.
     */
    session_data?: Record<string, unknown>
  }
): Promise<SeededCheckout> {
  const cartModule = container.resolve<ICartModuleService>(Modules.CART)
  const orderModule = container.resolve<IOrderModuleService>(Modules.ORDER)
  const paymentModule = container.resolve<IPaymentModuleService>(Modules.PAYMENT)
  const link = container.resolve<LinkModuleService>(
    ContainerRegistrationKeys.LINK
  )

  let productId: string
  let variantId: string

  if (product) {
    productId = product.product_id
    variantId = product.variant_id
  } else {
    const created = await createProductWithVariant(container)
    productId = created.product.id
    variantId = created.variant.id

    await createPlanOfferSeed(container, {
      name: `checkout-${Date.now()}`,
      scope: PlanOfferScope.VARIANT,
      product_id: productId,
      variant_id: variantId,
      is_enabled: true,
      allowed_frequencies: [
        { interval: PlanOfferFrequencyInterval.MONTH, value: 1 },
      ],
    })
  }

  const lineItemMetadata = {
    is_subscription: true,
    frequency_interval: "month",
    frequency_value: 1,
    payment_mode: "manual",
  }

  const shippingAddress = {
    first_name: "Checkout",
    last_name: "Gate",
    address_1: "1 Test Way",
    city: "Testville",
    postal_code: "00001",
    country_code: "us",
  }

  // SAFETY: `createCarts` answers a single created cart at runtime, while the
  // pinned types declare an array; this narrows it to the id the links need.
  const cart = (await cartModule.createCarts({
    currency_code: "usd",
    email: customer.email,
    customer_id: customer.id,
    metadata: {},
    shipping_address: shippingAddress,
    items: [
      {
        title: "Subscription item",
        unit_price: 18,
        quantity: 1,
        variant_id: variantId,
        metadata: lineItemMetadata,
      } as never,
    ],
  } as never)) as unknown as { id: string }

  const paymentCollection = await paymentModule.createPaymentCollections({
    currency_code: "usd",
    amount: 18,
  })

  await paymentModule.createPaymentSession(paymentCollection.id, {
    provider_id: "pp_system_default",
    currency_code: "usd",
    amount: 18,
    data: options?.session_data ?? {},
  } as never)

  // SAFETY: same shape as the cart above — one created order, narrowed to its id.
  const order = (await orderModule.createOrders({
    customer_id: customer.id,
    email: customer.email,
    currency_code: "usd",
    status: "completed",
    items: [
      {
        title: "Subscription item",
        quantity: 1,
        unit_price: 18,
        variant_id: variantId,
        metadata: lineItemMetadata,
      } as never,
    ],
    shipping_address: shippingAddress,
  } as never)) as unknown as { id: string }

  await link.create([
    {
      [Modules.ORDER]: { order_id: order.id },
      [Modules.CART]: { cart_id: cart.id },
    },
    {
      [Modules.ORDER]: { order_id: order.id },
      [Modules.PAYMENT]: { payment_collection_id: paymentCollection.id },
    },
    {
      [Modules.CART]: { cart_id: cart.id },
      [Modules.PAYMENT]: { payment_collection_id: paymentCollection.id },
    },
  ])

  return {
    product_id: productId,
    variant_id: variantId,
    cart_id: cart.id,
    order_id: order.id,
    payment_collection_id: paymentCollection.id,
  }
}

/**
 * A bare cart the completion gate can decide on — no order, no payment
 * collection, nothing the core handler needs. Only the line item matters: the
 * gate reads the cart's product ids and whether it carries the subscription
 * signal, and `isSubscription: false` is how a case proves the reorder rail's
 * occupancy rule is independent of the subscription track's fold exception.
 */
export async function seedGateCart(
  container: MedusaContainer,
  customer: { id: string; email: string | null },
  variantId: string,
  isSubscription: boolean
): Promise<string> {
  const cartModule = container.resolve<ICartModuleService>(Modules.CART)

  // SAFETY: `createCarts` answers a single created cart at runtime, while the
  // pinned types declare an array; this narrows it to the id the request uses.
  const cart = (await cartModule.createCarts({
    currency_code: "usd",
    email: customer.email,
    customer_id: customer.id,
    metadata: {},
    shipping_address: {
      first_name: "Gate",
      last_name: "Test",
      address_1: "1 Test Way",
      city: "Testville",
      postal_code: "00001",
      country_code: "us",
    },
    items: [
      {
        title: "Item",
        unit_price: 18,
        quantity: 1,
        variant_id: variantId,
        metadata: isSubscription
          ? {
              is_subscription: true,
              frequency_interval: "month",
              frequency_value: 1,
              payment_mode: "manual",
            }
          : {},
      } as never,
    ],
  } as never)) as unknown as { id: string }

  return cart.id
}
