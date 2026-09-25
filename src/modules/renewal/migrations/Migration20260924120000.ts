import { Migration } from "@medusajs/framework/mikro-orm/migrations";

/**
 * Ticket #08, the upcoming-cycle invariant, enforced where it is written: a
 * subscription may own at most one live `renewal_cycle` row in status
 * `scheduled`. Before this migration a stacked purchase (`row_stacking_policy`
 * `extend`) pushed `next_renewal_at` forward and the ensure step appended a
 * second future cycle, so the off-session scheduler charged the customer at
 * both dates.
 *
 * Hand-authored on purpose. MikroORM can express a unique index and its
 * generator already emits the `WHERE deleted_at IS NULL` predicate (see
 * `src/modules/redemption/migrations/Migration20260909120000.ts`), but it
 * cannot express the extra `status = 'scheduled'` predicate, so nothing here is
 * derived from the models. Consequence to watch: a later
 * `medusa plugin:db:generate` has no model to compare against and may propose
 * dropping this index. That drop is a regression, not cleanup: without the
 * constraint the duplicate is written silently again.
 */
export class Migration20260924120000 extends Migration {
  override async up(): Promise<void> {
    /**
     * Normalize first, then constrain: creating the index on a drifted database
     * fails outright ("could not create unique index ... is duplicated"), which
     * would break every host upgrade that carries drift.
     *
     * Rules applied:
     * - duplicates are soft-deleted, never flipped to `failed`, because
     *   `listDueRenewalCyclesForProcessing` selects `status in [scheduled,
     *   failed]` and a `failed` row would be re-armed for a charge
     * - the surviving row is the one already matching
     *   `subscription.next_renewal_at`, otherwise the most recent one, which is
     *   the same preference `resolveUpcomingCycle` applies
     *
     * The `subscription` lookup is guarded rather than plain because the plugin's
     * module migrators run in alphabetical module order: on a fresh database the
     * renewal module is migrated before the subscription module has created its
     * table, and an unguarded join would abort that run. A database with no
     * `subscription` table cannot hold drift against an entitlement date, so the
     * fallback ordering (most recent first) is sufficient there.
     *
     * The guard is `to_regclass('"subscription"')`, deliberately *not*
     * `to_regclass('public.subscription')`. Everything else in this migration
     * names its tables unqualified and resolves them through `search_path`, and
     * a host may well keep the plugin in another schema: measured on Postgres 16
     * with `search_path = r1_ns, public` and `subscription` in `r1_ns` only,
     * `to_regclass('public.subscription')` is NULL while the same session's plain
     * `from "subscription"` reads `r1_ns.subscription`, so the hard-coded form
     * silently degraded the normalization to newest-first and soft-deleted the
     * entitlement-matching row instead. A quoted bare name resolves through
     * `search_path` exactly like the join does (verified: it returned the
     * `r1_ns` relation, and `public.subscription` for a public-schema host), so
     * the guard now answers for the very table the statement joins.
     */
    this.addSql(`DO $$
DECLARE
  entitlement_join text := '';
  prefer_entitlement text := '';
BEGIN
  IF to_regclass('"subscription"') IS NOT NULL THEN
    entitlement_join := ' left join "subscription" sub on sub."id" = rc."subscription_id"';
    prefer_entitlement := '(coalesce(rc."scheduled_for" = sub."next_renewal_at", false)) desc, ';
  END IF;

  EXECUTE 'with live_scheduled as (
              select rc."id" as cycle_id,
                     row_number() over (
                       partition by rc."subscription_id"
                       order by ' || prefer_entitlement || 'rc."scheduled_for" desc, rc."id"
                     ) as row_rank
                from "renewal_cycle" rc' || entitlement_join || '
               where rc."status" = ''scheduled''
                 and rc."deleted_at" is null
           )
           update "renewal_cycle" target
              set "deleted_at" = now(),
                  "updated_at" = now(),
                  "last_error" = ''normalized: duplicate upcoming cycle removed by the 1.6.0 uniqueness migration''
             from live_scheduled duplicate
            where target."id" = duplicate.cycle_id
              and duplicate.row_rank > 1';
END $$;`);

    this.addSql(
      `create unique index if not exists "renewal_cycle_one_scheduled_per_subscription" on "renewal_cycle" ("subscription_id") where "status" = 'scheduled' and "deleted_at" is null;`
    );
  }

  /**
   * Drops the index only; normalized duplicates stay soft-deleted. Restoring
   * them would put a second chargeable cycle back on the scheduler's list, so a
   * rollback removes the constraint without reviving the money it was added to
   * protect. This asymmetry is intentional and documented here for the host
   * upgrade notes.
   */
  override async down(): Promise<void> {
    this.addSql(
      `drop index if exists "renewal_cycle_one_scheduled_per_subscription";`
    );
  }
}
