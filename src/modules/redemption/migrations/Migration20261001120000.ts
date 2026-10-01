import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20261001120000 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`alter table if exists "redemption_batch" add column if not exists "trial_enabled" boolean not null default false, add column if not exists "trial_days" integer null, add column if not exists "trial_bonus_days" integer null, add column if not exists "trial_requires_payment_method" boolean not null default false;`);
  }

  override async down(): Promise<void> {
    this.addSql(`alter table if exists "redemption_batch" drop column if exists "trial_enabled", drop column if exists "trial_days", drop column if exists "trial_bonus_days", drop column if exists "trial_requires_payment_method";`);
  }

}
