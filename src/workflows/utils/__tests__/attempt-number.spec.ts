/**
 * Spec: `.agents/specs/2026-10-08-manual-renewal-attempts-and-trial-bind-reuse.md`.
 *
 * The bug this pins down: `createManualRenewalStep` hardcoded
 * `attempt_no: 1`, so the second `/renew` on a cycle that already carried an
 * attempt collided with
 * `IDX_renewal_attempt_renewal_cycle_id_attempt_no_unique` — permanently, since
 * a failed workflow step keeps its own committed writes.
 */
import { nextAttemptNumber } from "../attempt-number"

describe("nextAttemptNumber", () => {
  it("returns 1 when the cycle has no attempts yet", () => {
    expect(nextAttemptNumber([])).toBe(1)
  })

  it("returns max + 1 so a retry never collides with the unique index", () => {
    expect(nextAttemptNumber([{ attempt_no: 1 }])).toBe(2)
    expect(nextAttemptNumber([{ attempt_no: 1 }, { attempt_no: 3 }])).toBe(4)
  })

  it("does not depend on row order", () => {
    expect(nextAttemptNumber([{ attempt_no: 3 }, { attempt_no: 1 }])).toBe(4)
  })

  it("treats missing and non-numeric values as absent", () => {
    expect(nextAttemptNumber([{ attempt_no: null }, { attempt_no: 2 }])).toBe(3)
    expect(nextAttemptNumber([{}])).toBe(1)
  })
})
