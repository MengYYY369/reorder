import { expect, test } from "@playwright/test";
import {
  deleteSubscriptionTree,
  insertSubscription,
  insertSubscriptionLog,
} from "./helpers/db";
import { ActivityLogPage } from "./pages/ActivityLogPage";

/** Mirrors the `subscription_log_event_type_check` CHECK constraint — an event
 *  type outside this list would be rejected by the database, so the page could
 *  never render it. */
const KNOWN_EVENT_TYPES = [
  "subscription.created",
  "subscription.paused",
  "subscription.resumed",
  "subscription.canceled",
  "subscription.plan_change_scheduled",
  "subscription.shipping_address_updated",
  "subscription.next_delivery_skipped",
  "subscription.payment_method_updated",
  "subscription.expired",
  "subscription.creation_failed",
  "redemption.redeemed",
  "renewal.cycle_created",
  "renewal.approval_approved",
  "renewal.approval_rejected",
  "renewal.force_requested",
  "renewal.succeeded",
  "renewal.failed",
  "dunning.started",
  "dunning.retry_executed",
  "dunning.recovered",
  "dunning.unrecovered",
  "dunning.retry_schedule_updated",
  "cancellation.case_started",
  "cancellation.offer_applied",
  "cancellation.reason_updated",
  "cancellation.finalized",
];

test.describe("Subscription activity log", () => {
  const createdSubscriptionIds: string[] = [];

  /** Two events on purpose: one admin-authored (`actor_type: user`, rendered as
   *  "Admin") and one machine-authored ("System"), so the actor column and the
   *  event-type filter both have something to discriminate between. */
  async function seedSubscriptionWithEvents() {
    const sub = await insertSubscription();
    createdSubscriptionIds.push(sub.id);

    const paused = await insertSubscriptionLog(sub, {
      eventType: "subscription.paused",
      actorType: "user",
      reason: "Customer requested a temporary pause",
      changedFields: ["status"],
    });
    const dunning = await insertSubscriptionLog(sub, {
      eventType: "dunning.started",
      actorType: "system",
      reason: "Renewal failed with CARD_DECLINED",
    });

    expect(KNOWN_EVENT_TYPES).toContain(paused.eventType);
    expect(KNOWN_EVENT_TYPES).toContain(dunning.eventType);

    return sub;
  }

  test.afterEach(async () => {
    while (createdSubscriptionIds.length) {
      await deleteSubscriptionTree(createdSubscriptionIds.pop()!);
    }
  });

  test("lists both seeded lifecycle events for a subscription", async ({
    page,
  }) => {
    const sub = await seedSubscriptionWithEvents();
    const log = new ActivityLogPage(page);

    await log.goto();
    await log.search(sub.reference);

    await expect(log.rowFor(sub.reference)).toHaveCount(2);
    await expect(
      log.rowFor(sub.reference).filter({ hasText: "Paused" })
    ).toHaveCount(1);
    await expect(
      log.rowFor(sub.reference).filter({ hasText: "Started" })
    ).toHaveCount(1);
    await expect(
      log.rowFor(sub.reference).filter({ hasText: "Admin" })
    ).toHaveCount(1);
    await expect(
      log.rowFor(sub.reference).filter({ hasText: "System" })
    ).toHaveCount(1);
  });

  test("event type filter narrows the list to the selected event", async ({
    page,
  }) => {
    const sub = await seedSubscriptionWithEvents();
    const log = new ActivityLogPage(page);

    await log.goto();
    await log.search(sub.reference);
    await log.toggleEventType("Paused");

    await expect(log.rowFor(sub.reference)).toHaveCount(1);
    await expect(
      log.rowFor(sub.reference).filter({ hasText: "Started" })
    ).toHaveCount(0);
  });

  test("opening a row shows the event detail drawer", async ({ page }) => {
    const sub = await seedSubscriptionWithEvents();
    const log = new ActivityLogPage(page);

    await log.goto();
    await log.search(sub.reference);
    await log.openFirstEventRow(sub.reference);

    const drawer = page.getByRole("dialog");
    await expect(
      drawer.getByRole("heading", { name: "Activity Log Event" })
    ).toBeVisible();
    await expect(drawer.getByText("Overview")).toBeVisible();
    await expect(drawer.getByText("Subscription Snapshot")).toBeVisible();
    await expect(
      drawer.getByText("Customer requested a temporary pause")
    ).toBeVisible();

    await drawer.getByRole("button", { name: "Close" }).click();
    await expect(drawer).toBeHidden();
  });
});
