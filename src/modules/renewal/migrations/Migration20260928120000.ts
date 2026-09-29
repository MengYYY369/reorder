import { Migration } from "@medusajs/framework/mikro-orm/migrations";

/**
 * Two new renewal cycle states for the billing-engine hardening work:
 * `abandoned` (terminal — structural retries or dunning are exhausted) and
 * `awaiting_manual_resolution` (parked — a human must decide; the period is
 * neither paid nor written off). Neither is selected by the scheduler's due
 * query, which reads `status in [scheduled, failed]`. Nothing writes these
 * states yet; later tasks own the writers. This migration only widens what
 * the database accepts and adds the two failure-bookkeeping columns
 * (`last_failure_kind` records the failure classifier's verdict,
 * `structural_attempt_count` counts consecutive structural failures and is
 * deliberately separate from `attempt_count`, which also counts payment
 * attempts dunning owns).
 *
 * The constraint name is not a guess: the original table was created with an
 * inline `check ("status" in (...))`, so Postgres generated the name, and it
 * was read back from a database created by that very migration as
 * `renewal_cycle_status_check` (alongside `renewal_cycle_approval_status_check`).
 * Use the explicit name; a different name would leave the old constraint in
 * place and the new states would still be rejected.
 */
export class Migration20260928120000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `alter table if exists "renewal_cycle" drop constraint if exists "renewal_cycle_status_check";`
    );
    this.addSql(
      `alter table if exists "renewal_cycle" add constraint "renewal_cycle_status_check" check ("status" in ('scheduled', 'processing', 'succeeded', 'failed', 'abandoned', 'awaiting_manual_resolution'));`
    );
    this.addSql(
      `alter table if exists "renewal_cycle" add column if not exists "last_failure_kind" text null;`
    );
    this.addSql(
      `alter table if exists "renewal_cycle" add column if not exists "structural_attempt_count" integer not null default 0;`
    );
  }

  /**
   * Maps `abandoned` and `awaiting_manual_resolution` rows back to `failed`
   * BEFORE restoring the old four-value constraint — the rows would otherwise
   * violate it and the rollback would abort. That remap re-arms them for the
   * scheduler, which is exactly the behaviour these states exist to remove, so
   * this rollback is only safe together with a code rollback: running it while
   * the current code is deployed sends unpaid periods back into the retry
   * loop. The rows are remapped, never dropped — losing the record of an
   * unpaid period is worse than retrying it. The two new columns are left in
   * place; old code ignores them.
   */
  override async down(): Promise<void> {
    this.addSql(
      `update "renewal_cycle" set "status" = 'failed' where "status" in ('abandoned', 'awaiting_manual_resolution');`
    );
    this.addSql(
      `alter table if exists "renewal_cycle" drop constraint if exists "renewal_cycle_status_check";`
    );
    this.addSql(
      `alter table if exists "renewal_cycle" add constraint "renewal_cycle_status_check" check ("status" in ('scheduled', 'processing', 'succeeded', 'failed'));`
    );
  }
}
