import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import type { MedusaContainer } from "@medusajs/framework/types"
import type {
  MedusaNextFunction,
  MedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http"
import { SUBSCRIPTION_MODULE } from ".."
import { SubscriptionStatus } from "../types"
import {
  rejectConflictingPurchase,
  resolveCheckoutGate,
} from "../utils/checkout-gate"
import {
  findBlockingNativeSubscription,
  findLiveNativeRecurrences,
  readProductTitle,
} from "../utils/native-exclusivity"
import {
  NATIVE_SUBSCRIPTION_REFERENCE_PATTERN,
  TRACK_OCCUPYING_SUBSCRIPTION_STATUSES,
  type NativeRowCandidate,
} from "../utils/native-subscription"
import {
  findBlockingReorderRailRow,
  findLiveReorderRailSubscriptions,
  isFoldableReorderRailRow,
  type ReorderRailRowCandidate,
} from "../utils/reorder-rail-exclusivity"
import {
  resolveExtendTarget,
  type ExtendableSubscription,
} from "../utils/stacking"

/**
 * Ticket 12 acceptance coverage for the checkout-completion gate.
 *
 * Both halves of the gate — the middleware and the decision unit — live in this
 * module (`src/modules/subscription/utils/checkout-gate.ts`), so every import
 * here stays inside the module tree: `src/api/store/carts/completion-gate.ts`
 * is only the registration path `src/api/middlewares.ts` keeps using, and
 * asserting through it would mean a modules spec reaching into `src/api/`.
 *
 * What the cases pin, in order:
 * - the middleware passes the acting customer's id and the cart id from the
 *   request down into the reads — the two values a mixed-up wiring would use to
 *   refuse the wrong customer's checkout;
 * - anything the *rule* reads cannot answer (a rejection or a contract-forbidden
 *   result shape) lets the request reach the core handler with no 400 written,
 *   which is the ticket's fail-open ruling;
 * - a real collision still blocks, with the exact response body the storefront
 *   contract depends on;
 * - a *title* read that fails degrades the wording only: the block is decided
 *   before it runs, so a collision can never be answered with a pass. Two claims,
 *   pinned apart — the throwing readers answer a guard widened over the title
 *   read, and the recorded read sequence answers a title read hoisted over the
 *   decision; call counts alone pin neither;
 * - both checkout guards share exactly one copy of the three-condition pushdown
 *   with ticket 09's `findBlockingNativeSubscription`, semantics unchanged;
 * - `readProductTitle` is total on its own account: whatever the product read
 *   answers with — a rejection, a synchronous throw, an unresolvable QUERY, a
 *   missing row — it returns the product id instead of propagating. The
 *   subscription track interpolates that return value straight into the error it
 *   throws, so this is asserted on the value, never on a mock being called.
 */

/** Distinctive ids: the wiring assertions below fail on any other value. */
const AUTH_CUSTOMER_ID = "cus_gate_42"
const CART_ID = "cart_gate_77"

/** The storefront contract, verbatim. */
const REJECTION_BODY = {
  message:
    "You already have an active subscription for 'Coffee Club' managed by " +
    "your payment provider. Change or cancel that subscription first, or remove " +
    "this item to continue ordering.",
  type: "not_allowed",
  data: {
    product_id: "prod_1",
    subscription_id: "sub_native_1",
  },
}

/**
 * The reorder-rail rejection, verbatim: same body shape, its own wording. The
 * native wording above is pinned by the HTTP spec; the two directions must
 * stay distinguishable. The sentence names the product and the subscription
 * and promises no self-service action (the vault rail has none yet).
 */
const reorderRejectionBody = (
  productTitle: string,
  productId: string,
  subscriptionId: string
) => ({
  message:
    `You already have an active subscription for '${productTitle}' on this ` +
    `account (subscription ${subscriptionId}). A product can be covered by ` +
    `only one active subscription at a time, so this checkout cannot be ` +
    `completed.`,
  type: "not_allowed",
  data: {
    product_id: productId,
    subscription_id: subscriptionId,
  },
})

const reorderRow = (
  overrides: Partial<ReorderRailRowCandidate> = {}
): ReorderRailRowCandidate => ({
  id: "sub_reorder_1",
  reference: "SUB-REORDER-1",
  status: SubscriptionStatus.ACTIVE,
  product_id: "prod_1",
  ...overrides,
})

function makeScope(input: { listSubscriptions?: jest.Mock; graph?: jest.Mock }) {
  return {
    resolve: jest.fn((key: string) => {
      if (key === SUBSCRIPTION_MODULE) {
        return { listSubscriptions: input.listSubscriptions }
      }

      if (key === ContainerRegistrationKeys.QUERY) {
        return { graph: input.graph }
      }

      throw new Error(`unregistered container key: ${key}`)
    }),
  }
}

function makeReq(
  scope: ReturnType<typeof makeScope>,
  customerId: string | null,
  cartId: string | undefined = CART_ID
) {
  const req: Record<string, unknown> = { scope, params: { id: cartId } }

  if (customerId) {
    req.auth_context = { actor_id: customerId, actor_type: "customer" }
  }

  // Only the fields the gate reads exist on the fake; a full express-typed
  // request is not constructible in a unit run.
  return req as unknown as MedusaRequest
}

function makeRes() {
  const res = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  }

  return res as unknown as MedusaResponse & {
    status: jest.Mock
    json: jest.Mock
  }
}

const nativeRow = (
  overrides: Partial<NativeRowCandidate> = {}
): NativeRowCandidate => ({
  id: "sub_native_1",
  reference: "NATIVE-I-ABC123",
  status: SubscriptionStatus.ACTIVE,
  product_id: "prod_1",
  ...overrides,
})

/**
 * A QUERY fake answering both reads the gate makes through it: the cart and the
 * blocking product's title.
 *
 * Only the cart read can be failed here, deliberately. A `fail: "product"`
 * branch would exercise the middleware against a product read that throws, but
 * the middleware injects `readProductTitle`, whose own `try` turns any failure
 * into the product id, so such a case answers the *defective* gate and the fixed
 * one identically — it can never be observed red, which is what makes it
 * worthless here. The failure it seems to cover is pinned where it is
 * discriminating: injected readers, in `resolveCheckoutGate` below.
 */
function makeGraph(input: {
  cartProductIds?: string[]
  /** The cart's line metadata, keyed by product id, as `read_cart_item_signals` reads it. */
  cartSignals?: Array<{ product_id: string; is_subscription: boolean }>
  productTitle?: string
  fail?: "cart"
}) {
  return jest.fn(async (config: { entity: string }) => {
    if (config.entity === "cart") {
      if (input.fail === "cart") {
        throw new Error("graph down")
      }

      return {
        data: [
          {
            id: CART_ID,
            items: (input.cartProductIds ?? []).map((productId) => ({
              variant: { product_id: productId },
              metadata: input.cartSignals?.find(
                (signal) => signal.product_id === productId
              )?.is_subscription
                ? { is_subscription: true }
                : null,
            })),
          },
        ],
      }
    }

    return { data: [{ id: "prod_1", title: input.productTitle ?? "Coffee Club" }] }
  })
}

/**
 * A result the read contract forbids. No honest call can produce one — the point
 * of the fail-open rule is that the gate must not hand an unexpected shape
 * further, nor reject on it.
 */
function notAList<T>(): Promise<T[]> {
  return Promise.resolve(null as unknown as T[])
}

describe("rejectConflictingPurchase (the gate middleware)", () => {
  let next: MedusaNextFunction

  beforeEach(() => {
    next = jest.fn()
  })

  it("passes a guest through without reading anything", async () => {
    const scope = makeScope({})
    const res = makeRes()

    await rejectConflictingPurchase(makeReq(scope, null), res, next)

    expect(next).toHaveBeenCalledTimes(1)
    expect(res.status).not.toHaveBeenCalled()
    expect(scope.resolve).not.toHaveBeenCalled()
  })

  it("looks up both rails' rows for the customer on the request, and no one else's", async () => {
    // The fail-open gate is only as good as its identity wiring: a lost or
    // swapped `auth_context` actor id would evaluate one customer's live
    // rows against another customer's cart and refuse the wrong checkout.
    // Both rail readers answer from the same module, so one mock sees both
    // calls — one with the `NATIVE-%` pushdown, one with its negation.
    const listSubscriptions = jest.fn(async () => [])
    const graph = jest.fn()
    const scope = makeScope({ listSubscriptions, graph })
    const res = makeRes()

    await rejectConflictingPurchase(makeReq(scope, AUTH_CUSTOMER_ID), res, next)

    expect(listSubscriptions).toHaveBeenCalledTimes(2)
    expect(listSubscriptions).toHaveBeenCalledWith(
      expect.objectContaining({ customer_id: AUTH_CUSTOMER_ID })
    )
    expect(next).toHaveBeenCalledTimes(1)
    expect(res.status).not.toHaveBeenCalled()
    // Nothing collides, so the cart is never loaded.
    expect(scope.resolve).not.toHaveBeenCalledWith(
      ContainerRegistrationKeys.QUERY
    )
    expect(graph).not.toHaveBeenCalled()
  })

  it("reads the cart named by the route params, not an arbitrary one", async () => {
    const listSubscriptions = jest.fn(async () => [nativeRow()])
    const graph = makeGraph({ cartProductIds: ["prod_unrelated"] })
    const scope = makeScope({ listSubscriptions, graph })
    const res = makeRes()

    await rejectConflictingPurchase(makeReq(scope, AUTH_CUSTOMER_ID), res, next)

    expect(graph).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "cart",
        filters: { id: [CART_ID] },
      })
    )
    expect(next).toHaveBeenCalledTimes(1)
    expect(res.status).not.toHaveBeenCalled()
  })

  it("passes through when the recurrence read throws", async () => {
    // The defect on the base commit: `listSubscriptions` was awaited
    // unguarded, so a module or database failure rejected the async
    // middleware instead of falling through to `next()` — hanging or 500-ing
    // checkout, the opposite of the ticket's "unreadable means let it
    // through" ruling.
    const listSubscriptions = jest.fn(async () => {
      throw new Error("db down")
    })
    const scope = makeScope({ listSubscriptions })
    const res = makeRes()

    await rejectConflictingPurchase(makeReq(scope, AUTH_CUSTOMER_ID), res, next)

    expect(next).toHaveBeenCalledTimes(1)
    expect(res.status).not.toHaveBeenCalled()
    expect(res.json).not.toHaveBeenCalled()
  })

  it("passes through when the recurrence read answers with something that is not a list", async () => {
    // Same defect class as the throwing read: an unexpected result shape used
    // to reach `candidateRows.length` outside the guard and reject the
    // middleware anyway.
    const listSubscriptions = jest.fn(async () => null)
    const graph = jest.fn()
    const scope = makeScope({ listSubscriptions, graph })
    const res = makeRes()

    await rejectConflictingPurchase(makeReq(scope, AUTH_CUSTOMER_ID), res, next)

    expect(next).toHaveBeenCalledTimes(1)
    expect(res.status).not.toHaveBeenCalled()
    expect(res.json).not.toHaveBeenCalled()
  })

  it("passes through when the cart cannot be read", async () => {
    const listSubscriptions = jest.fn(async () => [nativeRow()])
    const graph = makeGraph({ fail: "cart" })
    const scope = makeScope({ listSubscriptions, graph })
    const res = makeRes()

    await rejectConflictingPurchase(makeReq(scope, AUTH_CUSTOMER_ID), res, next)

    expect(next).toHaveBeenCalledTimes(1)
    expect(res.status).not.toHaveBeenCalled()
  })

  it("blocks a colliding purchase with the structured 400 and never calls next", async () => {
    const listSubscriptions = jest.fn(async () => [nativeRow()])
    const graph = makeGraph({ cartProductIds: ["prod_1"] })
    const scope = makeScope({ listSubscriptions, graph })
    const res = makeRes()

    await rejectConflictingPurchase(makeReq(scope, AUTH_CUSTOMER_ID), res, next)

    expect(next).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledTimes(1)
    expect(res.json).toHaveBeenCalledWith(REJECTION_BODY)
    // The message names the product the decision was taken on, so the title
    // read must be keyed on it too.
    expect(graph).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "product",
        filters: { id: ["prod_1"] },
      })
    )
  })

  it("blocks a colliding live reorder-rail row with its own message", async () => {
    // The second direction (T8): the customer's live vault row occupies the
    // product just as a provider recurrence does. The mock answers each
    // reader the way the module does: the native read is the one carrying the
    // `NATIVE-%` reference pushdown; the reorder read arrives without one and
    // filters the prefix in the reader.
    const listSubscriptions = jest.fn(
      async (filters: { reference?: unknown }) =>
        filters.reference ? [] : [reorderRow()]
    )
    const graph = makeGraph({ cartProductIds: ["prod_1"] })
    const scope = makeScope({ listSubscriptions, graph })
    const res = makeRes()

    await rejectConflictingPurchase(makeReq(scope, AUTH_CUSTOMER_ID), res, next)

    expect(next).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledTimes(1)
    expect(res.json).toHaveBeenCalledWith(
      reorderRejectionBody("Coffee Club", "prod_1", "sub_reorder_1")
    )
    // The two directions stay distinguishable: the reorder wording never
    // carries the native guard's text.
    expect(
      (res.json as jest.Mock).mock.calls[0][0].message
    ).not.toContain("managed by your payment provider")
  })

  it("lets a cancelled reorder-rail row reach the core handler", async () => {
    const listSubscriptions = jest.fn(
      async (filters: { reference?: unknown }) =>
        filters.reference
          ? []
          : [reorderRow({ status: SubscriptionStatus.CANCELLED })]
    )
    const scope = makeScope({ listSubscriptions })
    const res = makeRes()

    await rejectConflictingPurchase(makeReq(scope, AUTH_CUSTOMER_ID), res, next)

    expect(next).toHaveBeenCalledTimes(1)
    expect(res.status).not.toHaveBeenCalled()
    expect(res.json).not.toHaveBeenCalled()
  })

  it("lets a subscription-track purchase through onto a foldable live row", async () => {
    // Ticket 12 (D12) at the middleware seam: the cart carries the subscription
    // signal and the live row is a card-free trial, so the repeat purchase is
    // allowed to fold into it. The signal comes from the cart's own line
    // metadata, read only once the reorder-rail block exists.
    const listSubscriptions = jest.fn(
      async (filters: { reference?: unknown }) =>
        filters.reference
          ? []
          : [
              reorderRow({
                is_trial: true,
                payment_context: {
                  payment_provider_id: null,
                  payment_mode: "auto",
                  payment_method_reference: null,
                },
              }),
            ]
    )
    const graph = makeGraph({
      cartProductIds: ["prod_1"],
      cartSignals: [{ product_id: "prod_1", is_subscription: true }],
    })
    const scope = makeScope({ listSubscriptions, graph })
    const res = makeRes()

    await rejectConflictingPurchase(makeReq(scope, AUTH_CUSTOMER_ID), res, next)

    expect(next).toHaveBeenCalledTimes(1)
    expect(res.status).not.toHaveBeenCalled()
    expect(res.json).not.toHaveBeenCalled()
  })
})

describe("resolveCheckoutGate (the decision unit)", () => {
  it("fails open when the recurrence read throws, without touching the cart", async () => {
    const read_cart_product_ids = jest.fn()
    const read_cart_item_signals = jest.fn()
    const read_product_title = jest.fn()

    expect(
      await resolveCheckoutGate({
        find_live_recurrences: async () => {
          throw new Error("db down")
        },
        find_live_reorder_rows: async () => [],
        read_cart_product_ids,
        read_cart_item_signals,
        read_product_title,
      })
    ).toEqual({ action: "allow" })

    expect(read_cart_product_ids).not.toHaveBeenCalled()
    expect(read_cart_item_signals).not.toHaveBeenCalled()
    expect(read_product_title).not.toHaveBeenCalled()
  })

  it("fails open when the recurrence read answers with a non-list, without touching the cart", async () => {
    const read_cart_product_ids = jest.fn()

    expect(
      await resolveCheckoutGate({
        find_live_recurrences: () => notAList<NativeRowCandidate>(),
        find_live_reorder_rows: async () => [],
        read_cart_product_ids,
        read_cart_item_signals: async () => [],
        read_product_title: async () => "unused",
      })
    ).toEqual({ action: "allow" })

    expect(read_cart_product_ids).not.toHaveBeenCalled()
  })

  it("allows a customer with zero live recurrences and never reads the cart", async () => {
    const read_cart_product_ids = jest.fn()

    expect(
      await resolveCheckoutGate({
        find_live_recurrences: async () => [],
        find_live_reorder_rows: async () => [],
        read_cart_product_ids,
        read_cart_item_signals: async () => [],
        read_product_title: async (productId) => productId,
      })
    ).toEqual({ action: "allow" })

    expect(read_cart_product_ids).not.toHaveBeenCalled()
  })

  it("fails open when the cart read throws", async () => {
    const read_product_title = jest.fn()

    expect(
      await resolveCheckoutGate({
        find_live_recurrences: async () => [nativeRow()],
        find_live_reorder_rows: async () => [],
        read_cart_product_ids: async () => {
          throw new Error("graph down")
        },
        read_cart_item_signals: async () => [],
        read_product_title,
      })
    ).toEqual({ action: "allow" })

    expect(read_product_title).not.toHaveBeenCalled()
  })

  it("fails open when the cart read answers with a non-list", async () => {
    expect(
      await resolveCheckoutGate({
        find_live_recurrences: async () => [nativeRow()],
        find_live_reorder_rows: async () => [],
        read_cart_product_ids: () => notAList<string>(),
        read_cart_item_signals: async () => [],
        read_product_title: async (productId) => productId,
      })
    ).toEqual({ action: "allow" })
  })

  it("allows when the cart has no products", async () => {
    expect(
      await resolveCheckoutGate({
        find_live_recurrences: async () => [nativeRow()],
        find_live_reorder_rows: async () => [],
        read_cart_product_ids: async () => [],
        read_cart_item_signals: async () => [],
        read_product_title: async (productId) => productId,
      })
    ).toEqual({ action: "allow" })
  })

  it("allows when no recurrence collides with a cart product", async () => {
    const read_product_title = jest.fn()

    expect(
      await resolveCheckoutGate({
        find_live_recurrences: async () => [
          nativeRow({ product_id: "prod_z" }),
        ],
        find_live_reorder_rows: async () => [],
        read_cart_product_ids: async () => ["prod_1"],
        read_cart_item_signals: async () => [],
        read_product_title,
      })
    ).toEqual({ action: "allow" })

    expect(read_product_title).not.toHaveBeenCalled()
  })

  it("allows on rows that are not native mirrors, even when the product matches", async () => {
    // Defense in depth: the pushdown already excludes these rows, and
    // `findBlockingNativeRow` re-checks, so nothing that is not a
    // `NATIVE-%` mirror may ever block through the native rule.
    expect(
      await resolveCheckoutGate({
        find_live_recurrences: async () => [
          nativeRow({ reference: "SUB-1001" }),
        ],
        find_live_reorder_rows: async () => [],
        read_cart_product_ids: async () => ["prod_1"],
        read_cart_item_signals: async () => [],
        read_product_title: async (productId) => productId,
      })
    ).toEqual({ action: "allow" })
  })

  it("names the blocking product in the rejection body, from the injected title", async () => {
    const read_product_title = jest.fn(
      async (productId: string) => `title-of-${productId}`
    )

    expect(
      await resolveCheckoutGate({
        find_live_recurrences: async () => [nativeRow()],
        find_live_reorder_rows: async () => [],
        read_cart_product_ids: async () => ["prod_1"],
        read_cart_item_signals: async () => [],
        read_product_title,
      })
    ).toEqual({
      action: "block",
      response_body: {
        message:
          "You already have an active subscription for 'title-of-prod_1' managed by " +
          "your payment provider. Change or cancel that subscription first, or remove " +
          "this item to continue ordering.",
        type: "not_allowed",
        data: {
          product_id: "prod_1",
          subscription_id: "sub_native_1",
        },
      },
    })

    expect(read_product_title).toHaveBeenCalledTimes(1)
    expect(read_product_title).toHaveBeenCalledWith("prod_1")
  })

  it("still blocks when the title reader rejects, degrading only the wording", async () => {
    // The last silent-allow in the gate: the block verdict and the cosmetic
    // title read used to share one `try`, so a product read that threw answered
    // a real collision with `next()`. Production `readProductTitle` falls back
    // to the id by itself, but the verdict may not depend on that.
    const read_product_title = jest.fn(async (productId: string) => {
      throw new Error(`product read down: ${productId}`)
    })

    expect(
      await resolveCheckoutGate({
        find_live_recurrences: async () => [nativeRow()],
        find_live_reorder_rows: async () => [],
        read_cart_product_ids: async () => ["prod_1"],
        read_cart_item_signals: async () => [],
        read_product_title,
      })
    ).toEqual({
      action: "block",
      response_body: {
        message:
          "You already have an active subscription for 'prod_1' managed by " +
          "your payment provider. Change or cancel that subscription first, or remove " +
          "this item to continue ordering.",
        type: "not_allowed",
        data: {
          product_id: "prod_1",
          subscription_id: "sub_native_1",
        },
      },
    })

    expect(read_product_title).toHaveBeenCalledTimes(1)
    expect(read_product_title).toHaveBeenCalledWith("prod_1")
  })

  it("still blocks when the title reader throws before returning a promise", async () => {
    // A guard around `await` alone would miss this: the throw happens while the
    // call is being made, which is inside the same region that decides the
    // verdict today.
    const read_product_title = jest.fn((productId: string): Promise<string> => {
      throw new Error(`product read down: ${productId}`)
    })

    expect(
      await resolveCheckoutGate({
        find_live_recurrences: async () => [nativeRow()],
        find_live_reorder_rows: async () => [],
        read_cart_product_ids: async () => ["prod_1"],
        read_cart_item_signals: async () => [],
        read_product_title,
      })
    ).toEqual({
      action: "block",
      response_body: {
        message:
          "You already have an active subscription for 'prod_1' managed by " +
          "your payment provider. Change or cancel that subscription first, or remove " +
          "this item to continue ordering.",
        type: "not_allowed",
        data: {
          product_id: "prod_1",
          subscription_id: "sub_native_1",
        },
      },
    })
  })

  it("walks the reads in sequence, with the title read starting last and running once", async () => {
    // Three claims, and each is carried by a different line below:
    // - `sequence` pins the order the gate walks its reads: the title read is
    //   entered only after the last rule read has *settled*. This is the half
    //   the call counts cannot pin — hoisting or parallelising the title read
    //   (a `Promise.all` over the four reads) leaves every count at 1 and is
    //   exactly what the recorded sequence goes red on. The rule reads settle
    //   before the verdict is computed, so nothing cosmetic can be in flight
    //   while the decision is taken.
    // - the `toHaveBeenCalledTimes(1)` pins catch a re-read: a verdict
    //   recomputed from a second cart read, or a title asked for twice.
    // - `action === "block"` against a title reader that throws is the one that
    //   catches a guard widened to cover the title read — the original
    //   silent-allow, and the shape the two cases above exist for. That
    //   property is pinned by the verdict line, never by the counts.
    const sequence: string[] = []

    const find_live_recurrences = jest.fn(async () => {
      sequence.push("recurrences")
      await null // a real read settles on a later turn; the gate must wait for it
      sequence.push("recurrences:settled")

      return [nativeRow()]
    })
    const find_live_reorder_rows = jest.fn(async () => {
      sequence.push("reorder-rail")
      await null
      sequence.push("reorder-rail:settled")

      return []
    })
    const read_cart_product_ids = jest.fn(async () => {
      sequence.push("cart")
      await null
      sequence.push("cart:settled")

      return ["prod_1"]
    })
    const read_cart_item_signals = jest.fn(async () => {
      sequence.push("cart-signals")

      return []
    })
    const read_product_title = jest.fn(
      async (productId: string) => {
        sequence.push(`title:${productId}`)

        throw new Error("product read down")
      }
    )

    const decision = await resolveCheckoutGate({
      find_live_recurrences,
      find_live_reorder_rows,
      read_cart_product_ids,
      read_cart_item_signals,
      read_product_title,
    })

    expect(sequence).toEqual([
      "recurrences",
      "recurrences:settled",
      "reorder-rail",
      "reorder-rail:settled",
      "cart",
      "cart:settled",
      "title:prod_1",
    ])
    expect(decision.action).toBe("block")
    expect(find_live_recurrences).toHaveBeenCalledTimes(1)
    expect(find_live_reorder_rows).toHaveBeenCalledTimes(1)
    expect(read_cart_product_ids).toHaveBeenCalledTimes(1)
    // A native collision is decided before the reorder-rail exception is even
    // reachable, so the cart-signal read is never entered on this path.
    expect(read_cart_item_signals).not.toHaveBeenCalled()
    expect(read_product_title).toHaveBeenCalledTimes(1)
  })

  it("blocks a colliding live native recurrence for either occupying status", async () => {
    for (const status of TRACK_OCCUPYING_SUBSCRIPTION_STATUSES) {
      const blocking = nativeRow({
        id: "sub_live",
        status,
        product_id: "prod_b",
      })

      expect(
        await resolveCheckoutGate({
          find_live_recurrences: async () => [blocking],
          find_live_reorder_rows: async () => [],
          read_cart_product_ids: async () => ["prod_a", "prod_b"],
          read_cart_item_signals: async () => [],
          read_product_title: async () => "Coffee Club",
        })
      ).toEqual({
        action: "block",
        response_body: {
          message: REJECTION_BODY.message,
          type: "not_allowed",
          data: {
            product_id: "prod_b",
            subscription_id: "sub_live",
          },
        },
      })
    }
  })

  it("blocks through the reorder-rail rule with its own wording", async () => {
    // The second direction (T8): this plugin's own live row occupies the
    // product just as a provider recurrence does, and the rejection must stay
    // distinguishable from the native one. The cart is a pure one-time purchase
    // (no signal), so the ticket 12 exception does not apply.
    expect(
      await resolveCheckoutGate({
        find_live_recurrences: async () => [],
        find_live_reorder_rows: async () => [reorderRow()],
        read_cart_product_ids: async () => ["prod_a", "prod_1"],
        read_cart_item_signals: async () => [],
        read_product_title: async () => "Coffee Club",
      })
    ).toEqual({
      action: "block",
      response_body: reorderRejectionBody(
        "Coffee Club",
        "prod_1",
        "sub_reorder_1"
      )
    })
  })

  it("fails open when the reorder-rail read throws, like the native one", async () => {
    // The fail-open rule is per decision and covers both rails: a read
    // failure on either side must not decide the customer's checkout.
    expect(
      await resolveCheckoutGate({
        find_live_recurrences: async () => [],
        find_live_reorder_rows: async () => {
          throw new Error("db down")
        },
        read_cart_product_ids: async () => ["prod_1"],
        read_cart_item_signals: async () => [],
        read_product_title: async (productId) => productId,
      })
    ).toEqual({ action: "allow" })
  })

  /**
   * Ticket 12 (D12): the strict exclusion's one exception. The subscription
   * track may buy again when the colliding live row is one the stacking fold
   * takes; a pure one-time purchase, or a row the fold would refuse, keeps the
   * refusal.
   */
  describe("subscription-track exception (ticket 12 / D12)", () => {
    const subscriptionCart = async () => [
      { product_id: "prod_1", is_subscription: true },
    ]
    const oneTimeCart = async () => [
      { product_id: "prod_1", is_subscription: false },
    ]

    it("lets a subscription purchase fold into a card-free trial row", async () => {
      expect(
        await resolveCheckoutGate({
          find_live_recurrences: async () => [],
          find_live_reorder_rows: async () => [
            reorderRow({
              is_trial: true,
              payment_context: {
                payment_provider_id: null,
                payment_mode: "auto",
                payment_method_reference: null,
              },
            }),
          ],
          read_cart_product_ids: async () => ["prod_1"],
          read_cart_item_signals: subscriptionCart,
          read_product_title: async (productId) => productId,
        })
      ).toEqual({ action: "allow" })
    })

    it("lets a subscription purchase fold into a paid live row", async () => {
      expect(
        await resolveCheckoutGate({
          find_live_recurrences: async () => [],
          find_live_reorder_rows: async () => [
            reorderRow({
              is_trial: false,
              payment_context: {
                payment_provider_id: "pp_paypal_paypal",
                payment_mode: "auto",
                payment_method_reference: "pm_1",
              },
            }),
          ],
          read_cart_product_ids: async () => ["prod_1"],
          read_cart_item_signals: subscriptionCart,
          read_product_title: async (productId) => productId,
        })
      ).toEqual({ action: "allow" })
    })

    it.each([
      [
        "a bound auto trial row",
        {
          is_trial: true,
          payment_context: {
            payment_provider_id: "pp_paypal_paypal",
            payment_mode: "auto",
            payment_method_reference: "pm_bound",
          },
        },
      ],
      [
        "a bound manual trial row",
        {
          is_trial: true,
          payment_context: {
            payment_provider_id: "pp_paypal_paypal",
            payment_mode: "manual",
            payment_method_reference: "pm_bound",
          },
        },
      ],
    ])(
      "lets a subscription purchase fold into %s",
      async (_label, overrides) => {
        // A trial row qualifies whether or not it has bound a method: the
        // extend clears the trial state and moves the anchor the upcoming
        // cycle follows, so the conversion charge is the slot the purchase
        // just paid for.
        expect(
          await resolveCheckoutGate({
            find_live_recurrences: async () => [],
            find_live_reorder_rows: async () => [
              reorderRow(overrides as Partial<ReorderRailRowCandidate>),
            ],
            read_cart_product_ids: async () => ["prod_1"],
            read_cart_item_signals: subscriptionCart,
            read_product_title: async (productId) => productId,
          })
        ).toEqual({ action: "allow" })
      }
    )

    it("still blocks a pure one-time purchase of the same product", async () => {
      // The cart carries no subscription signal: buying the product once more
      // is the double-buy the strict rule refuses, whatever the live row is.
      expect(
        await resolveCheckoutGate({
          find_live_recurrences: async () => [],
          find_live_reorder_rows: async () => [
            reorderRow({
              is_trial: true,
              payment_context: {
                payment_provider_id: null,
                payment_mode: "auto",
                payment_method_reference: null,
              },
            }),
          ],
          read_cart_product_ids: async () => ["prod_1"],
          read_cart_item_signals: oneTimeCart,
          read_product_title: async () => "Coffee Club",
        })
      ).toEqual({
        action: "block",
        response_body: reorderRejectionBody(
          "Coffee Club",
          "prod_1",
          "sub_reorder_1"
        ),
      })
    })

    it.each([
      [
        "a redemption row with no provider",
        {
          is_trial: false,
          payment_context: {
            payment_provider_id: null,
            payment_mode: "auto",
            payment_method_reference: null,
          },
        },
      ],
      [
        "a row with no payment context at all",
        { is_trial: false, payment_context: null },
      ],
    ])("still blocks %s", async (_label, overrides) => {
      expect(
        await resolveCheckoutGate({
          find_live_recurrences: async () => [],
          find_live_reorder_rows: async () => [
            reorderRow(overrides as Partial<ReorderRailRowCandidate>),
          ],
          read_cart_product_ids: async () => ["prod_1"],
          read_cart_item_signals: subscriptionCart,
          read_product_title: async () => "Coffee Club",
        })
      ).toEqual({
        action: "block",
        response_body: reorderRejectionBody(
          "Coffee Club",
          "prod_1",
          "sub_reorder_1"
        ),
      })
    })

    it("still blocks a paused row, which the fold would not take either", async () => {
      // Stacking folds only ACTIVE rows; letting a PAUSED row through would make
      // the purchase create a second live row for the same product.
      expect(
        await resolveCheckoutGate({
          find_live_recurrences: async () => [],
          find_live_reorder_rows: async () => [
            reorderRow({
              status: SubscriptionStatus.PAUSED,
              is_trial: true,
              payment_context: {
                payment_provider_id: null,
                payment_mode: "auto",
                payment_method_reference: null,
              },
            }),
          ],
          read_cart_product_ids: async () => ["prod_1"],
          read_cart_item_signals: subscriptionCart,
          read_product_title: async () => "Coffee Club",
        })
      ).toEqual({
        action: "block",
        response_body: reorderRejectionBody(
          "Coffee Club",
          "prod_1",
          "sub_reorder_1"
        ),
      })
    })

    it("fails open when the cart-signal read throws", async () => {
      // The exception's read sits inside the decision's one `try`, so an
      // unreadable cart signal lets the checkout through rather than deciding
      // it — the same fail-open rule as every other rule read.
      expect(
        await resolveCheckoutGate({
          find_live_recurrences: async () => [],
          find_live_reorder_rows: async () => [reorderRow()],
          read_cart_product_ids: async () => ["prod_1"],
          read_cart_item_signals: async () => {
            throw new Error("graph down")
          },
          read_product_title: async () => "Coffee Club",
        })
      ).toEqual({ action: "allow" })
    })

    it("is a strict subset of what the stacking fold takes", async () => {
      // The exception may only let a purchase through onto a row the fold will
      // actually extend. If `resolveExtendTarget` ever narrows, a predicate that
      // did not follow would let the checkout pass and the create step mint a
      // second row for the same product.
      const candidates: ReorderRailRowCandidate[] = [
        reorderRow({
          is_trial: true,
          payment_context: {
            payment_provider_id: null,
            payment_mode: "auto",
            payment_method_reference: null,
          },
        }),
        reorderRow({
          is_trial: false,
          payment_context: {
            payment_provider_id: "pp_paypal_paypal",
            payment_mode: "auto",
            payment_method_reference: "pm_1",
          },
        }),
        reorderRow({
          is_trial: true,
          payment_context: {
            payment_provider_id: "pp_paypal_paypal",
            payment_mode: "auto",
            payment_method_reference: "pm_bound",
          },
        }),
        reorderRow({
          is_trial: true,
          payment_context: {
            payment_provider_id: "pp_paypal_paypal",
            payment_mode: "manual",
            payment_method_reference: "pm_bound",
          },
        }),
        reorderRow({
          status: SubscriptionStatus.PAUSED,
          is_trial: true,
          payment_context: null,
        }),
        reorderRow({ reference: "NATIVE-I-X", is_trial: true }),
      ]

      for (const row of candidates) {
        if (!isFoldableReorderRailRow(row)) {
          continue
        }

        const fold = resolveExtendTarget(
          [row as unknown as ExtendableSubscription],
          {
            customer_id: "cus_1",
            product_id: "prod_1",
            row_stacking_policy: "extend",
          }
        )

        expect(fold.action).toBe("extend")
      }
    })
  })
})

function makeContainer(listSubscriptions: jest.Mock): MedusaContainer {
  return {
    resolve: jest.fn(() => ({ listSubscriptions })),
  } as unknown as MedusaContainer
}

/**
 * A container exposing only what a product read needs: `makeScope` is the one
 * fake here that answers `ContainerRegistrationKeys.QUERY`, so `readProductTitle`
 * is pointed at the same `graph` fakes the middleware cases use.
 */
function makeQueryContainer(graph: jest.Mock): MedusaContainer {
  return makeScope({ graph }) as unknown as MedusaContainer
}

describe("findLiveNativeRecurrences (the shared query)", () => {
  it("pushes the customer, the occupying statuses and the NATIVE-% reference down in one read", async () => {
    const rows = [nativeRow()]
    const listSubscriptions = jest.fn(async () => rows)

    const result = await findLiveNativeRecurrences(
      makeContainer(listSubscriptions),
      { customer_id: "cus_1" }
    )

    expect(listSubscriptions).toHaveBeenCalledWith({
      customer_id: "cus_1",
      status: [...TRACK_OCCUPYING_SUBSCRIPTION_STATUSES],
      reference: { $like: NATIVE_SUBSCRIPTION_REFERENCE_PATTERN },
    })
    expect(result).toEqual(rows)
  })

  it("propagates a read failure — failing open is the gate's decision, not this read's", async () => {
    const listSubscriptions = jest.fn(async () => {
      throw new Error("db down")
    })

    await expect(
      findLiveNativeRecurrences(makeContainer(listSubscriptions), {
        customer_id: "cus_1",
      })
    ).rejects.toThrow("db down")
  })
})

describe("findLiveReorderRailSubscriptions (the mirrored query, T8)", () => {
  it("pushes the customer and the occupying statuses down, and excludes NATIVE- rows from whatever comes back", async () => {
    // The rail split is the NATIVE- reference prefix, negated in this reader
    // rather than pushed down: on the pinned Medusa 2.20 + MikroORM 6.6.14
    // stack the SQL negation (`$not`/`$like`) reaches knex unexpanded and
    // throws `The operator "not" is not permitted`, which would fail the
    // whole gate open. The blocking rule re-checks the reference regardless.
    const rows = [
      reorderRow(),
      reorderRow({ id: "sub_native_leak", reference: "NATIVE-I-GATE1" }),
    ]
    const listSubscriptions = jest.fn(async () => rows)

    const result = await findLiveReorderRailSubscriptions(
      makeContainer(listSubscriptions),
      { customer_id: "cus_1" }
    )

    expect(listSubscriptions).toHaveBeenCalledWith({
      customer_id: "cus_1",
      status: [...TRACK_OCCUPYING_SUBSCRIPTION_STATUSES],
    })
    expect(result).toEqual([reorderRow()])
  })

  it("propagates a read failure, exactly like the native reader", async () => {
    const listSubscriptions = jest.fn(async () => {
      throw new Error("db down")
    })

    await expect(
      findLiveReorderRailSubscriptions(makeContainer(listSubscriptions), {
        customer_id: "cus_1",
      })
    ).rejects.toThrow("db down")
  })
})

describe("findBlockingReorderRailRow (the mirrored rule, T8)", () => {
  it("blocks a live non-native row whose product is in the cart", async () => {
    for (const status of TRACK_OCCUPYING_SUBSCRIPTION_STATUSES) {
      const blocking = reorderRow({ id: "sub_live", status })

      expect(
        findBlockingReorderRailRow([blocking], ["prod_a", "prod_1"])
      ).toEqual(blocking)
    }
  })

  it("never blocks on a NATIVE- row even if a defective read handed one over", async () => {
    // The two rules must stay disjoint: mirror rows are the native rule's
    // job. The pushdown already excludes them; this re-check is the second
    // half of that defense.
    expect(
      findBlockingReorderRailRow(
        [reorderRow({ reference: "NATIVE-I-GATE1" })],
        ["prod_1"]
      )
    ).toBeNull()
  })

  it("returns null when no row's product is in the cart", async () => {
    expect(
      findBlockingReorderRailRow(
        [reorderRow({ product_id: "prod_z" })],
        ["prod_1"]
      )
    ).toBeNull()
  })

  it("returns null for an empty cart", async () => {
    expect(findBlockingReorderRailRow([reorderRow()], [])).toBeNull()
  })
})

describe("findBlockingNativeSubscription (ticket 09 path, semantics pinned)", () => {
  it("returns the colliding row out of the shared query's rows", async () => {
    const blocking = nativeRow({ id: "sub_live", product_id: "prod_b" })
    const listSubscriptions = jest.fn(async () => [
      nativeRow({ id: "sub_other", product_id: "prod_z" }),
      blocking,
    ])

    expect(
      await findBlockingNativeSubscription(makeContainer(listSubscriptions), {
        customer_id: "cus_1",
        product_id: "prod_b",
      })
    ).toEqual(blocking)

    expect(listSubscriptions).toHaveBeenCalledWith({
      customer_id: "cus_1",
      status: [...TRACK_OCCUPYING_SUBSCRIPTION_STATUSES],
      reference: { $like: NATIVE_SUBSCRIPTION_REFERENCE_PATTERN },
    })
  })

  it("returns null when nothing collides", async () => {
    const listSubscriptions = jest.fn(async () => [
      nativeRow({ product_id: "prod_z" }),
    ])

    expect(
      await findBlockingNativeSubscription(makeContainer(listSubscriptions), {
        customer_id: "cus_1",
        product_id: "prod_b",
      })
    ).toBeNull()
  })
})

/**
 * `readProductTitle`'s totality, asserted on what it returns.
 *
 * Nothing else in this file executes that contract: the middleware injects the
 * function, but a failure seen there is indistinguishable from
 * `readBlockingProductTitle`'s guard performing the same id fallback, so no case
 * through the gate can pin it — the reason `makeGraph`'s deleted
 * `fail: "product"` branch could never go red. Direct calls are the only seam
 * where the contract is observable.
 *
 * The caller that needs it is the subscription track: `assertNoNativeRecurrence`
 * (`src/workflows/steps/validate-subscription-cart.ts`) interpolates this return
 * value straight into the error it throws and guards nothing of its own, so a
 * propagating title read would swap a domain rejection for an unclassified step
 * failure. The gate deliberately does not rely on it, which is why these cases
 * cannot be borrowed from the gate's.
 */
describe("readProductTitle (the total title read)", () => {
  it("answers with the product's own title when the read returns one", async () => {
    const graph = makeGraph({ productTitle: "Coffee Club" })

    expect(await readProductTitle(makeQueryContainer(graph), "prod_1")).toBe(
      "Coffee Club"
    )
    // Asking for the field is half of the title arriving: a read that dropped
    // `title` from its field list would answer every product with the id, and
    // the fallback below would absorb it silently.
    expect(graph).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "product",
        fields: ["id", "title"],
        filters: { id: ["prod_1"] },
      })
    )
  })

  it("returns the product id when the read rejects", async () => {
    const graph = jest.fn(async () => {
      throw new Error("graph down")
    })

    expect(await readProductTitle(makeQueryContainer(graph), "prod_1")).toBe(
      "prod_1"
    )
  })

  it("returns the product id when the read throws before returning a promise", async () => {
    // Same region, different shape: here the throw happens while the call is
    // being made, not in an awaited rejection chain.
    const graph = jest.fn(() => {
      throw new Error("graph down")
    })

    expect(await readProductTitle(makeQueryContainer(graph), "prod_1")).toBe(
      "prod_1"
    )
  })

  it("returns the product id when QUERY itself cannot be resolved", async () => {
    // The guard covers the dependency lookup, not only the read: a container
    // without QUERY must not turn a collision report into a crash.
    const container = {
      resolve: jest.fn(() => {
        throw new Error("unregistered container key: QUERY")
      }),
    } as unknown as MedusaContainer

    expect(await readProductTitle(container, "prod_1")).toBe("prod_1")
  })

  it("returns the product id when the read answers with something that is not a result", async () => {
    // The `const { data } = …` destructure throws on `null`, so a contract
    // violation is absorbed exactly like a transport failure — the shape class
    // the gate's own injected reads are pinned for.
    const graph = jest.fn(async () => null)

    expect(await readProductTitle(makeQueryContainer(graph), "prod_1")).toBe(
      "prod_1"
    )
  })

  it("returns the product id when the read finds no product row", async () => {
    const graph = jest.fn(async () => ({ data: [] }))

    expect(await readProductTitle(makeQueryContainer(graph), "prod_1")).toBe(
      "prod_1"
    )
  })

  it("returns the product id when the row carries no title", async () => {
    const graph = jest.fn(async () => ({ data: [{ id: "prod_1" }] }))

    expect(await readProductTitle(makeQueryContainer(graph), "prod_1")).toBe(
      "prod_1"
    )
  })
})
