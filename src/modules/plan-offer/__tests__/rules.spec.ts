import { mapRules } from "../utils/admin-query"
import {
  normalizeConsentFromSession,
  normalizeMaxStackingCycles,
  normalizeRowStackingPolicy,
  resolvePlanOfferRules,
} from "../utils/rules"
import {
  PLAN_OFFER_RULES_DEFAULTS,
  PlanOfferRowStackingPolicy,
  PlanOfferRules,
  PlanOfferStackingPolicy,
} from "../types"

const BASE_RULES: PlanOfferRules = {
  minimum_cycles: null,
  trial_enabled: false,
  trial_days: null,
  trial_requires_payment_method: false,
  stacking_policy: PlanOfferStackingPolicy.ALLOWED,
}

describe("resolvePlanOfferRules", () => {
  it("applies the pre-v1.6.0 defaults to rows persisted before the keys existed", () => {
    expect(resolvePlanOfferRules(BASE_RULES)).toEqual({
      consent_from_session: null,
      row_stacking_policy: PlanOfferRowStackingPolicy.EXTEND,
      max_stacking_cycles: null,
    })
    expect(resolvePlanOfferRules(null)).toEqual(PLAN_OFFER_RULES_DEFAULTS)
    expect(resolvePlanOfferRules(undefined)).toEqual(PLAN_OFFER_RULES_DEFAULTS)
  })

  it("passes configured values through", () => {
    expect(
      resolvePlanOfferRules({
        ...BASE_RULES,
        consent_from_session: "customer_id",
        row_stacking_policy: PlanOfferRowStackingPolicy.ALLOW_MULTIPLE,
        max_stacking_cycles: 6,
      })
    ).toEqual({
      consent_from_session: "customer_id",
      row_stacking_policy: PlanOfferRowStackingPolicy.ALLOW_MULTIPLE,
      max_stacking_cycles: 6,
    })
  })

  it("treats an explicit null ceiling as unlimited", () => {
    expect(
      resolvePlanOfferRules({ ...BASE_RULES, max_stacking_cycles: null })
        .max_stacking_cycles
    ).toBeNull()
  })
})

describe("mapRules", () => {
  it("carries the three new keys to the Admin read model instead of dropping them", () => {
    const mapped = mapRules({
      ...BASE_RULES,
      consent_from_session: "customer_id",
      row_stacking_policy: PlanOfferRowStackingPolicy.ALLOW_MULTIPLE,
      max_stacking_cycles: 3,
    })

    expect(mapped).toMatchObject({
      consent_from_session: "customer_id",
      row_stacking_policy: "allow_multiple",
      max_stacking_cycles: 3,
    })
  })

  it("shows legacy rows with the defaults rather than empty controls", () => {
    expect(mapRules(BASE_RULES)).toMatchObject({
      consent_from_session: null,
      row_stacking_policy: "extend",
      max_stacking_cycles: null,
    })
  })

  it("keeps an absent rules object absent", () => {
    expect(mapRules(null)).toBeNull()
  })
})

describe("rule field validators", () => {
  it("rejects values outside the enum", () => {
    expect(() => normalizeRowStackingPolicy("stack_em_forever")).toThrow(
      /row_stacking_policy/
    )
    expect(() => normalizeConsentFromSession("email")).toThrow(
      /consent_from_session/
    )
  })

  it("rejects negative or fractional ceilings", () => {
    expect(() => normalizeMaxStackingCycles(-1)).toThrow(
      /max_stacking_cycles/
    )
    expect(() => normalizeMaxStackingCycles(2.5)).toThrow(
      /max_stacking_cycles/
    )
    expect(normalizeMaxStackingCycles(0)).toBe(0)
  })
})
