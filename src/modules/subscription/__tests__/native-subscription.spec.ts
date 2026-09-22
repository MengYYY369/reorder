import {
  NATIVE_SUBSCRIPTION_REFERENCE_PATTERN,
  NATIVE_SUBSCRIPTION_REFERENCE_PREFIX,
  buildNativeSubscriptionReference,
  isNativeSubscriptionReference,
} from "../utils/native-subscription"

describe("isNativeSubscriptionReference", () => {
  it("matches the prefix the event bridge writes", () => {
    expect(
      isNativeSubscriptionReference(`${NATIVE_SUBSCRIPTION_REFERENCE_PREFIX}I-abc123`)
    ).toBe(true)
  })

  it("does not match reorder's own SUB- references", () => {
    expect(isNativeSubscriptionReference("SUB-1234")).toBe(false)
    expect(isNativeSubscriptionReference("sub-native-1")).toBe(false)
  })

  it("survives the values a jsonb or graph read can hand back", () => {
    for (const value of [null, undefined, 7, {}, "", "  ", []]) {
      expect(isNativeSubscriptionReference(value)).toBe(false)
    }
  })
})

describe("buildNativeSubscriptionReference", () => {
  it("is stable for one provider id", () => {
    expect(buildNativeSubscriptionReference("I-abc123")).toEqual("NATIVE-I-abc123")
    expect(buildNativeSubscriptionReference(" I-abc123 ")).toEqual(
      "NATIVE-I-abc123"
    )
  })

  it("refuses to build an anchorless reference", () => {
    expect(buildNativeSubscriptionReference(null)).toBeNull()
    expect(buildNativeSubscriptionReference(undefined)).toBeNull()
    expect(buildNativeSubscriptionReference("   ")).toBeNull()
    expect(buildNativeSubscriptionReference(42)).toBeNull()
  })
})

describe("NATIVE_SUBSCRIPTION_REFERENCE_PATTERN", () => {
  it("is the LIKE form of the same rule", () => {
    expect(NATIVE_SUBSCRIPTION_REFERENCE_PATTERN).toEqual("NATIVE-%")
  })
})
