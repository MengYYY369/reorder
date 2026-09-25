import {
  restoreDeletedUpcomingCycles,
  type RestoreableRenewalCycle,
} from "../../../workflows/steps/ensure-next-renewal-cycle"
import { RenewalCycleStatus } from "../../renewal/types"

function snapshot(
  id: string,
  scheduledFor: Date | string,
  overrides: Partial<RestoreableRenewalCycle> = {}
): RestoreableRenewalCycle {
  return {
    id,
    subscription_id: "sub_restore_probe",
    scheduled_for: scheduledFor,
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
  }
}

/**
 * Records every write in order and how many rows were live at that instant, so a
 * rollback that briefly leaves two upcoming cycles behind fails here even when it
 * ends in the right state.
 */
/** What the writer is handed: `scheduled_for` is always a `Date` by then. */
type WrittenRow = RestoreableRenewalCycle & { scheduled_for: Date }

function fakeRestoreWriter() {
  const writes: Array<{ method: string; ids: string[] }> = []
  const live = new Set<string>()
  const peakLive: number[] = [0]

  const writtenDates: unknown[] = []

  return {
    writes,
    writtenDates: () => writtenDates,
    liveIds: () => [...live].sort(),
    peak: () => Math.max(...peakLive),
    writer: {
      async createRenewalCycles(data: WrittenRow[]) {
        for (const cycle of data) {
          live.add(cycle.id)
          writtenDates.push(cycle.scheduled_for)
        }
        writes.push({
          method: "create",
          ids: data.map((cycle) => cycle.id),
        })
        peakLive.push(live.size)
      },
      async softDeleteRenewalCycles(ids: string[]) {
        const list = Array.isArray(ids) ? ids : [ids]
        for (const id of list) {
          live.delete(id)
        }
        writes.push({ method: "softDelete", ids: list })
        peakLive.push(live.size)
      },
    },
  }
}

describe("restoreDeletedUpcomingCycles", () => {
  it("keeps exactly one row live when the step had deleted several", async () => {
    const rows = [
      snapshot("rcy_mid", new Date("2026-06-15T00:00:00.000Z")),
      snapshot("rcy_first", new Date("2026-04-15T00:00:00.000Z")),
      snapshot("rcy_last", new Date("2026-08-15T00:00:00.000Z")),
    ]
    const fake = fakeRestoreWriter()

    await restoreDeletedUpcomingCycles(fake.writer, rows)

    // The most future row is the keeper, and it is restored last so nothing else
    // can be live alongside it.
    expect(fake.liveIds()).toEqual(["rcy_last"])
    expect(fake.writes.map((write) => `${write.method}:${write.ids.join("+")}`))
      .toEqual([
        "create:rcy_mid",
        "softDelete:rcy_mid",
        "create:rcy_first",
        "softDelete:rcy_first",
        "create:rcy_last",
      ])
    expect(fake.peak()).toEqual(1)
  })

  it("restores the single row a step can be handed under the index", async () => {
    const rows = [snapshot("rcy_only", new Date("2026-07-01T00:00:00.000Z"))]
    const fake = fakeRestoreWriter()

    await restoreDeletedUpcomingCycles(fake.writer, rows)

    expect(fake.writes).toEqual([{ method: "create", ids: ["rcy_only"] }])
    expect(fake.liveIds()).toEqual(["rcy_only"])
  })

  it("orders a JSON payload the same way, because compensation round-trips it", async () => {
    // The engine serializes the compensation, so `scheduled_for` arrives as a
    // string and the id tie-break still has to hold.
    const rows = [
      snapshot("rcy_b", "2026-09-01T00:00:00.000Z"),
      snapshot("rcy_a", "2026-09-01T00:00:00.000Z"),
    ]
    const fake = fakeRestoreWriter()

    await restoreDeletedUpcomingCycles(fake.writer, rows)

    expect(fake.liveIds()).toEqual(["rcy_a"])
    expect(fake.writes.map((write) => `${write.method}:${write.ids.join("+")}`))
      .toEqual(["create:rcy_b", "softDelete:rcy_b", "create:rcy_a"])
    // and the date is written back as a date, not as the string that arrived
    expect(fake.writtenDates().every((value) => value instanceof Date)).toBe(true)
  })

  it("never marks a restored row failed, which the scheduler would re-arm", async () => {
    const rows = [
      snapshot("rcy_extra", new Date("2026-05-01T00:00:00.000Z")),
      snapshot("rcy_keeper", new Date("2026-09-01T00:00:00.000Z")),
    ]
    const fake = fakeRestoreWriter()

    await restoreDeletedUpcomingCycles(fake.writer, rows)

    const methods = new Set(fake.writes.map((write) => write.method))
    expect(methods).toEqual(new Set(["create", "softDelete"]))

    const extra = fake.writes.find((write) => write.ids.includes("rcy_extra"))

    expect(extra).toBeDefined()
  })

  it("writes nothing for an empty payload", async () => {
    const fake = fakeRestoreWriter()

    await restoreDeletedUpcomingCycles(fake.writer, [])

    expect(fake.writes).toEqual([])
    expect(fake.liveIds()).toEqual([])
  })
})
