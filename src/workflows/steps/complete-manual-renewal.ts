import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { RENEWAL_MODULE } from "../../modules/renewal"
import type RenewalModuleService from "../../modules/renewal/service"
import {
  RenewalAttemptStatus,
  RenewalCycleStatus,
} from "../../modules/renewal/types"
import { renewalErrors } from "../../modules/renewal/utils/errors"
import { SUBSCRIPTION_MODULE } from "../../modules/subscription"
import type SubscriptionModuleService from "../../modules/subscription/service"
import { SubscriptionStatus } from "../../modules/subscription/types"

export type CompleteManualRenewalStepInput = {
  renewal_order_id: string
}

export type CompleteManualRenewalStepOutput = {
  subscription_id: string
  renewal_cycle_id: string
  next_renewal_at: string
}

type OrderMetadataRecord = {
  id: string
  metadata: {
    renewal_cycle_id?: string
    subscription_id?: string
  } | null
}

type CycleRecord = {
  id: string
  subscription_id: string
  scheduled_for: string | Date
  status: RenewalCycleStatus
}

type SubscriptionRecord = {
  id: string
  status: SubscriptionStatus
  frequency_interval: "week" | "month" | "year"
  frequency_value: number
  next_renewal_at: Date | null
  skip_next_cycle: boolean
  product_snapshot: Record<string, unknown> | null
  pending_update_data: Record<string, unknown> | null
}

/**
 * Finalizes a manual renewal after the customer actually paid: marks the
 * renewal cycle succeeded, advances the subscription cadence, and creates the
 * next cycle row. Anchor is `max(now, scheduled_for)` — renewing early keeps
 * the original billing anchor (no lost days, D20), renewing after expiry
 * starts a fresh period from the payment date.
 *
 * Invoked by the payment.captured subscriber (and safe to call manually by
 * an admin flow); idempotent via the cycle SUCCEEDED check.
 */
export const completeManualRenewalStep = createStep(
  "complete-manual-renewal",
  async function (
    input: CompleteManualRenewalStepInput,
    { container }
  ) {
    const renewalModule =
      container.resolve<RenewalModuleService>(RENEWAL_MODULE)
    const subscriptionModule =
      container.resolve<SubscriptionModuleService>(SUBSCRIPTION_MODULE)

    const metadata = await loadOrderMetadata(container, input.renewal_order_id)

    if (!metadata?.renewal_cycle_id || !metadata?.subscription_id) {
      throw renewalErrors.invalidData(
        `Order '${input.renewal_order_id}' is not a renewal order (missing renewal metadata)`
      )
    }

    const cycle = await loadCycle(container, metadata.renewal_cycle_id)

    if (cycle.status === RenewalCycleStatus.SUCCEEDED) {
      const existing = await loadSubscription(
        container,
        metadata.subscription_id
      )

      return new StepResponse<
        CompleteManualRenewalStepOutput,
        string | null
      >(
        {
          subscription_id: metadata.subscription_id,
          renewal_cycle_id: cycle.id,
          next_renewal_at: existing.next_renewal_at?.toISOString() ?? "",
        },
        null
      )
    }

    const subscription = await loadSubscription(
      container,
      metadata.subscription_id
    )

    const finishedAt = new Date()
    const anchorRaw = new Date(cycle.scheduled_for)
    const anchor = anchorRaw > finishedAt ? anchorRaw : finishedAt

    // Pending frequency changes (change-frequency flow) apply on renewal.
    const pendingUpdate =
      (subscription.pending_update_data as {
        frequency_interval?: "week" | "month" | "year"
        frequency_value?: number
        variant_id?: string
        variant_title?: string
        sku?: string | null
      } | null) ?? null

    const nextInterval =
      pendingUpdate?.frequency_interval ?? subscription.frequency_interval
    const nextValue = pendingUpdate?.frequency_value ?? subscription.frequency_value
    const nextRenewalAt = addCadence(anchor, nextInterval, nextValue)

    const nextProductSnapshot = pendingUpdate
      ? {
          ...(subscription.product_snapshot ?? {}),
          variant_id: pendingUpdate.variant_id,
          variant_title: pendingUpdate.variant_title,
          sku: pendingUpdate.sku ?? null,
        }
      : undefined

    const updatePayload: Record<string, unknown> = {
      id: subscription.id,
      frequency_interval: nextInterval,
      frequency_value: nextValue,
      next_renewal_at: nextRenewalAt,
      last_renewal_at: finishedAt,
      skip_next_cycle: false,
      pending_update_data: pendingUpdate ? null : subscription.pending_update_data,
    }

    if (nextProductSnapshot) {
      updatePayload.product_snapshot = nextProductSnapshot
      updatePayload.variant_id = pendingUpdate?.variant_id
    }

    if (subscription.status === SubscriptionStatus.PAST_DUE) {
      updatePayload.status = SubscriptionStatus.ACTIVE
    }

    await subscriptionModule.updateSubscriptions(updatePayload as never)

    await renewalModule.updateRenewalCycles({
      id: cycle.id,
      status: RenewalCycleStatus.SUCCEEDED,
      processed_at: finishedAt,
      last_error: null,
    } as never)

    // Ensure the next period has a cycle row; the scheduler skips manual
    // subscriptions, so this is the only place the chain advances.
    await renewalModule.createRenewalCycles({
      subscription_id: subscription.id,
      scheduled_for: nextRenewalAt,
      status: RenewalCycleStatus.SCHEDULED,
      approval_required: false,
      approval_status: null,
      processed_at: null,
      generated_order_id: null,
      applied_pending_update_data: null,
      last_error: null,
      attempt_count: 0,
      metadata: { trigger_type: "manual", created_by: "complete-manual-renewal" },
    } as never)

    return new StepResponse<
      CompleteManualRenewalStepOutput,
      string | null
    >(
      {
        subscription_id: subscription.id,
        renewal_cycle_id: cycle.id,
        next_renewal_at: nextRenewalAt.toISOString(),
      },
      input.renewal_order_id
    )
  },
  // Compensation: revert the cycle to PROCESSING and drop the pre-created
  // next cycle (by subscription+scheduled_for match) so retries stay possible.
  async function (orderId, { container }) {
    if (!orderId) {
      return
    }
    // Cycle status reverts are intentionally not automated: the captured
    // payment is authoritative and idempotent reruns short-circuit on
    // SUCCEEDED. Leave state as-is.
  }
)

async function loadOrderMetadata(
  container: { resolve(key: string): unknown },
  orderId: string
): Promise<OrderMetadataRecord["metadata"]> {
  const query = container.resolve(ContainerRegistrationKeys.QUERY) as {
    graph: (config: Record<string, unknown>) => Promise<{
      data: OrderMetadataRecord[]
    }>
  }

  const { data } = await query.graph({
    entity: "order",
    fields: ["id", "metadata"],
    filters: { id: [orderId] },
  })

  return data[0]?.metadata ?? null
}

async function loadCycle(
  container: { resolve(key: string): unknown },
  cycleId: string
): Promise<CycleRecord> {
  const query = container.resolve(ContainerRegistrationKeys.QUERY) as {
    graph: (config: Record<string, unknown>) => Promise<{ data: CycleRecord[] }>
  }

  const { data } = await query.graph({
    entity: "renewal_cycle",
    fields: ["id", "subscription_id", "scheduled_for", "status"],
    filters: { id: [cycleId] },
  })

  const cycle = data[0]

  if (!cycle) {
    throw renewalErrors.notFound("RenewalCycle", cycleId)
  }

  return cycle
}

async function loadSubscription(
  container: { resolve<T>(key: string): T },
  subscriptionId: string
): Promise<SubscriptionRecord> {
  const subscriptionModule =
    container.resolve<SubscriptionModuleService>(SUBSCRIPTION_MODULE)

  const subscriptions = await subscriptionModule.listSubscriptions({
    id: [subscriptionId],
  })

  const subscription = subscriptions[0] as unknown as
    | SubscriptionRecord
    | undefined

  if (!subscription) {
    throw renewalErrors.notFound("Subscription", subscriptionId)
  }

  return subscription
}

function addCadence(
  date: Date,
  interval: "week" | "month" | "year",
  value: number
): Date {
  const next = new Date(date)

  switch (interval) {
    case "week":
      next.setUTCDate(next.getUTCDate() + value * 7)
      return next
    case "month":
      next.setUTCMonth(next.getUTCMonth() + value)
      return next
    case "year":
      next.setUTCFullYear(next.getUTCFullYear() + value)
      return next
  }
}
