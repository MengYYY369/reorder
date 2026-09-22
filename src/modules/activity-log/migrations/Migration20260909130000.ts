import { Migration } from "@medusajs/framework/mikro-orm/migrations"

const PREVIOUS_EVENT_TYPES =
  "'subscription.created', 'subscription.paused', 'subscription.resumed', 'subscription.canceled', 'subscription.plan_change_scheduled', 'subscription.shipping_address_updated', 'subscription.next_delivery_skipped', 'subscription.payment_method_updated', 'renewal.cycle_created', 'renewal.approval_approved', 'renewal.approval_rejected', 'renewal.force_requested', 'renewal.succeeded', 'renewal.failed', 'dunning.started', 'dunning.retry_executed', 'dunning.recovered', 'dunning.unrecovered', 'dunning.retry_schedule_updated', 'cancellation.case_started', 'cancellation.offer_applied', 'cancellation.reason_updated', 'cancellation.finalized'"

const NEXT_EVENT_TYPES = `${PREVIOUS_EVENT_TYPES}, 'subscription.expired', 'redemption.redeemed'`

export class Migration20260909130000 extends Migration {
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
    this.addSql(
      `alter table if exists "subscription_log" add constraint "subscription_log_event_type_check" check("event_type" in (${PREVIOUS_EVENT_TYPES}));`
    )
  }
}
