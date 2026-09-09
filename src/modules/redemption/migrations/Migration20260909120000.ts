import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20260909120000 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`create table if not exists "redemption_batch" ("id" text not null, "name" text not null, "variant_id" text not null, "frequency_interval" text check ("frequency_interval" in ('week', 'month', 'year')) not null default 'month', "frequency_value" integer not null default 1, "free_cycles" integer not null default 1, "status" text check ("status" in ('active', 'disabled')) not null default 'active', "code_prefix" text not null default 'RDM', "max_redemptions_per_code" integer not null default 1, "starts_at" timestamptz null, "expires_at" timestamptz null, "metadata" jsonb null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "redemption_batch_pkey" primary key ("id"));`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_redemption_batch_variant_id" ON "redemption_batch" ("variant_id") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_redemption_batch_status" ON "redemption_batch" ("status") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_redemption_batch_name" ON "redemption_batch" ("name") WHERE deleted_at IS NULL;`);

    this.addSql(`create table if not exists "redemption_code" ("id" text not null, "batch_id" text not null, "code" text not null, "status" text check ("status" in ('active', 'disabled')) not null default 'active', "max_redemptions" integer not null default 1, "redemption_count" integer not null default 0, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "redemption_code_pkey" primary key ("id"));`);
    this.addSql(`alter table if exists "redemption_code" add constraint "redemption_code_batch_id_foreign" foreign key ("batch_id") references "redemption_batch" ("id") on update cascade on delete cascade deferrable initially deferred;`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_redemption_code_code_unique" ON "redemption_code" (LOWER("code")) WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_redemption_code_batch_id" ON "redemption_code" ("batch_id") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_redemption_code_status" ON "redemption_code" ("status") WHERE deleted_at IS NULL;`);

    this.addSql(`create table if not exists "redemption_record" ("id" text not null, "batch_id" text not null, "code_id" text not null, "customer_id" text not null, "subscription_id" text not null, "outcome" text check ("outcome" in ('subscription_created', 'subscription_extended')) not null, "free_cycles_applied" integer not null default 0, "frequency_interval" text check ("frequency_interval" in ('week', 'month', 'year')) not null, "frequency_value" integer not null default 1, "metadata" jsonb null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "redemption_record_pkey" primary key ("id"));`);
    this.addSql(`alter table if exists "redemption_record" add constraint "redemption_record_batch_id_foreign" foreign key ("batch_id") references "redemption_batch" ("id") on update cascade on delete cascade deferrable initially deferred;`);
    this.addSql(`alter table if exists "redemption_record" add constraint "redemption_record_code_id_foreign" foreign key ("code_id") references "redemption_code" ("id") on update cascade on delete cascade deferrable initially deferred;`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_redemption_record_code_customer_unique" ON "redemption_record" ("code_id", "customer_id") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_redemption_record_batch_id" ON "redemption_record" ("batch_id") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_redemption_record_code_id" ON "redemption_record" ("code_id") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_redemption_record_customer_id" ON "redemption_record" ("customer_id") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_redemption_record_subscription_id" ON "redemption_record" ("subscription_id") WHERE deleted_at IS NULL;`);
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "redemption_record";`);
    this.addSql(`drop table if exists "redemption_code";`);
    this.addSql(`drop table if exists "redemption_batch";`);
  }

}
