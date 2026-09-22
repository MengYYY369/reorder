import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import type { MedusaContainer, RemoteQueryFunction } from "@medusajs/framework/types"
import { SUBSCRIPTION_MODULE } from ".."
import type SubscriptionModuleService from "../service"
import {
  TRACK_OCCUPYING_NATIVE_STATUSES,
  findBlockingNativeRow,
  nativeSubscriptionReferenceFilter,
  type NativeRowCandidate,
} from "./native-subscription"

/**
 * The shared "is a provider recurrence already occupying this product" lookup.
 *
 * Both checkout guards call this and nothing else: the subscription-track check
 * in `validate-subscription-cart`, and the method-level middleware that guards
 * the core cart-completion route for plain purchases. Keeping it in one place is
 * what stops the two gates from disagreeing about what "already subscribed"
 * means.
 *
 * The query pushes all three conditions down — `customer_id`, `status` and the
 * `NATIVE-%` reference pattern are all indexed on the subscription model — so a
 * customer with no mirror rows costs one indexed read.
 */
export async function findBlockingNativeSubscription(
  container: MedusaContainer,
  input: { customer_id: string; product_id: string }
): Promise<NativeRowCandidate | null> {
  const subscriptionModule = container.resolve<SubscriptionModuleService>(
    SUBSCRIPTION_MODULE
  )

  const rows = (await subscriptionModule.listSubscriptions({
    customer_id: input.customer_id,
    status: [...TRACK_OCCUPYING_NATIVE_STATUSES],
    ...nativeSubscriptionReferenceFilter(),
  } as never)) as unknown as NativeRowCandidate[]

  return findBlockingNativeRow(rows, [input.product_id])
}

/**
 * Title for the rejection message. Read lazily through QUERY so the guard does
 * not need the product module when there is nothing to report.
 */
export async function readProductTitle(
  container: MedusaContainer,
  productId: string
): Promise<string> {
  try {
    const query = container.resolve<RemoteQueryFunction>(
      ContainerRegistrationKeys.QUERY
    )
    const { data } = await query.graph({
      entity: "product",
      fields: ["id", "title"],
      filters: { id: [productId] },
    })

    return (data as Array<{ title?: string }>)[0]?.title ?? productId
  } catch {
    return productId
  }
}
