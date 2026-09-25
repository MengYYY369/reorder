import {
  restoreReconciledCycle,
  type UpcomingCycleReconcileSnapshot,
} from "../../../workflows/steps/ensure-next-renewal-cycle"
import {
  restoreForUpcomingCycleReconcile,
  type UpcomingRenewalCycleRecord,
} from "../utils/upcoming-cycle"
import { RenewalApprovalStatus, RenewalCycleStatus } from "../types"

/**
 * Pure spec for the rollback of a reconciliation write: the compensation the
 * `updated` and `adopted` branches run when the workflow fails after the row was
 * already rewritten. `restoreForUpcomingCycleReconcile` snapshots the row and the
 * step pairs that snapshot with its id in the same return; this is the half that
 * puts it back, and while it was a bare `updateRenewalCycles` call inside a
 * compensation handler no gate could reach it. Neither half needs a database.
 */

/**
 * A row as the step read it before writing, built as a full record because that
 * is what the snapshot helper takes. The fields outside the restore set carry
 * distinctive values, so a rollback that wrote one of them — or dropped one it
 * owes — shows up in the closed field set pinned below.
 */
const cycle = (
  overrides: Partial<UpcomingRenewalCycleRecord> = {}
): UpcomingRenewalCycleRecord => ({
  id: "renewal_cycle_adopted",
  subscription_id: "sub_reconcile_probe",
  scheduled_for: new Date("2026-08-24T10:00:00.000Z"),
  processed_at: null,
  status: RenewalCycleStatus.SCHEDULED,
  approval_required: true,
  approval_status: RenewalApprovalStatus.APPROVED,
  approval_decided_at: new Date("2026-07-01T10:00:00.000Z"),
  approval_decided_by: "user_original",
  approval_reason: "price change accepted",
  generated_order_id: "order_from_a_past_period",
  applied_pending_update_data: { variant_id: "variant_old" },
  last_error: "kept as is",
  attempt_count: 2,
  metadata: {
    settings_policy: {
      default_renewal_behavior: "require_review_for_pending_changes",
      settings_version: 3,
      is_persisted: true,
    },
  },
  ...overrides,
})

/** The payload the step's `updated` / `adopted` returns hand the compensation. */
const snapshotOf = (
  before: UpcomingRenewalCycleRecord
): UpcomingCycleReconcileSnapshot => ({
  id: before.id,
  ...restoreForUpcomingCycleReconcile(before),
})

/** Every column a reconciliation write can touch, plus the id selecting the row. */
const RESTORE_FIELD_SET = [
  "approval_decided_at",
  "approval_decided_by",
  "approval_reason",
  "approval_required",
  "approval_status",
  "id",
  "metadata",
  "scheduled_for",
]

function fakeReconcileWriter() {
  const updates: UpcomingCycleReconcileSnapshot[] = []

  return {
    updates,
    writer: {
      async updateRenewalCycles(data: UpcomingCycleReconcileSnapshot) {
        updates.push(data)
      },
    },
  }
}

describe("restoreReconciledCycle", () => {
  it("restores every column the reconcile write may have changed, and nothing else", async () => {
    const fake = fakeReconcileWriter()

    await restoreReconciledCycle(fake.writer, snapshotOf(cycle()))

    expect(fake.updates).toHaveLength(1)
    expect(Object.keys(fake.updates[0]).sort()).toEqual(RESTORE_FIELD_SET)
  })

  it("puts back the pre-write value of every column it restores", async () => {
    const before = cycle()
    const fake = fakeReconcileWriter()

    await restoreReconciledCycle(fake.writer, snapshotOf(before))

    const restored = fake.updates[0]
    expect(restored.id).toBe("renewal_cycle_adopted")
    expect(restored.scheduled_for).toEqual(
      new Date("2026-08-24T10:00:00.000Z")
    )
    expect(restored.approval_required).toBe(true)
    expect(restored.approval_status).toBe(RenewalApprovalStatus.APPROVED)
    expect(restored.approval_decided_at).toEqual(
      new Date("2026-07-01T10:00:00.000Z")
    )
    expect(restored.approval_decided_by).toBe("user_original")
    expect(restored.approval_reason).toBe("price change accepted")
    expect(restored.metadata).toEqual(before.metadata)
  })

  /**
   * The `adopted` case, which is what this spec was opened for: an adopt moves
   * the row onto the entitlement date, and a rollback that restored the approval
   * state and the settings policy while leaving the moved date behind would put
   * the row back into the period the failed run claimed for it.
   */
  it("moves back the date an adopt changed, not only the state it re-derived", async () => {
    const entitlementDate = new Date("2026-11-24T10:00:00.000Z")
    const before = cycle({ scheduled_for: new Date("2026-08-24T10:00:00.000Z") })
    const fake = fakeReconcileWriter()

    await restoreReconciledCycle(fake.writer, snapshotOf(before))

    expect(fake.updates[0].scheduled_for).toEqual(before.scheduled_for)
    expect(fake.updates[0].scheduled_for).not.toEqual(entitlementDate)
  })

  /**
   * A cleared approval state has to travel as an explicit `null`. A payload that
   * dropped the empty columns would leave the row holding the pending approval
   * the failed run derived for it — the defect this rollback exists to prevent.
   */
  it("carries a cleared approval state as nulls rather than as absent columns", async () => {
    const before = cycle({
      approval_required: false,
      approval_status: null,
      approval_decided_at: null,
      approval_decided_by: null,
      approval_reason: null,
      metadata: null,
    })
    const fake = fakeReconcileWriter()

    await restoreReconciledCycle(fake.writer, snapshotOf(before))

    const restored = fake.updates[0]
    const written = Object.keys(restored)

    expect(written).toContain("approval_status")
    expect(written).toContain("approval_decided_at")
    expect(written).toContain("approval_decided_by")
    expect(written).toContain("approval_reason")
    expect(written).toContain("metadata")
    expect(restored.approval_required).toBe(false)
    expect(restored.approval_status).toBeNull()
    expect(restored.approval_decided_at).toBeNull()
    expect(restored.approval_decided_by).toBeNull()
    expect(restored.approval_reason).toBeNull()
    expect(restored.metadata).toBeNull()
  })
})
