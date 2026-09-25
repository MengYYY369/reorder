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
  TRACK_OCCUPYING_NATIVE_STATUSES,
  type NativeRowCandidate,
} from "../utils/native-subscription"

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

  it("looks up the recurrences of the customer on the request, and no one else's", async () => {
    // The fail-open gate is only as good as its identity wiring: a lost or
    // swapped `auth_context` actor id would evaluate one customer's live
    // recurrences against another customer's cart and refuse the wrong checkout.
    const listSubscriptions = jest.fn(async () => [])
    const graph = jest.fn()
    const scope = makeScope({ listSubscriptions, graph })
    const res = makeRes()

    await rejectConflictingPurchase(makeReq(scope, AUTH_CUSTOMER_ID), res, next)

    expect(listSubscriptions).toHaveBeenCalledTimes(1)
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
})

describe("resolveCheckoutGate (the decision unit)", () => {
  it("fails open when the recurrence read throws, without touching the cart", async () => {
    const read_cart_product_ids = jest.fn()
    const read_product_title = jest.fn()

    expect(
      await resolveCheckoutGate({
        find_live_recurrences: async () => {
          throw new Error("db down")
        },
        read_cart_product_ids,
        read_product_title,
      })
    ).toEqual({ action: "allow" })

    expect(read_cart_product_ids).not.toHaveBeenCalled()
    expect(read_product_title).not.toHaveBeenCalled()
  })

  it("fails open when the recurrence read answers with a non-list, without touching the cart", async () => {
    const read_cart_product_ids = jest.fn()

    expect(
      await resolveCheckoutGate({
        find_live_recurrences: () => notAList<NativeRowCandidate>(),
        read_cart_product_ids,
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
        read_cart_product_ids,
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
        read_cart_product_ids: async () => {
          throw new Error("graph down")
        },
        read_product_title,
      })
    ).toEqual({ action: "allow" })

    expect(read_product_title).not.toHaveBeenCalled()
  })

  it("fails open when the cart read answers with a non-list", async () => {
    expect(
      await resolveCheckoutGate({
        find_live_recurrences: async () => [nativeRow()],
        read_cart_product_ids: () => notAList<string>(),
        read_product_title: async (productId) => productId,
      })
    ).toEqual({ action: "allow" })
  })

  it("allows when the cart has no products", async () => {
    expect(
      await resolveCheckoutGate({
        find_live_recurrences: async () => [nativeRow()],
        read_cart_product_ids: async () => [],
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
        read_cart_product_ids: async () => ["prod_1"],
        read_product_title,
      })
    ).toEqual({ action: "allow" })

    expect(read_product_title).not.toHaveBeenCalled()
  })

  it("allows on rows that are not native mirrors, even when the product matches", async () => {
    // Defense in depth: the pushdown already excludes these rows, and
    // `findBlockingNativeRow` re-checks, so nothing that is not a
    // `NATIVE-%` mirror may ever block checkout.
    expect(
      await resolveCheckoutGate({
        find_live_recurrences: async () => [
          nativeRow({ reference: "SUB-1001" }),
        ],
        read_cart_product_ids: async () => ["prod_1"],
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
        read_cart_product_ids: async () => ["prod_1"],
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
        read_cart_product_ids: async () => ["prod_1"],
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
        read_cart_product_ids: async () => ["prod_1"],
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
    //   (a `Promise.all` over the three reads) leaves every count at 1 and is
    //   exactly what the recorded sequence goes red on. The rule reads settle
    //   before the verdict is computed, so nothing cosmetic can be in flight
    //   while the decision is taken.
    // - the three `toHaveBeenCalledTimes(1)` pins catch a re-read: a verdict
    //   recomputed from a second cart read, or a title asked for twice.
    // - `action === "block"` against a title reader that throws is the one that
    //   catches a guard widened to cover the title read — the original
    //   silent-allow, and the shape the two cases above exist for. A reorder
    //   inside the guarded region does not disturb this case's sequence, so
    //   that property is pinned by the verdict line, never by the counts.
    const sequence: string[] = []

    const find_live_recurrences = jest.fn(async () => {
      sequence.push("recurrences")
      await null // a real read settles on a later turn; the gate must wait for it
      sequence.push("recurrences:settled")

      return [nativeRow()]
    })
    const read_cart_product_ids = jest.fn(async () => {
      sequence.push("cart")
      await null
      sequence.push("cart:settled")

      return ["prod_1"]
    })
    const read_product_title = jest.fn(
      async (productId: string) => {
        sequence.push(`title:${productId}`)

        throw new Error("product read down")
      }
    )

    const decision = await resolveCheckoutGate({
      find_live_recurrences,
      read_cart_product_ids,
      read_product_title,
    })

    expect(sequence).toEqual([
      "recurrences",
      "recurrences:settled",
      "cart",
      "cart:settled",
      "title:prod_1",
    ])
    expect(decision.action).toBe("block")
    expect(find_live_recurrences).toHaveBeenCalledTimes(1)
    expect(read_cart_product_ids).toHaveBeenCalledTimes(1)
    expect(read_product_title).toHaveBeenCalledTimes(1)
  })

  it("blocks a colliding live native recurrence for either occupying status", async () => {
    for (const status of TRACK_OCCUPYING_NATIVE_STATUSES) {
      const blocking = nativeRow({
        id: "sub_live",
        status,
        product_id: "prod_b",
      })

      expect(
        await resolveCheckoutGate({
          find_live_recurrences: async () => [blocking],
          read_cart_product_ids: async () => ["prod_a", "prod_b"],
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
      status: [...TRACK_OCCUPYING_NATIVE_STATUSES],
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
      status: [...TRACK_OCCUPYING_NATIVE_STATUSES],
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
