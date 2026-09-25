import { test, expect } from "@playwright/test";
import {
  deleteSubscriptionTree,
  insertRenewalCycle,
  insertSubscription,
} from "./helpers/db";
import { RenewalDetailPage } from "./pages/RenewalDetailPage";

interface SeedOptions {
  approvalRequired: boolean;
  approvalStatus: string | null;
  cycleStatus?: string;
}

/**
 * Seed a fresh active subscription and a linked renewal cycle through the
 * shared data layer, the same rows the store checkout and the scheduler would
 * produce. The subscription id is returned so `afterEach` can delete the tree.
 */
async function seedSubscriptionWithRenewalCycle(options: SeedOptions) {
  const sub = await insertSubscription();
  const cycleId = await insertRenewalCycle(sub.id, {
    status: options.cycleStatus,
    approvalRequired: options.approvalRequired,
    approvalStatus: options.approvalStatus,
  });

  return { reference: sub.reference, subscriptionId: sub.id, cycleId };
}

test.describe("Renewal force execution & approval", () => {
  let detailPage: RenewalDetailPage;
  const seededSubscriptionIds: string[] = [];

  test.beforeEach(async ({ page }) => {
    detailPage = new RenewalDetailPage(page);
    // Login flow is handled globally via Playwright setup/auth state in this repo.
  });

  test.afterEach(async () => {
    while (seededSubscriptionIds.length) {
      await deleteSubscriptionTree(seededSubscriptionIds.pop()!);
    }
  });

  test("forces a scheduled renewal cycle", async ({ page }) => {
    // 1. Seed subscription + renewal_cycle (scheduled, no approval)
    const { reference, subscriptionId, cycleId } =
      await seedSubscriptionWithRenewalCycle({
        approvalRequired: false,
        approvalStatus: null,
        cycleStatus: "scheduled",
      });
    seededSubscriptionIds.push(subscriptionId);

    // 2-6. Navigate via queue and wait for load
    await detailPage.gotoFromQueue(reference);
    await detailPage.waitForLoaded();

    // 7. Assert initial status
    await detailPage.expectCycleStatus("Scheduled");

    // 8. Set up API intercept
    const forceResponsePromise = page.waitForResponse(
      (response) =>
        response.url().includes(`/admin/renewals/${cycleId}/force`) &&
        response.request().method() === "POST",
    );

    // 9-11. Open action dropdown and click Force renewal
    await detailPage.openActionMenu();
    await expect(
      page.getByRole("menuitem", { name: "Force renewal" }),
    ).toBeVisible();
    await detailPage.clickForceRenewal();

    // 12. Confirm prompt
    await detailPage.confirmPrompt("Force renewal");

    // 13. Assert API response 200
    const forceResponse = await forceResponsePromise;
    const responseBody = await forceResponse.json();
    expect(
      forceResponse.status(),
      `Failed with ${JSON.stringify(responseBody)}`,
    ).toBe(200);

    // 14. Assert API response body
    expect(responseBody.renewal).toBeDefined();
    expect(responseBody.renewal.status).toBeDefined();

    // 15. Assert toast
    await detailPage.expectToast("Renewal forced");

    // 16. Assert StatusBadge updates (wait for it NOT to be Scheduled)
    await expect(detailPage.statusBadge).not.toContainText("Scheduled", {
      timeout: 10_000,
    });

    // 17. Assert attempt history shows row #1
    await detailPage.expectAttemptRow(1);
  });

  test("approves pending changes on a renewal cycle", async ({ page }) => {
    // 1. Seed subscription + renewal_cycle (approval pending)
    const { reference, subscriptionId, cycleId } =
      await seedSubscriptionWithRenewalCycle({
        approvalRequired: true,
        approvalStatus: "pending",
        cycleStatus: "scheduled",
      });
    seededSubscriptionIds.push(subscriptionId);

    // 2-4. Navigate via queue and wait for load
    await detailPage.gotoFromQueue(reference);
    await detailPage.waitForLoaded();

    // 5. Assert initial status
    await detailPage.expectCycleStatus("Scheduled");

    // 6-8. Open action dropdown and assert items
    await detailPage.openActionMenu();
    await expect(
      page.getByRole("menuitem", { name: "Approve changes" }),
    ).toBeVisible();
    await expect(
      page.getByRole("menuitem", { name: "Reject changes" }),
    ).toBeVisible();

    // 9-10. Click Approve and check drawer
    await detailPage.clickApproveChanges();
    await expect(
      page.getByRole("heading", { name: "Approve changes" }),
    ).toBeVisible();

    // 11. Fill reason
    await detailPage.fillDecisionReason("Approved by E2E test");

    // 12. Set up API intercept
    const approveResponsePromise = page.waitForResponse(
      (response) =>
        response.url().includes(`/admin/renewals/${cycleId}/approve-changes`) &&
        response.request().method() === "POST",
    );

    // 13. Submit drawer
    await detailPage.submitDecision("Approve");

    // 14. Confirm prompt
    await detailPage.confirmPrompt("Approve");

    // 15-16. Assert API response 200 and request payload
    const approveResponse = await approveResponsePromise;
    const approveResponseBody = await approveResponse.json();
    expect(
      approveResponse.status(),
      `Failed with ${JSON.stringify(approveResponseBody)}`,
    ).toBe(200);

    const requestPayload = approveResponse.request().postDataJSON();
    expect(requestPayload).toMatchObject({ reason: "Approved by E2E test" });

    // 17. Assert toast
    await detailPage.expectToast("Pending changes approved");

    // 18. Assert drawer closes
    await expect(page.getByRole("dialog")).toBeHidden();

    // 19. Assert approval summary
    await detailPage.expectApprovalStatus("Approved");

    // 20-21. Open action dropdown and verify item visibility
    await detailPage.openActionMenu();
    await expect(
      page.getByRole("menuitem", { name: "Approve changes" }),
    ).toBeHidden();
    await expect(
      page.getByRole("menuitem", { name: "Reject changes" }),
    ).toBeHidden();
    await expect(
      page.getByRole("menuitem", { name: "Force renewal" }),
    ).toBeVisible();
  });
});
