import { expect, Locator, Page } from "@playwright/test";

export class RedemptionBatchesPage {
  readonly page: Page;
  readonly heading: Locator;
  readonly createBatchButton: Locator;

  constructor(page: Page) {
    this.page = page;
    this.heading = page.getByRole("heading", { level: 1 });
    this.createBatchButton = page
      .getByRole("button", { name: "Create batch" })
      .first();
  }

  async goto(): Promise<void> {
    await this.page.goto("/app/subscriptions/redemptions");
    await expect(this.heading).toBeVisible({ timeout: 15_000 });
  }

  async openCreateModal(): Promise<void> {
    await this.createBatchButton.click();
    await expect(
      this.page.getByRole("heading", { name: "Create redemption batch" }),
    ).toBeVisible({ timeout: 10_000 });
  }

  async fillName(name: string): Promise<void> {
    await this.page.locator("#batch-name").fill(name);
  }

  async selectVariant(
    productTitle: string,
    variantTitle: string,
  ): Promise<void> {
    await this.page
      .getByRole("button", { name: /select variant|variant/i })
      .first()
      .click();
    // Product picker opens first; search for the seeded product, wait for its
    // row to appear, then continue to the variant picker.
    await expect(
      this.page.getByRole("heading", { name: /select product/i }),
    ).toBeVisible({ timeout: 5_000 });
    await this.page
      .getByPlaceholder("Search products...")
      .fill(productTitle);
    const productRow = this.page
      .getByRole("row")
      .filter({ hasText: productTitle })
      .first();
    await expect(productRow).toBeVisible({ timeout: 5_000 });
    await productRow.getByRole("checkbox").click();
    await this.page.getByRole("button", { name: "Apply" }).click();
    await expect(
      this.page.getByRole("heading", { name: /select variant/i }),
    ).toBeVisible({ timeout: 5_000 });
    await this.page
      .getByRole("row")
      .filter({ hasText: variantTitle })
      .first()
      .getByRole("checkbox")
      .click();
    await this.page.getByRole("button", { name: "Apply" }).click();
    await expect(
      this.page.getByText(variantTitle, { exact: false }).first(),
    ).toBeVisible();
  }

  async fillFreeCycles(cycles: number): Promise<void> {
    await this.page.locator("#batch-free-cycles").fill(String(cycles));
  }

  async fillGeneratedCount(count: number): Promise<void> {
    await this.page
      .locator("#batch-generated-count")
      .fill(String(count));
  }

  async addCustomCode(code: string): Promise<void> {
    await this.page
      .getByRole("button", { name: "Add code" })
      .click();
    const inputs = this.page.getByPlaceholder("BLACKFRIDAY2026");
    await inputs.last().fill(code);
  }

  async submit(): Promise<void> {
    await this.page
      .getByRole("button", { name: "Create batch" })
      .last()
      .click();
  }

  async expectToast(message: string): Promise<void> {
    await expect(
      this.page.getByText(message, { exact: false }).first(),
    ).toBeVisible({ timeout: 10_000 });
  }

  rowForBatch(name: string): Locator {
    return this.page.getByRole("row").filter({ hasText: name }).first();
  }

  async openBatch(name: string): Promise<void> {
    await this.rowForBatch(name).getByRole("link").first().click();
    await expect(
      this.page.getByRole("heading", { name: name }),
    ).toBeVisible({ timeout: 10_000 });
  }
}

export class RedemptionBatchDetailPage {
  readonly page: Page;
  readonly heading: Locator;

  constructor(page: Page) {
    this.page = page;
    this.heading = page.getByRole("heading", { level: 1 });
  }

  codeRow(code: string): Locator {
    return this.page.getByRole("row").filter({ hasText: code }).first();
  }

  async disableCode(code: string): Promise<void> {
    await this.codeRow(code).getByRole("button", { name: "Disable code" }).click();
    await expect(
      this.page.getByRole("alertdialog"),
    ).toBeVisible({ timeout: 5_000 });
    await this.page.getByRole("alertdialog").getByRole("button", { name: "Disable" }).click();
  }

  async disableBatch(): Promise<void> {
    await this.page
      .getByRole("button", { name: "Disable batch" })
      .click();
    await expect(
      this.page.getByRole("alertdialog"),
    ).toBeVisible({ timeout: 5_000 });
    await this.page.getByRole("alertdialog").getByRole("button", { name: "Disable" }).click();
  }
}
