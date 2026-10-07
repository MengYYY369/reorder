import {
  buildNativeMirrorFieldsFromRecord,
  nativeMirrorReconcileFields,
  type NativeSubscriptionRecordInput,
} from "../utils/native-mirror"
import { SubscriptionFrequencyInterval, SubscriptionStatus } from "../types"

/**
 * The mirror's one builder, driven by the provider's own record — the shape both
 * the neutral rail event and the capability view's `listRecords` hand over.
 */
const record = (
  overrides: Partial<NativeSubscriptionRecordInput> = {}
): NativeSubscriptionRecordInput => ({
  kind: "paypal",
  provider_id: "pp_paypal_paypal",
  provider_subscription_id: "I-ABC123",
  plan_id: "plan_1",
  status: "active",
  customer_id: "cus_1",
  variant_id: "variant_1",
  interval_unit: "MONTH",
  interval_count: 1,
  next_billing_at: "2026-11-06T00:00:00.000Z",
  last_billing_at: "2026-10-06T00:00:00.000Z",
  ...overrides,
})

describe("buildNativeMirrorFieldsFromRecord — the status vocabulary", () => {
  it("reads the rail's four words as reorder's own", () => {
    expect(
      buildNativeMirrorFieldsFromRecord(record({ status: "active" }), "prod_1")
    ).toMatchObject({ ok: true, fields: { status: SubscriptionStatus.ACTIVE } })
    expect(
      buildNativeMirrorFieldsFromRecord(record({ status: "paused" }), "prod_1")
    ).toMatchObject({ ok: true, fields: { status: SubscriptionStatus.PAUSED } })
    expect(
      buildNativeMirrorFieldsFromRecord(record({ status: "past_due" }), "prod_1")
    ).toMatchObject({ ok: true, fields: { status: SubscriptionStatus.PAST_DUE } })
    expect(
      buildNativeMirrorFieldsFromRecord(record({ status: "cancelled" }), "prod_1")
    ).toMatchObject({ ok: true, fields: { status: SubscriptionStatus.CANCELLED } })
  })

  it("tolerates the casing and padding a jsonb round-trip can add", () => {
    expect(
      buildNativeMirrorFieldsFromRecord(record({ status: " ACTIVE " }), "prod_1")
    ).toMatchObject({ ok: true, fields: { status: SubscriptionStatus.ACTIVE } })
  })

  it("writes nothing for a null status (an approval nobody finished)", () => {
    const result = buildNativeMirrorFieldsFromRecord(
      record({ status: null }),
      "prod_1"
    )

    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toContain("unmappable_status")
  })

  it("writes nothing for a status outside the vocabulary", () => {
    const result = buildNativeMirrorFieldsFromRecord(
      record({ status: "something_new" }),
      "prod_1"
    )

    expect(result.ok).toBe(false)
  })
})

describe("buildNativeMirrorFieldsFromRecord — the reference", () => {
  it("builds the kind-scoped reference and keeps the raw provider id", () => {
    const result = buildNativeMirrorFieldsFromRecord(record(), "prod_1")

    expect(result.ok).toBe(true)
    expect(result.ok === true && result.fields.reference).toBe(
      "NATIVE-paypal-I-ABC123"
    )
    // The raw id is what a provider's `cancel` receives — never the reference.
    expect(result.ok === true && result.fields.provider_subscription_id).toBe(
      "I-ABC123"
    )
    expect(result.ok === true && result.fields.provider_id).toBe("pp_paypal_paypal")
    expect(result.ok === true && result.fields.kind).toBe("paypal")
  })

  it("refuses a record without a provider subscription id", () => {
    const result = buildNativeMirrorFieldsFromRecord(
      record({ provider_subscription_id: "  " }),
      "prod_1"
    )

    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toBe(
      "missing_provider_subscription_id"
    )
  })

  it("refuses a record without a kind, which the reference needs", () => {
    const result = buildNativeMirrorFieldsFromRecord(record({ kind: "" }), "prod_1")

    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toBe("missing_kind")
  })
})

describe("buildNativeMirrorFieldsFromRecord — required fields", () => {
  it("refuses a record missing any identity field", () => {
    for (const [patch, expected] of [
      [{ customer_id: null }, "missing_customer_id"],
      [{ variant_id: null }, "missing_variant_id"],
      [{ interval_unit: "" }, "missing_interval_unit"],
    ] as const) {
      const result = buildNativeMirrorFieldsFromRecord(record(patch), "prod_1")

      expect(result.ok).toBe(false)
      expect(result.ok === false && result.reason).toContain(expected)
    }
  })

  it("refuses a record whose variant could not be resolved to a product", () => {
    // A guessed product id would block the wrong checkout, which is worse than
    // not mirroring at all.
    const result = buildNativeMirrorFieldsFromRecord(record(), null)

    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toContain("product_id")
  })

  it("refuses a frequency the plugin cannot bill", () => {
    const result = buildNativeMirrorFieldsFromRecord(
      record({ interval_unit: "FORTNIGHT" }),
      "prod_1"
    )

    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toBe("unsupported_frequency")
  })

  it("accepts the three intervals the plugin bills and counts them", () => {
    for (const [unit, expected] of [
      ["WEEK", SubscriptionFrequencyInterval.WEEK],
      ["MONTH", SubscriptionFrequencyInterval.MONTH],
      ["YEAR", SubscriptionFrequencyInterval.YEAR],
    ] as const) {
      const result = buildNativeMirrorFieldsFromRecord(
        record({ interval_unit: unit, interval_count: 3 }),
        "prod_1"
      )

      expect(result.ok).toBe(true)
      expect(result.ok === true && result.fields.frequency_interval).toBe(expected)
      expect(result.ok === true && result.fields.frequency_value).toBe(3)
    }
  })
})

describe("buildNativeMirrorFieldsFromRecord — dates and plan", () => {
  it("normalises the provider's timestamps to ISO and keeps the plan", () => {
    const result = buildNativeMirrorFieldsFromRecord(
      record({
        next_billing_at: "2026-11-06T00:00:00.000Z",
        last_billing_at: null,
        plan_id: "P-1",
      }),
      "prod_1"
    )

    expect(result.ok === true && result.fields.next_renewal_at).toBe(
      "2026-11-06T00:00:00.000Z"
    )
    expect(result.ok === true && result.fields.last_renewal_at).toBeNull()
    expect(result.ok === true && result.fields.plan_id).toBe("P-1")
  })

  it("leaves an unparseable date out instead of inventing one", () => {
    const result = buildNativeMirrorFieldsFromRecord(
      record({ next_billing_at: "not a date" }),
      "prod_1"
    )

    expect(result.ok === true && result.fields.next_renewal_at).toBeNull()
  })
})

describe("nativeMirrorReconcileFields", () => {
  it("omits a date the record did not carry rather than nulling the column", () => {
    const built = buildNativeMirrorFieldsFromRecord(
      record({ next_billing_at: null, last_billing_at: null }),
      "prod_1"
    )

    expect(built.ok).toBe(true)

    const update = nativeMirrorReconcileFields(
      "sub_1",
      built.ok === true ? built.fields : ({} as never)
    )

    // The previous value came from a real provider response; an event that
    // says nothing about it must not erase it.
    expect("next_renewal_at" in update).toBe(false)
    expect("last_renewal_at" in update).toBe(false)
    expect(update.status).toBe(SubscriptionStatus.ACTIVE)
  })

  it("writes the dates it does carry", () => {
    const built = buildNativeMirrorFieldsFromRecord(record(), "prod_1")
    const update = nativeMirrorReconcileFields(
      "sub_1",
      built.ok === true ? built.fields : ({} as never)
    )

    expect(update.next_renewal_at).toEqual(
      new Date("2026-11-06T00:00:00.000Z")
    )
    expect(update.last_renewal_at).toEqual(
      new Date("2026-10-06T00:00:00.000Z")
    )
  })
})
