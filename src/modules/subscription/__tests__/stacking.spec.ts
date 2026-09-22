import {
  SubscriptionFrequencyInterval,
  SubscriptionStatus,
} from "../types"
import {
  STACKING_CYCLES_METADATA_KEY,
  exceedsStackingCeiling,
  extendSubscriptionRenewalDate,
  readStackedCycles,
  resolveExtendTarget,
  withStackedCycles,
  type ExtendableSubscription,
} from "../utils/stacking"

const row = (overrides: Partial<ExtendableSubscription> = {}): ExtendableSubscription => ({
  id: "sub_1",
  reference: "SUB-1",
  status: SubscriptionStatus.ACTIVE,
  started_at: "2026-01-15T00:00:00.000Z",
  next_renewal_at: "2026-09-15T00:00:00.000Z",
  metadata: { [STACKING_CYCLES_METADATA_KEY]: 8 },
  payment_context: null,
  ...overrides,
})

describe("resolveExtendTarget", () => {
  it("folds a repeat purchase into the existing active row", () => {
    const existing = row()

    expect(resolveExtendTarget([existing], {
      customer_id: "cus_1",
      product_id: "prod_1",
      row_stacking_policy: "extend",
    })).toEqual({ action: "extend", subscription: existing })
  })

  it("skips a native mirror row rather than selling onto it", () => {
    expect(
      resolveExtendTarget(
        [row({ reference: "NATIVE-I-ABC" })],
        { customer_id: "cus_1", product_id: "prod_1", row_stacking_policy: "extend" }
      )
    ).toEqual({ action: "create", subscription: null })
  })

  it("skips rows the customer can no longer extend", () => {
    for (const status of [
      SubscriptionStatus.PAUSED,
      SubscriptionStatus.CANCELLED,
      SubscriptionStatus.PAST_DUE,
    ]) {
      expect(
        resolveExtendTarget([row({ status })], {
          customer_id: "cus_1",
          product_id: "prod_1",
          row_stacking_policy: "extend",
        })
      ).toEqual({ action: "create", subscription: null })
    }
  })

  it("prefers the active row when a customer also has older ones", () => {
    const cancelled = row({ id: "sub_old", status: SubscriptionStatus.CANCELLED })
    const active = row({ id: "sub_live" })

    expect(
      resolveExtendTarget([cancelled, active], {
        customer_id: "cus_1",
        product_id: "prod_1",
        row_stacking_policy: "extend",
      })
    ).toMatchObject({ action: "extend", subscription: { id: "sub_live" } })
  })

  it("bypasses the merge when the offer allows separate rows", () => {
    expect(
      resolveExtendTarget([row()], {
        customer_id: "cus_1",
        product_id: "prod_1",
        row_stacking_policy: "allow_multiple",
      })
    ).toEqual({ action: "create", subscription: null })
  })

  it("creates when there is nothing to extend", () => {
    expect(
      resolveExtendTarget([], {
        customer_id: "cus_1",
        product_id: "prod_1",
        row_stacking_policy: "extend",
      })
    ).toEqual({ action: "create", subscription: null })
  })
})

describe("extendSubscriptionRenewalDate", () => {
  const purchasedAt = new Date("2026-09-20T00:00:00.000Z")

  it("adds the purchased cadence to the current period end, not to today", () => {
    expect(
      extendSubscriptionRenewalDate(
        "2026-09-15T00:00:00.000Z",
        purchasedAt,
        SubscriptionFrequencyInterval.MONTH,
        1
      ).toISOString()
    ).toEqual("2026-10-15T00:00:00.000Z")
  })

  it("carries across a month boundary", () => {
    expect(
      extendSubscriptionRenewalDate(
        "2026-01-31T00:00:00.000Z",
        purchasedAt,
        SubscriptionFrequencyInterval.MONTH,
        2
      ).toISOString()
    ).toEqual("2026-03-31T00:00:00.000Z")
  })

  it("carries across a year boundary", () => {
    expect(
      extendSubscriptionRenewalDate(
        "2026-12-05T00:00:00.000Z",
        purchasedAt,
        SubscriptionFrequencyInterval.MONTH,
        2
      ).toISOString()
    ).toEqual("2027-02-05T00:00:00.000Z")
  })

  it("handles weekly and yearly cadences", () => {
    expect(
      extendSubscriptionRenewalDate(
        "2026-12-28T00:00:00.000Z",
        purchasedAt,
        SubscriptionFrequencyInterval.WEEK,
        1
      ).toISOString()
    ).toEqual("2027-01-04T00:00:00.000Z")

    expect(
      extendSubscriptionRenewalDate(
        "2026-02-28T00:00:00.000Z",
        purchasedAt,
        SubscriptionFrequencyInterval.YEAR,
        1
      ).toISOString()
    ).toEqual("2027-02-28T00:00:00.000Z")
  })

  it("restarts from the purchase date when the row has no known end", () => {
    expect(
      extendSubscriptionRenewalDate(
        null,
        purchasedAt,
        SubscriptionFrequencyInterval.MONTH,
        3
      ).toISOString()
    ).toEqual("2026-12-20T00:00:00.000Z")
  })
})

describe("cycle accounting", () => {
  it("counts an untagged legacy row as one period", () => {
    expect(readStackedCycles(null)).toBe(1)
    expect(readStackedCycles({})).toBe(1)
    expect(readStackedCycles({ cycles_purchased: "abc" })).toBe(1)
  })

  it("reads a recorded count from either representation", () => {
    expect(readStackedCycles({ [STACKING_CYCLES_METADATA_KEY]: 9 })).toBe(9)
    expect(readStackedCycles({ [STACKING_CYCLES_METADATA_KEY]: "9" })).toBe(9)
  })

  it("accumulates without dropping the rest of the metadata", () => {
    expect(
      withStackedCycles({ source: "store_order_placed" }, 12)
    ).toEqual({
      source: "store_order_placed",
      [STACKING_CYCLES_METADATA_KEY]: 12,
    })
  })
})

describe("exceedsStackingCeiling", () => {
  it("treats a null ceiling as unlimited", () => {
    expect(
      exceedsStackingCeiling({
        existing_cycles: 999,
        purchased_cycles: 1,
        max_stacking_cycles: null,
      })
    ).toBe(false)
  })

  it("rejects the purchase that crosses the ceiling, and allows the one that lands on it", () => {
    expect(
      exceedsStackingCeiling({
        existing_cycles: 11,
        purchased_cycles: 1,
        max_stacking_cycles: 12,
      })
    ).toBe(false)

    expect(
      exceedsStackingCeiling({
        existing_cycles: 12,
        purchased_cycles: 1,
        max_stacking_cycles: 12,
      })
    ).toBe(true)
  })
})
