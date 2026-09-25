import { Page, Locator, expect } from "@playwright/test";

/**
 * `/app/subscriptions/analytics`.
 *
 * KPI cards and the trend chart are driven entirely by whatever the read model
 * (`subscription_metrics_daily`) happens to hold in the target environment, so
 * this page object asserts the *request contract* rather than card values:
 * which endpoints fire, with which query params, and whether the export flow
 * completes. The chart itself is only assertable through its accessible name
 * (`{label} trend chart`), which disappears when a range has no data.
 *
 * Filter labels are plain `<Text>` nodes with no programmatic association
 * (`analytics/page.tsx:399-438`), so the product Select is matched on the
 * placeholder text inside its trigger rather than by label.
 */
export class AnalyticsPage {
  readonly page: Page;

  readonly heading: Locator;
  readonly productSelect: Locator;
  readonly exportButton: Locator;

  constructor(page: Page) {
    this.page = page;
    this.heading = page.getByRole("heading", { name: "Analytics", exact: true });
    this.productSelect = page
      .getByRole("combobox")
      .filter({ hasText: "All products" });
    this.exportButton = page.getByRole("button", { name: "Export", exact: true });
  }

  async goto(): Promise<void> {
    await this.page.goto("/app/subscriptions/analytics");
    await expect(this.heading).toBeVisible({ timeout: 15_000 });
    await expect(
      this.page.getByText(
        "Review recurring revenue, churn, LTV, and subscription creation trends from the analytics read model."
      )
    ).toBeVisible();
  }

  metricTab(name: "MRR" | "Churn" | "LTV" | "Created"): Locator {
    return this.page.getByRole("button", { name, exact: true });
  }

  async selectProduct(optionName: string): Promise<void> {
    await this.productSelect.click();
    await this.page.getByRole("option", { name: optionName }).click();
  }

  /** The export is a client-side blob download (`analytics/data-loading.ts:168-180`),
   *  so Playwright's download event is unreliable — assert the request instead. */
  async exportCsv(): Promise<{ status: number; url: string }> {
    const responsePromise = this.page.waitForResponse((res) =>
      res.url().includes("/admin/subscription-analytics/export")
    );

    await this.exportButton.click();
    await this.page.getByRole("menuitem", { name: "Export CSV" }).click();

    const res = await responsePromise;
    return { status: res.status(), url: res.url() };
  }

  async expectToast(text: string): Promise<void> {
    await expect(this.page.getByText(text)).toBeVisible({ timeout: 10_000 });
  }
}
