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

/**
 * What a run did, as the workflow reports it.
 *
 * `retired` is the one case where the retire set was the run's only write: a
 * `match` that held a terminal row on the entitlement date while a live
 * `scheduled` neighbour sat behind it, cleared and reported as nothing-happened
 * before Task 15 named the neighbour. `deferred` keeps its own action when it
 * retires as well, because the promise that branch makes is about the protected
 * row it refuses to write, and the retirement it does make is on the log.
 */
export type EnsureNextRenewalCycleStepOutput = {
  action:
    | "noop"
    | "created"
    | "updated"
    | "adopted"
    | "deferred"
    | "deleted"
    | "retired"
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
export type UpcomingCycleReconcileSnapshot = {
  id: string
} & UpcomingCycleReconcileRestore

/**
 * The one write a reconciliation rollback performs, narrowed to exactly what it
 * calls, so the field set the `updated` / `adopted` compensation restores is
 * assertable from a module spec without a workflow engine — the same extraction
 * `deleted`'s ordering rule already got (`RenewalCycleRestoreWriter`). Inline in
 * the compensation handler it was reachable only by driving a failing workflow,
 * which no gate does.
 */
export type ReconcileRestoreWriter = {
  updateRenewalCycles: (
    data: UpcomingCycleReconcileSnapshot
  ) => Promise<unknown>
}

/**
 * Roll a reconciliation write back: one statement putting every column the patch
 * touched — and, for an `adopt`, moved — back to the value the snapshot recorded
 * before the write happened.
 */
export async function restoreReconciledCycle(
  writer: ReconcileRestoreWriter,
  previous: UpcomingCycleReconcileSnapshot
): Promise<void> {
  await writer.updateRenewalCycles(previous)
}

/**
 * The one write a retire performs, narrowed to what it calls so the effect is
 * assertable from a module spec instead of only from a driven workflow.
 */
export type UpcomingCycleRetireWriter = {
  softDeleteRenewalCycles: (ids: string[]) => Promise<unknown>
}

/**
 * Act on the rows `resolveUpcomingCycle` named.
 *
 * The selector reports the live `scheduled` rows a decision neither moves nor
 * deletes, and reporting a clean resolution while leaving one of those behind is
 * the leak: the scheduler's `query.graph` select hands it every `scheduled` row
 * whose `deleted_at` is null, so the neighbour is charged on its own date. The
 * protection the naming implies has to be a write, and this is it — the same
 * soft delete the step already performs on rows a subscription no longer needs,
 * so the row keeps its history and its `renewal_attempt` children (the model
 * declares no soft-remove cascade, so retiring cannot orphan them) while the
 * one-live-cycle index and the scheduler both stop seeing it.
 *
 * `madeRoomFor` names the row the run kept or moved, so the warning records both
 * sides of the decision: what went, and what it went for.
 */
export async function retireStaleUpcomingCycles(
  writer: UpcomingCycleRetireWriter,
  subscriptionId: string,
  retired: UpcomingRenewalCycleRecord[],
  logger: { warn: (message: string) => void },
  madeRoomFor: string
): Promise<void> {
  if (!retired.length) {
    return
  }

  const ids = retired.map((row) => row.id)

  await writer.softDeleteRenewalCycles(ids)

  logger.warn(
    `[reorder] retired ${retired.length} stale upcoming renewal cycle(s) of ` +
      `subscription '${subscriptionId}' (${ids.join(", ")}) behind '${madeRoomFor}'`
  )
}

/**
 * The rollback of a retire. Narrowed to `restoreRenewalCycles` on purpose: this
 * is NOT `restoreDeletedUpcomingCycles`, which re-inserts rows by id and is right
 * only because the `deleted` branch hard-deletes. A soft-deleted row is still in
 * the table, so re-inserting it fails on `renewal_cycle_pkey`, and a writer type
 * without `createRenewalCycles` makes that confusion unrepresentable.
 */
export type RetiredCycleRestoreWriter = {
  restoreRenewalCycles: (ids: string[]) => Promise<unknown>
}

export async function restoreRetiredUpcomingCycles(
  writer: RetiredCycleRestoreWriter,
  retiredIds: string[]
): Promise<void> {
  if (!retiredIds.length) {
    return
  }

  await writer.restoreRenewalCycles(retiredIds)
}

/**
 * The `defer` report, with its retire already acted on.
 *
 * The branch is one call so that a module spec can pin what it promises: the
 * protected row is reported untouched and stays the run's `renewal_cycle_id`, the
 * rows the selector named are the only write the run makes, and they travel to
 * the compensation as a `retired` rollback because there is no snapshot of a
 * write to undo. Inlined in the branch, none of that was reachable without a
 * workflow container — and the branch losing the retirement again is the exact
 * regression this task was opened for.
 */
export async function retireAndDefer(
  writer: UpcomingCycleRetireWriter,
  logger: { warn: (message: string) => void },
  deferred: UpcomingRenewalCycleRecord,
  retired: UpcomingRenewalCycleRecord[]
): Promise<
  StepResponse<
    EnsureNextRenewalCycleStepOutput,
    EnsureNextRenewalCycleCompensation
  >
> {
  const retiredIds = retired.map((row) => row.id)

  /**
   * Refusing to move the protected row is not refusing to clear the row beside
   * it: `defer` names its neighbour in `retire` too, and a branch that reported
   * `deferred` without acting on it left that neighbour chargeable. The protected
   * row is what the retirement made room for.
   */
  await retireStaleUpcomingCycles(
    writer,
    deferred.subscription_id,
    retired,
    logger,
    deferred.id
  )

  return new StepResponse(
    {
      action: "deferred",
      subscription_id: deferred.subscription_id,
      renewal_cycle_id: deferred.id,
    },
    retiredCyclesCompensation(retiredIds)
  )
}

/**
 * The report of a run that wrote nothing to the row it chose — a `match` on a
 * terminal row, or one whose approval state already agrees with what the settings
 * policy asks for — after clearing the rows the selector named.
 *
 * Each of those paths returns early for its own reason, and none of those reasons
 * says anything about the neighbour left behind, so the retirement happens here
 * and the action says so: a run that cleared a row is not a run that did
 * nothing.
 */
export async function retireAndReportUnchanged(
  writer: UpcomingCycleRetireWriter,
  logger: { warn: (message: string) => void },
  existingCycle: UpcomingRenewalCycleRecord,
  retired: UpcomingRenewalCycleRecord[]
): Promise<
  StepResponse<
    EnsureNextRenewalCycleStepOutput,
    EnsureNextRenewalCycleCompensation
  >
> {
  const retiredIds = retired.map((row) => row.id)

  await retireStaleUpcomingCycles(
    writer,
    existingCycle.subscription_id,
    retired,
    logger,
    existingCycle.id
  )

  return new StepResponse(
    {
      action: retiredIds.length ? "retired" : "noop",
      subscription_id: existingCycle.subscription_id,
      renewal_cycle_id: existingCycle.id,
    },
    retiredCyclesCompensation(retiredIds)
  )
}

/**
 * The retire half a run carries alongside whatever else it has to undo, so a
 * workflow that fails after the step returns cannot leave the cleared rows
 * behind. `retired_ids` is always present on the variants that can retire, and
 * empty when the run retired nothing.
 */
type RetiredCyclesCompensation = {
  retired_ids: string[]
}

export type EnsureNextRenewalCycleCompensation =
  | {
      action: "created"
      renewal_cycle_id: string
    }
  | ({
      action: "updated"
      previous: UpcomingCycleReconcileSnapshot
    } & RetiredCyclesCompensation)
  | ({
      action: "adopted"
      previous: UpcomingCycleReconcileSnapshot
    } & RetiredCyclesCompensation)
  | ({
      /**
       * The run's whole write set was the retire — the `deferred` and `noop`
       * paths that cleared a named neighbour without touching the row they
       * reported on. Those branches return early, so there is no snapshot of a
       * write to roll back, only rows to bring back.
       */
      action: "retired"
    } & RetiredCyclesCompensation)
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
 * What a run hands its compensation for the rows it retired, or nothing when it
 * retired nothing — so a rollback of an ordinary run is exactly what it was
 * before the retire existed. The `deferred` and `noop` branches use this whole:
 * on those paths the retire is the run's only write, so the retire is also the
 * only thing there is to undo.
 */
function retiredCyclesCompensation(
  retiredIds: string[]
): Extract<
  EnsureNextRenewalCycleCompensation,
  { action: "retired" }
> | undefined {
  return retiredIds.length
    ? { action: "retired", retired_ids: retiredIds }
    : undefined
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

      return retireAndDefer(
        renewalModule,
        logger,
        deferred,
        resolution.retire
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
     * The rows this resolution named: every live `scheduled` row other than the
     * one the run keeps or moves. They are cleared on every path that can carry
     * them, and each of those paths returns early for its own reason — a terminal
     * row that owns the entitlement date, an approval state with nothing to
     * re-derive, a reconciliation write that succeeded — none of which says
     * anything about the neighbour left behind.
     */
    const retired = resolution.retire
    const retiredIds = retired.map((row) => row.id)
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
      /**
       * This is the shape Task 15 pinned as a deliberate refusal to adopt: a
       * terminal row owns the entitlement date and the live `scheduled` neighbour
       * is named rather than moved. Naming it was the decision's half; clearing
       * it is the effect's, and the run reports `retired` rather than `noop`
       * because a row did go.
       */
      return retireAndReportUnchanged(
        renewalModule,
        logger,
        existingCycle,
        retired
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
      // Same on the match that needed no write: the row keeps its approval state,
      // and the neighbour the selector named still goes.
      return retireAndReportUnchanged(
        renewalModule,
        logger,
        existingCycle,
        retired
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

    /**
     * After the write, so a run that failed at the write destroyed nothing, and
     * before the return, so no path reports a clean reconciliation while the
     * neighbour the selector named is still live. On this path the retire is an
     * extra to the run's own rollback, so the ids travel inside its compensation
     * instead of as a `retired` one of their own.
     */
    await retireStaleUpcomingCycles(
      renewalModule,
      subscription.id,
      retired,
      logger,
      existingCycle.id
    )

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
          retired_ids: retiredIds,
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
        retired_ids: retiredIds,
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

    if (compensation.action === "deleted") {
      await restoreDeletedUpcomingCycles(renewalModule, compensation.previous)
      return
    }

    /**
     * A run that deferred or changed nothing returns no compensation data, and
     * the engine then hands this handler the step's own output (`deferred`,
     * `noop`, `retired`-free): nothing was written, so there is nothing to undo.
     * Everything that does have a rollback carries the retire half, with or
     * without a snapshot beside it, so the check that separates the two is the
     * one the union can actually be narrowed by.
     */
    if (!("retired_ids" in compensation)) {
      return
    }

    /**
     * The rows a run retired come back whatever else it also rolls back: a
     * retired row is never the row the run wrote (`collectRetirable` excludes the
     * chosen one), so the two restores cannot land on the same row, and a
     * `retired` run has nothing else to undo.
     */
    if (compensation.retired_ids.length) {
      await restoreRetiredUpcomingCycles(renewalModule, compensation.retired_ids)
    }

    if (compensation.action === "retired") {
      return
    }

    await restoreReconciledCycle(renewalModule, compensation.previous)
  }
)
