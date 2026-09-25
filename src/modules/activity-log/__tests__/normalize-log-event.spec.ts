import {
  normalizeActivityLogEvent,
  buildActivityLogDedupeKey,
} from "../utils/normalize-log-event"
import { ACTIVITY_LOG_SENSITIVE_KEYS } from "../utils/sensitive-keys"
import {
  ActivityLogActorType,
  ActivityLogEventType,
} from "../types"

/**
 * Every key the activity log must mask, spelled out independently of
 * `sensitive-keys.ts` so the writer is pinned by what it drops rather than by
 * what the shared constant currently contains. `api_key`, `secret` and `token`
 * are the members this normalizer only masks since the two writers' key lists
 * were merged into one set.
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
 * The members this writer did not mask before the merge — they came from the
 * error serializer's list. They are what makes the cases below fail the moment
 * the normalizer keeps a private list again.
 */
const NORMALIZER_FOREIGN_KEYS = ["api_key", "secret", "token"]

/**
 * Ordinary fields a state or metadata payload legitimately carries, which must
 * survive: the shared set being *wider* than this list is as much a regression
 * as it being narrower, because over-masking silently empties the admin log.
 */
const CONTROL_KEYS = [
  "id",
  "subscription_id",
  "order_id",
  "status",
  "country_code",
  "reason_code",
  "attempt_no",
  "reference",
]

function leakedValue(key: string): string {
  return `leaked-${key}`
}

function leakedPayload(keys: string[]): Record<string, string> {
  return Object.fromEntries(keys.map((key) => [key, leakedValue(key)]))
}

/**
 * A key that exists only in the live shared set: added for one assertion and
 * removed straight after. Nothing but a writer that consults
 * `ACTIVITY_LOG_SENSITIVE_KEYS` at the moment it sanitizes can drop it — which
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

describe("normalizeActivityLogEvent", () => {
  it("builds compact changed_fields from previous and new state", () => {
    const normalized = normalizeActivityLogEvent({
      subscription_id: "sub_123",
      customer_id: "cus_123",
      event_type: ActivityLogEventType.SUBSCRIPTION_PAUSED,
      actor_type: ActivityLogActorType.USER,
      actor_id: "user_123",
      display: {
        subscription_reference: "SUB-123",
        customer_name: "Jane Doe",
        product_title: "Coffee Club",
        variant_title: "Monthly",
      },
      previous_state: {
        status: "active",
        skip_next_cycle: false,
      },
      new_state: {
        status: "paused",
        skip_next_cycle: false,
      },
      reason: "customer requested a break",
      metadata: {
        source: "admin",
      },
      dedupe: {
        scope: "subscription",
        target_id: "sub_123",
        qualifier: "2026-04-01T10:00:00.000Z",
      },
    })

    expect(normalized.changed_fields).toEqual([
      {
        field: "status",
        before: "active",
        after: "paused",
      },
    ])
  })

  it("redacts sensitive state payload fields", () => {
    const normalized = normalizeActivityLogEvent({
      subscription_id: "sub_123",
      event_type: ActivityLogEventType.SUBSCRIPTION_SHIPPING_ADDRESS_UPDATED,
      actor_type: ActivityLogActorType.USER,
      display: {
        subscription_reference: "SUB-123",
      },
      previous_state: {
        city: "Warsaw",
        address_1: "Hidden Street 1",
        postal_code: "00-001",
        phone: "+48123123123",
      },
      new_state: {
        city: "Krakow",
        address_1: "Hidden Street 2",
        payment_context: {
          payment_method_reference: "pm_secret",
        },
      },
      metadata: {
        order_id: "order_123",
        provider_payload: {
          unsafe: true,
        },
      },
      dedupe: {
        scope: "subscription",
        target_id: "sub_123",
      },
    })

    expect(normalized.previous_state).toEqual({
      city: "Warsaw",
    })
    expect(normalized.new_state).toEqual({
      city: "Krakow",
    })
    expect(normalized.metadata).toEqual({
      order_id: "order_123",
    })
  })

  it("drops through the shared key set itself, not through a private copy of it", () => {
    // The pin that survives every shape of the regression this module exists to
    // prevent: deleting the `sensitive-keys` import and restoring a private list
    // — the historical one or a fresh copy of today's union — leaves this writer
    // unable to see a key added to the shared set afterwards.
    const probe = sharedSetProbe()

    try {
      const normalized = normalizeActivityLogEvent({
        subscription_id: "sub_123",
        event_type: ActivityLogEventType.SUBSCRIPTION_SHIPPING_ADDRESS_UPDATED,
        actor_type: ActivityLogActorType.USER,
        display: {
          subscription_reference: "SUB-123",
        },
        previous_state: {
          city: "Warsaw",
          [probe.key]: probe.value,
        },
        new_state: {
          city: "Krakow",
          shipping: {
            country_code: "PL",
            [probe.key]: probe.value,
          },
        },
        metadata: {
          order_id: "order_123",
          status_after: {
            state: "paid",
            [probe.key]: probe.value,
          },
        },
        dedupe: {
          scope: "subscription",
          target_id: "sub_123",
        },
      })

      expect(normalized.previous_state).toEqual({ city: "Warsaw" })
      expect(normalized.new_state).toEqual({
        city: "Krakow",
        shipping: { country_code: "PL" },
      })
      expect(normalized.metadata).toEqual({
        order_id: "order_123",
        status_after: { state: "paid" },
      })
      expect(normalized.changed_fields).toEqual([
        { field: "city", before: "Warsaw", after: "Krakow" },
        {
          field: "shipping",
          before: null,
          after: { country_code: "PL" },
        },
      ])
      expect(JSON.stringify(normalized)).not.toContain(probe.value)
    } finally {
      probe.remove()
    }

    expect(ACTIVITY_LOG_SENSITIVE_KEYS.has(probe.key)).toBe(false)
  })

  it("drops every key of the shared set, and nothing outside it, from both states and changed_fields", () => {
    const normalized = normalizeActivityLogEvent({
      subscription_id: "sub_123",
      event_type: ActivityLogEventType.SUBSCRIPTION_SHIPPING_ADDRESS_UPDATED,
      actor_type: ActivityLogActorType.USER,
      display: {
        subscription_reference: "SUB-123",
      },
      previous_state: {
        city: "Warsaw",
        ...leakedPayload(SENSITIVE_KEY_UNION),
        ...leakedPayload(CONTROL_KEYS),
      },
      new_state: {
        city: "Krakow",
        ...leakedPayload(CONTROL_KEYS),
      },
      dedupe: {
        scope: "subscription",
        target_id: "sub_123",
      },
    })

    expect(normalized.previous_state).toEqual({
      city: "Warsaw",
      ...leakedPayload(CONTROL_KEYS),
    })
    expect(normalized.new_state).toEqual({
      city: "Krakow",
      ...leakedPayload(CONTROL_KEYS),
    })
    expect(normalized.changed_fields).toEqual([
      { field: "city", before: "Warsaw", after: "Krakow" },
    ])

    for (const key of SENSITIVE_KEY_UNION) {
      expect(JSON.stringify(normalized)).not.toContain(leakedValue(key))
    }
  })

  it("drops the credential keys the normalizer gained when the sets were merged", () => {
    const normalized = normalizeActivityLogEvent({
      subscription_id: "sub_123",
      event_type: ActivityLogEventType.SUBSCRIPTION_PAYMENT_METHOD_UPDATED,
      actor_type: ActivityLogActorType.SYSTEM,
      display: {
        subscription_reference: "SUB-123",
      },
      previous_state: {
        provider: "stripe",
        ...leakedPayload(NORMALIZER_FOREIGN_KEYS),
      },
      new_state: {
        provider: "stripe",
        payment: {
          label: "visa",
          token: "tok_live_other",
          payment_reference: "pay_live_other",
        },
      },
      metadata: {
        order_id: "order_123",
        status_after: {
          state: "paid",
          secret: "whsec_hidden",
        },
      },
      dedupe: {
        scope: "subscription",
        target_id: "sub_123",
      },
    })

    expect(normalized.previous_state).toEqual({
      provider: "stripe",
    })
    expect(normalized.new_state).toEqual({
      provider: "stripe",
      payment: {
        label: "visa",
      },
    })
    expect(normalized.metadata).toEqual({
      order_id: "order_123",
      status_after: {
        state: "paid",
      },
    })

    for (const key of NORMALIZER_FOREIGN_KEYS) {
      expect(JSON.stringify(normalized)).not.toContain(leakedValue(key))
    }

    expect(JSON.stringify(normalized)).not.toContain("tok_live_other")
    expect(JSON.stringify(normalized)).not.toContain("pay_live_other")
  })

  it("adds correlation_id and filters metadata to an allow-list", () => {
    const normalized = normalizeActivityLogEvent({
      subscription_id: "sub_123",
      event_type: ActivityLogEventType.RENEWAL_FAILED,
      actor_type: ActivityLogActorType.SYSTEM,
      display: {
        subscription_reference: "SUB-123",
      },
      metadata: {
        renewal_cycle_id: "renewal_123",
        attempt_no: 2,
        ignored_key: "drop-me",
      },
      correlation_id: "renewal-force-uuid",
      dedupe: {
        scope: "renewal",
        target_id: "renewal_123",
      },
    })

    expect(normalized.metadata).toEqual({
      renewal_cycle_id: "renewal_123",
      attempt_no: 2,
      correlation_id: "renewal-force-uuid",
    })
  })

  it("builds a stable dedupe key", () => {
    expect(
      buildActivityLogDedupeKey(
        ActivityLogEventType.DUNNING_RETRY_EXECUTED,
        "dunning",
        "dunning_123",
        3
      )
    ).toBe("dunning.retry_executed:dunning:dunning_123:3")
  })

  it("changes dedupe key when qualifier changes", () => {
    expect(
      buildActivityLogDedupeKey(
        ActivityLogEventType.SUBSCRIPTION_PAUSED,
        "subscription",
        "sub_123",
        "2026-04-01T10:00:00.000Z"
      )
    ).not.toBe(
      buildActivityLogDedupeKey(
        ActivityLogEventType.SUBSCRIPTION_PAUSED,
        "subscription",
        "sub_123",
        "2026-04-01T11:00:00.000Z"
      )
    )
  })

  it("returns null changed_fields when state did not effectively change", () => {
    const normalized = normalizeActivityLogEvent({
      subscription_id: "sub_123",
      event_type: ActivityLogEventType.CANCELLATION_REASON_UPDATED,
      actor_type: ActivityLogActorType.USER,
      display: {
        subscription_reference: "SUB-123",
      },
      previous_state: {
        reason_category: "price",
      },
      new_state: {
        reason_category: "price",
      },
      dedupe: {
        scope: "cancellation",
        target_id: "case_123",
      },
    })

    expect(normalized.changed_fields).toBeNull()
  })

  it("keeps checkout metadata for subscription creation events", () => {
    const normalized = normalizeActivityLogEvent({
      subscription_id: "sub_123",
      customer_id: "cus_123",
      event_type: ActivityLogEventType.SUBSCRIPTION_CREATED,
      actor_type: ActivityLogActorType.CUSTOMER,
      actor_id: "cus_123",
      display: {
        subscription_reference: "SUB-123",
        customer_name: "Jane Doe",
        product_title: "Coffee Club",
        variant_title: "Monthly",
      },
      new_state: {
        status: "active",
        started_at: "2026-04-01T10:00:00.000Z",
        next_renewal_at: "2026-05-01T10:00:00.000Z",
      },
      metadata: {
        order_id: "order_123",
        source: "store",
        trigger_type: "checkout",
      },
      dedupe: {
        scope: "order",
        target_id: "order_123",
        qualifier: "sub_123",
      },
    })

    expect(normalized.previous_state).toBeNull()
    expect(normalized.changed_fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: "status",
          before: null,
          after: "active",
        }),
      ])
    )
    expect(normalized.metadata).toEqual({
      order_id: "order_123",
      source: "store",
      trigger_type: "checkout",
    })
  })

  it("serializes dates in state and metadata while redacting nested sensitive fields", () => {
    const normalized = normalizeActivityLogEvent({
      subscription_id: "sub_123",
      event_type: ActivityLogEventType.RENEWAL_SUCCEEDED,
      actor_type: ActivityLogActorType.SCHEDULER,
      display: {
        subscription_reference: "SUB-123",
      },
      previous_state: {
        processed_at: new Date("2026-04-01T10:00:00.000Z"),
        payment_context: {
          session_id: "hidden",
        },
      },
      new_state: {
        processed_at: new Date("2026-04-01T10:05:00.000Z"),
        order: {
          id: "order_123",
          payment_reference: "secret_payment",
        },
      },
      metadata: {
        order_id: "order_123",
        scheduled_for: new Date("2026-04-01T10:00:00.000Z"),
        provider_response: {
          unsafe: true,
        },
      },
      dedupe: {
        scope: "renewal",
        target_id: "renewal_123",
        qualifier: "success",
      },
    })

    expect(normalized.previous_state).toEqual({
      processed_at: "2026-04-01T10:00:00.000Z",
    })
    expect(normalized.new_state).toEqual({
      processed_at: "2026-04-01T10:05:00.000Z",
      order: {
        id: "order_123",
      },
    })
    expect(normalized.metadata).toEqual({
      order_id: "order_123",
      scheduled_for: "2026-04-01T10:00:00.000Z",
    })
  })
})
