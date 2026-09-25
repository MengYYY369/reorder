import {
  applyConsentFlip,
  resolveConsentFlip,
  type ConsentFlipInput,
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

/** A plugin-owned row: the reference carries no `NATIVE-` prefix. */
const PLUGIN_REFERENCE = "SUB-2026-0001"

/** A mirror row as the event bridge writes it. */
const NATIVE_REFERENCE = "NATIVE-I3SUP1ABCDEF01"

/**
 * What a case may leave out — and `reference` is not on that list.
 *
 * The helper used to take `Partial<ConsentFlipInput>`, which made *it* the hole
 * the file exists to close: with `exactOptionalPropertyTypes` off
 * (`tsconfig.json:20`) a case could write `decide({ reference: undefined })`
 * without a compile error, so "a missing reference answers not-native" stayed
 * reachable from the tests themselves. Naming the row is required here for the
 * same reason it is required on the real call.
 */
type DecideOverrides = Partial<Omit<ConsentFlipInput, "reference">> &
  Pick<ConsentFlipInput, "reference">

const decide = (overrides: DecideOverrides) =>
  resolveConsentFlip({
    consent_from_session: "customer_id",
    payment_context: { ...MANUAL_CONTEXT },
    session_data: { customer_id: "cus_1" },
    ...overrides,
  })

describe("resolveConsentFlip", () => {
  it("flips when the rule is on and the session carries the named field", () => {
    expect(decide({ reference: PLUGIN_REFERENCE })).toMatchObject({
      flip: true,
      payment_mode: "auto",
      mechanism: "reorder_auto",
      consent_field: "customer_id",
      skip_reason: null,
    })
  })

  it("does not flip when the offer has no consent rule", () => {
    expect(
      decide({
        reference: PLUGIN_REFERENCE,
        consent_from_session: null,
      })
    ).toMatchObject({
      flip: false,
      payment_mode: "manual",
      skip_reason: "consent_from_session_disabled",
    })
  })

  it("does not flip when the session lacks the field", () => {
    expect(
      decide({
        reference: PLUGIN_REFERENCE,
        session_data: { order_id: "order_1" },
      })
    ).toMatchObject({
      flip: false,
      skip_reason: "consent_field_missing",
    })
  })

  it("does not flip on a blank string", () => {
    expect(
      decide({
        reference: PLUGIN_REFERENCE,
        session_data: { customer_id: "   " },
      })
    ).toMatchObject({
      flip: false,
      skip_reason: "consent_field_missing",
    })
  })

  it("never flips a native mirror row into plugin charging", () => {
    expect(
      decide({
        reference: NATIVE_REFERENCE,
        payment_context: { ...MANUAL_CONTEXT, mechanism: "native" },
      })
    ).toMatchObject({
      flip: false,
      payment_mode: "manual",
      mechanism: "native",
      skip_reason: "native_reference",
    })
  })

  it("leaves an already automatic row alone", () => {
    expect(
      decide({
        reference: PLUGIN_REFERENCE,
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
      decide({
        reference: PLUGIN_REFERENCE,
        payment_context: { payment_mode: "manual" },
      })
    ).toMatchObject({ flip: true, mechanism: "reorder_auto" })
  })

  it("does not flip a mirror row whose only native marker is its reference prefix", () => {
    // The discriminating case: rows written before `mechanism` existed have no
    // such key at all, so a `payment_context.mechanism` comparison sees nothing
    // and would hand a PayPal-owned recurrence to the reorder scheduler. Only the
    // reference says this row is a mirror.
    expect(
      decide({
        reference: NATIVE_REFERENCE,
        payment_context: { payment_mode: "manual" },
      })
    ).toMatchObject({
      flip: false,
      payment_mode: "manual",
      mechanism: undefined,
      consent_field: "customer_id",
      skip_reason: "native_reference",
    })
  })

  it("never reads the mechanism annotation as the native predicate", () => {
    // A `native` annotation on a plugin-owned row must not stop the flip: the
    // annotation is informational and mirror rows always carry both it and the
    // reference, so a context-only match would mean two sources of truth.
    expect(
      decide({
        reference: PLUGIN_REFERENCE,
        payment_context: { ...MANUAL_CONTEXT, mechanism: "native" },
      })
    ).toMatchObject({
      flip: true,
      payment_mode: "auto",
      mechanism: "reorder_auto",
      skip_reason: null,
    })
  })

  it("flips a row whose reference the caller deliberately passed as null", () => {
    // `null` is a statement, not an accident: it is what `resolveStackingDecision`
    // returns when nothing is being extended, and what a caller passes when it
    // genuinely has no row to name. It is decidable (a null reference cannot be a
    // `NATIVE-` mirror), so the flip stays available.
    expect(
      decide({
        reference: null,
        payment_context: { payment_mode: "manual" },
      })
    ).toMatchObject({ flip: true, mechanism: "reorder_auto" })
  })
})

describe("resolveConsentFlip: an unnamed row is undecidable, not native-clean", () => {
  it("will not compile a call that leaves the reference out, and does not flip one", () => {
    // The shape the contract forbids, pinned from both sides. Compile time: the
    // call is an error, so a caller which forgot the field cannot be merged.
    // Runtime: the value such a call carries is `undefined`, and the guard answers
    // it the same way it answers an unreadable row — no flip. The runtime half is
    // what makes the type half non-essential: this repo has no CI, so a build
    // nobody runs cannot be the only thing standing between a forgotten field and
    // reorder charging a recurrence the provider is already charging.
    const withoutReference: Omit<ConsentFlipInput, "reference"> = {
      consent_from_session: "customer_id",
      payment_context: { payment_mode: "manual" },
      session_data: { customer_id: "cus_1" },
    }

    // @ts-expect-error TS2345: `reference` is required on ConsentFlipInput.
    const decision = resolveConsentFlip(withoutReference)

    expect(decision).toMatchObject({
      flip: false,
      payment_mode: "manual",
      consent_field: "customer_id",
      skip_reason: "reference_undecidable",
    })
  })

  it("will not compile `reference: undefined` through the test helper either", () => {
    // Guards the guard: the helper used to hand out a reference silently, which
    // meant every case in this file was written against a row it never named.
    // @ts-expect-error TS2322: `undefined` is not assignable to `string | null`.
    const decision = decide({ reference: undefined })

    expect(decision).toMatchObject({
      flip: false,
      skip_reason: "reference_undecidable",
    })
  })

  it("treats every non-string reference as undecidable", () => {
    // A string is always decidable, because the native test is a prefix test and
    // a string either has the prefix or provably does not — `""` included. Only a
    // value that is not a string at all carries no information, and that is the
    // realistic failure: `reference` reaches this function through container
    // resolves (`payment-captured-save-payment-method.ts:126-128` still casts its
    // read to `SubscriptionRecord`), so a projection which stops selecting the
    // column hands `undefined` to a call site that named the property in good
    // faith.
    const undecidable: unknown[] = [undefined, 42, true, { value: "SUB-1" }]

    for (const reference of undecidable) {
      const input = {
        consent_from_session: "customer_id" as const,
        payment_context: { payment_mode: "manual" },
        session_data: { customer_id: "cus_1" },
        reference,
      }

      // @ts-expect-error TS2345: `reference` is `string | null`, never `unknown`.
      const decision = resolveConsentFlip(input)

      expect(decision).toMatchObject({
        flip: false,
        payment_mode: "manual",
        skip_reason: "reference_undecidable",
      })
    }
  })

  it("does not let an undecidable reference decide anything else either", () => {
    // The guard runs before the mode check, so a row already on auto still
    // reports why it was left alone rather than pretending to have inspected it.
    expect(
      (() => {
        const input = {
          consent_from_session: "customer_id" as const,
          payment_context: { payment_mode: "auto" },
          session_data: { customer_id: "cus_1" },
        }

        // @ts-expect-error TS2345: `reference` is required on ConsentFlipInput.
        return resolveConsentFlip(input)
      })()
    ).toMatchObject({
      flip: false,
      payment_mode: "auto",
      skip_reason: "reference_undecidable",
    })
  })
})

describe("applyConsentFlip", () => {
  it("writes mode and mechanism onto the same object", () => {
    const next = applyConsentFlip(
      { ...MANUAL_CONTEXT },
      decide({ reference: PLUGIN_REFERENCE })
    )

    expect(next).toMatchObject({
      payment_mode: "auto",
      mechanism: "reorder_auto",
      payment_method_reference: null,
    })
  })

  it("leaves the context untouched when there is no flip", () => {
    const decision = decide({
      reference: PLUGIN_REFERENCE,
      consent_from_session: null,
    })

    expect(applyConsentFlip({ ...MANUAL_CONTEXT }, decision)).toMatchObject(
      MANUAL_CONTEXT
    )
    expect(applyConsentFlip({ ...MANUAL_CONTEXT }, decision).mechanism).toBeUndefined()
  })
})
