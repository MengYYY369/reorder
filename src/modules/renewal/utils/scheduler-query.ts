import { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import {
  RenewalApprovalStatus,
  RenewalCycleStatus,
} from "../types"
import { SUBSCRIPTION_MODULE } from "../../subscription"
import type SubscriptionModuleService from "../../subscription/service"
import { isNativeSubscriptionReference } from "../../subscription/utils/native-subscription"

export type ListDueRenewalCyclesInput = {
  limit: number
  offset: number
  now?: Date
}

export type DueRenewalCycleRecord = {
  id: string
  subscription_id: string
  scheduled_for: string
  status: RenewalCycleStatus
  approval_required: boolean
  approval_status: RenewalApprovalStatus | null
}

export type DueRenewalCyclesResult = {
  cycles: DueRenewalCycleRecord[]
  count: number
  limit: number
  offset: number
}

const schedulerCycleFields = [
  "id",
  "subscription_id",
  "scheduled_for",
  "status",
  "approval_required",
  "approval_status",
] as const

function isApprovalEligible(record: DueRenewalCycleRecord) {
  if (!record.approval_required) {
    return true
  }

  return record.approval_status === RenewalApprovalStatus.APPROVED
}

export async function listDueRenewalCyclesForProcessing(
  container: MedusaContainer,
  input: ListDueRenewalCyclesInput
): Promise<DueRenewalCyclesResult> {
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const now = input.now ?? new Date()

  const {
    data,
    metadata: { count = 0, take = input.limit, skip = input.offset } = {},
  } = await query.graph({
    entity: "renewal_cycle",
    fields: [...schedulerCycleFields],
    filters: {
      status: [RenewalCycleStatus.SCHEDULED, RenewalCycleStatus.FAILED],
      scheduled_for: {
        $lte: now,
      },
    },
    pagination: {
      take: input.limit,
      skip: input.offset,
      order: {
        scheduled_for: "ASC",
      },
    },
  })

  const cycles = (data as DueRenewalCycleRecord[]).filter(isApprovalEligible)

  const chargeable = await excludeNonChargeableCycles(container, cycles)

  return {
    cycles: chargeable,
    count,
    limit: take,
    offset: skip,
  }
}

/**
 * Two kinds of row must never reach the off-session scheduler:
 *
 * - manual-mode subscriptions, which are renewed through the interactive manual
 *   renewal flow instead
 * - native mirror rows, whose recurrence PayPal charges itself — picking one up
 *   would charge the customer a second time for the same period
 *
 * Their due cycles stay SCHEDULED (so the manual flow can mark them succeeded on
 * payment) and are excluded here to keep the scheduler from charging or failing
 * them.
 *
 * Note: the filter runs after pagination, so a page consisting solely of
 * excluded cycles returns an empty batch until the next offset pass. Volume for
 * manual subscriptions is expected to be small; the manual renewal rework
 * (dedicated cycle lifecycle) supersedes this filter.
 */
async function excludeNonChargeableCycles(
  container: MedusaContainer,
  cycles: DueRenewalCycleRecord[]
): Promise<DueRenewalCycleRecord[]> {
  if (!cycles.length) {
    return cycles
  }

  const subscriptionModule = container.resolve<SubscriptionModuleService>(
    SUBSCRIPTION_MODULE
  )

  const subscriptionIds = Array.from(
    new Set(cycles.map((cycle) => cycle.subscription_id))
  )

  const subscriptions = await subscriptionModule.listSubscriptions({
    id: subscriptionIds,
  })

  const excludedSubscriptionIds = new Set(
    subscriptions
      .filter(
        (subscription) =>
          isNativeSubscriptionReference(subscription.reference) ||
          (subscription.payment_context as
            | { payment_mode?: string }
            | null
            | undefined)?.payment_mode === "manual"
      )
      .map((subscription) => subscription.id)
  )

  if (!excludedSubscriptionIds.size) {
    return cycles
  }

  return cycles.filter((cycle) => !excludedSubscriptionIds.has(cycle.subscription_id))
}

