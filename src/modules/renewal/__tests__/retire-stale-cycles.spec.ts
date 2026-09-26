import { StepResponse } from "@medusajs/framework/workflows-sdk"
import {
  retireAndDefer,
  retireAndReportReconciled,
  retireAndReportUnchanged,
  restoreRetiredUpcomingCycles,
  retireStaleUpcomingCycles,
  rollBackUpcomingCycleWrites,
  type EnsureNextRenewalCycleCompensation,
  type EnsureNextRenewalCycleRollbackPayload,
  type EnsureNextRenewalCycleRollbackWriter,
  type EnsureNextRenewalCycleStepOutput,
  type RetiredCycleRestoreWriter,
  type UpcomingCycleRetireWriter,
  type UpcomingCycleReconcileSnapshot,
} from "../../../workflows/steps/ensure-next-renewal-cycle"
import {
  restoreForUpcomingCycleReconcile,
  type UpcomingRenewalCycleRecord,
} from "../utils/upcoming-cycle"
import { RenewalCycleStatus } from "../types"

/**
 * Pure spec for the write that acts on the retire set `resolveUpcomingCycle`
 * names (Task 15) and for its rollback. The selector reports the live
 * `scheduled` rows a decision neither moves nor deletes; this unit is the half
 * that stops them from staying chargeable after the step returns early.
 *
 * The early-return branches (`defer`, and the two paths that report a row as
 * unchanged) are covered through the three functions that build their responses —
 * `retireAndDefer`, `retireAndReportUnchanged` and `retireAndReportReconciled` —
 * so that the retirement and the report it has to agree with are pinned by the
 * same case. All halves are module-level units rather than lines inside the step
 * or its compensation handler for the reason that file already records about the
 * other two rollbacks (`restoreReconciledCycle`, `restoreDeletedUpcomingCycles`):
 * inline, they are reachable only by driving a failing workflow, which no gate
 * does.
 *
 * The three things this file holds the retire to, beyond "the named row goes":
 *
 * - it goes only if it still qualifies at the moment of the write, and the
 *   warning claims only what the write did;
 * - a run's snapshot reaches the rollback whatever the rollback payload was
 *   persisted by, which is why the dispatcher below is a unit and not lines
 *   inside the compensation handler;
 * - a rollback says so, because the retirement warning is the line an operator
 *   greps and a silent undo leaves that line standing as the last word.
 */

/**
 * A complete row, because `UpcomingRenewalCycleRecord` is complete: the retire
 * is handed the rows the selector found, and a fixture missing the columns it
 * does not read would not survive the writer that does.
 */
const cycle = (
  overrides: Partial<UpcomingRenewalCycleRecord> = {}
): UpcomingRenewalCycleRecord => ({
  id: "rcy_stale",
  subscription_id: "sub_1",
  scheduled_for: new Date("2026-09-24T10:00:00.000Z"),
  processed_at: null,
  status: RenewalCycleStatus.SCHEDULED,
  approval_required: false,
  approval_status: null,
  approval_decided_at: null,
  approval_decided_by: null,
  approval_reason: null,
  generated_order_id: null,
  applied_pending_update_data: null,
  last_error: null,
  attempt_count: 0,
  metadata: null,
  ...overrides,
})

/**
 * The snapshot a reconciliation rollback restores, built through the same helper
 * the step uses, so this file cannot drift from the field set the write owns.
 */
const reconcileSnapshot = (id: string): UpcomingCycleReconcileSnapshot => ({
  id,
  ...restoreForUpcomingCycleReconcile(cycle({ id })),
})

/** A row as the table holds it: what the qualification reads, plus liveness. */
type FakeCycleRow = {
  id: string
  status: RenewalCycleStatus
  generated_order_id: string | null
  deleted: boolean
}

/**
 * The one read and the one write a retire performs, over a table the case can
 * change underneath the retire.
 *
 * The table is the point: the rows a case hands the retire are the rows the
 * selector named from an EARLIER read, and the writer's own `listRenewalCycles`
 * is where a row that changed in between shows up. A case mutates it with
 * `bill` (what `create-manual-renewal` does to a due row — stamp an order id and
 * leave the status alone) and the retire's behaviour has to follow the table, not
 * the argument.
 *
 * The journal is shared with the fake logger so the ORDER of the two is
 * observable: a warning emitted before the delete would claim a retirement the
 * row never got, and that pairing — log says retired, row still live — is the
 * regression this unit exists to prevent. `listRenewalCycles` is deliberately not
 * journalled: it is the read that decides, so pinning it as an event would let a
 * case pass on the read happening instead of on the rows it withheld.
 */
function fakeRetireWriter(liveIds: string[] = ["rcy_stale", "rcy_keeper"]) {
  const journal: string[] = []
  const warnings: string[] = []
  let softDeleteFailure: Error | undefined

  const rows: FakeCycleRow[] = liveIds.map((id) => ({
    id,
    status: RenewalCycleStatus.SCHEDULED,
    generated_order_id: null,
    deleted: false,
  }))

  const row = (id: string): FakeCycleRow => {
    const found = rows.find((candidate) => candidate.id === id)
    if (!found) {
      throw new Error(`the fake table has no row '${id}'`)
    }
    return found
  }

  const writer: UpcomingCycleRetireWriter = {
    async listRenewalCycles(filters) {
      return rows
        .filter(
          (candidate) =>
            !candidate.deleted && filters.id.includes(candidate.id)
        )
        .map(({ id, status, generated_order_id }) => ({
          id,
          status,
          generated_order_id,
        }))
    },
    async softDeleteRenewalCycles(ids) {
      if (softDeleteFailure) {
        throw softDeleteFailure
      }
      for (const id of ids) {
        row(id).deleted = true
      }
      journal.push(`soft:${ids.join("+")}`)
    },
  }

  const logger = {
    warn(message: string) {
      journal.push("warn")
      warnings.push(message)
    },
  }

  return {
    writer,
    logger,
    journal: () => [...journal],
    warnings,
    live: () =>
      rows
        .filter((candidate) => !candidate.deleted)
        .map((candidate) => candidate.id)
        .sort(),
    /** Money moved onto a row after the selector named it. */
    bill: (id: string, orderId: string) => {
      row(id).generated_order_id = orderId
    },
    /** The failure mode I-4 is about: the write itself throws. */
    failSoftDelete: (error: Error) => {
      softDeleteFailure = error
    },
  }
}

describe("retireStaleUpcomingCycles", () => {
  it("soft-deletes the stale row and warns about the row it made room for", async () => {
    const fake = fakeRetireWriter()

    await retireStaleUpcomingCycles(
      fake.writer,
      "sub_1",
      [cycle({ id: "rcy_stale" })],
      fake.logger,
      "rcy_keeper"
    )

    expect(fake.live()).toEqual(["rcy_keeper"])
    expect(fake.warnings).toHaveLength(1)
    expect(fake.warnings[0]).toContain("rcy_stale")
    expect(fake.warnings[0]).toContain("rcy_keeper")
    expect(fake.warnings[0]).toContain("sub_1")
  })

  /**
   * The disclosure line an operator greps for, pinned exactly: it names how many
   * rows went, which subscription, which rows, and which row they were cleared
   * behind. A retire that is not visible here is indistinguishable from a row a
   * host lost to a bug. The count is the number that actually went, which is the
   * only number this line is allowed to state.
   */
  it("states the retirement once, naming both rows and the subscription", async () => {
    const fake = fakeRetireWriter()

    await retireStaleUpcomingCycles(
      fake.writer,
      "sub_1",
      [cycle({ id: "rcy_stale" })],
      fake.logger,
      "rcy_keeper"
    )

    expect(fake.warnings[0]).toBe(
      "[reorder] retired 1 stale upcoming renewal cycle(s) of subscription " +
        "'sub_1' (rcy_stale) behind 'rcy_keeper'"
    )
  })

  it("warns only after the write landed", async () => {
    const fake = fakeRetireWriter()

    await retireStaleUpcomingCycles(
      fake.writer,
      "sub_1",
      [cycle({ id: "rcy_stale" })],
      fake.logger,
      "rcy_keeper"
    )

    expect(fake.journal()).toEqual(["soft:rcy_stale", "warn"])
  })

  it("retires every row the selector named, in one write", async () => {
    const fake = fakeRetireWriter([
      "rcy_stale",
      "rcy_stale_later",
      "rcy_keeper",
    ])

    await retireStaleUpcomingCycles(
      fake.writer,
      "sub_1",
      [
        cycle({ id: "rcy_stale" }),
        cycle({
          id: "rcy_stale_later",
          scheduled_for: new Date("2026-12-24T10:00:00.000Z"),
        }),
      ],
      fake.logger,
      "rcy_keeper"
    )

    expect(fake.journal()).toEqual([
      "soft:rcy_stale+rcy_stale_later",
      "warn",
    ])
    expect(fake.live()).toEqual(["rcy_keeper"])
    expect(fake.warnings[0]).toContain("retired 2 stale")
  })

  it("writes nothing when there is nothing to retire", async () => {
    const fake = fakeRetireWriter()

    await retireStaleUpcomingCycles(
      fake.writer,
      "sub_1",
      [],
      fake.logger,
      "rcy_keeper"
    )

    expect(fake.journal()).toEqual([])
    expect(fake.live()).toEqual(["rcy_keeper", "rcy_stale"])
  })

  /**
   * The qualifying window. The rows above are the rows the selector named from a
   * read the step took before it decided anything, and no lock covers this step
   * against a writer that claims one of them in the meantime — the scheduler
   * locks `renewal:<cycle_id>` per row and a manual renewal locks the order id,
   * neither subscription-scoped. A row that took an order id since the selection
   * has money in flight, so it stays live, and the retirement line is not allowed
   * to name it: the two warnings below say what went and what was withheld, and
   * neither is free to overstate.
   */
  it("leaves a candidate that became order-carrying after the selection alone", async () => {
    const fake = fakeRetireWriter(["rcy_stale", "rcy_billed", "rcy_keeper"])
    fake.bill("rcy_billed", "order_in_flight")

    await retireStaleUpcomingCycles(
      fake.writer,
      "sub_1",
      [cycle({ id: "rcy_stale" }), cycle({ id: "rcy_billed" })],
      fake.logger,
      "rcy_keeper"
    )

    expect(fake.live()).toEqual(["rcy_billed", "rcy_keeper"])
    expect(fake.journal()).toEqual(["warn", "soft:rcy_stale", "warn"])
    expect(fake.warnings[0]).toContain("withheld 1")
    expect(fake.warnings[0]).toContain("rcy_billed")
    expect(fake.warnings[1]).toContain("retired 1 stale")
    expect(fake.warnings[1]).not.toContain("rcy_billed")
  })

  it("writes nothing when every candidate stopped qualifying", async () => {
    const fake = fakeRetireWriter(["rcy_billed", "rcy_keeper"])
    fake.bill("rcy_billed", "order_in_flight")

    await retireStaleUpcomingCycles(
      fake.writer,
      "sub_1",
      [cycle({ id: "rcy_billed" })],
      fake.logger,
      "rcy_keeper"
    )

    expect(fake.journal()).toEqual(["warn"])
    expect(fake.live()).toEqual(["rcy_billed", "rcy_keeper"])
    expect(fake.warnings).toHaveLength(1)
    expect(fake.warnings[0]).toContain("withheld")
    expect(fake.warnings[0]).not.toContain("retired")
  })

  /**
   * A row the re-read does not return is already out of the scheduler's sight —
   * someone else retired it — so claiming it again would double-count a
   * retirement this run did not perform. Retiring twice is the shape a retried
   * or overlapping run gives.
   */
  it("claims nothing when the named row was already retired by someone else", async () => {
    const fake = fakeRetireWriter(["rcy_stale", "rcy_keeper"])
    const named = [cycle({ id: "rcy_stale" })]

    await retireStaleUpcomingCycles(
      fake.writer,
      "sub_1",
      named,
      fake.logger,
      "rcy_keeper"
    )
    const afterFirst = fake.journal()

    await retireStaleUpcomingCycles(
      fake.writer,
      "sub_1",
      named,
      fake.logger,
      "rcy_keeper"
    )

    expect(afterFirst).toEqual(["soft:rcy_stale", "warn"])
    expect(fake.journal()).toEqual([...afterFirst, "warn"])
    expect(fake.warnings).toHaveLength(2)
    expect(fake.warnings[1]).toContain("withheld 1")
    expect(fake.warnings[1]).not.toContain("retired")
    expect(fake.live()).toEqual(["rcy_keeper"])
  })
})

/**
 * The `defer` branch: the protected row is the in-flight one this run refuses to
 * write, so the retire is the branch's whole write set and the report keeps
 * saying `deferred` while the named neighbour goes. A branch that reported a
 * clean deferral and left the neighbour live is the regression this pair pins.
 */
describe("retireAndDefer", () => {
  it("retires the neighbour and still reports the protected row as deferred", async () => {
    const fake = fakeRetireWriter(["rcy_in_flight", "rcy_stale"])

    const response = await retireAndDefer(
      fake.writer,
      fake.logger,
      cycle({
        id: "rcy_in_flight",
        status: RenewalCycleStatus.PROCESSING,
        generated_order_id: "order_in_flight",
      }),
      [cycle({ id: "rcy_stale" })]
    )

    expect(response.output).toEqual<EnsureNextRenewalCycleStepOutput>({
      action: "deferred",
      subscription_id: "sub_1",
      renewal_cycle_id: "rcy_in_flight",
    })
    expect(response.compensateInput).toEqual<EnsureNextRenewalCycleCompensation>(
      {
        action: "retired",
        retired_ids: ["rcy_stale"],
      }
    )
    expect(fake.live()).toEqual(["rcy_in_flight"])
    expect(fake.warnings[0]).toContain("behind 'rcy_in_flight'")
  })

  it("carries no compensation for a deferral that had nothing to retire", async () => {
    const fake = fakeRetireWriter(["rcy_in_flight"])

    const response = await retireAndDefer(
      fake.writer,
      fake.logger,
      cycle({ id: "rcy_in_flight", status: RenewalCycleStatus.PROCESSING }),
      []
    )

    expect(response.output).toEqual<EnsureNextRenewalCycleStepOutput>({
      action: "deferred",
      subscription_id: "sub_1",
      renewal_cycle_id: "rcy_in_flight",
    })
    // No compensation was handed, so the engine echoes the output and the
    // rollback finds no retire to undo.
    expect(response.compensateInput).toEqual(response.output)
    expect(response.compensateInput).not.toHaveProperty("retired_ids")
    expect(fake.journal()).toEqual([])
    expect(fake.live()).toEqual(["rcy_in_flight"])
  })
})

/**
 * The two paths that report the chosen row as unchanged. A retirement makes that
 * report false — a row did go — so the action becomes `retired`, and the ids
 * travel to the compensation, which is the whole of what that run has to undo.
 * With nothing to retire the branch is the `noop` it always was, and the
 * zero-write pin the http suite holds keeps passing.
 */
describe("retireAndReportUnchanged", () => {
  const matchedTerminalRow = () =>
    cycle({
      id: "rcy_matched",
      status: RenewalCycleStatus.SUCCEEDED,
      scheduled_for: new Date("2026-11-24T10:00:00.000Z"),
      generated_order_id: "order_paid",
    })

  it("reports retired, not noop, when the run cleared a named neighbour", async () => {
    const fake = fakeRetireWriter(["rcy_matched", "rcy_stale"])

    const response = await retireAndReportUnchanged(
      fake.writer,
      fake.logger,
      matchedTerminalRow(),
      [cycle({ id: "rcy_stale" })]
    )

    expect(response.output).toEqual<EnsureNextRenewalCycleStepOutput>({
      action: "retired",
      subscription_id: "sub_1",
      renewal_cycle_id: "rcy_matched",
    })
    expect(response.compensateInput).toEqual<EnsureNextRenewalCycleCompensation>(
      {
        action: "retired",
        retired_ids: ["rcy_stale"],
      }
    )
    expect(fake.live()).toEqual(["rcy_matched"])
  })

  it("still reports noop when the same path had nothing to retire", async () => {
    const fake = fakeRetireWriter(["rcy_matched", "rcy_stale"])

    const response = await retireAndReportUnchanged(
      fake.writer,
      fake.logger,
      matchedTerminalRow(),
      []
    )

    expect(response.output).toEqual<EnsureNextRenewalCycleStepOutput>({
      action: "noop",
      subscription_id: "sub_1",
      renewal_cycle_id: "rcy_matched",
    })
    // The echo again: nothing was written, so nothing is handed to the rollback.
    expect(response.compensateInput).toEqual(response.output)
    expect(response.compensateInput).not.toHaveProperty("retired_ids")
    expect(fake.journal()).toEqual([])
    expect(fake.live()).toEqual(["rcy_matched", "rcy_stale"])
  })
})

/**
 * The reconciliation write path, where the retire is an extra to a run that
 * already has a snapshot to hand back.
 *
 * The reconciliation write has landed before this runs, so the snapshot is the
 * only thing standing between an applied `adopt` / `update` and the row it
 * overwrote. A soft delete that throws used to propagate out of the step, and a
 * step that throws without a response never compensates: the write stayed, and
 * the field-by-field mirror of it was discarded next to the row it described. So
 * the failure is reported as a permanent step failure carrying that same
 * compensation — the engine stores the response it wraps before reverting the
 * step, which is what makes the rollback reachable at all.
 *
 * What this pins is that the snapshot travels. That the engine then runs this
 * step's rollback off the stored response is framework behaviour
 * (`transaction-orchestrator.js` `flagStepsToRevert` matching `PERMANENT_FAILURE`,
 * `create-step-handler.js` reading the stored invoke output); the http suite owns
 * the end-to-end proof, and this file does not claim it.
 */
describe("retireAndReportReconciled", () => {
  const reconciled = {
    action: "updated" as const,
    subscription_id: "sub_1",
    renewal_cycle_id: "rcy_matched",
    previous: reconcileSnapshot("rcy_matched"),
  }

  it("reports the reconciliation and carries the retire inside its compensation", async () => {
    const fake = fakeRetireWriter(["rcy_matched", "rcy_stale"])

    const response = await retireAndReportReconciled(
      fake.writer,
      fake.logger,
      reconciled,
      [cycle({ id: "rcy_stale" })]
    )

    expect(response.output).toEqual<EnsureNextRenewalCycleStepOutput>({
      action: "updated",
      subscription_id: "sub_1",
      renewal_cycle_id: "rcy_matched",
    })
    expect(response.compensateInput).toEqual<EnsureNextRenewalCycleCompensation>(
      {
        action: "updated",
        previous: reconciled.previous,
        retired_ids: ["rcy_stale"],
      }
    )
    expect(fake.live()).toEqual(["rcy_matched"])
  })

  it("reports adopted, not updated, when the run moved the row", async () => {
    const fake = fakeRetireWriter(["rcy_matched", "rcy_stale"])

    const response = await retireAndReportReconciled(
      fake.writer,
      fake.logger,
      { ...reconciled, action: "adopted" },
      [cycle({ id: "rcy_stale" })]
    )

    expect(response.output).toEqual<EnsureNextRenewalCycleStepOutput>({
      action: "adopted",
      subscription_id: "sub_1",
      renewal_cycle_id: "rcy_matched",
    })
    expect(response.compensateInput).toEqual<EnsureNextRenewalCycleCompensation>(
      {
        action: "adopted",
        previous: reconciled.previous,
        retired_ids: ["rcy_stale"],
      }
    )
  })

  it("hands the snapshot to the rollback when the retire itself fails", async () => {
    const fake = fakeRetireWriter(["rcy_matched", "rcy_stale"])
    fake.failSoftDelete(new Error("connection terminated"))

    let caught: unknown
    try {
      await retireAndReportReconciled(
        fake.writer,
        fake.logger,
        reconciled,
        [cycle({ id: "rcy_stale" })]
      )
    } catch (error) {
      caught = error
    }

    const failure = requirePermanentStepFailure(caught)

    expect(failure.compensation).toEqual<EnsureNextRenewalCycleCompensation>({
      action: "updated",
      previous: reconciled.previous,
      retired_ids: ["rcy_stale"],
    })
    // The write that landed is not undone here — that is the rollback's job —
    // and the failure says which reconciliation is being abandoned.
    expect(fake.journal()).toEqual([])
    expect(failure.message).toContain("rcy_matched")
    expect(failure.message).toContain("connection terminated")
  })
})

/**
 * The whole rollback, dispatched on the action a run reported.
 *
 * This is the seam the compensation handler used to own inline, and the reason it
 * is a unit: which restores a run needs is settled by what it WROTE, while which
 * fields its payload carries is settled by which build PERSISTED it, and a
 * compensation outlives the deploy that wrote it. Keying the rollback off a field
 * therefore silently dropped the reconcile restore for every `updated` /
 * `adopted` run persisted before the retire existed — a rollback the old code
 * performed, and the shape the first case below feeds in deliberately.
 */
describe("rollBackUpcomingCycleWrites", () => {
  /**
   * Every write a rollback performs, journalled in call order, so a case can see
   * both which restores ran and in what sequence.
   */
  function fakeRollbackWriter() {
    const journal: string[] = []
    const warnings: string[] = []

    const writer: EnsureNextRenewalCycleRollbackWriter = {
      async deleteRenewalCycles(ids) {
        journal.push(`delete:${ids}`)
      },
      async updateRenewalCycles(data) {
        journal.push(`update:${data.id}`)
      },
      async restoreRenewalCycles(ids) {
        journal.push(`restore:${ids.join("+")}`)
      },
      async createRenewalCycles(data) {
        journal.push(`create:${data.map((row) => row.id).join("+")}`)
      },
      async softDeleteRenewalCycles(ids) {
        journal.push(`soft:${ids.join("+")}`)
      },
    }

    const logger = {
      warn(message: string) {
        warnings.push(message)
      },
    }

    return { writer, logger, journal: () => [...journal], warnings }
  }

  it("restores the snapshot of a compensation persisted before the retire existed", async () => {
    const fake = fakeRollbackWriter()
    /**
     * Shaped by the previous build: the `updated` variant it stored, which knew
     * nothing about `retired_ids`. Typed as the handler's input rather than the
     * compensation, because that is what arrives across a deploy boundary.
     */
    const preDeploy: EnsureNextRenewalCycleRollbackPayload = {
      action: "updated",
      previous: reconcileSnapshot("rcy_matched"),
    }

    await rollBackUpcomingCycleWrites(fake.writer, fake.logger, preDeploy)

    expect(fake.journal()).toEqual(["update:rcy_matched"])
  })

  it("restores the retired rows before the row the run wrote", async () => {
    const fake = fakeRollbackWriter()

    await rollBackUpcomingCycleWrites(fake.writer, fake.logger, {
      action: "adopted",
      previous: reconcileSnapshot("rcy_matched"),
      retired_ids: ["rcy_stale"],
    })

    expect(fake.journal()).toEqual([
      "restore:rcy_stale",
      "update:rcy_matched",
    ])
  })

  it("restores only the retired rows for a run whose whole write was the retire", async () => {
    const fake = fakeRollbackWriter()

    await rollBackUpcomingCycleWrites(fake.writer, fake.logger, {
      action: "retired",
      retired_ids: ["rcy_stale", "rcy_stale_later"],
    })

    expect(fake.journal()).toEqual(["restore:rcy_stale+rcy_stale_later"])
    expect(fake.warnings).toHaveLength(1)
  })

  it("deletes the row a created run made, and nothing else", async () => {
    const fake = fakeRollbackWriter()

    await rollBackUpcomingCycleWrites(fake.writer, fake.logger, {
      action: "created",
      renewal_cycle_id: "rcy_new",
    })

    expect(fake.journal()).toEqual(["delete:rcy_new"])
  })

  it("puts the deleted rows back through the keeper-last restore", async () => {
    const fake = fakeRollbackWriter()

    await rollBackUpcomingCycleWrites(fake.writer, fake.logger, {
      action: "deleted",
      previous: [
        cycle({ id: "rcy_extra" }),
        cycle({
          id: "rcy_keeper",
          scheduled_for: new Date("2026-12-24T10:00:00.000Z"),
        }),
      ],
    })

    expect(fake.journal()).toEqual([
      "create:rcy_extra",
      "soft:rcy_extra",
      "create:rcy_keeper",
    ])
  })

  it("writes nothing for the echoed report of a run that deferred", async () => {
    const fake = fakeRollbackWriter()

    await rollBackUpcomingCycleWrites(fake.writer, fake.logger, {
      action: "deferred",
      subscription_id: "sub_1",
      renewal_cycle_id: "rcy_in_flight",
    })

    expect(fake.journal()).toEqual([])
    expect(fake.warnings).toEqual([])
  })

  /**
   * The one action that exists on BOTH sides of the union. A `retired` run does
   * carry a rollback, but its report is not one: it names no ids, and a dispatcher
   * that keyed off the action alone would hand `undefined` to the restore. The
   * report is recognized as a report, and nothing runs.
   */
  it("writes nothing for the echoed report of a run that retired a neighbour", async () => {
    const fake = fakeRollbackWriter()

    await rollBackUpcomingCycleWrites(fake.writer, fake.logger, {
      action: "retired",
      subscription_id: "sub_1",
      renewal_cycle_id: "rcy_matched",
    })

    expect(fake.journal()).toEqual([])
    expect(fake.warnings).toEqual([])
  })
})

describe("restoreRetiredUpcomingCycles", () => {
  /**
   * The `retired` compensation, and the reason it is not
   * `restoreDeletedUpcomingCycles`: a retire SOFT-deletes, so the row is still in
   * the table and re-inserting it by id would fail on `renewal_cycle_pkey`. The
   * writer this rollback takes carries `restoreRenewalCycles` and no
   * `createRenewalCycles`, which makes that mistake unrepresentable rather than
   * merely untested.
   */
  function fakeRestoreWriter(liveIds: string[] = ["rcy_keeper"]) {
    const calls: string[] = []
    const warnings: string[] = []
    const live = new Set(liveIds)

    const writer: RetiredCycleRestoreWriter = {
      async restoreRenewalCycles(ids) {
        for (const id of ids) {
          live.add(id)
        }
        calls.push(`restore:${ids.join("+")}`)
      },
    }

    const logger = {
      warn(message: string) {
        warnings.push(message)
      },
    }

    return {
      writer,
      logger,
      calls,
      warnings,
      live: () => [...live].sort(),
    }
  }

  it("brings a retired row back by id, not by re-inserting it", async () => {
    const retired = fakeRetireWriter(["rcy_stale", "rcy_keeper"])
    await retireStaleUpcomingCycles(
      retired.writer,
      "sub_1",
      [cycle({ id: "rcy_stale" })],
      retired.logger,
      "rcy_keeper"
    )
    expect(retired.live()).toEqual(["rcy_keeper"])

    const fake = fakeRestoreWriter(["rcy_keeper"])
    await restoreRetiredUpcomingCycles(fake.writer, ["rcy_stale"], fake.logger)

    expect(fake.calls).toEqual(["restore:rcy_stale"])
    expect(fake.live()).toEqual(["rcy_keeper", "rcy_stale"])
  })

  it("restores every row a run retired, in one write", async () => {
    const fake = fakeRestoreWriter()

    await restoreRetiredUpcomingCycles(
      fake.writer,
      ["rcy_stale", "rcy_stale_later"],
      fake.logger
    )

    expect(fake.calls).toEqual(["restore:rcy_stale+rcy_stale_later"])
  })

  /**
   * The rollback has to be as loud as the write it undoes. The retirement warning
   * is the field signal an operator greps, so a silent restore leaves the log
   * asserting a retirement that was undone — a row that is chargeable again
   * reading as one that was cleared.
   */
  it("says which rows it restored, because the retirement said it retired them", async () => {
    const fake = fakeRestoreWriter()

    await restoreRetiredUpcomingCycles(
      fake.writer,
      ["rcy_stale", "rcy_stale_later"],
      fake.logger
    )

    expect(fake.warnings[0]).toContain("restored 2")
    expect(fake.warnings[0]).toContain("rcy_stale")
    expect(fake.warnings[0]).toContain("rcy_stale_later")
  })

  it("restores nothing for an empty retire set", async () => {
    const fake = fakeRestoreWriter()

    await restoreRetiredUpcomingCycles(fake.writer, [], fake.logger)

    expect(fake.calls).toEqual([])
    expect(fake.warnings).toEqual([])
    expect(fake.live()).toEqual(["rcy_keeper"])
  })
})

/**
 * The error `StepResponse.permanentFailure` throws is structural here on purpose:
 * the class itself lives in `@medusajs/orchestration`, which this plugin does not
 * depend on, and `getStepResponse()` is the only part of it a caller can act on —
 * it is what the orchestrator stores as this step's invoke output, and therefore
 * what the rollback is handed.
 */
function isPermanentStepFailure(
  error: unknown
): error is { name: string; message: string; getStepResponse(): unknown } {
  return (
    typeof error === "object" &&
    error !== null &&
    "getStepResponse" in error &&
    typeof error.getStepResponse === "function" &&
    "name" in error &&
    error.name === "PermanentStepFailure"
  )
}

/**
 * The message and the compensation the engine would hand this step's rollback,
 * or a test failure naming what arrived instead — a bare throw being exactly the
 * shape this case exists to rule out.
 */
function requirePermanentStepFailure(error: unknown): {
  message: string
  compensation: unknown
} {
  if (!isPermanentStepFailure(error)) {
    throw new Error(
      `expected a permanent step failure carrying a response, received: ${String(
        error
      )}`
    )
  }

  const response = error.getStepResponse()

  return {
    message: error.message,
    compensation:
      response instanceof StepResponse ? response.compensateInput : response,
  }
}
