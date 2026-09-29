import { Migration } from "@medusajs/framework/mikro-orm/migrations"

// The exact list `Migration20260922120000.up()` installed: the 25 values from
// `Migration20260909130000` plus `subscription.creation_failed`.
const PREVIOUS_EVENT_TYPES =
  "'subscription.created', 'subscription.paused', 'subscription.resumed', 'subscription.canceled', 'subscription.plan_change_scheduled', 'subscription.shipping_address_updated', 'subscription.next_delivery_skipped', 'subscription.payment_method_updated', 'subscription.expired', 'redemption.redeemed', 'renewal.cycle_created', 'renewal.approval_approved', 'renewal.approval_rejected', 'renewal.force_requested', 'renewal.succeeded', 'renewal.failed', 'dunning.started', 'dunning.retry_executed', 'dunning.recovered', 'dunning.unrecovered', 'dunning.retry_schedule_updated', 'cancellation.case_started', 'cancellation.offer_applied', 'cancellation.reason_updated', 'cancellation.finalized', 'subscription.creation_failed'"

// Task 12 of the billing hardening plan: the two operational renewal events
// are appended (list order carries no meaning to the check; every migration in
// this directory appends, so the previous list stays a prefix of the next one).
const NEXT_EVENT_TYPES = `${PREVIOUS_EVENT_TYPES}, 'renewal.abandoned', 'renewal.awaiting_manual_resolution'`

export class Migration20260929120000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `alter table if exists "subscription_log" drop constraint if exists "subscription_log_event_type_check";`
    )
    this.addSql(
      `alter table if exists "subscription_log" add constraint "subscription_log_event_type_check" check("event_type" in (${NEXT_EVENT_TYPES}));`
    )
  }

  override async down(): Promise<void> {
    this.addSql(
      `alter table if exists "subscription_log" drop constraint if exists "subscription_log_event_type_check";`
    )

    // `add constraint ... check` validates the rows already in the table, so
    // the rows this migration made legal are removed before the constraint is
    // re-added — the same ordering the 1.6.0 rollback defect (see
    // `Migration20260922120000.down()`) got wrong.
    this.addSql(
      `delete from "subscription_log" where "event_type" in ('renewal.abandoned', 'renewal.awaiting_manual_resolution');`
    )
    this.addSql(
      `alter table if exists "subscription_log" add constraint "subscription_log_event_type_check" check("event_type" in (${PREVIOUS_EVENT_TYPES}));`
    )
  }
}
