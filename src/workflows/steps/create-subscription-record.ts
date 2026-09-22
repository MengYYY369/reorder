import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { SUBSCRIPTION_MODULE } from "../../modules/subscription"
import type SubscriptionModuleService from "../../modules/subscription/service"
import type {
  SubscriptionFrequencyInterval,
  SubscriptionPaymentContext,
  SubscriptionPaymentMechanism,
  SubscriptionPaymentMode,
  SubscriptionPricingSnapshot,
  SubscriptionProductSnapshot,
  SubscriptionShippingAddress,
} from "../../modules/subscription/types"
import { SubscriptionStatus } from "../../modules/subscription/types"
import { subscriptionErrors } from "../../modules/subscription/utils/errors"
import {
  extendSubscriptionRenewalDate,
  withStackedCycles,
} from "../../modules/subscription/utils/stacking"

export type CreateSubscriptionRecordStepInput = {
  customer_id: string
  cart_id: string
  order_id: string
  order_display_id: string | number | null
  started_at: string
  frequency_interval: SubscriptionFrequencyInterval
  frequency_value: number
  customer_snapshot: {
    email: string
    full_name: string | null
  }
  product_snapshot: SubscriptionProductSnapshot
  pricing_snapshot: SubscriptionPricingSnapshot | null
  shipping_address: SubscriptionShippingAddress
  payment_context: SubscriptionPaymentContext
  is_trial: boolean
  trial_ends_at: string | null
  next_renewal_at: string | null
  /**
   * Value stored in subscription metadata.source. Defaults to
   * "store_cart_subscribe" (upstream checkout flow); the order-driven flow
   * passes "store_order_placed".
   */
  metadata_source?: string
  /**
   * When set, this purchase folds into that existing row instead of creating a
   * second one (resolved by `resolveStackingDecision` during cart validation).
   */
  extend_subscription_id?: string | null
  /** Accumulated cycles after this purchase, written to metadata. */
  total_cycles?: number
  /**
   * Consent proven by this checkout, to be applied to the row being extended.
   * Merged into that row's stored context rather than replacing it, so the
   * method reference collected earlier survives.
   */
  consent_flip?: {
    payment_mode: SubscriptionPaymentMode
    mechanism: SubscriptionPaymentMechanism
  } | null
}

type CreatedSubscriptionRecord = {
  id: string
  extended: boolean
}

type ExtendCompensation = {
  id: string
  previous: {
    next_renewal_at: Date | null
    metadata: Record<string, unknown> | null
    payment_context: Record<string, unknown> | null
  }
}

export const createSubscriptionRecordStep = createStep(
  "create-subscription-record",
  async function (
    input: CreateSubscriptionRecordStepInput,
    { container }
  ) {
    const subscriptionModule =
      container.resolve<SubscriptionModuleService>(SUBSCRIPTION_MODULE)

    const metadata = withStackedCycles(
      {
        source: input.metadata_source ?? "store_cart_subscribe",
        source_order_id: input.order_id,
      },
      input.total_cycles ?? input.frequency_value
    )

    if (input.extend_subscription_id) {
      return await extendSubscriptionRecord(
        subscriptionModule,
        input,
        metadata
      )
    }

    const created = await subscriptionModule.createSubscriptions({
      reference: buildSubscriptionReference(input.order_display_id, input.order_id),
      status: SubscriptionStatus.ACTIVE,
      customer_id: input.customer_id,
      cart_id: input.cart_id,
      product_id: input.product_snapshot.product_id,
      variant_id: input.product_snapshot.variant_id,
      frequency_interval: input.frequency_interval,
      frequency_value: input.frequency_value,
      started_at: new Date(input.started_at),
      next_renewal_at: input.next_renewal_at
        ? new Date(input.next_renewal_at)
        : null,
      last_renewal_at: null,
      paused_at: null,
      cancelled_at: null,
      cancel_effective_at: null,
      skip_next_cycle: false,
      is_trial: input.is_trial,
      trial_ends_at: input.trial_ends_at ? new Date(input.trial_ends_at) : null,
      customer_snapshot: input.customer_snapshot,
      product_snapshot: input.product_snapshot,
      pricing_snapshot: input.pricing_snapshot,
      shipping_address: input.shipping_address,
      payment_context: input.payment_context,
      pending_update_data: null,
      metadata,
    } as any)

    return new StepResponse<CreatedSubscriptionRecord, string>(
      {
        id: created.id,
        extended: false,
      },
      created.id
    )
  },
  async function (
    compensation: string | ExtendCompensation,
    { container }
  ) {
    if (!compensation) {
      return
    }

    const subscriptionModule =
      container.resolve<SubscriptionModuleService>(SUBSCRIPTION_MODULE)

    if (typeof compensation === "string") {
      await subscriptionModule.deleteSubscriptions([compensation])

      return
    }

    // An extension must roll back to the previous period end; deleting the row
    // would erase a subscription the customer already paid for.
    await subscriptionModule.updateSubscriptions({
      id: compensation.id,
      next_renewal_at: compensation.previous.next_renewal_at,
      metadata: compensation.previous.metadata,
      payment_context: compensation.previous.payment_context,
    } as never)
  }
)

async function extendSubscriptionRecord(
  subscriptionModule: SubscriptionModuleService,
  input: CreateSubscriptionRecordStepInput,
  metadata: Record<string, unknown>
) {
  const existing = (await subscriptionModule.listSubscriptions({
    id: [input.extend_subscription_id!],
  } as never)) as unknown as Array<{
    id: string
    next_renewal_at: Date | null
    metadata: Record<string, unknown> | null
    payment_context: Record<string, unknown> | null
  }>

  const target = existing[0]

  if (!target) {
    throw subscriptionErrors.notFound(
      "Subscription",
      input.extend_subscription_id!
    )
  }

  const previousPaymentContext = target.payment_context ?? null
  const paymentContext = input.consent_flip
    ? {
        ...previousPaymentContext,
        payment_mode: input.consent_flip.payment_mode,
        mechanism: input.consent_flip.mechanism,
      }
    : undefined

  const purchasedAt = new Date(input.started_at)
  const nextRenewalAt = extendSubscriptionRenewalDate(
    target.next_renewal_at,
    purchasedAt,
    input.frequency_interval,
    input.frequency_value
  )

  await subscriptionModule.updateSubscriptions({
    id: target.id,
    next_renewal_at: nextRenewalAt,
    // The new purchase may use a different variant of the same product; the row
    // keeps charging at the cadence just bought, and its snapshots follow it.
    frequency_interval: input.frequency_interval,
    frequency_value: input.frequency_value,
    variant_id: input.product_snapshot.variant_id,
    product_snapshot: input.product_snapshot,
    pricing_snapshot: input.pricing_snapshot,
    metadata,
    ...(paymentContext ? { payment_context: paymentContext } : {}),
  } as never)

  return new StepResponse<
    CreatedSubscriptionRecord,
    ExtendCompensation
  >(
    { id: target.id, extended: true },
    {
      id: target.id,
      previous: {
        next_renewal_at: target.next_renewal_at ?? null,
        metadata: target.metadata ?? null,
        payment_context: previousPaymentContext,
      },
    }
  )
}

function buildSubscriptionReference(
  orderDisplayId: string | number | null,
  orderId: string
) {
  if (orderDisplayId !== null && orderDisplayId !== undefined) {
    return `SUB-${String(orderDisplayId)}`
  }

  return `SUB-${orderId}`
}
