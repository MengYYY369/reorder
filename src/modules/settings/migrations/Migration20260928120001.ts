import { Migration } from "@medusajs/framework/mikro-orm/migrations";

/**
 * Two renewal policy settings on the global subscription settings singleton:
 * `renewal_max_attempts` caps consecutive renewal attempts for one period
 * (consumed by the renewal failure-cap logic) and
 * `renewal_reminder_lead_days` schedules the upcoming-renewal reminder job
 * that many days before the next renewal (0 disables the job). Both default
 * to 3, so existing singleton rows are backfilled to the same defaults the
 * settings service falls back to.
 *
 * `add column if not exists` keeps the migration idempotent: a database that
 * already carries the columns (e.g. re-run against a schema generated from
 * entities) is left untouched instead of failing on a duplicate column.
 */
export class Migration20260928120001 extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `alter table if exists "subscription_settings" add column if not exists "renewal_max_attempts" integer not null default 3;`
    );
    this.addSql(
      `alter table if exists "subscription_settings" add column if not exists "renewal_reminder_lead_days" integer not null default 3;`
    );
  }

  override async down(): Promise<void> {
    this.addSql(
      `alter table if exists "subscription_settings" drop column if exists "renewal_max_attempts";`
    );
    this.addSql(
      `alter table if exists "subscription_settings" drop column if exists "renewal_reminder_lead_days";`
    );
  }
}
