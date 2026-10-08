/**
 * The next `attempt_no` for a renewal cycle.
 *
 * `renewal_attempt` carries a partial unique index —
 * `IDX_renewal_attempt_renewal_cycle_id_attempt_no_unique UNIQUE
 * (renewal_cycle_id, attempt_no) WHERE deleted_at IS NULL` — and
 * `createManualRenewalStep` used to hardcode `attempt_no: 1`. The second
 * `/renew` on the same cycle therefore always collided.
 *
 * It never recovered, because **a failed Medusa v2 workflow step does not roll
 * back its own committed writes**: measured in production on 2026-10-08, the
 * first attempt and the order it had already created both survived the failure
 * that aborted the step, so every subsequent retry collided with the same row
 * and the subscription could not be renewed again. The collision surfaced as
 * `invalid_data` (via the DAL error mapper) rather than as a customer refusal,
 * so it was rethrown as `unexpected_state` and answered 500 with no inner
 * detail in the log.
 *
 * Max + 1, not "first free slot": gaps carry no meaning, and a monotonically
 * increasing number keeps the retry history readable.
 */
export function nextAttemptNumber(
  existing: { attempt_no?: number | null }[]
): number {
  const highest = existing.reduce((max, row) => {
    const value = typeof row.attempt_no === "number" ? row.attempt_no : 0

    return value > max ? value : max
  }, 0)

  return highest + 1
}
