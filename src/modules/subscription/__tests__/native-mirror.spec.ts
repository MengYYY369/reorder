import { SubscriptionStatus } from "../types"
import {
  NATIVE_MIRROR_SHIPPING_ADDRESS,
  PAYPAL_SUBSCRIPTION_EVENT_NAMES,
  buildNativeMirrorFields,
  buildNativeMirrorFieldsFromRecord,
  buildNativeMirrorProductSnapshot,
  mapNativeStatus,
  nativeMirrorReconcileFields,
  resolveNativeStatus,
} from "../utils/native-mirror"

const FULL_PAYLOAD = {
  paypal_subscription_id: "I-7PU63T2MQYX1",
  status: "ACTIVE",
  customer_id: "cus_1",
  product_id: "prod_1",
  variant_id: "variant_1",
  plan_id: "P-3ML9C1V2U4T8",
  frequency_interval: "month",
  frequency_value: 1,
  next_billing_at: "2026-10-05T00:00:00Z",
  last_billing_at: "2026-09-05T00:00:00Z",
}

describe("mapNativeStatus", () => {
  it("pins the whole PayPal status table", () => {
    expect(mapNativeStatus("APPROVAL_PENDING")).toBeNull()
    expect(mapNativeStatus("ACTIVE")).toEqual(SubscriptionStatus.ACTIVE)
    expect(mapNativeStatus("SUSPENDED")).toEqual(SubscriptionStatus.PAUSED)
    expect(mapNativeStatus("CANCELLED")).toEqual(SubscriptionStatus.CANCELLED)
    expect(mapNativeStatus("EXPIRED")).toEqual(SubscriptionStatus.CANCELLED)
  })

  it("is case insensitive and rejects unknown states", () => {
    expect(mapNativeStatus(" active ")).toEqual(SubscriptionStatus.ACTIVE)
    expect(mapNativeStatus("SUSPENDED_FINALLY")).toBeNull()
    expect(mapNativeStatus(null)).toBeNull()
    expect(mapNativeStatus(undefined)).toBeNull()
  })
})

describe("resolveNativeStatus", () => {
  it("lets payment_failed drive past_due regardless of the payload status", () => {
    expect(
      resolveNativeStatus("paypal.subscription.payment_failed", {
        ...FULL_PAYLOAD,
        status: "ACTIVE",
      })
    ).toEqual(SubscriptionStatus.PAST_DUE)
  })

  it("maps expired to cancelled even if the provider still says ACTIVE", () => {
    expect(
      resolveNativeStatus("paypal.subscription.expired", {
        ...FULL_PAYLOAD,
        status: "ACTIVE",
      })
    ).toEqual(SubscriptionStatus.CANCELLED)
  })

  it("keeps every other event on the payload status", () => {
    expect(
      resolveNativeStatus("paypal.subscription.suspended", FULL_PAYLOAD)
    ).toEqual(SubscriptionStatus.ACTIVE)
    expect(
      resolveNativeStatus("paypal.subscription.suspended", {
        ...FULL_PAYLOAD,
        status: "SUSPENDED",
      })
    ).toEqual(SubscriptionStatus.PAUSED)
  })
})

describe("buildNativeMirrorFields", () => {
  it("builds a row whose reference is the idempotency anchor", () => {
    const result = buildNativeMirrorFields(
      "paypal.subscription.activated",
      FULL_PAYLOAD
    )

    expect(result.ok).toBe(true)

    if (!result.ok) {
      return
    }

    expect(result.fields).toEqual({
      reference: "NATIVE-I-7PU63T2MQYX1",
      paypal_subscription_id: "I-7PU63T2MQYX1",
      status: SubscriptionStatus.ACTIVE,
      customer_id: "cus_1",
      product_id: "prod_1",
      variant_id: "variant_1",
      frequency_interval: "month",
      frequency_value: 1,
      next_renewal_at: "2026-10-05T00:00:00.000Z",
      last_renewal_at: "2026-09-05T00:00:00.000Z",
      plan_id: "P-3ML9C1V2U4T8",
    })
  })

  it("falls back to the provider row id when the PayPal id is absent", () => {
    const { paypal_subscription_id: _providerId, ...withoutProviderId } =
      FULL_PAYLOAD
    const result = buildNativeMirrorFields("paypal.subscription.activated", {
      ...withoutProviderId,
      subscription_id: "psub_local_1",
    })

    expect(
      result.ok ? result.fields.reference : result.reason
    ).toEqual("NATIVE-psub_local_1")
  })

  it("tolerates an activation without a billing date instead of guessing one", () => {
    const result = buildNativeMirrorFields("paypal.subscription.activated", {
      ...FULL_PAYLOAD,
      next_billing_at: null,
      last_billing_at: undefined,
    })

    expect(result.ok).toBe(true)

    if (!result.ok) {
      return
    }

    expect(result.fields.next_renewal_at).toBeNull()
    expect(result.fields.last_renewal_at).toBeNull()
  })

  it("drops events missing any row-building field", () => {
    for (const field of [
      "customer_id",
      "product_id",
      "variant_id",
      "frequency_interval",
      "frequency_value",
    ]) {
      const result = buildNativeMirrorFields("paypal.subscription.activated", {
        ...FULL_PAYLOAD,
        [field]: null,
      })

      expect(result.ok).toBe(false)

      if (!result.ok) {
        expect(result.reason).toContain(field)
      }
    }
  })

  it("drops an event with no provider id at all", () => {
    const result = buildNativeMirrorFields("paypal.subscription.activated", {
      ...FULL_PAYLOAD,
      paypal_subscription_id: "  ",
      subscription_id: null,
    })

    expect(result).toEqual({ ok: false, reason: "missing_paypal_subscription_id" })
  })

  it("drops an APPROVAL_PENDING event rather than blocking the customer", () => {
    const result = buildNativeMirrorFields("paypal.subscription.activated", {
      ...FULL_PAYLOAD,
      status: "APPROVAL_PENDING",
    })

    expect(result).toEqual({ ok: false, reason: "unmappable_status_APPROVAL_PENDING" })
  })

  it("rejects frequencies reorder cannot represent", () => {
    expect(
      buildNativeMirrorFields("paypal.subscription.activated", {
        ...FULL_PAYLOAD,
        frequency_interval: "day",
      })
    ).toEqual({ ok: false, reason: "unsupported_frequency" })

    expect(
      buildNativeMirrorFields("paypal.subscription.activated", {
        ...FULL_PAYLOAD,
        frequency_value: "0",
      })
    ).toEqual({ ok: false, reason: "unsupported_frequency" })
  })

  it("parses numeric frequency values carried as strings", () => {
    const result = buildNativeMirrorFields("paypal.subscription.activated", {
      ...FULL_PAYLOAD,
      frequency_interval: "YEAR",
      frequency_value: "2",
    })

    expect(
      result.ok
        ? [result.fields.frequency_interval, result.fields.frequency_value]
        : result.reason
    ).toEqual(["year", 2])
  })

  it("leaves revised to the reconciliation job until medusa-paypal 0.5.0 ships", () => {
    expect(
      buildNativeMirrorFields("paypal.subscription.revised", FULL_PAYLOAD)
    ).toEqual({ ok: false, reason: "revised_not_supported_until_paypal_0_5_0" })
  })

  it("covers every event the provider emits plus revised", () => {
    expect(PAYPAL_SUBSCRIPTION_EVENT_NAMES).toHaveLength(8)
  })
})

describe("buildNativeMirrorFieldsFromRecord", () => {
  const PROVIDER_ROW = {
    id: "ppsub_01ABC",
    paypal_subscription_id: "I-7PU63T2MQYX1",
    paypal_plan_id: "P-3ML9C1V2U4T8",
    status: "ACTIVE",
    customer_id: "cus_1",
    variant_id: "variant_1",
    interval_unit: "Month",
    interval_count: 1,
    next_billing_at: new Date("2026-10-05T00:00:00Z"),
    last_billing_at: null,
  }

  it("maps a provider row using the caller-resolved product id", () => {
    const result = buildNativeMirrorFieldsFromRecord(PROVIDER_ROW, "prod_1")

    expect(result.ok).toBe(true)

    if (!result.ok) {
      return
    }

    expect(result.fields).toMatchObject({
      reference: "NATIVE-I-7PU63T2MQYX1",
      frequency_interval: "month",
      frequency_value: 1,
      product_id: "prod_1",
      next_renewal_at: "2026-10-05T00:00:00.000Z",
      last_renewal_at: null,
      plan_id: "P-3ML9C1V2U4T8",
    })
  })

  it("skips a row whose product could not be resolved", () => {
    expect(buildNativeMirrorFieldsFromRecord(PROVIDER_ROW, null)).toEqual({
      ok: false,
      reason: "missing_product_id",
    })
  })

  it("skips a row without a customer", () => {
    const result = buildNativeMirrorFieldsFromRecord(
      { ...PROVIDER_ROW, customer_id: null },
      "prod_1"
    )

    expect(result.ok).toBe(false)

    if (!result.ok) {
      expect(result.reason).toContain("customer_id")
    }
  })
})

describe("nativeMirrorReconcileFields", () => {
  const built = buildNativeMirrorFields(
    "paypal.subscription.activated",
    FULL_PAYLOAD
  )

  if (!built.ok) {
    throw new Error("fixture payload must build")
  }

  const fields = built.fields

  it("carries status and cadence", () => {
    expect(nativeMirrorReconcileFields("sub_1", fields)).toMatchObject({
      id: "sub_1",
      status: SubscriptionStatus.ACTIVE,
      frequency_interval: "month",
      frequency_value: 1,
    })
  })

  it("does not clear a known billing date when the newer event has none", () => {
    const update = nativeMirrorReconcileFields("sub_1", {
      ...fields,
      next_renewal_at: null,
      last_renewal_at: null,
    })

    expect("next_renewal_at" in update).toBe(false)
    expect("last_renewal_at" in update).toBe(false)
  })
})

describe("NATIVE_MIRROR_SHIPPING_ADDRESS", () => {
  it("is the inert placeholder a mirror row is required to carry", () => {
    // `shipping_address` is NOT NULL on the model and a mirror row never
    // generates an order; the N/A country is what distinguishes it from a
    // reorder row that lost its address.
    expect(NATIVE_MIRROR_SHIPPING_ADDRESS.country_code).toEqual("N/A")
    expect(NATIVE_MIRROR_SHIPPING_ADDRESS.postal_code).toEqual("00000")
  })
})

describe("buildNativeMirrorProductSnapshot", () => {
  it("falls back to ids so a mirror row never shows an empty title", () => {
    expect(
      buildNativeMirrorProductSnapshot({
        product_id: "prod_1",
        variant_id: "variant_1",
        product_title: null,
        variant_title: "  ",
      })
    ).toEqual({
      product_id: "prod_1",
      product_title: "prod_1",
      variant_id: "variant_1",
      variant_title: "variant_1",
      sku: null,
    })
  })

  it("keeps resolved titles", () => {
    expect(
      buildNativeMirrorProductSnapshot({
        product_id: "prod_1",
        variant_id: "variant_1",
        product_title: "Coffee Club",
        variant_title: "Monthly",
        sku: "CC-M",
      })
    ).toEqual({
      product_id: "prod_1",
      product_title: "Coffee Club",
      variant_id: "variant_1",
      variant_title: "Monthly",
      sku: "CC-M",
    })
  })
})
