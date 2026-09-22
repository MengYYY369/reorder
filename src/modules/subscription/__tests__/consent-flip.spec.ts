import {
  applyConsentFlip,
  resolveConsentFlip,
} from "../utils/consent-flip"
import type { SubscriptionPaymentContext } from "../types"

const MANUAL_CONTEXT: SubscriptionPaymentContext = {
  payment_provider_id: "pp_paypal_paypal",
  payment_mode: "manual",
  source_payment_collection_id: "paycol_1",
  source_payment_session_id: "payses_1",
  payment_method_reference: null,
  customer_payment_reference: null,
}

const decide = (overrides: Partial<Parameters<typeof resolveConsentFlip>[0]> = {}) =>
  resolveConsentFlip({
    consent_from_session: "customer_id",
    payment_context: { ...MANUAL_CONTEXT },
    session_data: { customer_id: "cus_1" },
    ...overrides,
  })

describe("resolveConsentFlip", () => {
  it("flips when the rule is on and the session carries the named field", () => {
    expect(decide()).toMatchObject({
      flip: true,
      payment_mode: "auto",
      mechanism: "reorder_auto",
      consent_field: "customer_id",
      skip_reason: null,
    })
  })

  it("does not flip when the offer has no consent rule", () => {
    expect(decide({ consent_from_session: null })).toMatchObject({
      flip: false,
      payment_mode: "manual",
      skip_reason: "consent_from_session_disabled",
    })
  })

  it("does not flip when the session lacks the field", () => {
    expect(decide({ session_data: { order_id: "order_1" } })).toMatchObject({
      flip: false,
      skip_reason: "consent_field_missing",
    })
  })

  it("does not flip on a blank string", () => {
    expect(decide({ session_data: { customer_id: "   " } })).toMatchObject({
      flip: false,
      skip_reason: "consent_field_missing",
    })
  })

  it("never flips a native mirror row into plugin charging", () => {
    expect(
      decide({
        payment_context: { ...MANUAL_CONTEXT, mechanism: "native" },
      })
    ).toMatchObject({
      flip: false,
      payment_mode: "manual",
      mechanism: "native",
      skip_reason: "native_mechanism",
    })
  })

  it("leaves an already automatic row alone", () => {
    expect(
      decide({
        payment_context: { ...MANUAL_CONTEXT, payment_mode: "auto" },
      })
    ).toMatchObject({
      flip: false,
      payment_mode: "auto",
      skip_reason: "already_auto",
    })
  })

  it("treats a row with no mechanism key as flippable", () => {
    expect(
      resolveConsentFlip({
        consent_from_session: "customer_id",
        payment_context: { payment_mode: "manual" },
        session_data: { customer_id: "cus_1" },
      })
    ).toMatchObject({ flip: true, mechanism: "reorder_auto" })
  })
})

describe("applyConsentFlip", () => {
  it("writes mode and mechanism onto the same object", () => {
    const next = applyConsentFlip(
      { ...MANUAL_CONTEXT },
      decide()
    )

    expect(next).toMatchObject({
      payment_mode: "auto",
      mechanism: "reorder_auto",
      payment_method_reference: null,
    })
  })

  it("leaves the context untouched when there is no flip", () => {
    const decision = decide({ consent_from_session: null })

    expect(applyConsentFlip({ ...MANUAL_CONTEXT }, decision)).toMatchObject(
      MANUAL_CONTEXT
    )
    expect(applyConsentFlip({ ...MANUAL_CONTEXT }, decision).mechanism).toBeUndefined()
  })
})
