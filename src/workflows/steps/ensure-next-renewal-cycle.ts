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

type EnsureNextRenewalCycleDeletedSnapshot = Extract<
  EnsureNextRenewalCycleCompensation,
  { action: "deleted" }
>["previous"][number]

/**
 * The two writes a `deleted` rollback performs, narrowed to exactly what it
 * calls so its ordering rule is reachable from a test without a workflow engine.
 *
 * It is the one place a rollback could leave two live chargeable cycles behind,
 * and it can no longer be driven through a real run: the uniqueness index means
 * the step is only ever handed one live `scheduled` row to delete. A database
 * whose index was lost is the shape this covers, and it is the shape its spec
 * drives directly.
 */
export type RenewalCycleRestoreWriter = {
  createRenewalCycles: (
    data: EnsureNextRenewalCycleDeletedSnapshot[]
  ) => Promise<unknown>
  softDeleteRenewalCycles: (ids: string[]) => Promise<unknown>
}

/**
 * Restore the rows the step deleted, keeping the invariant true at every instant
 * rather than only at the end: extras are inserted and immediately soft-deleted,
 * sequentially, and the keeper — the most future row, smaller id first on a tie
 * (`orderCyclesForRestore`) — is recreated live last. Extras are never marked
 * `failed`, which `scheduler-query.ts` selects alongside `scheduled` and would
 * therefore re-arm for a charge.
 */
export async function restoreDeletedUpcomingCycles(
  writer: RenewalCycleRestoreWriter,
  deleted: RestoreableRenewalCycle[]
): Promise<void> {
  const [keeper, ...extras] = orderCyclesForRestore(deleted)

  for (const cycle of extras) {
    await writer.createRenewalCycles([toRestoreWrite(cycle)])
    await writer.softDeleteRenewalCycles([cycle.id])
  }

  if (keeper) {
    await writer.createRenewalCycles([toRestoreWrite(keeper)])
  }
}

/**
 * Which row the `deleted` compensation keeps live: the most future, smaller id
 * first on a tie.
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
  TRestorable extends { id: string; scheduled_for: Date | string }
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

/** A deleted-row snapshot as the rollback receives it: dates may be JSON. */
export type RestoreableRenewalCycle = Omit<
  EnsureNextRenewalCycleDeletedSnapshot,
  "scheduled_for"
> & {
  scheduled_for: Date | string
}

/**
 * A row as it is written back. `scheduled_for` is rebuilt as a `Date` because a
 * compensation that round-tripped the engine carries an ISO string, and leaving
 * that to the ORM to reinterpret would make the restored row's type depend on
 * whether a rollback happened to run through serialization.
 */
function toRestoreWrite(
  cycle: RestoreableRenewalCycle
): EnsureNextRenewalCycleDeletedSnapshot {
  return { ...cycle, scheduled_for: new Date(cycle.scheduled_for) }
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
    } as Record<string, unknown>)) as UpcomingRenewalCycleRecord[]

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
      await restoreDeletedUpcomingCycles(renewalModule, compensation.previous)
      return
    }

    await renewalModule.updateRenewalCycles(compensation.previous)
  }
)
