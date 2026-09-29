import { Migration } from "@medusajs/framework/mikro-orm/migrations"

/**
 * Creates the `trial_claim` ledger (Phase 12 of the billing hardening plan,
 * Task 20): one row per trial claim, keyed on (`customer_id`, `product_id`).
 *
 * The unique index is the race-safe anchor of the eligibility rule: two
 * concurrent claims for the same customer and product cannot both win, no
 * matter which door each came through, and because it lives on a table this
 * feature owns, no webhook-driven mirror write can collide with it.
 *
 * The index is partial (`WHERE deleted_at IS NULL`) on purpose: it follows
 * the soft-delete convention every other unique index on a soft-deletable
 * table in this repo uses (the migration generator itself emits that clause
 * for model-declared unique indexes — see
 * `src/modules/subscription/migrations/Migration20260327143452.ts`), so a
 * later `medusa plugin:db:generate` run does not propose dropping it, and a
 * soft-deleted row frees the pair it held. Two concurrent live claims still
 * collide, which is the property the rule needs.
 *
 * There is no `provider_subscription` column (Q11): a provider-managed
 * subscription never passes through any door that writes this ledger.
 *
 * `down()` drops the table. Unlike a status rollback, this loses no
 * money-relevant state: the trial subscriptions themselves survive; only the
 * claim bookkeeping (and with it, the "already claimed" answer for pairs
 * whose only record was a ledger row) is gone. Rolling back together with a
 * code rollback removes the ledger's readers too.
 */
export class Migration20260929140000 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`create table if not exists "trial_claim" ("id" text not null, "customer_id" text not null, "product_id" text not null, "variant_id" text not null, "claimed_at" timestamptz not null, "trial_ends_at" timestamptz null, "source" text check ("source" in ('self_service', 'redemption', 'admin')) not null, "subscription_id" text not null, "binding_method" text check ("binding_method" in ('none', 'vault')) not null default 'none', "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "trial_claim_pkey" primary key ("id"));`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_trial_claim_customer_id" ON "trial_claim" ("customer_id") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_trial_claim_product_id" ON "trial_claim" ("product_id") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_trial_claim_subscription_id" ON "trial_claim" ("subscription_id") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "trial_claim_customer_product_unique" ON "trial_claim" ("customer_id", "product_id") WHERE deleted_at IS NULL;`);
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "trial_claim";`);
  }

}
