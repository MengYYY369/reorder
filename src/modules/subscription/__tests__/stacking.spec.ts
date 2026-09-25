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
  resolveStackingDecision,
  withStackedCycles,
  type StackingContainer,
  type StackingSubscriptionRecord,
} from "../utils/stacking"
import { SUBSCRIPTION_MODULE } from ".."
import { PlanOfferRowStackingPolicy } from "../../plan-offer/types"

/**
 * Fixtures are built at the width the module service really returns
 * (`StackingSubscriptionRecord`, i.e. the record type of its `listSubscriptions`),
 * not at the narrower `ExtendableSubscription` the decision consumes. That is
 * the cost of the read naming the service instead of restating itself, and it is
 * a cost worth paying: the fake below can no longer claim a row shape the real
 * read does not have, so a field the stacking decision depends on disappearing
 * from the service is a compile error here too.
 */
const row = (
  overrides: Partial<StackingSubscriptionRecord> = {}
): StackingSubscriptionRecord => ({
  id: "sub_1",
  reference: "SUB-1",
  status: SubscriptionStatus.ACTIVE,
  customer_id: "cus_1",
  cart_id: null,
  product_id: "prod_1",
  variant_id: "var_1",
  frequency_interval: SubscriptionFrequencyInterval.MONTH,
  frequency_value: 1,
  started_at: new Date("2026-01-15T00:00:00.000Z"),
  next_renewal_at: new Date("2026-09-15T00:00:00.000Z"),
  last_renewal_at: null,
  paused_at: null,
  cancelled_at: null,
  cancel_effective_at: null,
  skip_next_cycle: false,
  free_cycles_remaining: 0,
  is_trial: false,
  trial_ends_at: null,
  customer_snapshot: null,
  product_snapshot: { product_id: "prod_1" },
  pricing_snapshot: null,
  shipping_address: {},
  payment_context: null,
  pending_update_data: null,
  metadata: { [STACKING_CYCLES_METADATA_KEY]: 8 },
  created_at: new Date("2026-01-15T00:00:00.000Z"),
  updated_at: new Date("2026-01-15T00:00:00.000Z"),
  deleted_at: null,
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

/**
 * `resolveStackingDecision` is the only stacking unit that reads, so it is the
 * only one needing a container. The value it returns is what the checkout step
 * hands to the consent flip, and the flip decides native-ness on the row's
 * reference alone — which is why naming the row is part of this contract and
 * not something the caller may leave out.
 */
type StackingCall = Parameters<typeof resolveStackingDecision>[1]

const stackingInput = (overrides: Partial<StackingCall> = {}): StackingCall => ({
  customer_id: "cus_1",
  product_id: "prod_1",
  purchased_cycles: 1,
  row_stacking_policy: PlanOfferRowStackingPolicy.EXTEND,
  max_stacking_cycles: null,
  ...overrides,
})

/**
 * The narrowest container the read accepts, with no cast in it.
 *
 * `resolveStackingDecision` is given `StackingContainer`, whose reader is
 * `Pick<SubscriptionModuleService, "listSubscriptions">`, so the fake has to
 * satisfy the real method: `listSubscriptions` by that name, answering with rows
 * built at `StackingSubscriptionRecord` width (see `row` above). Typing the
 * parameter generic instead (`resolve: <T>(key: string) => T`) would need
 * `subscriptionModule as unknown as T` here to satisfy it — an `any` equivalent
 * whose effect was to let the fake claim anything about the real read, which is
 * the same reason the production side dropped its `as never` / `as unknown as`
 * pair.
 *
 * `resolvedKeys` records what the unit was asked to resolve, which is the half
 * the type cannot pin at runtime: the read goes through the shared registration
 * constant, not through a literal of its own.
 */
function makeStackingContainer(rows: StackingSubscriptionRecord[]) {
  const listSubscriptions = jest.fn(async () => rows)
  const resolvedKeys: string[] = []

  return {
    listSubscriptions,
    resolvedKeys,
    container: {
      resolve: (_key: typeof SUBSCRIPTION_MODULE) => {
        resolvedKeys.push(_key)
        return { listSubscriptions }
      },
    },
  }
}

/**
 * What `resolveStackingDecision` may ask its container for.
 *
 * The contract is one registration key wide. Typed the other way round — a
 * `resolve` answering any string with the reader — the unit would hand a
 * subscription-shaped object to a lookup of some other module and the compiler
 * would agree with it, which is the escape the generic `<T>(key: string) => T`
 * had before it.
 */
type ResolvableStackingKey = Parameters<StackingContainer["resolve"]>[0]

describe("resolveStackingDecision", () => {
  it("names the row it folds into, so the caller can test it for native-ness", async () => {
    const { container, listSubscriptions } = makeStackingContainer([
      row({ reference: "SUB-1" }),
    ])

    const decision = await resolveStackingDecision(container, stackingInput())

    expect(decision.extend_subscription_id).toBe("sub_1")
    expect(decision.extend_subscription_reference).toBe("SUB-1")
    // The narrow filter reaches the module exactly as declared: this is what the
    // `as never` used to assert rather than check.
    expect(listSubscriptions).toHaveBeenCalledWith({
      customer_id: "cus_1",
      product_id: "prod_1",
      status: [SubscriptionStatus.ACTIVE],
    })
  })

  it("resolves the subscription module by its registration key, and no other", async () => {
    // The type half of this case is the `@ts-expect-error`: widening
    // `StackingContainer`'s `resolve` key back to `string` does not make the
    // line below run differently, it makes the directive unused, which `tsc`
    // reports as `TS2578`. The runtime half then pins the other direction — the
    // read asks for the shared constant, so a registration rename is a miss the
    // container answers, not a silently-resolved lookup of something else.
    const module_key: ResolvableStackingKey = SUBSCRIPTION_MODULE
    // @ts-expect-error TS2322: another module's key is not one this read may resolve
    const foreign_key: ResolvableStackingKey = "payment"

    const { container, resolvedKeys } = makeStackingContainer([])
    await resolveStackingDecision(container, stackingInput())

    expect([module_key, foreign_key]).toEqual([SUBSCRIPTION_MODULE, "payment"])
    expect(resolvedKeys).toEqual([SUBSCRIPTION_MODULE])
  })

  it("names no row when the only existing one is a provider mirror", async () => {
    const { container } = makeStackingContainer([
      row({ id: "sub_native", reference: "NATIVE-I3SUP1ABCDEF01" }),
    ])

    const decision = await resolveStackingDecision(container, stackingInput())

    // An extend decision and its reference travel together: a decision that
    // folded into a row without naming it is how the flip guard is skipped.
    expect(decision.extend_subscription_id).toBeNull()
    expect(decision.extend_subscription_reference).toBeNull()
  })

  it("surfaces the chosen row's reference, not the mirror beside it", async () => {
    const { container } = makeStackingContainer([
      row({ id: "sub_native", reference: "NATIVE-I3SUP1ABCDEF01" }),
      row({ id: "sub_live", reference: "SUB-2" }),
    ])

    const decision = await resolveStackingDecision(container, stackingInput())

    expect(decision.extend_subscription_id).toBe("sub_live")
    expect(decision.extend_subscription_reference).toBe("SUB-2")
  })

  it("always answers the reference key, so no caller can receive an absent one", async () => {
    // The pair the consent flip is written against: `extend_subscription_id` is
    // null exactly when `extend_subscription_reference` is null, so the value
    // reaching `resolveConsentFlip` is a string naming a row or an explicit null
    // and never the absent key the flip fails closed on.
    const { container } = makeStackingContainer([])

    const decision = await resolveStackingDecision(container, stackingInput())

    expect(
      Object.prototype.hasOwnProperty.call(
        decision,
        "extend_subscription_reference"
      )
    ).toBe(true)
    expect(decision.extend_subscription_reference).toBeNull()
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
