import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import type {
  ICartModuleService,
  ILinkModuleService,
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

export type SeededCheckout = {
  product_id: string
  variant_id: string
  cart_id: string
  order_id: string
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
  product?: { product_id: string; variant_id: string }
): Promise<SeededCheckout> {
  const cartModule = container.resolve<ICartModuleService>(Modules.CART)
  const orderModule = container.resolve<IOrderModuleService>(Modules.ORDER)
  const paymentModule = container.resolve<IPaymentModuleService>(Modules.PAYMENT)
  const link = container.resolve<ILinkModuleService>(
    ContainerRegistrationKeys.LINK
  )

  const target = product ?? (await createProductWithVariant(container))
  const productId = product?.product_id ?? target.product.id
  const variantId = product?.variant_id ?? target.variant.id

  if (!product) {
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

  const cart = await cartModule.createCarts({
    currency_code: "usd",
    email: customer.email,
    customer_id: customer.id,
    metadata: {},
    shipping_address: shippingAddress,
    items: [
      {
        title: "Subscription item",
        unit_price: 1800,
        quantity: 1,
        variant_id: variantId,
        metadata: lineItemMetadata,
      } as never,
    ],
  } as never)

  const paymentCollection = await paymentModule.createPaymentCollections({
    currency_code: "usd",
    amount: 1800,
  })

  await paymentModule.createPaymentSession(paymentCollection.id, {
    provider_id: "pp_system_default",
    currency_code: "usd",
    amount: 1800,
    data: {},
  } as never)

  const order = await orderModule.createOrders({
    customer_id: customer.id,
    email: customer.email,
    currency_code: "usd",
    status: "completed",
    items: [
      {
        title: "Subscription item",
        quantity: 1,
        unit_price: 1800,
        variant_id: variantId,
        metadata: lineItemMetadata,
      } as never,
    ],
    shipping_address: shippingAddress,
  } as never)

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
  }
}
