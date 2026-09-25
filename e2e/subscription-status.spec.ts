import { expect, test } from "@playwright/test";
import {
  deleteSubscriptionTree,
  insertSubscription,
  queryRows,
} from "./helpers/db";
import { SubscriptionDetailPage } from "./pages/SubscriptionDetailPage";

/**
 * Seed a fresh active subscription through the shared data layer and return its
 * reference. The row is registered for deletion, so a run against a long-lived
 * environment does not accumulate leftovers.
 */
test.describe("Subscription status transitions (pause & resume)", () => {
  let reference: string;
  let subscriptionId: string;
  let detailPage: SubscriptionDetailPage;

  test.beforeEach(async ({ page }) => {
    const sub = await insertSubscription();
    reference = sub.reference;
    subscriptionId = sub.id;
    detailPage = new SubscriptionDetailPage(page);
    // Navigate to the detail page via the list so we exercise real navigation
    await detailPage.gotoFromList(reference);
  });

  test.afterEach(async () => {
    await deleteSubscriptionTree(subscriptionId);
  });

  test("pauses and resumes an active subscription", async ({ page }) => {
    // ── Initial state ────────────────────────────────────────────────────────
    await detailPage.expectStatus("Active");

    // ── PAUSE ─────────────────────────────────────────────────────────────────

    // Intercept the pause API call before triggering the action
    const pauseResponse = page.waitForResponse(
      (res) =>
        res.url().includes("/admin/subscriptions/") &&
        res.url().endsWith("/pause") &&
        res.request().method() === "POST"
    );

    await detailPage.openActionMenu();

    // When active, "Pause" must be visible and "Resume" must be absent
    await expect(page.getByRole("menuitem", { name: "Pause" })).toBeVisible();
    await expect(
      page.getByRole("menuitem", { name: "Resume" })
    ).not.toBeVisible();

    await detailPage.clickAction("Pause");
    // The usePrompt dialog title is "Pause subscription?"
    await detailPage.confirmPrompt("Pause");

    // Verify API response
    const pauseRes = await pauseResponse;
    expect(pauseRes.status()).toBe(200);
    const pauseBody = await pauseRes.json();
    expect(pauseBody.subscription.status).toBe("paused");

    // Verify UI feedback
    await detailPage.expectToast("Subscription paused");
    await detailPage.expectStatus("Paused");

    // Open menu again: "Resume" visible, "Pause" absent
    await detailPage.openActionMenu();
    await expect(page.getByRole("menuitem", { name: "Resume" })).toBeVisible();
    await expect(
      page.getByRole("menuitem", { name: "Pause" })
    ).not.toBeVisible();
    // Close the menu by pressing Escape
    await page.keyboard.press("Escape");

    // ── RESUME ────────────────────────────────────────────────────────────────

    const resumeResponse = page.waitForResponse(
      (res) =>
        res.url().includes("/admin/subscriptions/") &&
        res.url().endsWith("/resume") &&
        res.request().method() === "POST"
    );

    await detailPage.openActionMenu();
    await detailPage.clickAction("Resume");
    // The usePrompt dialog title is "Resume subscription?"
    await detailPage.confirmPrompt("Resume");

    // Verify API response
    const resumeRes = await resumeResponse;
    expect(resumeRes.status()).toBe(200);
    const resumeBody = await resumeRes.json();
    expect(resumeBody.subscription.status).toBe("active");

    // Verify UI feedback
    await detailPage.expectToast("Subscription resumed");
    await detailPage.expectStatus("Active");

    // The write really landed: the row is active again, not just re-rendered.
    expect(
      await queryRows(
        `SELECT status FROM subscription WHERE id = '${subscriptionId}'`
      )
    ).toEqual(["active"]);

    // Open menu again: "Pause" visible, "Resume" absent
    await detailPage.openActionMenu();
    await expect(page.getByRole("menuitem", { name: "Pause" })).toBeVisible();
    await expect(
      page.getByRole("menuitem", { name: "Resume" })
    ).not.toBeVisible();
    await page.keyboard.press("Escape");
  });
});
