import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import type {
  MedusaContainer,
  RemoteQueryFunction,
} from "@medusajs/framework/types"
import type {
  MedusaNextFunction,
  MedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http"
import {
  findLiveNativeRecurrences,
  readProductTitle,
} from "./native-exclusivity"
import {
  findBlockingNativeRow,
  type NativeRowCandidate,
} from "./native-subscription"

/**
 * The checkout-completion guard for the strict mutual-exclusion rule (R3 + Q1),
 * ticket 12: decision and middleware together, in the module that owns the rule.
 *
 * A plain one-time purchase never touches this plugin's validation step — it
 * goes through the core cart-completion route — so without a guard there a
 * customer holding a live PayPal recurrence could still buy the same product a
 * second time from the storefront. `rejectConflictingPurchase` runs on that
 * route, before the core handler, and refuses the order while nothing has moved
 * yet.
 *
 * Why the middleware body lives here instead of in `src/api/store/carts/`:
 * - no jest `testMatch` ever runs anything under `src/api/`, so a rule written
 *   inline in that directory could never be asserted — not even by a test that
 *   imports it from a module spec;
 * - this is already this repository's layout for middleware that belongs to a
 *   module: `src/api/middlewares.ts` pulls its middlewares from
 *   `src/modules/saas-bridge/auth.ts`, and `completion-gate.ts` is now the thin
 *   re-export of this file that keeps that registration path stable.
 *
 * The rule that makes the decision a unit: every failure mode of the *rule*
 * reads is fail-open. A throw there would surface as a rejected middleware
 * promise and hang or 500 the whole checkout over a plugin-side read failure,
 * while the ticket's ruling is to let the request reach the core handler and let
 * core report problems its own way. `resolveCheckoutGate` is therefore total: a
 * rejected read *or* an unexpected result shape both mean "cannot decide", and
 * the answer to that is always to let the request through. The exclusion rule
 * itself (which rows block) stays `findBlockingNativeRow`'s, unchanged.
 *
 * Fail-open is bounded to the decision, though, and that bound is a second
 * rule: the guard covers only the reads the rule needs, so the verdict is final
 * before the product title — a purely cosmetic input to the rejection message —
 * is read at all. A title that cannot be read degrades the wording (to the
 * product id, the same fallback the production reader uses) and can never turn a
 * real collision back into a silent pass.
 */

/** A cart line as far as this gate is concerned: only its product matters. */
type CartLineItem = {
  variant?: { product_id?: string | null } | null
}

/**
 * The body a blocked checkout is answered with. Shape and wording are the
 * storefront contract asserted by
 * `integration-tests/http/native-checkout-gate.spec.ts`: the structured payload
 * is what lets the storefront offer "take me to the plan change".
 */
export type CheckoutGateRejectionBody = {
  message: string
  type: "not_allowed"
  data: {
    product_id: string
    subscription_id: string
  }
}

export type CheckoutGateDecision =
  | { action: "allow" }
  | { action: "block"; response_body: CheckoutGateRejectionBody }

/**
 * The reads the gate needs, injected as thunks so the decision can be tested
 * against injected successes, rejections and unexpected shapes.
 */
export type CheckoutGateReads = {
  /** Live provider recurrences for the acting customer. */
  find_live_recurrences: () => Promise<NativeRowCandidate[]>
  /** Products in the cart being completed. */
  read_cart_product_ids: () => Promise<string[]>
  /**
   * Title for the blocking product, to name it in the rejection message.
   * Cosmetic input only: it is read after the verdict exists and behind its own
   * guard, so any outcome — a success, a rejection, a synchronous throw — is
   * absorbed here. Production injects `readProductTitle`, which is total and
   * falls back to the product id on any failure; this unit does not rely on
   * that, because the fallback would otherwise be a load-bearing contract that
   * nothing enforces.
   */
  read_product_title: (productId: string) => Promise<string>
}

const ALLOW: CheckoutGateDecision = { action: "allow" }

/** A collision found by the rule: everything the rejection is built from, minus
 * the product title. */
type BlockingRow = {
  product_id: string
  subscription_id: string
}

/**
 * The only guarded region of the gate: the two reads the rule needs and the
 * matching itself.
 *
 * Returns the blocking row, or `null` for "nothing blocks" — which covers "a
 * customer with no live recurrence", "a cart with nothing in it", "no row
 * collides" and, via the catch, "cannot decide" too. All four allow, so the
 * collapsed answer is enough; what matters is that it is final. Nothing read
 * after this function returns can change the verdict, which is why the catch may
 * not be widened to cover later reads.
 */
async function decideBlockingRow(
  reads: CheckoutGateReads
): Promise<BlockingRow | null> {
  try {
    const candidateRows = await reads.find_live_recurrences()

    // The overwhelmingly common case: no provider recurrence at all. One indexed
    // read, and the cart is never loaded.
    if (!candidateRows.length) {
      return null
    }

    const cartProductIds = await reads.read_cart_product_ids()

    if (!cartProductIds.length) {
      return null
    }

    const blocking = findBlockingNativeRow(candidateRows, cartProductIds)

    if (!blocking) {
      return null
    }

    return {
      product_id: blocking.product_id,
      subscription_id: blocking.id,
    }
  } catch {
    // Fail-open: unreadable state — a rejection or a result this unit cannot
    // work with — must not decide the customer's checkout. The core handler runs
    // instead, exactly as if the gate passed.
    return null
  }
}

/**
 * Name the blocking product, read only once the block is already decided.
 *
 * Its own guard, deliberately: this is the one read whose failure is allowed to
 * reach the shape of the message, never the choice it reports on. Falling back
 * to the product id keeps the sentence readable and the structured `data`
 * payload — the part the storefront acts on — untouched.
 */
async function readBlockingProductTitle(
  reads: CheckoutGateReads,
  productId: string
): Promise<string> {
  try {
    return await reads.read_product_title(productId)
  } catch {
    return productId
  }
}

/**
 * Decide whether this checkout may be completed. Never throws — see the fail-open
 * rule above; the caller may map `allow` straight to `next()`.
 */
export async function resolveCheckoutGate(
  reads: CheckoutGateReads
): Promise<CheckoutGateDecision> {
  const blocking = await decideBlockingRow(reads)

  if (!blocking) {
    return ALLOW
  }

  const productTitle = await readBlockingProductTitle(reads, blocking.product_id)

  return {
    action: "block",
    response_body: {
      message:
        `You already have an active subscription for '${productTitle}' managed by ` +
        `your payment provider. Change or cancel that subscription first, or remove ` +
        `this item to continue ordering.`,
      type: "not_allowed",
      data: {
        product_id: blocking.product_id,
        subscription_id: blocking.subscription_id,
      },
    },
  }
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
 * Products in the cart being completed. A cart that cannot be read is reported
 * as empty, so the core route answers with its own "cart not found" instead of
 * this plugin impersonating it.
 */
async function readCartProductIds(
  container: MedusaContainer,
  cartId: string | undefined
): Promise<string[]> {
  if (!cartId) {
    return []
  }

  try {
    const query = container.resolve<RemoteQueryFunction>(
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

/**
 * Deliberate choices baked into this handler:
 * - a guest is passed through: there is nothing to match against, and pulling a
 *   customer out of a completed order to retroactively cancel it is worse than
 *   letting it through.
 * - the whole cart is refused, but the message names the colliding product.
 *   Dropping a line from someone's cart changes the total, shipping and any
 *   promo threshold; a wrong bill is worse than a refused one.
 * - everything the gate cannot read is passed through (ticket 12).
 *
 * This handler holds no rule of its own: it wires the request's container into
 * `resolveCheckoutGate` and maps the decision to `next()` or to the 400. The
 * 400 is written directly rather than thrown: the core error handler reduces a
 * MedusaError to { code, type, message }, which would drop the structured
 * payload, and its wrap-handler short-circuits any wrapped handler that finds
 * `req.errors`.
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

  const decision = await resolveCheckoutGate({
    find_live_recurrences: () =>
      findLiveNativeRecurrences(req.scope, { customer_id: customerId }),
    read_cart_product_ids: () => readCartProductIds(req.scope, req.params?.id),
    read_product_title: (productId) => readProductTitle(req.scope, productId),
  })

  if (decision.action === "allow") {
    next()

    return
  }

  res.status(400).json(decision.response_body)
}
