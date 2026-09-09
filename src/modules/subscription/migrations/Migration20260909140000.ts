import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20260909140000 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`alter table if exists "subscription" add column if not exists "free_cycles_remaining" integer not null default 0;`);
  }

  override async down(): Promise<void> {
    this.addSql(`alter table if exists "subscription" drop column if exists "free_cycles_remaining";`);
  }

}
