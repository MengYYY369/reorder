import {
  buildPlan,
  type MirrorRow,
} from "../../../scripts/backfill-native-reference-format"

/**
 * Lives under the subscription module's `__tests__` because that is what the
 * unit project's `testMatch` covers; the subject is the subscription module's
 * mirror references, which is why the placement is not as arbitrary as it looks.
 */
const KINDS = new Map([["pp_paypal_paypal", "paypal"]])

function row(over: Partial<MirrorRow> & { id: string; reference: string }): MirrorRow {
  return {
    status: "active",
    payment_context: {
      payment_provider_id: "pp_paypal_paypal",
      customer_payment_reference: null,
    },
    ...over,
  }
}

describe("backfill-native-reference-format: buildPlan", () => {
  it("rewrites a legacy reference into the kind-scoped format", () => {
    const plan = buildPlan(
      [row({ id: "sub_1", reference: "NATIVE-I-LEGACY1" })],
      KINDS
    )

    expect(plan.rewrites).toEqual([
      { id: "sub_1", from: "NATIVE-I-LEGACY1", to: "NATIVE-paypal-I-LEGACY1" },
    ])
    expect(plan.alreadyCurrent).toBe(0)
    expect(plan.unresolved).toEqual([])
  })

  it("leaves an already-rewritten reference alone (a second run is a no-op)", () => {
    // The regression this guards: the provider subscription id used to be read by
    // slicing `NATIVE-` off the reference, so a second run read `paypal-I-X` as
    // the provider id and minted `NATIVE-paypal-paypal-I-X` — a new prefix on
    // every run, with the unique `reference` column hiding it.
    const plan = buildPlan(
      [
        row({
          id: "sub_1",
          reference: "NATIVE-paypal-I-LEGACY1",
          payment_context: {
            payment_provider_id: "pp_paypal_paypal",
            customer_payment_reference: "I-LEGACY1",
          },
        }),
      ],
      KINDS
    )

    expect(plan.rewrites).toEqual([])
    expect(plan.merges).toEqual([])
    expect(plan.alreadyCurrent).toBe(1)
  })

  it("still reads the id off a new-format reference when the context has none", () => {
    // Rows written before `customer_payment_reference` existed: the prefix has to
    // be recognised, or every run adds another kind token.
    const plan = buildPlan(
      [row({ id: "sub_1", reference: "NATIVE-paypal-I-OLD1" })],
      KINDS
    )

    expect(plan.rewrites).toEqual([])
    expect(plan.alreadyCurrent).toBe(1)
  })

  it("takes the context's id as authoritative when it disagrees with the reference", () => {
    const plan = buildPlan(
      [
        row({
          id: "sub_1",
          reference: "NATIVE-paypal-I-WRONG",
          payment_context: {
            payment_provider_id: "pp_paypal_paypal",
            customer_payment_reference: "I-RIGHT",
          },
        }),
      ],
      KINDS
    )

    expect(plan.rewrites).toEqual([
      { id: "sub_1", from: "NATIVE-paypal-I-WRONG", to: "NATIVE-paypal-I-RIGHT" },
    ])
  })

  it("merges a legacy row into the new-format row for the same subscription", () => {
    const plan = buildPlan(
      [
        row({ id: "sub_new", reference: "NATIVE-paypal-I-DUP" }),
        row({ id: "sub_old", reference: "NATIVE-I-DUP" }),
      ],
      KINDS
    )

    expect(plan.merges).toHaveLength(1)
    expect(plan.merges[0]).toMatchObject({
      target: "NATIVE-paypal-I-DUP",
      legacy: { id: "sub_old" },
    })
    expect(plan.merges[0].survivor.id).toBe("sub_new")
    expect(plan.rewrites).toEqual([])
    expect(plan.alreadyCurrent).toBe(1)
  })

  it("aborts the whole run when a row cannot resolve to a kind", () => {
    const plan = buildPlan(
      [
        row({ id: "sub_1", reference: "NATIVE-I-OK" }),
        row({
          id: "sub_2",
          reference: "NATIVE-I-UNKNOWN",
          payment_context: { payment_provider_id: "pp_mystery_mystery" },
        }),
      ],
      KINDS
    )

    expect(plan.unresolved).toHaveLength(1)
    expect(plan.unresolved[0].reference).toBe("NATIVE-I-UNKNOWN")
    // The resolvable row is still planned; the caller aborts before writing when
    // `unresolved` is non-empty.
    expect(plan.rewrites).toHaveLength(1)
  })
})
