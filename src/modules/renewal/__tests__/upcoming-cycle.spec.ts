import {
  RenewalApprovalStatus,
  RenewalCycleStatus,
} from "../types"
import {
  restoreForUpcomingCycleReconcile,
  resolveUpcomingCycle,
  type UpcomingCycleReconcilePatch,
  type UpcomingCycleReconcileRestore,
  type UpcomingCycleResolution,
  type UpcomingRenewalCycleRecord,
} from "../utils/upcoming-cycle"

/**
 * Pure spec for the two decisions the upcoming-cycle step delegates to the
 * renewal module: `resolveUpcomingCycle` picks what to do with the rows a
 * subscription already carries (every branch of the invariant #08), and
 * `restoreForUpcomingCycleReconcile` builds the rollback of the write that
 * applies the pick. Neither needs a database.
 */

const cycle = (
  overrides: Partial<UpcomingRenewalCycleRecord> = {}
): UpcomingRenewalCycleRecord => ({
  id: "renewal_cycle_1",
  subscription_id: "sub_1",
  scheduled_for: new Date("2026-10-24T10:00:00.000Z"),
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

describe("resolveUpcomingCycle", () => {
  describe("match", () => {
    it("matches the cycle already dated at the entitlement date", () => {
      const scheduled = cycle({
        scheduled_for: new Date("2026-11-24T10:00:00.000Z"),
      })

      expect(
        resolveUpcomingCycle([scheduled], new Date("2026-11-24T10:00:00.000Z"))
      ).toEqual<UpcomingCycleResolution>({
        action: "match",
        cycle: scheduled,
      })
    })

    it("matches a processing cycle on its exact date so its approval state stays reconcilable", () => {
      const processing = cycle({
        status: RenewalCycleStatus.PROCESSING,
        approval_required: true,
        approval_status: RenewalApprovalStatus.PENDING,
        scheduled_for: new Date("2026-11-24T10:00:00.000Z"),
      })

      expect(
        resolveUpcomingCycle([processing], new Date("2026-11-24T10:00:00.000Z"))
      ).toEqual<UpcomingCycleResolution>({ action: "match", cycle: processing })
    })

    it("prefers the exact-date hit over a differently dated scheduled row", () => {
      const stale = cycle({ id: "renewal_cycle_stale" })
      const exact = cycle({
        id: "renewal_cycle_exact",
        scheduled_for: new Date("2026-11-24T10:00:00.000Z"),
      })

      expect(
        resolveUpcomingCycle(
          [stale, exact],
          new Date("2026-11-24T10:00:00.000Z")
        )
      ).toEqual<UpcomingCycleResolution>({ action: "match", cycle: exact })
    })

    /**
     * Pinned contract (round-1 review, minor #4): an exact-date hit outranks an
     * open row for EVERY status, so a stale live `scheduled` row behind a
     * terminal one is reported as `match` and deliberately not adopted. Adopting
     * it would move a chargeable cycle onto a period the terminal row already
     * settled, i.e. trade a drift the step cannot repair for a double charge.
     * Closing the seam needs a step that deletes a row it does not own, and
     * neither the normalize migration nor
     * `renewal_cycle_one_scheduled_per_subscription` can produce this shape from
     * a new write any more.
     */
    it("matches a failed cycle on the entitlement date instead of adopting a stale scheduled row", () => {
      const stale = cycle({
        id: "renewal_cycle_stale",
        scheduled_for: new Date("2026-08-24T10:00:00.000Z"),
      })
      const failed = cycle({
        id: "renewal_cycle_failed",
        status: RenewalCycleStatus.FAILED,
        scheduled_for: new Date("2026-11-24T10:00:00.000Z"),
      })

      expect(
        resolveUpcomingCycle(
          [stale, failed],
          new Date("2026-11-24T10:00:00.000Z")
        )
      ).toEqual<UpcomingCycleResolution>({ action: "match", cycle: failed })
    })

    it("matches a succeeded cycle on the entitlement date instead of adopting a stale scheduled row", () => {
      const stale = cycle({
        id: "renewal_cycle_stale",
        scheduled_for: new Date("2026-08-24T10:00:00.000Z"),
      })
      const succeeded = cycle({
        id: "renewal_cycle_succeeded",
        status: RenewalCycleStatus.SUCCEEDED,
        scheduled_for: new Date("2026-11-24T10:00:00.000Z"),
        generated_order_id: "order_paid",
      })

      expect(
        resolveUpcomingCycle(
          [stale, succeeded],
          new Date("2026-11-24T10:00:00.000Z")
        )
      ).toEqual<UpcomingCycleResolution>({
        action: "match",
        cycle: succeeded,
      })
    })
  })

  describe("adopt", () => {
    it("adopts a past-dated scheduled row that carries no order", () => {
      const stale = cycle({
        scheduled_for: new Date("2026-08-24T10:00:00.000Z"),
      })

      expect(
        resolveUpcomingCycle([stale], new Date("2026-11-24T10:00:00.000Z"))
      ).toEqual<UpcomingCycleResolution>({ action: "adopt", cycle: stale })
    })

    it("adopts the future-dated scheduled row a stacked purchase left behind", () => {
      const folded = cycle({
        scheduled_for: new Date("2026-10-24T10:00:00.000Z"),
      })

      expect(
        resolveUpcomingCycle([folded], new Date("2026-11-24T10:00:00.000Z"))
      ).toEqual<UpcomingCycleResolution>({ action: "adopt", cycle: folded })
    })

    it("adopts the latest scheduled row when drift left two of them", () => {
      const older = cycle({ id: "renewal_cycle_older" })
      const newer = cycle({
        id: "renewal_cycle_newer",
        scheduled_for: new Date("2026-12-24T10:00:00.000Z"),
      })

      for (const input of [
        [older, newer],
        [newer, older],
      ]) {
        expect(
          resolveUpcomingCycle(input, new Date("2027-01-24T10:00:00.000Z"))
        ).toEqual<UpcomingCycleResolution>({ action: "adopt", cycle: newer })
      }
    })

    it("ignores terminal rows when picking a row to adopt", () => {
      const succeeded = cycle({
        id: "renewal_cycle_succeeded",
        status: RenewalCycleStatus.SUCCEEDED,
        scheduled_for: new Date("2026-09-24T10:00:00.000Z"),
      })
      const failed = cycle({
        id: "renewal_cycle_failed",
        status: RenewalCycleStatus.FAILED,
        scheduled_for: new Date("2026-08-24T10:00:00.000Z"),
      })
      const scheduled = cycle({
        id: "renewal_cycle_scheduled",
        scheduled_for: new Date("2026-07-24T10:00:00.000Z"),
      })

      expect(
        resolveUpcomingCycle(
          [succeeded, failed, scheduled],
          new Date("2026-11-24T10:00:00.000Z")
        )
      ).toEqual<UpcomingCycleResolution>({
        action: "adopt",
        cycle: scheduled,
      })
    })
  })

  describe("defer", () => {
    it("defers a scheduled row that already carries a generated order", () => {
      const inFlight = cycle({
        id: "renewal_cycle_in_flight",
        scheduled_for: new Date("2026-09-24T10:00:00.000Z"),
        generated_order_id: "order_unpaid",
      })

      expect(
        resolveUpcomingCycle([inFlight], new Date("2026-11-24T10:00:00.000Z"))
      ).toEqual<UpcomingCycleResolution>({ action: "defer", cycle: inFlight })
    })

    it("defers a processing row, whose renewal is already under way", () => {
      const processing = cycle({
        id: "renewal_cycle_processing",
        status: RenewalCycleStatus.PROCESSING,
        scheduled_for: new Date("2026-09-24T10:00:00.000Z"),
      })

      expect(
        resolveUpcomingCycle([processing], new Date("2026-11-24T10:00:00.000Z"))
      ).toEqual<UpcomingCycleResolution>({
        action: "defer",
        cycle: processing,
      })
    })

    it("defers on a free scheduled row that carries an order before adopting a later in-flight one", () => {
      // The in-flight manual row wins the latest-date comparison, so the step
      // must not reschedule anything: the older unpaid row keeps its date too.
      const unpaid = cycle({
        id: "renewal_cycle_unpaid",
        scheduled_for: new Date("2026-09-24T10:00:00.000Z"),
        generated_order_id: "order_unpaid",
      })
      const free = cycle({
        id: "renewal_cycle_free",
        scheduled_for: new Date("2026-08-24T10:00:00.000Z"),
      })

      expect(
        resolveUpcomingCycle(
          [unpaid, free],
          new Date("2026-11-24T10:00:00.000Z")
        )
      ).toEqual<UpcomingCycleResolution>({ action: "defer", cycle: unpaid })
    })
  })

  describe("create", () => {
    it("creates when there is no row at all", () => {
      expect(
        resolveUpcomingCycle([], new Date("2026-11-24T10:00:00.000Z"))
      ).toEqual<UpcomingCycleResolution>({ action: "create" })
    })

    it("creates when every existing row is terminal", () => {
      const succeeded = cycle({
        status: RenewalCycleStatus.SUCCEEDED,
        scheduled_for: new Date("2026-09-24T10:00:00.000Z"),
      })
      const failed = cycle({
        id: "renewal_cycle_2",
        status: RenewalCycleStatus.FAILED,
        scheduled_for: new Date("2026-08-24T10:00:00.000Z"),
      })

      expect(
        resolveUpcomingCycle(
          [succeeded, failed],
          new Date("2026-11-24T10:00:00.000Z")
        )
      ).toEqual<UpcomingCycleResolution>({ action: "create" })
    })
  })
})

/**
 * The step sends one patch object and hands back its mirror in the same
 * statement, so a rollback has to cover everything the write touched. An
 * `adopt` does not only move `scheduled_for`: it also re-derives the approval
 * state and restamps `metadata.settings_policy`. Restoring the date alone
 * (round-1 review, finding 2) left a rolled-back row carrying the approval state
 * and the settings policy of the run that failed.
 */
describe("restoreForUpcomingCycleReconcile", () => {
  const before = cycle({
    id: "renewal_cycle_adopted",
    scheduled_for: new Date("2026-08-24T10:00:00.000Z"),
    approval_required: true,
    approval_status: RenewalApprovalStatus.APPROVED,
    approval_decided_at: new Date("2026-07-01T10:00:00.000Z"),
    approval_decided_by: "user_original",
    approval_reason: "price change accepted",
    last_error: "kept as is",
    attempt_count: 2,
    metadata: {
      settings_policy: {
        default_renewal_behavior: "require_review_for_pending_changes",
        settings_version: 3,
      },
    },
  })

  it("restores the approval state and the settings policy an adopt overwrote, not only its date", () => {
    expect(restoreForUpcomingCycleReconcile(before)).toEqual<
      UpcomingCycleReconcileRestore
    >({
      scheduled_for: new Date("2026-08-24T10:00:00.000Z"),
      approval_required: true,
      approval_status: RenewalApprovalStatus.APPROVED,
      approval_decided_at: new Date("2026-07-01T10:00:00.000Z"),
      approval_decided_by: "user_original",
      approval_reason: "price change accepted",
      metadata: {
        settings_policy: {
          default_renewal_behavior: "require_review_for_pending_changes",
          settings_version: 3,
        },
      },
    })
  })

  it("carries a value for every field a reconciliation patch can write", () => {
    const patch: UpcomingCycleReconcilePatch = {
      scheduled_for: new Date("2026-11-24T10:00:00.000Z"),
      approval_required: false,
      approval_status: null,
      approval_decided_at: null,
      approval_decided_by: null,
      approval_reason: null,
      metadata: {},
    }
    const restore = restoreForUpcomingCycleReconcile(before)

    for (const field of Object.keys(patch)) {
      expect(restore).toHaveProperty(field)
    }

    expect(Object.keys(restore).sort()).toEqual([
      "approval_decided_at",
      "approval_decided_by",
      "approval_reason",
      "approval_required",
      "approval_status",
      "metadata",
      "scheduled_for",
    ])
  })

  it("rejects a rollback snapshot narrower than the write it undoes", () => {
    /**
     * Compile-time half of the contract, stated as a NEGATIVE: the object the
     * reviewed defect produced (a rollback restoring only `scheduled_for`) must
     * be rejected by `UpcomingCycleReconcileRestore`, and the directive below is
     * the assertion. Unlike a type-level equality it can fail in both
     * directions, so it is checked against the build gate
     * (`medusa plugin:build`, which typechecks this file) and
     * `corepack yarn tsc --noEmit -p tsconfig.json` rather than assumed. Both
     * mutations were applied and re-typechecked (baseline: 87 pre-existing
     * `error TS` lines, all of them in `integration-tests/**`, none under
     * `src/modules/renewal/**` or `src/workflows/**`):
     * - a key added to `UpcomingCycleReconcilePatch` without being filled by
     *   `restoreForUpcomingCycleReconcile` is a compile error even when the new
     *   key is optional, because `-?` in the mapped type requires it in the
     *   rollback: `error TS2741: Property 'probe_only_field' is missing ... but
     *   required in type 'UpcomingCycleReconcileRestore'` on the return value of
     *   `restoreForUpcomingCycleReconcile`, plus the same missing-property note
     *   on the deep equality case above (`error TS2345`).
     * - loosening the snapshot type to `Partial<UpcomingCycleReconcilePatch>`
     *   makes the directive below redundant, which the same gate rejects:
     *   `error TS2578: Unused '@ts-expect-error' directive` on this file's
     *   `tooNarrow` assignment, and nothing else in `src/` changes.
     *
     * What this replaces: an `Exclude<keyof UpcomingCycleReconcilePatch,
     * keyof UpcomingCycleReconcileRestore> extends never` check plus its mirror,
     * which could not go red: `UpcomingCycleReconcileRestore` is a mapped type
     * over exactly those keys, so both `Exclude`s are `never` by construction no
     * matter how far the write and the rollback drift apart. The first probe
     * above demonstrates that: it reddened two real assertions in this pair of
     * files while leaving that one satisfied.
     */
    const dateOnlyRollback = { scheduled_for: before.scheduled_for }

    // @ts-expect-error a rollback that restores only the date is not a snapshot
    const tooNarrow: UpcomingCycleReconcileRestore = dateOnlyRollback

    // The rejected shape really is the incomplete one: the shipped rollback
    // restores fields it leaves out.
    expect(Object.keys(tooNarrow)).not.toEqual(
      Object.keys(restoreForUpcomingCycleReconcile(before))
    )
  })
})
