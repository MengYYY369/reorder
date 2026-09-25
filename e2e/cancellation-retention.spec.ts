import { expect, test } from "@playwright/test";
import {
  deleteSubscriptionTree,
  insertCancellationCase,
  insertSubscription,
} from "./helpers/db";
import { CancellationCaseDetailPage } from "./pages/CancellationCaseDetailPage";
import { CancellationsListPage } from "./pages/CancellationsListPage";
import { SubscriptionDetailPage } from "./pages/SubscriptionDetailPage";

type SeededCancellationCase = {
  cancellationCaseId: string;
  subscriptionId: string;
  reference: string;
};

/**
 * Seed a fresh active subscription plus a `requested` cancellation case through
 * the shared data layer. The subscription id comes back so `afterEach` can
 * delete the whole tree — the previous hand-written INSERT left every row it
 * created behind.
 */
async function seedActiveCancellationCase(): Promise<SeededCancellationCase> {
  const sub = await insertSubscription();
  const cancellationCaseId = await insertCancellationCase(sub.id);

  return {
    cancellationCaseId,
    subscriptionId: sub.id,
    reference: sub.reference,
  };
}

test.describe("Cancellation & Retention", () => {
  let cancellationDetailPage: CancellationCaseDetailPage;
  let cancellationsListPage: CancellationsListPage;
  let subscriptionDetailPage: SubscriptionDetailPage;
  const seededSubscriptionIds: string[] = [];

  test.beforeEach(async ({ page }) => {
    cancellationDetailPage = new CancellationCaseDetailPage(page);
    cancellationsListPage = new CancellationsListPage(page);
    subscriptionDetailPage = new SubscriptionDetailPage(page);
  });

  test.afterEach(async () => {
    while (seededSubscriptionIds.length) {
      await deleteSubscriptionTree(seededSubscriptionIds.pop()!);
    }
  });

  test("applies a pause retention offer to an active case", async ({ page }) => {
    const seededCase = await seedActiveCancellationCase();
    seededSubscriptionIds.push(seededCase.subscriptionId);

    await cancellationsListPage.goto();
    await cancellationsListPage.openCase(seededCase.reference);
    await cancellationDetailPage.waitForLoaded();
    await cancellationDetailPage.expectCaseStatus("Requested");

    const applyOfferResponsePromise = page.waitForResponse(
      (response) =>
        response.url().includes(
          `/admin/cancellations/${seededCase.cancellationCaseId}/apply-offer`,
        ) && response.request().method() === "POST",
    );

    await cancellationDetailPage.openActionMenu();
    await cancellationDetailPage.openApplyRetentionOffer();
    await cancellationDetailPage.selectPauseOffer();
    await cancellationDetailPage.fillPauseCycles("2");
    await cancellationDetailPage.submitDrawer("Apply offer");
    await cancellationDetailPage.confirmPrompt("Apply pause offer", "Apply pause offer");

    const applyOfferResponse = await applyOfferResponsePromise;
    const applyOfferBody = await applyOfferResponse.json();
    expect(
      applyOfferResponse.status(),
      `Failed with ${JSON.stringify(applyOfferBody)}`,
    ).toBe(200);
    expect(applyOfferResponse.request().postDataJSON()).toMatchObject({
      offer_type: "pause_offer",
      offer_payload: {
        pause_offer: {
          pause_cycles: 2,
          resume_at: null,
        },
      },
    });
    expect(applyOfferBody.cancellation).toMatchObject({
      id: seededCase.cancellationCaseId,
      status: "paused",
      final_outcome: "paused",
    });

    await cancellationDetailPage.expectToast("Retention offer applied");
    await expect(cancellationDetailPage.drawer).toBeHidden();
    await cancellationDetailPage.expectCaseStatus("Paused");

    await subscriptionDetailPage.goto(seededCase.subscriptionId);
    await subscriptionDetailPage.expectStatus("Paused");
  });

  test("finalizes cancellation when retention is rejected", async ({ page }) => {
    const seededCase = await seedActiveCancellationCase();
    seededSubscriptionIds.push(seededCase.subscriptionId);
    const reason = "Customer declined every retention option";

    await cancellationsListPage.goto();
    await cancellationsListPage.openCase(seededCase.reference);
    await cancellationDetailPage.waitForLoaded();
    await cancellationDetailPage.expectCaseStatus("Requested");

    const finalizeResponsePromise = page.waitForResponse(
      (response) =>
        response.url().includes(
          `/admin/cancellations/${seededCase.cancellationCaseId}/finalize`,
        ) && response.request().method() === "POST",
    );

    await cancellationDetailPage.openActionMenu();
    await cancellationDetailPage.openFinalizeCancellation();
    await cancellationDetailPage.fillFinalizeReason(reason);
    await cancellationDetailPage.selectFinalizeReasonCategory("Price");
    await cancellationDetailPage.submitDrawer("Continue");
    await cancellationDetailPage.confirmPrompt("Finalize cancellation", "Finalize cancellation");

    const finalizeResponse = await finalizeResponsePromise;
    const finalizeBody = await finalizeResponse.json();
    expect(
      finalizeResponse.status(),
      `Failed with ${JSON.stringify(finalizeBody)}`,
    ).toBe(200);
    expect(finalizeResponse.request().postDataJSON()).toMatchObject({
      reason,
      reason_category: "price",
    });
    expect(finalizeBody.cancellation).toMatchObject({
      id: seededCase.cancellationCaseId,
      status: "canceled",
      final_outcome: "canceled",
    });

    await cancellationDetailPage.expectToast("Cancellation finalized");
    await expect(cancellationDetailPage.drawer).toBeHidden();
    await cancellationDetailPage.expectCaseStatus("Canceled");

    await cancellationsListPage.goto();
    await cancellationsListPage.expectCaseOutcome(
      seededCase.reference,
      "Canceled",
    );

    await subscriptionDetailPage.goto(seededCase.subscriptionId);
    await subscriptionDetailPage.expectStatus("Cancelled");
  });
});
