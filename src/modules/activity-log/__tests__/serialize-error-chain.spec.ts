import {
  collectErrorNodes,
  extractFailedStep,
  serializeErrorChain,
  toDedupeQualifier,
} from "../utils/serialize-error-chain"
import type { SerializedErrorNode } from "../utils/serialize-error-chain"
import {
  ACTIVITY_LOG_SENSITIVE_KEYS,
  REDACTION_PLACEHOLDER,
} from "../utils/sensitive-keys"
import {
  ActivityLogActorType,
  ActivityLogEventType,
} from "../types"
import {
  buildActivityLogDedupeKey,
  normalizeActivityLogEvent,
} from "../utils/normalize-log-event"

/**
 * Every key the activity log must mask, spelled out independently of
 * `sensitive-keys.ts` so the writer is pinned by what it masks rather than by
 * what the shared constant currently contains. This is the union of the two
 * private lists the writers used to keep: `api_key`/`secret`/`token` were
 * serializer only, `address_1`/`address_2`/`postal_code`/`phone`/
 * `payment_reference`/`raw_error`/`payment_session`/`payment_sessions`/
 * `source_payment_collection_id` were normalizer only.
 */
const SENSITIVE_KEY_UNION = [
  "address_1",
  "address_2",
  "api_key",
  "customer_payment_reference",
  "error_stack",
  "payment_context",
  "payment_method_reference",
  "payment_reference",
  "payment_session",
  "payment_sessions",
  "phone",
  "postal_code",
  "provider_payload",
  "provider_response",
  "raw_error",
  "secret",
  "source_payment_collection_id",
  "source_payment_session_id",
  "stack",
  "stacktrace",
  "token",
]

/**
 * The members this writer did not mask before the two lists were merged — they
 * came from the normalizer side. Redacting them is what makes the cases below
 * fail the moment the serializer keeps a private list again.
 */
const SERIALIZER_FOREIGN_KEYS = [
  "address_1",
  "address_2",
  "phone",
  "postal_code",
  "payment_reference",
  "raw_error",
  "source_payment_collection_id",
  "payment_session",
  "payment_sessions",
]

/**
 * Ordinary fields an error payload legitimately carries, which must survive
 * masking: the shared set being *wider* than this list is as much a regression
 * as it being narrower, because over-masking silently empties the admin log.
 */
const CONTROL_KEYS = [
  "code",
  "cart_id",
  "order_id",
  "subscription_id",
  "status",
  "reason_code",
  "country_code",
  "attempt_no",
]

function leakedValue(key: string): string {
  return `leaked-${key}`
}

function leakedPayload(keys: string[]): Record<string, string> {
  return Object.fromEntries(keys.map((key) => [key, leakedValue(key)]))
}

function redactedPayload(keys: string[]): Record<string, string> {
  return Object.fromEntries(keys.map((key) => [key, REDACTION_PLACEHOLDER]))
}

/**
 * A key that exists only in the live shared set: added for one assertion and
 * removed straight after. Nothing but a writer that consults
 * `ACTIVITY_LOG_SENSITIVE_KEYS` at the moment it sanitizes can mask it — which
 * is exactly the property a private list cannot have, even a byte-for-byte copy
 * of today's union. That copy is how the two writers drifted apart the first
 * time, and no assertion on the constant's contents can see it.
 */
function sharedSetProbe(): {
  key: string
  value: string
  remove: () => void
} {
  const keys = ACTIVITY_LOG_SENSITIVE_KEYS as Set<string>
  const key = "shared_set_only_probe_key"

  keys.add(key)

  return {
    key,
    value: leakedValue(key),
    remove: () => {
      keys.delete(key)
    },
  }
}

function parseChain(serialized: string): SerializedErrorNode[] {
  return JSON.parse(serialized) as SerializedErrorNode[]
}

function parseReasonPayload(message: string): Record<string, unknown> {
  return JSON.parse(message) as Record<string, unknown>
}

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

  it("masks through the shared key set itself, not through a private copy of it", () => {
    // The pin that survives every shape of the regression this module exists to
    // prevent. Deleting the `sensitive-keys` import and restoring a private list
    // — the historical one, or a fresh copy of today's union — leaves this writer
    // unable to see a key added to the shared set after the copy was made, and
    // this is the case that says so.
    const probe = sharedSetProbe()

    try {
      const [node] = parseChain(
        serializeErrorChain({
          action: "process-renewal-cycle",
          [probe.key]: probe.value,
          country_code: "PL",
        })
      )

      expect(node?.step).toBe("process-renewal-cycle")
      expect(parseReasonPayload(node!.message)).toEqual({
        [probe.key]: REDACTION_PLACEHOLDER,
        country_code: "PL",
      })
    } finally {
      probe.remove()
    }

    expect(ACTIVITY_LOG_SENSITIVE_KEYS.has(probe.key)).toBe(false)
  })

  it("redacts every key of the shared set, and nothing outside it, when an error dumps its own fields", () => {
    const serialized = serializeErrorChain({
      action: "process-renewal-cycle",
      ...leakedPayload(SENSITIVE_KEY_UNION),
      ...leakedPayload(CONTROL_KEYS),
    })

    for (const key of SENSITIVE_KEY_UNION) {
      expect(serialized).not.toContain(leakedValue(key))
    }

    const nodes = parseChain(serialized)

    expect(nodes).toHaveLength(1)
    expect(nodes[0].step).toBe("process-renewal-cycle")
    expect(parseReasonPayload(nodes[0].message)).toEqual({
      ...redactedPayload(SENSITIVE_KEY_UNION),
      ...leakedPayload(CONTROL_KEYS),
    })
  })

  it("keeps shipping and payment reference material out of nested chain nodes", () => {
    const chain = {
      message: "Failed to complete workflow create-subscription-from-order",
      errors: [
        {
          action: "validate-shipping-address",
          address_1: "Hidden Street 1",
          address_2: "Apt 9",
          postal_code: "00-001",
          phone: "+48123123123",
          payment_reference: "pay_live_secret",
          raw_error: "declined for Hidden Street 1",
          source_payment_collection_id: "pcol_live_secret",
          country_code: "PL",
        },
      ],
    }

    const serialized = serializeErrorChain(chain)

    expect(serialized).not.toContain("Hidden Street")
    expect(serialized).not.toContain("Apt 9")
    expect(serialized).not.toContain("00-001")
    expect(serialized).not.toContain("+48123123123")
    expect(serialized).not.toContain("pay_live_secret")
    expect(serialized).not.toContain("pcol_live_secret")

    const [node] = parseChain(serialized)
    const [child] = node.errors ?? []

    expect(child?.step).toBe("validate-shipping-address")
    expect(parseReasonPayload(child!.message)).toEqual({
      address_1: REDACTION_PLACEHOLDER,
      address_2: REDACTION_PLACEHOLDER,
      postal_code: REDACTION_PLACEHOLDER,
      phone: REDACTION_PLACEHOLDER,
      payment_reference: REDACTION_PLACEHOLDER,
      raw_error: REDACTION_PLACEHOLDER,
      source_payment_collection_id: REDACTION_PLACEHOLDER,
      country_code: "PL",
    })
  })

  it("masks the keys this writer did not have before the sets merged, nested inside a non-sensitive container", () => {
    // Nesting under `detail` is the shape a provider error actually arrives in,
    // and every key below is one this serializer used to let through: they came
    // from the normalizer's list. `api_key` stays so the credential members this
    // writer has always masked keep their own nesting coverage.
    const serialized = serializeErrorChain({
      detail: {
        provider: "stripe",
        ...leakedPayload(SERIALIZER_FOREIGN_KEYS),
        api_key: "sk_live_hidden",
        ...leakedPayload(CONTROL_KEYS),
      },
    })

    for (const key of SERIALIZER_FOREIGN_KEYS) {
      expect(serialized).not.toContain(leakedValue(key))
    }

    expect(serialized).not.toContain("sk_live_hidden")

    const [node] = parseChain(serialized)

    expect(parseReasonPayload(node!.message)).toEqual({
      detail: {
        provider: "stripe",
        ...redactedPayload(SERIALIZER_FOREIGN_KEYS),
        api_key: REDACTION_PLACEHOLDER,
        ...leakedPayload(CONTROL_KEYS),
      },
    })
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
