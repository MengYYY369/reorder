import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { RENEWAL_MODULE } from "../../modules/renewal"
import type RenewalModuleService from "../../modules/renewal/service"
import {
  RenewalApprovalStatus,
  RenewalCycleStatus,
} from "../../modules/renewal/types"
import {
  deriveUpcomingRenewalApprovalState,
  resolveUpcomingCycle,
  restoreForUpcomingCycleReconcile,
  type UpcomingCycleReconcilePatch,
  type UpcomingCycleReconcileRestore,
  type UpcomingRenewalCycleRecord,
  type UpcomingRenewalSubscriptionRecord,
  shouldSubscriptionHaveUpcomingRenewalCycle,
} from "../../modules/renewal/utils/upcoming-cycle"
import { SubscriptionRenewalBehavior } from "../../modules/settings/types"
import { SUBSCRIPTION_MODULE } from "../../modules/subscription"
import type SubscriptionModuleService from "../../modules/subscription/service"
import { getEffectiveSubscriptionSettings } from "../utils/subscription-settings"

export type EnsureNextRenewalCycleStepInput = {
  subscription_id: string
}

type EnsureNextRenewalCycleStepOutput = {
  action: "noop" | "created" | "updated" | "adopted" | "deferred" | "deleted"
  subscription_id: string
  renewal_cycle_id: string | null
}

/**
 * The row state a reconciliation write overwrote. `updated` (an exact-date hit)
 * and `adopted` (the drift repair) are the same write differing only by
 * `scheduled_for`, so both carry the full snapshot: a rollback that restored
 * just part of what the patch touched would leave the approval state or the
 * settings policy of a rolled-back row pointing at the failed run.
 */
type UpcomingCycleReconcileSnapshot = { id: string } & UpcomingCycleReconcileRestore

type EnsureNextRenewalCycleCompensation =
  | {
      action: "created"
      renewal_cycle_id: string
    }
  | {
      action: "updated"
      previous: UpcomingCycleReconcileSnapshot
    }
  | {
      action: "adopted"
      previous: UpcomingCycleReconcileSnapshot
    }
  | {
      action: "deleted"
      previous: Array<{
        id: string
        subscription_id: string
        scheduled_for: Date
        processed_at: Date | null
        status: RenewalCycleStatus
        approval_required: boolean
        approval_status: RenewalApprovalStatus | null
        approval_decided_at: Date | null
        approval_decided_by: string | null
        approval_reason: string | null
        generated_order_id: string | null
        applied_pending_update_data: Record<string, unknown> | null
        last_error: string | null
        attempt_count: number
        metadata: Record<string, unknown> | null
      }>
    }

/**
 * Rollback order for the `deleted` compensation: one row comes back live (the
 * most future, smaller id first on a tie) and every extra is recreated
 * soft-deleted, because `renewal_cycle_one_scheduled_per_subscription` permits
 * a single live `scheduled` row per subscription.
 *
 * That reproduces only the fallback tier of the preference the uniqueness
 * migration applies. The migration keeps the row whose `scheduled_for` already
 * equals `subscription.next_renewal_at` and falls back to the most future one;
 * this compensation receives a snapshot of cycle rows and never reads the
 * subscription, so the entitlement date is not knowable here and cannot be
 * preferred. With a single deleted row (the only shape a new write can produce
 * under that index) the two choices coincide; only legacy drift can make them
 * disagree, and either way the rollback leaves exactly one upcoming cycle.
 * Compensation payloads travel through JSON, so dates may arrive as strings.
 */
function orderCyclesForRestore<
  TRestorable extends { id: string; scheduled_for: Date }
>(cycles: TRestorable[]): TRestorable[] {
  return [...cycles].sort((left, right) => {
    const delta =
      new Date(right.scheduled_for).getTime() -
      new Date(left.scheduled_for).getTime()

    if (delta !== 0) {
      return delta
    }

    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0
  })
}

export const ensureNextRenewalCycleStep = createStep(
  "ensure-next-renewal-cycle",
  async function (
    input: EnsureNextRenewalCycleStepInput,
    { container }
  ) {
    const logger = container.resolve("logger") as {
      warn: (msg: string) => void
    }
    const renewalModule = container.resolve<RenewalModuleService>(RENEWAL_MODULE)
    const subscriptionModule =
      container.resolve<SubscriptionModuleService>(SUBSCRIPTION_MODULE)

    const subscription =
      (await subscriptionModule.retrieveSubscription(
        input.subscription_id
      )) as UpcomingRenewalSubscriptionRecord

    const existingCycles = (await renewalModule.listRenewalCycles({
      subscription_id: subscription.id,
    } as any)) as UpcomingRenewalCycleRecord[]

    if (!shouldSubscriptionHaveUpcomingRenewalCycle(subscription)) {
      const scheduledCycles = existingCycles.filter(
        (cycle) => cycle.status === RenewalCycleStatus.SCHEDULED
      )

      if (scheduledCycles.length) {
        await renewalModule.deleteRenewalCycles(
          scheduledCycles.map((cycle) => cycle.id)
        )

        return new StepResponse<
          EnsureNextRenewalCycleStepOutput,
          EnsureNextRenewalCycleCompensation
        >(
          {
            action: "deleted",
            subscription_id: subscription.id,
            renewal_cycle_id: null,
          },
          {
            action: "deleted",
            previous: scheduledCycles.map((cycle) => ({
              id: cycle.id,
              subscription_id: cycle.subscription_id,
              scheduled_for: cycle.scheduled_for,
              processed_at: cycle.processed_at,
              status: cycle.status,
              approval_required: cycle.approval_required,
              approval_status: cycle.approval_status,
              approval_decided_at: cycle.approval_decided_at,
              approval_decided_by: cycle.approval_decided_by,
              approval_reason: cycle.approval_reason,
              generated_order_id: cycle.generated_order_id,
              applied_pending_update_data: cycle.applied_pending_update_data,
              last_error: cycle.last_error,
              attempt_count: cycle.attempt_count,
              metadata: cycle.metadata,
            })),
          }
        )
      }

      return new StepResponse<
        EnsureNextRenewalCycleStepOutput,
        EnsureNextRenewalCycleCompensation
      >(
        {
          action: "noop",
          subscription_id: subscription.id,
          renewal_cycle_id: null,
        }
      )
    }

    const scheduledFor = subscription.next_renewal_at!
    const settings = await getEffectiveSubscriptionSettings(container)
    const resolution = resolveUpcomingCycle(existingCycles, scheduledFor)

    if (resolution.action === "defer") {
      const deferred = resolution.cycle

      logger.warn(
        `[reorder] left upcoming renewal cycle '${deferred.id}' of subscription '${subscription.id}' untouched: status '${deferred.status}' carries renewal order '${
          deferred.generated_order_id ?? "none"
        }' in flight while the entitlement date is '${scheduledFor.toISOString()}'`
      )

      return new StepResponse<
        EnsureNextRenewalCycleStepOutput,
        EnsureNextRenewalCycleCompensation
      >(
        {
          action: "deferred",
          subscription_id: subscription.id,
          renewal_cycle_id: deferred.id,
        }
      )
    }

    if (resolution.action === "create") {
      const createTimeBehavior = settings.is_persisted
        ? settings.default_renewal_behavior
        : SubscriptionRenewalBehavior.REQUIRE_REVIEW_FOR_PENDING_CHANGES

      const approvalState = deriveUpcomingRenewalApprovalState(
        subscription,
        scheduledFor,
        createTimeBehavior
      )
      const created = await renewalModule.createRenewalCycles({
        subscription_id: subscription.id,
        scheduled_for: scheduledFor,
        status: RenewalCycleStatus.SCHEDULED,
        metadata: {
          settings_policy: {
            default_renewal_behavior: createTimeBehavior,
            settings_version: settings.version,
            is_persisted: settings.is_persisted,
          },
        },
        ...approvalState,
      } as any)

      return new StepResponse<
        EnsureNextRenewalCycleStepOutput,
        EnsureNextRenewalCycleCompensation
      >(
        {
          action: "created",
          subscription_id: subscription.id,
          renewal_cycle_id: created.id,
        },
        {
          action: "created",
          renewal_cycle_id: created.id,
        }
      )
    }

    const existingCycle = resolution.cycle
    /**
     * `adopt` is the drift repair: the row a stacked purchase left behind keeps
     * its id, its `renewal_attempt` children and its `generated_order_id`
     * history, and only follows the entitlement date.
     */
    const adopting = resolution.action === "adopt"

    const existingBehavior =
      (
        existingCycle.metadata?.settings_policy as
          | {
              default_renewal_behavior?: SubscriptionRenewalBehavior
            }
          | undefined
      )?.default_renewal_behavior ??
      (settings.is_persisted
        ? settings.default_renewal_behavior
        : SubscriptionRenewalBehavior.REQUIRE_REVIEW_FOR_PENDING_CHANGES)

    const approvalState = deriveUpcomingRenewalApprovalState(
      subscription,
      scheduledFor,
      existingBehavior
    )

    if (
      existingCycle.status === RenewalCycleStatus.PROCESSING ||
      existingCycle.status === RenewalCycleStatus.SUCCEEDED
    ) {
      return new StepResponse<
        EnsureNextRenewalCycleStepOutput,
        EnsureNextRenewalCycleCompensation
      >(
        {
          action: "noop",
          subscription_id: subscription.id,
          renewal_cycle_id: existingCycle.id,
        }
      )
    }

    if (
      !adopting &&
      existingCycle.approval_required === approvalState.approval_required &&
      existingCycle.approval_status === approvalState.approval_status &&
      existingCycle.approval_decided_at === approvalState.approval_decided_at &&
      existingCycle.approval_decided_by === approvalState.approval_decided_by &&
      existingCycle.approval_reason === approvalState.approval_reason
    ) {
      return new StepResponse<
        EnsureNextRenewalCycleStepOutput,
        EnsureNextRenewalCycleCompensation
      >(
        {
          action: "noop",
          subscription_id: subscription.id,
          renewal_cycle_id: existingCycle.id,
        }
      )
    }

    /**
     * One object describes the whole write, and the compensation below is the
     * same object's mirror: whatever lands here is rolled back by the same
     * statement that applied it.
     */
    const reconcile: UpcomingCycleReconcilePatch = {
      ...(adopting ? { scheduled_for: scheduledFor } : {}),
      ...approvalState,
      metadata: {
        ...(existingCycle.metadata ?? {}),
        settings_policy: {
          default_renewal_behavior: existingBehavior,
          settings_version:
            (
              existingCycle.metadata?.settings_policy as
                | {
                    settings_version?: number
                  }
                | undefined
            )?.settings_version ?? settings.version,
          is_persisted:
            (
              existingCycle.metadata?.settings_policy as
                | {
                    is_persisted?: boolean
                  }
                | undefined
            )?.is_persisted ?? settings.is_persisted,
        },
      },
    }

    const updated = await renewalModule.updateRenewalCycles({
      id: existingCycle.id,
      ...reconcile,
    })

    if (adopting) {
      return new StepResponse<
        EnsureNextRenewalCycleStepOutput,
        EnsureNextRenewalCycleCompensation
      >(
        {
          action: "adopted",
          subscription_id: subscription.id,
          renewal_cycle_id: updated.id,
        },
        {
          action: "adopted",
          previous: {
            id: existingCycle.id,
            ...restoreForUpcomingCycleReconcile(existingCycle),
          },
        }
      )
    }

    return new StepResponse<
      EnsureNextRenewalCycleStepOutput,
      EnsureNextRenewalCycleCompensation
    >(
      {
        action: "updated",
        subscription_id: subscription.id,
        renewal_cycle_id: updated.id,
      },
      {
        action: "updated",
        previous: {
          id: existingCycle.id,
          ...restoreForUpcomingCycleReconcile(existingCycle),
        },
      }
    )
  },
  async function (
    compensation: EnsureNextRenewalCycleCompensation,
    { container }
  ) {
    if (!compensation) {
      return
    }

    const renewalModule = container.resolve<RenewalModuleService>(RENEWAL_MODULE)

    if (compensation.action === "created") {
      await renewalModule.deleteRenewalCycles(compensation.renewal_cycle_id)
      return
    }

    if (compensation.action === "adopted") {
      await renewalModule.updateRenewalCycles(compensation.previous)
      return
    }

    if (compensation.action === "deleted") {
      const restore = orderCyclesForRestore(compensation.previous)
      const [keeper, ...extras] = restore

      /**
       * Exactly one row may come back live. Drift can have handed this step
       * several `scheduled` rows to delete, and recreating them all as live
       * rows would break `renewal_cycle_one_scheduled_per_subscription` on the
       * second insert, leaving the rollback half-applied with a duplicate
       * upcoming cycle on the subscription it was meant to repair. Extras are
       * soft-deleted again right after they are inserted (never marked
       * `failed`, which `scheduler-query.ts` would re-arm), so at no point do
       * two live `scheduled` rows exist for the same subscription.
       */
      for (const cycle of extras) {
        await renewalModule.createRenewalCycles(cycle)
        await renewalModule.softDeleteRenewalCycles([cycle.id])
      }

      if (keeper) {
        await renewalModule.createRenewalCycles(keeper)
      }

      return
    }

    await renewalModule.updateRenewalCycles(compensation.previous)
  }
)
