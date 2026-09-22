import {
  NATIVE_SUBSCRIPTION_REFERENCE_PATTERN,
  NATIVE_SUBSCRIPTION_REFERENCE_PREFIX,
  TRACK_OCCUPYING_NATIVE_STATUSES,
  buildNativeSubscriptionReference,
  findBlockingNativeRow,
  isNativeSubscriptionReference,
} from "../utils/native-subscription"
import { SubscriptionStatus } from "../types"

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

const nativeRow = (status: string, productId = "prod_1") => ({
  id: "sub_native",
  reference: `${NATIVE_SUBSCRIPTION_REFERENCE_PREFIX}I-ABC`,
  status,
  product_id: productId,
})

const reorderRow = (status: string, productId = "prod_1") => ({
  id: "sub_own",
  reference: "SUB-1001",
  status,
  product_id: productId,
})

describe("findBlockingNativeRow", () => {
  it("blocks while a provider recurrence is running or paused", () => {
    for (const status of TRACK_OCCUPYING_NATIVE_STATUSES) {
      const row = nativeRow(status)

      expect(findBlockingNativeRow([row], ["prod_1"])).toEqual(row)
    }
  })

  it("lets a failed or finished recurrence through", () => {
    for (const status of [
      SubscriptionStatus.PAST_DUE,
      SubscriptionStatus.CANCELLED,
    ]) {
      expect(findBlockingNativeRow([nativeRow(status)], ["prod_1"])).toBeNull()
    }
  })

  it("never blocks on this plugin's own rows", () => {
    // Regression for the first draft of the checkout gate, which filtered on
    // customer + status and treated a healthy reorder subscription as a
    // provider recurrence, rejecting normal subscribers.
    expect(
      findBlockingNativeRow([reorderRow(SubscriptionStatus.ACTIVE)], ["prod_1"])
    ).toBeNull()
  })

  it("ignores products that are not in the cart", () => {
    expect(
      findBlockingNativeRow([nativeRow("active", "prod_other")], ["prod_1"])
    ).toBeNull()
  })

  it("names the colliding row out of a mixed cart", () => {
    const blocking = nativeRow("active", "prod_b")

    expect(
      findBlockingNativeRow(
        [reorderRow(SubscriptionStatus.ACTIVE), nativeRow("active", "prod_z"), blocking],
        ["prod_a", "prod_b"]
      )
    ).toEqual(blocking)
  })
})
