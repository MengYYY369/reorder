/**
 * Spec: `.agents/specs/2026-10-08-manual-renewal-attempts-and-trial-bind-reuse.md`.
 *
 * The bug this pins down: a claimed trial carries `payment_provider_id: null`
 * on purpose, and `createManualRenewalStep` threw when it saw that — so the
 * first `/renew-now` on a card-free trial always failed, and (because a failed
 * step keeps its own committed writes) left an attempt and an order behind that
 * then blocked every later retry.
 */
import {
  pickChargeableProvider,
  SYSTEM_DEFAULT_PROVIDER_ID,
} from "../region-payment-provider"

describe("pickChargeableProvider", () => {
  it("skips the system default placeholder", () => {
    expect(
      pickChargeableProvider([SYSTEM_DEFAULT_PROVIDER_ID, "pp_paypal_paypal"])
    ).toBe("pp_paypal_paypal")
  })

  it("returns null when only the system default is enabled", () => {
    expect(pickChargeableProvider([SYSTEM_DEFAULT_PROVIDER_ID])).toBeNull()
  })

  it("returns null for an empty list", () => {
    expect(pickChargeableProvider([])).toBeNull()
  })

  it("is deterministic when several real providers are enabled", () => {
    expect(pickChargeableProvider(["pp_paypal_paypal", "pp_epay"])).toBe("pp_epay")
    expect(pickChargeableProvider(["pp_epay", "pp_paypal_paypal"])).toBe("pp_epay")
  })

  it("ignores empty and non-string ids", () => {
    expect(
      pickChargeableProvider([
        "",
        SYSTEM_DEFAULT_PROVIDER_ID,
        // A region relation can hand back a null id; it must not win.
        undefined as unknown as string,
      ])
    ).toBeNull()
  })
})
