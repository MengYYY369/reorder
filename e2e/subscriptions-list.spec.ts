import { expect, test, type Page } from "@playwright/test";
import {
  deleteSubscriptionTree,
  insertSubscription,
  queryRows,
} from "./helpers/db";

const DESCRIPTION = "Monitor subscription status, cadence, and upcoming renewals.";

/**
 * Rows are seeded rather than picked from whatever the environment happens to
 * hold: an assertion on "the first row" only proves the table rendered, and it
 * flips red or green depending on unrelated data.
 */
test.describe("Subscriptions list page", () => {
  const created: { id: string; reference: string }[] = [];
  let active: { id: string; reference: string };
  let paused: { id: string; reference: string };
  let cancelled: { id: string; reference: string };

  test.beforeAll(async () => {
    active = await insertSubscription({ status: "active" });
    paused = await insertSubscription({ status: "paused" });
    cancelled = await insertSubscription({ status: "cancelled" });
    created.push(active, paused, cancelled);
  });

  test.afterAll(async () => {
    while (created.length) {
      await deleteSubscriptionTree(created.pop()!.id);
    }
  });

  async function gotoList(page: Page): Promise<void> {
    await page.goto("/app/subscriptions");
    await expect(
      page.getByRole("heading", { name: "Subscriptions", exact: true })
    ).toBeVisible({ timeout: 15_000 });
  }

  async function search(page: Page, term: string): Promise<void> {
    await page.getByPlaceholder("Search").fill(term);
    await page.waitForResponse((res) => res.url().includes("/admin/subscriptions"));
  }

  function rowFor(page: Page, reference: string) {
    return page.getByRole("row").filter({ hasText: reference });
  }

  test("displays the page heading and description", async ({ page }) => {
    await gotoList(page);
    await expect(page.getByText(DESCRIPTION)).toBeVisible();
  });

  test("renders the data table with expected columns", async ({ page }) => {
    await gotoList(page);

    for (const column of [
      "Reference",
      "Product",
      "Status",
      "Frequency",
      "Next renewal",
    ]) {
      await expect(
        page.getByRole("columnheader", { name: column })
      ).toBeVisible();
    }
  });

  test("search narrows the table to the matching reference", async ({
    page,
  }) => {
    await gotoList(page);
    await search(page, active.reference);

    await expect(rowFor(page, active.reference)).toHaveCount(1);
    await expect(rowFor(page, paused.reference)).toHaveCount(0);
  });

  test("search with no match reports the filtered empty state", async ({
    page,
  }) => {
    await gotoList(page);
    await search(page, "SUB-E2E-DOES-NOT-EXIST");

    await expect(page.getByText("No matching subscriptions")).toBeVisible();
    await expect(
      page.getByText("Try changing the search term or active filters.")
    ).toBeVisible();
  });

  test("each row's status badge matches the stored status", async ({
    page,
  }) => {
    await gotoList(page);

    for (const [sub, label] of [
      [active, "Active"],
      [paused, "Paused"],
      [cancelled, "Cancelled"],
    ] as const) {
      await search(page, sub.reference);
      const cell = page
        .getByRole("row")
        .filter({ hasText: sub.reference })
        .getByText(label, { exact: true });
      await expect(cell).toBeVisible();
    }
  });

  test("navigates to subscription detail on row click", async ({ page }) => {
    await gotoList(page);
    await search(page, active.reference);

    await rowFor(page, active.reference).click();

    await expect(page).toHaveURL(
      new RegExp(`/app/subscriptions/${active.id}`),
      { timeout: 10_000 }
    );
    await expect(
      page.getByRole("heading", { name: active.reference, exact: true })
    ).toBeVisible({ timeout: 10_000 });
  });

  test("row actions follow the subscription status", async ({ page }) => {
    await gotoList(page);

    await search(page, active.reference);
    await rowFor(page, active.reference)
      .getByRole("button").last()
      .click();
    const activeMenu = page.getByRole("menu");
    await expect(activeMenu.getByRole("menuitem", { name: "Pause" })).toBeVisible();
    await expect(
      activeMenu.getByRole("menuitem", { name: "Resume" })
    ).toHaveCount(0);
    await page.keyboard.press("Escape");

    await search(page, paused.reference);
    await rowFor(page, paused.reference)
      .getByRole("button").last()
      .click();
    const pausedMenu = page.getByRole("menu");
    await expect(pausedMenu.getByRole("menuitem", { name: "Resume" })).toBeVisible();
    await expect(
      pausedMenu.getByRole("menuitem", { name: "Pause" })
    ).toHaveCount(0);
    await page.keyboard.press("Escape");

    // A cancelled subscription has no lifecycle action at all.
    await search(page, cancelled.reference);
    expect(
      await queryRows(
        `SELECT status FROM subscription WHERE id = '${cancelled.id}'`
      )
    ).toEqual(["cancelled"]);
    await expect(
      rowFor(page, cancelled.reference).getByText("Cancelled", { exact: true })
    ).toBeVisible();
  });
});
