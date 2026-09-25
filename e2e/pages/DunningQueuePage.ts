import { Page, Locator, expect } from "@playwright/test";

/**
 * `/app/subscriptions/dunning` — the recovery queue.
 *
 * Strings are the resolved values of `dunning.list.*` / `dunning.filters.*` in
 * `src/admin/i18n/json/en.json` (namespace `reorder`). The admin ships no
 * `data-testid`, so every locator here is role/text based.
 */
export class DunningQueuePage {
  readonly page: Page;

  readonly heading: Locator;
  readonly description: Locator;
  readonly searchInput: Locator;
  readonly addFilterButton: Locator;
  readonly clearAllButton: Locator;
  readonly emptyFilteredHeading: Locator;

  constructor(page: Page) {
    this.page = page;
    this.heading = page.getByRole("heading", { name: "Dunning", exact: true });
    this.description = page.getByText(
      "Monitor past-due subscriptions, retry timing, and recovery state."
    );
    this.searchInput = page.getByPlaceholder("Search");
    this.addFilterButton = page.getByRole("button", { name: "Add filter" });
    this.clearAllButton = page.getByRole("button", { name: "Clear all" });
    this.emptyFilteredHeading = page.getByText("No matching dunning cases");
  }

  async goto(): Promise<void> {
    await this.page.goto("/app/subscriptions/dunning");
    await expect(this.heading).toBeVisible({ timeout: 15_000 });
    await expect(this.description).toBeVisible();
  }

  /** Case rows carry no `<a>`, so scope to the row containing the reference. */
  rowFor(reference: string): Locator {
    return this.page.getByRole("row").filter({ hasText: reference });
  }

  async search(reference: string): Promise<void> {
    await this.searchInput.fill(reference);
    await this.page.waitForResponse((res) =>
      res.url().includes("/admin/dunning")
    );
  }

  /** Opens Add filter → Status and ticks one checkbox item. */
  async toggleStatusFilter(status: string): Promise<void> {
    await this.addFilterButton.click();
    await this.page.getByRole("menuitem", { name: "Status" }).click();
    await this.page.getByRole("menuitemcheckbox", { name: status }).click();
    await this.page.keyboard.press("Escape");
    await this.page.waitForResponse((res) =>
      res.url().includes("/admin/dunning")
    );
  }

  /** Queue rows carry the subscription reference, not the case id, and have no
   *  `<a>` (row `onClick` navigation), so both values are needed to assert the
   *  hop landed on the right case. */
  async openCaseFromQueue(reference: string, caseId: string): Promise<void> {
    await this.rowFor(reference).click();
    await expect(
      this.page.getByRole("heading", { name: caseId, exact: true })
    ).toBeVisible({ timeout: 15_000 });
  }
}
