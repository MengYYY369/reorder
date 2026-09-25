import { Page, Locator, expect } from "@playwright/test";

/**
 * `/app/subscriptions/dunning/:id`.
 *
 * The h1 is the case id itself (`dunning/[id]/page.tsx:427`), and the four
 * mutations all live in the header action menu, so the trigger is located the
 * same way the sibling page objects locate theirs. Menu item visibility is the
 * real assertion target: `Retry now` / `Mark recovered` / `Mark unrecovered` /
 * `Edit retry schedule` are hidden together once a case is terminal
 * (`page.tsx:51-54`, `:230-236`).
 */
export class DunningCaseDetailPage {
  readonly page: Page;

  private readonly caseId: string;

  readonly heading: Locator;
  readonly actionTrigger: Locator;
  readonly drawer: Locator;

  constructor(page: Page, caseId: string) {
    this.page = page;
    this.caseId = caseId;
    this.heading = page.getByRole("heading", { name: caseId, exact: true });
    // Same header container as the other detail pages: StatusBadge then the
    // icon-only menu trigger (`dunning/[id]/page.tsx:432-441`).
    this.actionTrigger = page
      .locator("div.flex.items-center.gap-x-2")
      .first()
      .getByRole("button");
    this.drawer = page.getByRole("dialog");
  }

  async goto(): Promise<void> {
    await this.page.goto(`/app/subscriptions/dunning/${this.caseId}`);
    await expect(this.heading).toBeVisible({ timeout: 15_000 });
    await expect(
      this.page.getByText(
        "Review recovery state, linked records, retry timing, and attempt history."
      )
    ).toBeVisible();
  }

  section(title: string): Locator {
    return this.page.getByRole("heading", { name: title, exact: true });
  }

  async openActionMenu(): Promise<void> {
    await this.actionTrigger.click();
    await expect(this.page.getByRole("menu")).toBeVisible({ timeout: 5_000 });
  }

  menuItem(name: string): Locator {
    return this.page.getByRole("menuitem", { name, exact: true });
  }

  async closeActionMenu(): Promise<void> {
    await this.page.keyboard.press("Escape");
    await expect(this.page.getByRole("menu")).toBeHidden();
  }

  async submitDrawer(actionLabel: string): Promise<void> {
    await this.drawer
      .getByRole("button", { name: actionLabel, exact: true })
      .click();
  }

  /** `usePrompt` renders an alertdialog whose accessible name is the prompt title
   *  (e.g. "Mark as recovered?") and whose confirm button reuses the action label. */
  async confirmPrompt(title: string, confirmText: string): Promise<void> {
    const prompt = this.page.getByRole("alertdialog", {
      name: new RegExp(`^${title}$`),
    });
    await expect(prompt).toBeVisible({ timeout: 5_000 });
    await prompt
      .getByRole("button", { name: confirmText, exact: true })
      .click();
  }

  field(label: string): Locator {
    return this.drawer.getByLabel(label);
  }

  /** The drawer's fields do have real `<Label htmlFor>` associations, but the
   *  reason label mutates between "Reason" and "Reason *" depending on the
   *  action, so the required one is addressed by id (`page.tsx:931` block). */
  fieldById(id: string): Locator {
    return this.drawer.locator(`#${id}`);
  }

  async expectToast(text: string): Promise<void> {
    await expect(this.page.getByText(text)).toBeVisible({ timeout: 10_000 });
  }
}
