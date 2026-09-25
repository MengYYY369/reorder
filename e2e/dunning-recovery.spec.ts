import { expect, test, type Page } from "@playwright/test";
import {
  deleteSubscriptionTree,
  insertDunningCase,
  insertRenewalCycle,
  insertSubscription,
  queryRows,
} from "./helpers/db";
import { DunningCaseDetailPage } from "./pages/DunningCaseDetailPage";
import { DunningQueuePage } from "./pages/DunningQueuePage";

type SeededCase = {
  subscriptionId: string;
  reference: string;
  caseId: string;
};

/**
 * Dunning is the money-recovery path: a case that is wrongly closed stops
 * retries, and a wrongly overridden retry schedule bills the customer at the
 * wrong cadence. Both are asserted here against the database, not just the DOM.
 */
async function seedCase(): Promise<SeededCase> {
  const sub = await insertSubscription({ status: "past_due" });
  const cycleId = await insertRenewalCycle(sub.id, { status: "failed" });
  const { caseId } = await insertDunningCase(sub.id, cycleId);

  return { subscriptionId: sub.id, reference: sub.reference, caseId };
}

test.describe("Dunning recovery queue", () => {
  const seeded: SeededCase[] = [];

  test.afterEach(async () => {
    while (seeded.length) {
      await deleteSubscriptionTree(seeded.pop()!.subscriptionId);
    }
  });

  async function seed(): Promise<SeededCase> {
    const c = await seedCase();
    seeded.push(c);
    return c;
  }

  /** POST calls the UI should never make while validation fails. */
  function trackPosts(page: Page, fragment: string): string[] {
    const seen: string[] = [];
    page.on("request", (req) => {
      if (req.method() === "POST" && req.url().includes(fragment)) {
        seen.push(req.url());
      }
    });
    return seen;
  }

  test("lists a case with its attempt count and payment error", async ({
    page,
  }) => {
    const c = await seed();
    const queue = new DunningQueuePage(page);

    await queue.goto();
    await queue.search(c.reference);

    const row = queue.rowFor(c.reference);
    await expect(row).toHaveCount(1);
    await expect(row).toContainText("Retry scheduled");
    await expect(row).toContainText("1 / 3");
    await expect(row).toContainText("CARD_DECLINED");
  });

  test("status filter changes what the queue returns", async ({ page }) => {
    const c = await seed();
    const queue = new DunningQueuePage(page);

    await queue.goto();
    await queue.search(c.reference);
    await expect(queue.rowFor(c.reference)).toHaveCount(1);

    await queue.toggleStatusFilter("Recovered");
    await expect(queue.rowFor(c.reference)).toHaveCount(0);
    await expect(page.getByText("No matching dunning cases")).toBeVisible();

    await queue.toggleStatusFilter("Recovered");
    await expect(queue.rowFor(c.reference)).toHaveCount(1);
  });

  test("opening a queue row lands on that case", async ({ page }) => {
    const c = await seed();
    const queue = new DunningQueuePage(page);

    await queue.goto();
    await queue.search(c.reference);
    await queue.openCaseFromQueue(c.reference, c.caseId);
  });

  test("an open case exposes all four recovery actions", async ({ page }) => {
    const c = await seed();
    const detail = new DunningCaseDetailPage(page, c.caseId);

    await detail.goto();
    await detail.openActionMenu();

    await expect(detail.menuItem("Retry now")).toBeVisible();
    await expect(detail.menuItem("Mark recovered")).toBeVisible();
    await expect(detail.menuItem("Mark unrecovered")).toBeVisible();
    await expect(detail.menuItem("Edit retry schedule")).toBeVisible();

    await detail.closeActionMenu();
  });

  test("marking a case unrecovered requires a reason", async ({ page }) => {
    const c = await seed();
    const detail = new DunningCaseDetailPage(page, c.caseId);
    const posts = trackPosts(page, "/mark-unrecovered");

    await detail.goto();
    await detail.openActionMenu();
    await detail.menuItem("Mark unrecovered").click();

    await expect(
      detail.drawer.getByRole("heading", { name: "Mark unrecovered" })
    ).toBeVisible();

    await detail.submitDrawer("Mark unrecovered");
    await detail.expectToast("Reason is required");
    expect(posts).toHaveLength(0);

    await detail.fieldById("dunning-reason").fill("Card is dead, stop retrying");
    await detail.submitDrawer("Mark unrecovered");
    await detail.confirmPrompt("Mark as unrecovered?", "Mark unrecovered");

    await detail.expectToast("Case marked as unrecovered");
    expect(posts).toHaveLength(1);
    expect(await queryRows(`SELECT status FROM dunning_case WHERE id = '${c.caseId}'`)).toEqual([
      "unrecovered",
    ]);
  });

  test("retry schedule override validates then persists the new schedule", async ({
    page,
  }) => {
    const c = await seed();
    const detail = new DunningCaseDetailPage(page, c.caseId);
    const posts = trackPosts(page, "/retry-schedule");

    await detail.goto();
    await detail.openActionMenu();
    await detail.menuItem("Edit retry schedule").click();

    await detail.field("Retry intervals (minutes)").fill("1440, 4320");
    await detail.field("Max attempts").fill("3");
    await detail.submitDrawer("Save schedule");

    await detail.expectToast("Max attempts must equal the number of retry intervals");
    expect(posts).toHaveLength(0);

    await detail.field("Max attempts").fill("2");
    await detail.submitDrawer("Save schedule");
    await detail.confirmPrompt("Override retry schedule?", "Save schedule");

    await detail.expectToast("Retry schedule updated");
    expect(posts).toHaveLength(1);

    const [row] = await queryRows(
      `SELECT max_attempts::text || '|' || retry_schedule::text FROM dunning_case WHERE id = '${c.caseId}'`
    );
    expect(row).toBe("2|[1440, 4320]");
  });

  test("marking a case recovered closes it and hides the actions", async ({
    page,
  }) => {
    const c = await seed();
    const detail = new DunningCaseDetailPage(page, c.caseId);

    await detail.goto();
    await detail.openActionMenu();
    await detail.menuItem("Mark recovered").click();
    await detail.submitDrawer("Mark recovered");
    await detail.confirmPrompt("Mark as recovered?", "Mark recovered");

    await detail.expectToast("Case marked as recovered");
    expect(
      queryRows(
        `SELECT (status = 'recovered' AND recovered_at IS NOT NULL)::text FROM dunning_case WHERE id = '${c.caseId}'`
      )
    ).toEqual(["true"]);

    await page.reload();
    await expect(detail.heading).toBeVisible({ timeout: 15_000 });
    await detail.openActionMenu();
    await expect(detail.menuItem("Retry now")).toHaveCount(0);
    await expect(detail.menuItem("Mark recovered")).toHaveCount(0);
  });
});
