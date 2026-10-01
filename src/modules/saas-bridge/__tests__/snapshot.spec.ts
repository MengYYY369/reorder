import { snapshot } from "../snapshot"
import type { SubscriptionRecord } from "../types"

const BASE: SubscriptionRecord = {
  id: "sub_1",
  reference: "SUB-1",
  status: "active",
  frequency_interval: "month",
  frequency_value: 1,
  next_renewal_at: "2026-11-01T00:00:00.000Z",
  cancel_effective_at: null,
  is_trial: false,
  trial_ends_at: null,
  customer_id: "cus_1",
  payment_context: {
    payment_mode: "manual",
    payment_method_reference: null,
  },
  metadata: { source_order_id: "order_1" },
}

/**
 * The reconcile snapshot is the SaaS's authoritative read of a subscription:
 * every field is camelCase, and a drift here breaks the webhook recovery path.
 * These cases pin the field names and the new trial fields the storefront reads
 * to tell a card-free trial from a paid manual row.
 */
describe("snapshot", () => {
  it("emits the camelCase contract the SaaS reads", () => {
    expect(snapshot(BASE)).toEqual({
      id: "sub_1",
      reference: "SUB-1",
      status: "active",
      frequencyInterval: "month",
      frequencyValue: 1,
      nextRenewalAt: "2026-11-01T00:00:00.000Z",
      cancelEffectiveAt: null,
      isTrial: false,
      trialEndsAt: null,
      paymentMode: "manual",
      hasPaymentMethod: false,
      orderId: "order_1",
    })
  })

  it("reports a trial row's state", () => {
    expect(
      snapshot({
        ...BASE,
        is_trial: true,
        trial_ends_at: "2026-10-08T00:00:00.000Z",
      })
    ).toMatchObject({
      isTrial: true,
      trialEndsAt: "2026-10-08T00:00:00.000Z",
    })
  })

  it("reports a redemption row's cancel boundary", () => {
    expect(
      snapshot({
        ...BASE,
        cancel_effective_at: "2026-12-31T00:00:00.000Z",
      })
    ).toMatchObject({
      cancelEffectiveAt: "2026-12-31T00:00:00.000Z",
      isTrial: false,
      trialEndsAt: null,
    })
  })
})
