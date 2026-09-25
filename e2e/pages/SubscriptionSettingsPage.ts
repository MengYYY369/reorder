import { Page, Locator, expect } from "@playwright/test";

/**
 * `/app/settings/subscription-settings`.
 *
 * These are global runtime defaults: a save here changes behaviour for every
 * later renewal, so specs that touch them must restore the previous document.
 * `Save` is disabled until the form is dirty (`page.tsx:349`) and the POST
 * carries `expected_version`, which is what makes a stale-tab conflict possible
 * if two specs save concurrently — hence `workers: 1` in the Playwright config
 * is load-bearing for this page, not just a performance knob.
 */
export class SubscriptionSettingsPage {
  readonly page: Page;

  readonly heading: Locator;
  readonly saveButton: Locator;
  readonly trialDays: Locator;
  readonly maxAttempts: Locator;
  readonly addIntervalButton: Locator;

  constructor(page: Page) {
    this.page = page;
    this.heading = page.getByRole("heading", {
      name: "Subscription Settings",
      exact: true,
    });
    this.saveButton = page.getByRole("button", { name: "Save", exact: true });
    this.trialDays = page.locator("#default_trial_days");
    this.maxAttempts = page.locator("#max_dunning_attempts");
    this.addIntervalButton = page.getByRole("button", { name: "Add interval" });
  }

  async goto(): Promise<void> {
    await this.page.goto("/app/settings/subscription-settings");
    await expect(this.heading).toBeVisible({ timeout: 15_000 });
    await expect(
      this.page.getByText(
        "Manage runtime defaults for trials, dunning, renewals, and cancellation flows."
      )
    ).toBeVisible();
  }

  statusLine(): Locator {
    return this.page.getByText(
      /No unsaved changes|Changes will apply after this save completes|Saving updated defaults/
    );
  }

  async expectToast(text: string): Promise<void> {
    await expect(this.page.getByText(text)).toBeVisible({ timeout: 10_000 });
  }
}
