import { Page, Locator, expect } from "@playwright/test";

/**
 * `/app/subscriptions/activity-log`.
 *
 * Event type cells render the last dotted segment of `event_type` with
 * underscores turned into spaces and each word capitalised
 * (`activity-log/page.tsx:898-905`), so `subscription.paused` shows as
 * "Paused" and `dunning.started` as "Started". Those short labels are not unique
 * across domains, which is why every assertion below is scoped to a row.
 */
export class ActivityLogPage {
  readonly page: Page;

  readonly heading: Locator;
  readonly searchInput: Locator;
  readonly addFilterButton: Locator;
  readonly clearAllButton: Locator;

  constructor(page: Page) {
    this.page = page;
    this.heading = page.getByRole("heading", { name: "Activity Log", exact: true });
    this.searchInput = page.getByPlaceholder("Search");
    this.addFilterButton = page.getByRole("button", { name: "Add filter" });
    this.clearAllButton = page.getByRole("button", { name: "Clear all" });
  }

  async goto(): Promise<void> {
    await this.page.goto("/app/subscriptions/activity-log");
    await expect(this.heading).toBeVisible({ timeout: 15_000 });
    await expect(
      this.page.getByText(
        "Review subscription lifecycle events across renewals, dunning, and cancellation workflows."
      )
    ).toBeVisible();
  }

  rowFor(reference: string): Locator {
    return this.page.getByRole("row").filter({ hasText: reference });
  }

  async search(reference: string): Promise<void> {
    await this.searchInput.fill(reference);
    await this.page.waitForResponse((res) =>
      res.url().includes("/admin/subscription-logs")
    );
  }

  /** Add filter → Event type → tick one checkbox item. */
  async toggleEventType(eventTypeLabel: string): Promise<void> {
    await this.addFilterButton.click();
    await this.page.getByRole("menuitem", { name: "Event type" }).click();
    await this.page
      .getByRole("menuitemcheckbox", { name: eventTypeLabel, exact: true })
      .click();
    await this.page.keyboard.press("Escape");
    await this.page.waitForResponse((res) =>
      res.url().includes("/admin/subscription-logs")
    );
  }

  async openFirstEventRow(reference: string): Promise<void> {
    await this.rowFor(reference).first().click();
    await expect(
      this.page.getByRole("heading", { name: "Activity Log Event", exact: true })
    ).toBeVisible({ timeout: 10_000 });
  }
}
