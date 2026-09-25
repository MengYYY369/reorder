import { expect, test } from "@playwright/test";
import {
  deleteSubscriptionTree,
  insertCancellationCase,
  insertSubscription,
} from "./helpers/db";
import { CancellationCaseDetailPage } from "./pages/CancellationCaseDetailPage";
import { CancellationsListPage } from "./pages/CancellationsListPage";

type SeededCase = {
  cancellationCaseId: string;
  subscriptionId: string;
  reference: string;
};

/**
 * `cancellation-retention.spec.ts` covers the pause branch only. This file
 * covers the two remaining retention offers plus the reason route, all of which
 * are money- or evidence-bearing and have no other guard:
 *
 * - a `discount_offer` payload decides the percentage a customer is billed, and
 *   the server rejects anything above 50% — a client-side-only test would miss
 *   that entirely;
 * - a `bonus_offer` needs a value for `free_cycle`/`credit` but not `gift`;
 * - the reason route is the churn evidence the operator typed, and it is the
 *   only write in this area with no confirmation prompt.
 */
test.describe("Retention offers and reason updates", () => {
  let detail: CancellationCaseDetailPage;
  let list: CancellationsListPage;
  const seededSubscriptionIds: string[] = [];

  test.beforeEach(async ({ page }) => {
    detail = new CancellationCaseDetailPage(page);
    list = new CancellationsListPage(page);
  });

  test.afterEach(async () => {
    while (seededSubscriptionIds.length) {
      await deleteSubscriptionTree(seededSubscriptionIds.pop()!);
    }
  });

  async function seedCase(): Promise<SeededCase> {
    const sub = await insertSubscription();
    seededSubscriptionIds.push(sub.id);
    const cancellationCaseId = await insertCancellationCase(sub.id);

    return {
      cancellationCaseId,
      subscriptionId: sub.id,
      reference: sub.reference,
    };
  }

  function trackPosts(page: import("@playwright/test").Page, fragment: string) {
    const seen: string[] = [];
    page.on("request", (req) => {
      if (req.method() === "POST" && req.url().includes(fragment)) {
        seen.push(req.url());
      }
    });
    return seen;
  }

  async function openCase(page: import("@playwright/test").Page, c: SeededCase) {
    await list.goto();
    await list.openCase(c.reference);
    await detail.waitForLoaded();
    await detail.expectCaseStatus("Requested");
  }

  test("a discount offer persists the exact payload and retains the case", async ({
    page,
  }) => {
    const c = await seedCase();
    await openCase(page, c);

    const responsePromise = page.waitForResponse(
      (res) =>
        res.url().includes(
          `/admin/cancellations/${c.cancellationCaseId}/apply-offer`
        ) && res.request().method() === "POST"
    );

    await detail.openActionMenu();
    await detail.openApplyRetentionOffer();
    await detail.selectOfferType("Discount offer");

    // The form pre-fills percentage / 10 / 2 cycles; the operator only overrides
    // the value, which is the number that decides what the customer is billed.
    await detail.fieldById("discount-value").fill("25");
    await detail.fieldById("discount-duration-cycles").fill("3");
    await detail.submitDrawer("Apply offer");
    await detail.confirmPrompt("Apply discount offer", "Apply offer");

    const res = await responsePromise;
    expect(res.status(), await res.text()).toBe(200);
    expect(res.request().postDataJSON()).toMatchObject({
      offer_type: "discount_offer",
      offer_payload: {
        discount_offer: {
          discount_type: "percentage",
          discount_value: 25,
          duration_cycles: 3,
        },
      },
    });

    expect((await res.json()).cancellation).toMatchObject({
      id: c.cancellationCaseId,
      status: "retained",
      final_outcome: "retained",
    });

    await detail.expectToast("Retention offer applied");
    await detail.expectCaseStatus("Retained");
  });

  test("a discount over 50% passes the form but is refused by the server", async ({
    page,
  }) => {
    const c = await seedCase();
    await openCase(page, c);

    const responsePromise = page.waitForResponse(
      (res) =>
        res.url().includes(
          `/admin/cancellations/${c.cancellationCaseId}/apply-offer`
        ) && res.request().method() === "POST"
    );

    await detail.openActionMenu();
    await detail.openApplyRetentionOffer();
    await detail.selectOfferType("Discount offer");
    await detail.fieldById("discount-value").fill("75");
    await detail.submitDrawer("Apply offer");
    await detail.confirmPrompt("Apply discount offer", "Apply offer");

    const res = await responsePromise;
    expect(res.status()).toBe(400);
    expect(await res.text()).toContain("Percentage discount can't exceed 50");

    // The case must still be open: a case wrongly closed as retained stops every
    // later recovery attempt on a customer who never accepted anything.
    await detail.expectCaseStatus("Requested");
  });

  test("a zero discount is blocked before any request leaves the browser", async ({
    page,
  }) => {
    const c = await seedCase();
    await openCase(page, c);
    const posts = trackPosts(page, "/apply-offer");

    await detail.openActionMenu();
    await detail.openApplyRetentionOffer();
    await detail.selectOfferType("Discount offer");
    await detail.fieldById("discount-value").fill("0");
    await detail.submitDrawer("Apply offer");

    await expect(
      page.getByText("Discount value must be greater than 0")
    ).toBeVisible({ timeout: 10_000 });
    expect(posts).toHaveLength(0);
  });

  test("a free-cycle bonus needs a value, a gift does not", async ({ page }) => {
    const c = await seedCase();
    await openCase(page, c);
    const posts = trackPosts(page, "/apply-offer");

    await detail.openActionMenu();
    await detail.openApplyRetentionOffer();
    await detail.selectOfferType("Bonus offer");

    // Default bonus_type is "free_cycle", so an empty value must be refused.
    await detail.fieldById("bonus-value").fill("");
    await detail.submitDrawer("Apply offer");
    await expect(
      page.getByText("Bonus value is required for free cycle or credit")
    ).toBeVisible({ timeout: 10_000 });
    expect(posts).toHaveLength(0);

    // A gift carries no value, and the payload keeps `value: null`.
    await detail.selectBonusType("Gift");
    await detail.fieldById("bonus-label").fill("Sticker pack");

    const responsePromise = page.waitForResponse(
      (res) =>
        res.url().includes(
          `/admin/cancellations/${c.cancellationCaseId}/apply-offer`
        ) && res.request().method() === "POST"
    );
    await detail.submitDrawer("Apply offer");
    await detail.confirmPrompt("Apply bonus offer", "Apply offer");

    const res = await responsePromise;
    expect(res.status(), await res.text()).toBe(200);
    expect(res.request().postDataJSON()).toMatchObject({
      offer_type: "bonus_offer",
      offer_payload: {
        bonus_offer: {
          bonus_type: "gift",
          value: null,
          label: "Sticker pack",
        },
      },
    });

    expect((await res.json()).cancellation).toMatchObject({
      status: "retained",
      final_outcome: "retained",
    });
    await detail.expectToast("Retention offer applied");
  });

  test("updating the reason writes it back and asks for no confirmation", async ({
    page,
  }) => {
    const c = await seedCase();
    await openCase(page, c);

    const responsePromise = page.waitForResponse(
      (res) =>
        res.url().includes(
          `/admin/cancellations/${c.cancellationCaseId}/reason`
        ) && res.request().method() === "POST"
    );

    await detail.openActionMenu();
    await detail.menuItem("Edit reason").click();

    const drawer = page.getByRole("dialog");
    await expect(
      drawer.getByRole("heading", { name: "Update reason" })
    ).toBeVisible();

    await detail.fieldById("cancellation-reason").fill("Too expensive this month");
    await detail.selectReasonCategory("Price");
    await detail.submitDrawerWithLabel("Save");

    const res = await responsePromise;
    expect(res.status(), await res.text()).toBe(200);
    expect(res.request().postDataJSON()).toMatchObject({
      reason: "Too expensive this month",
      reason_category: "price",
    });

    await detail.expectToast("Reason updated");
    // No prompt was involved, so the only dialog left is the one that closed.
    await expect(drawer).toBeHidden();
  });

  test("an empty reason is blocked before the request is sent", async ({ page }) => {
    const c = await seedCase();
    await openCase(page, c);
    const posts = trackPosts(page, "/reason");

    await detail.openActionMenu();
    await detail.menuItem("Edit reason").click();

    const drawer = page.getByRole("dialog");
    await expect(
      drawer.getByRole("heading", { name: "Update reason" })
    ).toBeVisible();

    await detail.fieldById("cancellation-reason").fill("   ");
    await detail.submitDrawerWithLabel("Save");

    await expect(page.getByText("Reason is required").first()).toBeVisible({
      timeout: 10_000,
    });
    expect(posts).toHaveLength(0);
  });
});
