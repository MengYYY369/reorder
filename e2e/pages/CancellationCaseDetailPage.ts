import { expect, Locator, Page } from "@playwright/test";

type CancellationCaseStatus =
  | "Requested"
  | "Evaluating retention"
  | "Retention offered"
  | "Retained"
  | "Paused"
  | "Canceled";

export class CancellationCaseDetailPage {
  readonly page: Page;
  readonly heading: Locator;
  readonly statusBadge: Locator;
  readonly actionMenuTrigger: Locator;
  readonly drawer: Locator;

  constructor(page: Page) {
    this.page = page;
    this.heading = page.getByRole("heading", { level: 1 });

    const headerActions = page
      .locator("div.flex.items-center.gap-x-2")
      .first();
    this.statusBadge = headerActions.locator("span").first();
    this.actionMenuTrigger = headerActions.getByRole("button");
    this.drawer = page.getByRole("dialog");
  }

  async waitForLoaded(): Promise<void> {
    await expect(this.heading).toBeVisible({ timeout: 15_000 });
  }

  async expectCaseStatus(status: CancellationCaseStatus): Promise<void> {
    await expect(this.statusBadge).toContainText(status, { timeout: 10_000 });
  }

  async openActionMenu(): Promise<void> {
    await this.actionMenuTrigger.click();
    await expect(this.page.getByRole("menu")).toBeVisible({ timeout: 5_000 });
  }

  async openApplyRetentionOffer(): Promise<void> {
    await this.page
      .getByRole("menuitem", { name: "Apply retention offer" })
      .click();
    await expect(
      this.drawer.getByRole("heading", { name: "Apply retention offer" }),
    ).toBeVisible();
  }

  async openFinalizeCancellation(): Promise<void> {
    await this.page
      .getByRole("menuitem", { name: "Finalize cancellation" })
      .click();
    await expect(
      this.drawer.getByRole("heading", { name: "Finalize cancellation" }),
    ).toBeVisible();
  }

  menuItem(name: string): Locator {
    return this.page.getByRole("menuitem", { name, exact: true });
  }

  fieldById(id: string): Locator {
    return this.drawer.locator(`#${id}`);
  }

  async selectPauseOffer(): Promise<void> {
    await this.page.locator("#offer-type").click();
    await this.page.getByRole("option", { name: "Pause offer" }).click();
  }

  /** The offer-type Select holds all three offers; only the ones eligible for the
   *  case's current state are rendered as options. */
  async selectOfferType(label: string): Promise<void> {
    await this.page.locator("#offer-type").click();
    await this.page.getByRole("option", { name: label, exact: true }).click();
  }

  async selectBonusType(label: string): Promise<void> {
    await this.page.locator("#bonus-type").click();
    await this.page.getByRole("option", { name: label, exact: true }).click();
  }

  async selectReasonCategory(label: string): Promise<void> {
    await this.page.locator("#cancellation-reason-category").click();
    await this.page.getByRole("option", { name: label, exact: true }).click();
  }

  /** Submits the open drawer by its footer label. The apply-offer drawer's
   *  button is "Apply offer" while the reason drawer's is "Save", so the
   *  label is passed in rather than inferred from the drawer mode. */
  async submitDrawerWithLabel(label: string): Promise<void> {
    await this.drawer.getByRole("button", { name: label, exact: true }).click();
  }

  async fillPauseCycles(cycles: string): Promise<void> {
    await this.page.locator("#pause-cycles").fill(cycles);
  }

  async fillFinalizeReason(reason: string): Promise<void> {
    await this.page.locator("#finalize-reason").fill(reason);
  }

  async selectFinalizeReasonCategory(category: "Price"): Promise<void> {
    await this.page.locator("#finalize-reason-category").click();
    await this.page.getByRole("option", { name: category }).click();
  }

  async submitDrawer(buttonName: "Apply offer" | "Continue"): Promise<void> {
    await this.drawer.getByRole("button", { name: buttonName, exact: true }).click();
  }

  async confirmPrompt(
    confirmText: "Apply pause offer" | "Apply discount offer" | "Apply bonus offer" | "Finalize cancellation",
    confirmButton: string
  ): Promise<void> {
    const prompt = this.page.getByRole("alertdialog", {
      name: new RegExp(`^${confirmText}\\?$`),
    });
    await expect(prompt).toBeVisible({ timeout: 5_000 });
    await prompt
      .getByRole("button", { name: confirmButton, exact: true })
      .click();
  }

  async expectToast(text: string): Promise<void> {
    await expect(this.page.getByText(text)).toBeVisible({ timeout: 10_000 });
  }
}
