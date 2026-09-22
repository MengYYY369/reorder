import {
  serializeStoreSubscriptionListItem,
  type StoreSubscriptionListItemSource,
} from "../utils/store-list-serialization"

const NEXT_RENEWAL = "2026-10-01T00:00:00.000Z"

const BASE: StoreSubscriptionListItemSource = {
  id: "sub_1",
  reference: "SUB-1",
  status: "active",
  created_at: "2026-09-01T00:00:00.000Z",
  next_renewal_at: NEXT_RENEWAL,
  frequency_interval: "month",
  frequency_value: 1,
  skip_next_cycle: false,
  product_snapshot: { product_title: "Coffee Club", variant_title: "Monthly" },
  payment_context: null,
}

describe("serializeStoreSubscriptionListItem", () => {
  it("exposes the cadence and payment fields the benefit card needs", () => {
    const item = serializeStoreSubscriptionListItem(
      {
        ...BASE,
        payment_context: {
          payment_mode: "auto",
          payment_method_reference: "pm_123",
        },
      },
      null
    )

    expect(item).toMatchObject({
      frequency_interval: "month",
      frequency_value: 1,
      payment_mode: "auto",
      has_payment_method: true,
      next_renewal_at: NEXT_RENEWAL,
    })
  })

  it("reports no payment method when the reference is null or blank", () => {
    expect(
      serializeStoreSubscriptionListItem(
        { ...BASE, payment_context: { payment_method_reference: null } },
        null
      ).has_payment_method
    ).toBe(false)

    expect(
      serializeStoreSubscriptionListItem(
        { ...BASE, payment_context: { payment_mode: "manual" } },
        null
      )
    ).toMatchObject({ payment_mode: "manual", has_payment_method: false })
  })

  it("keeps a null payment context as a null mode rather than inventing auto", () => {
    const item = serializeStoreSubscriptionListItem(BASE, null)

    expect(item.payment_mode).toBeNull()
    expect(item.has_payment_method).toBe(false)
  })

  it("keeps effective_next_renewal_at ahead of the raw column when a cycle is skipped", () => {
    const skipped = serializeStoreSubscriptionListItem(
      { ...BASE, skip_next_cycle: true },
      null
    )
    const plain = serializeStoreSubscriptionListItem(BASE, null)

    expect(new Date(skipped.effective_next_renewal_at!).getTime()).toBeGreaterThan(
      new Date(plain.effective_next_renewal_at!).getTime()
    )
  })

  it("carries the active cancellation case through unchanged", () => {
    expect(
      serializeStoreSubscriptionListItem(
        BASE,
        { id: "cancel_1", status: "retention_offered" }
      ).active_cancellation_case
    ).toEqual({ id: "cancel_1", status: "retention_offered" })

    expect(
      serializeStoreSubscriptionListItem(BASE, null).active_cancellation_case
    ).toBeNull()
  })
})
