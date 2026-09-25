import { expect, test } from "@playwright/test";
import { adminGet, adminPost } from "./helpers/db";
import { SubscriptionSettingsPage } from "./pages/SubscriptionSettingsPage";

type Settings = {
  subscription_settings: {
    default_trial_days: number;
    dunning_retry_intervals: number[];
    max_dunning_attempts: number;
    default_renewal_behavior: string;
    default_cancellation_behavior: string;
    version: number;
  };
};

/**
 * These are global runtime defaults: saving here changes how later renewals and
 * dunning cases behave for every subscription in the environment, so the
 * original document is always written back.
 */
test.describe("Subscription settings", () => {
  let settings: SubscriptionSettingsPage;

  test.beforeEach(({ page }) => {
    settings = new SubscriptionSettingsPage(page);
  });

  async function restore(previous: Settings["subscription_settings"]) {
    const current = await adminGet<Settings>("/admin/subscription-settings");

    await adminPost("/admin/subscription-settings", {
      default_trial_days: previous.default_trial_days,
      dunning_retry_intervals: previous.dunning_retry_intervals,
      max_dunning_attempts: previous.max_dunning_attempts,
      default_renewal_behavior: previous.default_renewal_behavior,
      default_cancellation_behavior: previous.default_cancellation_behavior,
      expected_version: current.subscription_settings.version,
    });
  }

  test("opens clean, with Save disabled until something is edited", async () => {
    await settings.goto();

    await expect(settings.saveButton).toBeDisabled();
    await expect(settings.statusLine()).toContainText("No unsaved changes");
  });

  test("saving a new default trial period is persisted and reloads", async ({
    page,
  }) => {
    const before = (await adminGet<Settings>("/admin/subscription-settings"))
      .subscription_settings;
    const next = before.default_trial_days === 14 ? 15 : 14;

    try {
      await settings.goto();
      await settings.trialDays.fill(String(next));
      await expect(settings.saveButton).toBeEnabled();

      const responsePromise = page.waitForResponse((res) =>
        res.url().includes("/admin/subscription-settings") &&
        res.request().method() === "POST"
      );
      await settings.saveButton.click();

      const res = await responsePromise;
      expect(res.status(), await res.text()).toBe(200);
      await settings.expectToast("Subscription settings updated");

      await page.reload();
      await settings.goto();
      await expect(settings.trialDays).toHaveValue(String(next));

      const after = (await adminGet<Settings>("/admin/subscription-settings"))
        .subscription_settings;
      expect(after.default_trial_days).toBe(next);
      expect(after.version).toBeGreaterThan(before.version);
    } finally {
      await restore(before);
    }
  });

  test("an interval list that no longer matches max attempts blocks the save", async ({
    page,
  }) => {
    const posts: string[] = [];
    page.on("request", (req) => {
      if (req.method() === "POST" && req.url().includes("/admin/subscription-settings")) {
        posts.push(req.url());
      }
    });

    await settings.goto();
    await settings.addIntervalButton.click();
    await expect(settings.saveButton).toBeEnabled();
    await settings.saveButton.click();

    await settings.expectToast(
      "Max dunning attempts must match the number of retry intervals"
    );
    expect(posts).toHaveLength(0);
  });
});
