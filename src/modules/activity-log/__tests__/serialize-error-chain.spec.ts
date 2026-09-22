import {
  collectErrorNodes,
  extractFailedStep,
  serializeErrorChain,
  toDedupeQualifier,
} from "../utils/serialize-error-chain"
import {
  ActivityLogActorType,
  ActivityLogEventType,
} from "../types"
import {
  buildActivityLogDedupeKey,
  normalizeActivityLogEvent,
} from "../utils/normalize-log-event"

describe("serializeErrorChain", () => {
  it("serializes a thrown Error by message", () => {
    const serialized = serializeErrorChain(
      new Error("Subscription checkout requires complete address data")
    )

    expect(JSON.parse(serialized)).toEqual([
      {
        message: "Subscription checkout requires complete address data",
        step: null,
      },
    ])
  })

  it("keeps the payload of a non-Error rejection instead of [object Object]", () => {
    const serialized = serializeErrorChain({
      code: "PAYMENT_SESSION_MISSING",
      cart_id: "cart_123",
    })

    expect(serialized).not.toContain("[object Object]")
    expect(JSON.parse(serialized)).toEqual([
      {
        message: JSON.stringify({
          code: "PAYMENT_SESSION_MISSING",
          cart_id: "cart_123",
        }),
        step: null,
      },
    ])
  })

  it("serializes primitives and empty rejections", () => {
    expect(JSON.parse(serializeErrorChain("boom"))).toEqual([
      { message: "boom", step: null },
    ])
    expect(JSON.parse(serializeErrorChain(42))).toEqual([
      { message: "42", step: null },
    ])
    expect(JSON.parse(serializeErrorChain(undefined))).toEqual([
      { message: "undefined", step: null },
    ])
  })

  it("walks the workflow engine { message, errors } chain and keeps step names", () => {
    const chain = {
      message: "Failed to complete workflow create-subscription-from-order",
      errors: [
        {
          action: "validate-subscription-cart",
          errors: [
            {
              action: "load-cart",
              error: new Error("Cart 'cart_123' was not found"),
            },
          ],
        },
      ],
    }

    const nodes = collectErrorNodes(chain)

    expect(nodes).toHaveLength(1)
    expect(nodes[0].step).toBeNull()
    expect(nodes[0].errors?.[0]).toMatchObject({
      message: "(no message)",
      step: "validate-subscription-cart",
    })
    expect(nodes[0].errors?.[0].errors?.[0]).toMatchObject({
      message: "(no message)",
      step: "load-cart",
    })
    expect(nodes[0].errors?.[0].errors?.[0].errors?.[0]).toMatchObject({
      message: "Cart 'cart_123' was not found",
      step: null,
    })
    expect(extractFailedStep(chain)).toBe("validate-subscription-cart")
  })

  it("accepts a raw engine errors array", () => {
    const errors = [
      {
        action: "create-subscription-record",
        error: { message: "duplicate key value violates unique constraint" },
      },
    ]

    expect(extractFailedStep(errors)).toBe("create-subscription-record")
    expect(serializeErrorChain(errors)).toContain(
      "duplicate key value violates unique constraint"
    )
  })

  it("survives circular references", () => {
    const circular: Record<string, unknown> = { message: "outer" }
    circular.self = circular
    circular.errors = [circular]

    let serialized = ""

    expect(() => {
      serialized = serializeErrorChain(circular)
    }).not.toThrow()

    expect(() => JSON.parse(serialized)).not.toThrow()
    expect(serialized).toContain("outer")
  })

  it("redacts payment material instead of echoing it", () => {
    const serialized = serializeErrorChain({
      detail: "charge failed",
      payment_method_reference: "pm_live_secret",
      payment_context: { token: "tok_live_secret" },
    })

    expect(serialized).not.toContain("pm_live_secret")
    expect(serialized).not.toContain("tok_live_secret")
  })

  it("truncates oversized messages", () => {
    const serialized = serializeErrorChain(new Error("x".repeat(5000)))

    expect(serialized).toContain("[truncated]")
    expect(serialized.length).toBeLessThan(2000)
  })
})

describe("toDedupeQualifier", () => {
  it("keeps step identifiers intact", () => {
    expect(toDedupeQualifier("validate-subscription-cart")).toBe(
      "validate-subscription-cart"
    )
  })

  it("collapses characters that would break the colon-joined dedupe key", () => {
    expect(toDedupeQualifier("step:failed at : 12")).toBe(
      "step-failed-at-12"
    )
    expect(toDedupeQualifier(null)).toBe("unknown-step")
    expect(toDedupeQualifier(":::")).toBe("unknown-step")
  })
})

describe("normalizeActivityLogEvent pre-creation records", () => {
  it("accepts an event without a subscription and nulls both display columns", () => {
    const normalized = normalizeActivityLogEvent({
      event_type: ActivityLogEventType.SUBSCRIPTION_CREATION_FAILED,
      actor_type: ActivityLogActorType.SYSTEM,
      customer_id: "cus_123",
      display: {
        product_title: "Coffee Club",
        variant_title: "Monthly",
      },
      reason: "step failed",
      metadata: {
        order_id: "order_123",
        source: "store",
        trigger_type: "order_placed",
        reason_code: "validate-subscription-cart",
        workflow_chain: "dropped-by-allowlist",
      },
      dedupe: {
        scope: "order",
        target_id: "order_123",
        qualifier: "validate-subscription-cart",
      },
    })

    expect(normalized.subscription_id).toBeNull()
    expect(normalized.subscription_reference).toBeNull()
    expect(normalized.dedupe_key).toBe(
      buildActivityLogDedupeKey(
        ActivityLogEventType.SUBSCRIPTION_CREATION_FAILED,
        "order",
        "order_123",
        "validate-subscription-cart"
      )
    )
    expect(normalized.dedupe_key).toBe(
      "subscription.creation_failed:order:order_123:validate-subscription-cart"
    )
  })

  it("keeps allowlisted metadata and drops unlisted keys", () => {
    const normalized = normalizeActivityLogEvent({
      event_type: ActivityLogEventType.SUBSCRIPTION_CREATION_FAILED,
      actor_type: ActivityLogActorType.SYSTEM,
      display: {},
      metadata: {
        order_id: "order_123",
        reason_code: "create-subscription-record",
        workflow_chain: "dropped-by-allowlist",
      },
      dedupe: { scope: "order", target_id: "order_123" },
    })

    expect(normalized.metadata).toEqual({
      order_id: "order_123",
      reason_code: "create-subscription-record",
    })
  })
})
