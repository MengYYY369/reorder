import { expect, test, type Page } from "@playwright/test";
import {
  createAdminProduct,
  deleteAdminProduct,
  deletePlanOffer,
  insertPlanOffer,
  queryRows,
} from "./helpers/db";

type SeededOffer = { id: string; name: string; productId: string };

/**
 * Enable/disable is the cheapest way to break store checkout: a disabled offer
 * silently stops the product from being subscribable, and the toggle changes no
 * plan data, so nothing else in the UI explains it.
 */
test.describe("Plan offers enable / disable", () => {
  const created: SeededOffer[] = [];
  const createdProductIds: string[] = [];

  test.afterEach(async () => {
    while (created.length) {
      await deletePlanOffer(created.pop()!.id);
    }
    while (createdProductIds.length) {
      await deleteAdminProduct(createdProductIds.pop()!);
    }
  });

  /**
   * Creates its own product instead of reusing one from the environment:
   * `IDX_plan_offer_product_target_unique` allows one product-scoped row per
   * product, so a shared catalog runs out of eligible products as soon as an
   * earlier run leaves an offer behind.
   */
  async function seedOffer(enabled: boolean): Promise<SeededOffer> {
    const product = await createAdminProduct(`E2E Offer Product ${Date.now()}`);
    createdProductIds.push(product.id);

    const offer = await insertPlanOffer(product.id, { isEnabled: enabled });
    const seeded = { ...offer, productId: product.id };
    created.push(seeded);
    return seeded;
  }

  async function gotoAndSearch(page: Page, name: string): Promise<void> {
    await page.goto("/app/subscriptions/plans-offers");
    await expect(
      page.getByRole("heading", { name: "Plans & Offers", exact: true })
    ).toBeVisible({ timeout: 15_000 });

    await page.getByPlaceholder("Search").fill(name);
    await page.waitForResponse((res) =>
      res.url().includes("/admin/subscription-offers")
    );
  }

  function rowFor(page: Page, name: string) {
    return page.getByRole("row").filter({ hasText: name });
  }

  test("lists a seeded offer as enabled with its frequencies", async ({
    page,
  }) => {
    const offer = await seedOffer(true);
    await gotoAndSearch(page, offer.name);

    const row = rowFor(page, offer.name);
    await expect(row).toHaveCount(1);
    await expect(row).toContainText("Enabled");
    await expect(row).toContainText("Monthly");
  });

  test("disabling through the row menu persists to the database", async ({
    page,
  }) => {
    const offer = await seedOffer(true);
    await gotoAndSearch(page, offer.name);

    await rowFor(page, offer.name)
      .getByRole("button").last()
      .click();
    await page.getByRole("menuitem", { name: "Disable", exact: true }).click();

    const prompt = page.getByRole("alertdialog", {
      name: /^Disable plan offer\?$/,
    });
    await expect(prompt).toBeVisible();
    await prompt.getByRole("button", { name: "Disable", exact: true }).click();

    await expect(page.getByText("Plan offer disabled")).toBeVisible({
      timeout: 10_000,
    });
    expect(
      await queryRows(`SELECT is_enabled::text FROM plan_offer WHERE id = '${offer.id}'`)
    ).toEqual(["false"]);

    await page.reload();
    await gotoAndSearch(page, offer.name);
    await expect(rowFor(page, offer.name)).toContainText("Disabled");
  });

  test("enabling a disabled offer round-trips", async ({ page }) => {
    const offer = await seedOffer(false);
    await gotoAndSearch(page, offer.name);

    await expect(rowFor(page, offer.name)).toContainText("Disabled");

    await rowFor(page, offer.name)
      .getByRole("button").last()
      .click();
    await page.getByRole("menuitem", { name: "Enable", exact: true }).click();

    const prompt = page.getByRole("alertdialog", {
      name: /^Enable plan offer\?$/,
    });
    await prompt.getByRole("button", { name: "Enable", exact: true }).click();

    await expect(page.getByText("Plan offer enabled")).toBeVisible({
      timeout: 10_000,
    });
    expect(
      await queryRows(`SELECT is_enabled::text FROM plan_offer WHERE id = '${offer.id}'`)
    ).toEqual(["true"]);
  });

  test("the status filter separates enabled from disabled offers", async ({
    page,
  }) => {
    const [enabled, disabled] = [await seedOffer(true), await seedOffer(false)];

    await page.goto("/app/subscriptions/plans-offers");
    await expect(
      page.getByRole("heading", { name: "Plans & Offers", exact: true })
    ).toBeVisible();

    await page.getByRole("button", { name: "Add filter" }).click();
    await page.getByRole("menuitem", { name: "Status" }).click();
    await page.getByRole("menuitemcheckbox", { name: "Disabled" }).click();
    await page.keyboard.press("Escape");
    await page.waitForResponse((res) =>
      res.url().includes("/admin/subscription-offers")
    );

    await expect(rowFor(page, disabled.name)).toHaveCount(1);
    await expect(rowFor(page, enabled.name)).toHaveCount(0);
  });
});
