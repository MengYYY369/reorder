import {
  retireAndDefer,
  retireAndReportUnchanged,
  restoreRetiredUpcomingCycles,
  retireStaleUpcomingCycles,
  type EnsureNextRenewalCycleCompensation,
  type EnsureNextRenewalCycleStepOutput,
  type RetiredCycleRestoreWriter,
  type UpcomingCycleRetireWriter,
} from "../../../workflows/steps/ensure-next-renewal-cycle"
import { type UpcomingRenewalCycleRecord } from "../utils/upcoming-cycle"
import { RenewalCycleStatus } from "../types"

/**
 * Pure spec for the write that acts on the retire set `resolveUpcomingCycle`
 * names (Task 15) and for its rollback. The selector reports the live
 * `scheduled` rows a decision neither moves nor deletes; this unit is the half
 * that stops them from staying chargeable after the step returns early.
 *
 * The early-return branches (`defer`, and the two paths that report a row as
 * unchanged) are covered through the two functions that build their responses —
 * `retireAndDefer` and `retireAndReportUnchanged` — so that the retirement and
 * the report it has to agree with are pinned by the same case. Both halves are
 * module-level units rather than lines inside the step or its compensation
 * handler for the reason that file already records about the other two rollbacks
 * (`restoreReconciledCycle`, `restoreDeletedUpcomingCycles`): inline, they are
 * reachable only by driving a failing workflow, which no gate does.
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
 * The one write the retire performs, narrowed to `UpcomingCycleRetireWriter`,
 * plus a journal shared with the fake logger so the ORDER of the two is
 * observable: a warning emitted before the delete would claim a retirement the
 * row never got, and that pairing — log says retired, row still live — is the
 * regression this unit exists to prevent.
 */
function fakeRetireWriter(
  liveIds: string[] = ["rcy_stale", "rcy_keeper"]
) {
  const journal: string[] = []
  const warnings: string[] = []
  const live = new Set(liveIds)

  const writer: UpcomingCycleRetireWriter = {
    async softDeleteRenewalCycles(ids) {
      for (const id of ids) {
        live.delete(id)
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
    live: () => [...live].sort(),
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
   * host lost to a bug.
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
    const live = new Set(liveIds)

    const writer: RetiredCycleRestoreWriter = {
      async restoreRenewalCycles(ids) {
        for (const id of ids) {
          live.add(id)
        }
        calls.push(`restore:${ids.join("+")}`)
      },
    }

    return { writer, calls, live: () => [...live].sort() }
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
    await restoreRetiredUpcomingCycles(fake.writer, ["rcy_stale"])

    expect(fake.calls).toEqual(["restore:rcy_stale"])
    expect(fake.live()).toEqual(["rcy_keeper", "rcy_stale"])
  })

  it("restores every row a run retired, in one write", async () => {
    const fake = fakeRestoreWriter()

    await restoreRetiredUpcomingCycles(fake.writer, [
      "rcy_stale",
      "rcy_stale_later",
    ])

    expect(fake.calls).toEqual(["restore:rcy_stale+rcy_stale_later"])
  })

  it("restores nothing for an empty retire set", async () => {
    const fake = fakeRestoreWriter()

    await restoreRetiredUpcomingCycles(fake.writer, [])

    expect(fake.calls).toEqual([])
    expect(fake.live()).toEqual(["rcy_keeper"])
  })
})
