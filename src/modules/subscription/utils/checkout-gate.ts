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
import {
  findBlockingReorderRailRow,
  findLiveReorderRailSubscriptions,
  isFoldableReorderRailRow,
  type ReorderRailRowCandidate,
} from "./reorder-rail-exclusivity"

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
 * the answer to that is always to let the request through. The exclusion rules
 * (which rows block) are `findBlockingNativeRow`'s for provider-owned mirror
 * rows and `findBlockingReorderRailRow`'s for this plugin's own live rows —
 * the same occupying status set, so the two directions cannot disagree about
 * what "already subscribed" means.
 *
 * Fail-open is bounded to the decision, though, and that bound is a second
 * rule: the guard covers only the reads the rules need, so the verdict is final
 * before the product title — a purely cosmetic input to the rejection message —
 * is read at all. A title that cannot be read degrades the wording (to the
 * product id, the same fallback the production reader uses) and can never turn a
 * real collision back into a silent pass.
 */

/** A cart line as far as this gate is concerned: only its product matters. */
type CartLineItem = {
  metadata?: Record<string, unknown> | null
  variant?: { product_id?: string | null } | null
}

/**
 * One cart line reduced to the two facts the exception reads: which product it
 * is for, and whether the purchase runs on the subscription track. Kept apart
 * from `read_cart_product_ids` — that read answers the matching rule and only
 * ever carries product ids, while the track flag is a separate question asked
 * only once a reorder-rail block exists (ticket 12 / D12).
 */
export type CartItemSignal = {
  product_id: string
  is_subscription: boolean
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
  /**
   * Live subscription rows on the reorder rail (the exact negation of the
   * native reference filter) for the acting customer. Same occupying status
   * set, so the two directions cannot disagree about what "already
   * subscribed" means.
   */
  find_live_reorder_rows: () => Promise<ReorderRailRowCandidate[]>
  /** Products in the cart being completed. */
  read_cart_product_ids: () => Promise<string[]>
  /**
   * The cart's lines as `{ product_id, is_subscription }`, read only when a
   * reorder-rail block exists, to decide the ticket 12 exception: the
   * subscription track may fold into a live foldable row, while a pure one-time
   * purchase of the same product stays refused.
   */
  read_cart_item_signals: () => Promise<CartItemSignal[]>
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

/** A collision found by one of the two rules: everything the rejection is
 * built from, minus the product title. */
type BlockingRow = {
  product_id: string
  subscription_id: string
  /** Which rail the live row runs on — the message is rail-specific. */
  rail: "native" | "reorder"
}

/**
 * The rejection wording for a live subscription on the reorder rail (this
 * plugin's own rows). Deliberately different from the native wording — that
 * one is pinned verbatim by `integration-tests/http/native-checkout-gate.spec.ts`,
 * and the two directions must stay distinguishable in the logs. The sentence
 * names the product and the subscription and stays factual: the vault rail
 * has no self-service change-or-cancel flow yet, so it must not promise one.
 */
function reorderRailRejectionMessage(
  productTitle: string,
  subscriptionId: string
): string {
  return (
    `You already have an active subscription for '${productTitle}' on this ` +
    `account (subscription ${subscriptionId}). A product can be covered by ` +
    `only one active subscription at a time, so this checkout cannot be ` +
    `completed.`
  )
}

/**
 * The only guarded region of the gate: the reads the rules need and the
 * matching itself.
 *
 * Two rail readers run beside each other — live `NATIVE-` mirror rows and
 * live reorder-rail rows, the exact negation of each other's reference
 * filter — because a second subscription for a product must be refused
 * whichever rail the first one runs on. Both sit under the one `try`: the
 * fail-open rule is per decision, not per read, so a failure on either rail
 * answers "cannot decide" and lets the request through. The common case —
 * no live row on either rail — costs two indexed reads and never loads the
 * cart.
 *
 * Returns the blocking row, or `null` for "nothing blocks" — which covers "a
 * customer with no live subscription", "a cart with nothing in it", "no row
 * collides", "the colliding reorder-rail row is one the subscription track may
 * fold into", and, via the catch, "cannot decide" too. All five allow, so the
 * collapsed answer is enough; what matters is that it is final. Nothing read
 * after this function returns can change the verdict, which is why the catch may
 * not be widened to cover later reads.
 */
async function decideBlockingRow(
  reads: CheckoutGateReads
): Promise<BlockingRow | null> {
  try {
    const candidateRows = await reads.find_live_recurrences()
    const reorderRailRows = await reads.find_live_reorder_rows()

    // The overwhelmingly common case: no live row on either rail. Two indexed
    // reads, and the cart is never loaded.
    if (!candidateRows.length && !reorderRailRows.length) {
      return null
    }

    const cartProductIds = await reads.read_cart_product_ids()

    if (!cartProductIds.length) {
      return null
    }

    const nativeBlocking = findBlockingNativeRow(
      candidateRows,
      cartProductIds
    )

    if (nativeBlocking) {
      return {
        product_id: nativeBlocking.product_id,
        subscription_id: nativeBlocking.id,
        rail: "native",
      }
    }

    const reorderBlocking = findBlockingReorderRailRow(
      reorderRailRows,
      cartProductIds
    )

    if (!reorderBlocking) {
      return null
    }

    // Ticket 12 (D12): the strict exclusion has exactly one exception — the
    // subscription track's own repeat purchase. It is a true subset of what the
    // stacking decision folds into (`isFoldableReorderRailRow`), and it only
    // applies when the cart itself carries the subscription signal: a pure
    // one-time purchase of the same product keeps the original refusal. Both
    // reads stay inside this `try`, so an unreadable cart signal fails open
    // like every other rule read rather than deciding the checkout.
    const cartSignals = await reads.read_cart_item_signals()

    if (
      isSubscriptionTrackPurchase(cartSignals, reorderBlocking.product_id) &&
      isFoldableReorderRailRow(reorderBlocking)
    ) {
      return null
    }

    return {
      product_id: reorderBlocking.product_id,
      subscription_id: reorderBlocking.id,
      rail: "reorder",
    }
  } catch {
    // Fail-open: unreadable state — a rejection or a result this unit cannot
    // work with — must not decide the customer's checkout. The core handler runs
    // instead, exactly as if the gate passed.
    return null
  }
}

/**
 * Whether the cart buys `productId` on the subscription track, using the same
 * boolean wording `validate-subscription-cart` reads (`true` or `"true"`).
 * Checked per line, so a cart that is not a subscription cart never gets the
 * exception even when a live row would be foldable.
 */
function isSubscriptionTrackPurchase(
  signals: CartItemSignal[],
  productId: string
): boolean {
  return signals.some(
    (signal) => signal.product_id === productId && signal.is_subscription
  )
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
        blocking.rail === "reorder"
          ? reorderRailRejectionMessage(productTitle, blocking.subscription_id)
          : `You already have an active subscription for '${productTitle}' managed by ` +
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
 * The cart's lines as `{ product_id, is_subscription }`, read only once a
 * reorder-rail block exists. The signal wording mirrors
 * `validate-subscription-cart`'s `isSubscriptionItem` (`true` or `"true"`) so
 * the gate and the step cannot disagree about what a subscription cart is. A
 * cart that cannot be read is reported as empty, which leaves the strict
 * exclusion in force rather than granting the exception on an unreadable cart.
 */
async function readCartItemSignals(
  container: MedusaContainer,
  cartId: string | undefined
): Promise<CartItemSignal[]> {
  if (!cartId) {
    return []
  }

  try {
    const query = container.resolve<RemoteQueryFunction>(
      ContainerRegistrationKeys.QUERY
    )
    const { data } = await query.graph({
      entity: "cart",
      fields: ["id", "items.metadata", "items.variant.product_id"],
      filters: { id: [cartId] },
    })

    const cart = (data as Array<{ items?: CartLineItem[] | null }>)[0]

    if (!cart) {
      return []
    }

    return (cart.items ?? []).flatMap((item) => {
      const productId = item?.variant?.product_id

      return productId
        ? [
            {
              product_id: productId,
              is_subscription: readBoolean(item?.metadata?.is_subscription),
            },
          ]
        : []
    })
  } catch {
    return []
  }
}

/**
 * The boolean wording `validate-subscription-cart` reads: a JSON boolean or the
 * string `"true"`. Anything else — including the string `"false"` — is false,
 * so the exception is never granted on a half-written metadata value.
 */
function readBoolean(value: unknown): boolean {
  if (typeof value === "boolean") {
    return value
  }

  if (typeof value === "string") {
    return value === "true"
  }

  return false
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
    find_live_reorder_rows: () =>
      findLiveReorderRailSubscriptions(req.scope, { customer_id: customerId }),
    read_cart_product_ids: () => readCartProductIds(req.scope, req.params?.id),
    read_cart_item_signals: () => readCartItemSignals(req.scope, req.params?.id),
    read_product_title: (productId) => readProductTitle(req.scope, productId),
  })

  if (decision.action === "allow") {
    next()

    return
  }

  res.status(400).json(decision.response_body)
}
