import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import type {
  MedusaNextFunction,
  MedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http"
import type { RemoteQueryFunction } from "@medusajs/framework/types"
import { SUBSCRIPTION_MODULE } from "../../../modules/subscription"
import type SubscriptionModuleService from "../../../modules/subscription/service"
import {
  TRACK_OCCUPYING_NATIVE_STATUSES,
  findBlockingNativeRow,
  nativeSubscriptionReferenceFilter,
  type NativeRowCandidate,
} from "../../../modules/subscription/utils/native-subscription"
import { readProductTitle } from "../../../modules/subscription/utils/native-exclusivity"

type CartLineItem = {
  variant?: { product_id?: string | null } | null
}

/**
 * `auth_context` is attached by the core authentication middleware, which runs
 * with `allowUnauthenticated: true` on store routes — so a guest request simply
 * has no actor to read.
 */
function readAuthContext(req: MedusaRequest) {
  return (req as { auth_context?: { actor_id?: string; actor_type?: string } })
    .auth_context
}

/**
 * Checkout-completion guard for the strict mutual-exclusion rule (R3 + Q1).
 *
 * A plain one-time purchase never touches this plugin's validation step — it
 * goes through the core cart-completion route — so without a guard here a
 * customer holding a live PayPal recurrence could still buy the same product a
 * second time from the storefront. This middleware runs on that route, before
 * the core handler, and refuses the order while nothing has moved yet.
 *
 * Deliberate choices:
 * - a guest is passed through: there is nothing to match against, and pulling a
 *   customer out of a completed order to retroactively cancel it is worse than
 *   letting it through.
 * - the whole cart is refused, but the message names the colliding product.
 *   Dropping a line from someone's cart changes the total, shipping and any
 *   promo threshold; a wrong bill is worse than a refused one.
 * - an unreadable cart is passed through, so the core route reports its own
 *   "cart not found" instead of this plugin impersonating it.
 *
 * Registration is the single matcher in `src/api/middlewares.ts`. It must NOT be
 * a `route.ts` on the same path: the last registration for a (matcher, method)
 * pair wins, so a plugin route there would replace the core handler outright.
 */
export async function rejectConflictingPurchase(
  req: MedusaRequest,
  res: MedusaResponse,
  next: MedusaNextFunction
) {
  const customerId = readAuthContext(req)?.actor_id ?? null

  if (!customerId) {
    next()

    return
  }

  const subscriptionModule = req.scope.resolve<SubscriptionModuleService>(
    SUBSCRIPTION_MODULE
  )

  const candidateRows = (await subscriptionModule.listSubscriptions({
    customer_id: customerId,
    status: [...TRACK_OCCUPYING_NATIVE_STATUSES],
    ...nativeSubscriptionReferenceFilter(),
  } as never)) as unknown as NativeRowCandidate[]

  // The overwhelmingly common case: no provider recurrence at all. One indexed
  // read, and the cart is never loaded.
  if (!candidateRows.length) {
    next()

    return
  }

  const cartProductIds = await readCartProductIds(req, req.params?.id)

  if (!cartProductIds.length) {
    next()

    return
  }

  const blocking = findBlockingNativeRow(candidateRows, cartProductIds)

  if (!blocking) {
    next()

    return
  }

  const productTitle = await readProductTitle(req.scope, blocking.product_id)

  // Written directly rather than thrown: the core error handler reduces a
  // MedusaError to { code, type, message }, which would drop the structured
  // payload the storefront needs to offer "take me to the plan change" (and its
  // wrap-handler short-circuits any wrapped handler that finds `req.errors`).
  res.status(400).json({
    message:
      `You already have an active subscription for '${productTitle}' managed by ` +
      `your payment provider. Change or cancel that subscription first, or remove ` +
      `this item to continue ordering.`,
    type: "not_allowed",
    data: {
      product_id: blocking.product_id,
      subscription_id: blocking.id,
    },
  })
}

async function readCartProductIds(
  req: MedusaRequest,
  cartId: string | undefined
): Promise<string[]> {
  if (!cartId) {
    return []
  }

  try {
    const query = req.scope.resolve<RemoteQueryFunction>(
      ContainerRegistrationKeys.QUERY
    )
    const { data } = await query.graph({
      entity: "cart",
      fields: ["id", "items.variant.product_id"],
      filters: { id: [cartId] },
    })

    const cart = (data as Array<{ items?: CartLineItem[] | null }>)[0]

    if (!cart) {
      return []
    }

    return (cart.items ?? [])
      .map((item) => item?.variant?.product_id)
      .filter((productId): productId is string => !!productId)
  } catch {
    return []
  }
}
