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
 * The edit drawer is where a live offer's rules change, and every field it
 * writes feeds checkout validation downstream: `rules.trial_*` decides whether a
 * trial cart can be checked out, `discounts[].value` decides what the customer is
 * billed, and `allowed_frequencies` decides which cadences the storefront offers.
 * A wrong write here is silent — nothing else in the admin explains it — so each
 * test below asserts the persisted row, not just the toast.
 *
 * Creating an offer through the UI is already covered by `plans-offers.spec.ts`;
 * this file covers only the update path (`POST /admin/subscription-offers/:id`).
 */
test.describe("Plan offer edit drawer", () => {
  const created: { offerId: string; productId: string }[] = [];

  test.afterEach(async () => {
    while (created.length) {
      const row = created.pop()!;
      await deletePlanOffer(row.offerId);
      await deleteAdminProduct(row.productId);
    }
  });

  async function seedOffer(): Promise<SeededOffer> {
    const product = await createAdminProduct(`E2E Edit Product ${Date.now()}`);
    const offer = await insertPlanOffer(product.id, {
      name: `E2E Edit Offer ${Date.now()}`,
    });
    created.push({ offerId: offer.id, productId: product.id });
    return { ...offer, productId: product.id };
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

  async function openEditDrawer(page: Page, name: string) {
    await rowFor(page, name)
      .getByRole("button")
      .last()
      .click();
    await page.getByRole("menuitem", { name: "Edit", exact: true }).click();

    const drawer = page.getByRole("dialog");
    await expect(
      drawer.getByRole("heading", { name: "Edit plan offer" })
    ).toBeVisible();
    return drawer;
  }

  /** The offer's switches carry no `<Label htmlFor>` — they sit next to a plain
   *  `<Text>` caption — so they are reached through the container that holds the
   *  caption, the same class-chain approach the other page objects use. */
  function switchBeside(drawer: ReturnType<Page["getByRole"]>, caption: string) {
    return drawer
      .locator("div.flex.items-center.justify-between.rounded-lg")
      .filter({ hasText: caption })
      .getByRole("switch");
  }

  /** Tracks POSTs to this offer's update route so "validation blocked it" is
   *  proven by the absence of a request, not by the absence of an error toast. */
  function trackUpdates(page: Page, offerId: string): string[] {
    const seen: string[] = [];
    page.on("request", (req) => {
      if (
        req.method() === "POST" &&
        req.url().includes(`/admin/subscription-offers/${offerId}`)
      ) {
        seen.push(req.url());
      }
    });
    return seen;
  }

  test("opens pre-filled from the stored offer", async ({ page }) => {
    const offer = await seedOffer();
    await gotoAndSearch(page, offer.name);

    const drawer = await openEditDrawer(page, offer.name);

    // The drawer fetches the detail before rendering the form, so an empty field
    // proves nothing — assert the value it actually loaded.
    await expect(drawer.locator("#edit-name")).toHaveValue(offer.name);
    // `insertPlanOffer` seeds two frequencies with a discount on the monthly
    // one; both must survive the round-trip for Save to send them back.
    await expect(
      drawer.locator('input[name="frequency_rows.0.value"]')
    ).toHaveValue("1");
    await expect(
      drawer.locator('input[name="frequency_rows.1.value"]')
    ).toHaveValue("1");
    await expect(
      drawer.locator('input[name="frequency_rows.0.discount_value"]')
    ).toHaveValue("10");
  });

  test("renaming persists the new name and keeps the frequencies", async ({
    page,
  }) => {
    const offer = await seedOffer();
    const renamed = `${offer.name} renamed`;
    await gotoAndSearch(page, offer.name);

    const drawer = await openEditDrawer(page, offer.name);
    await drawer.locator("#edit-name").fill(renamed);

    const responsePromise = page.waitForResponse(
      (res) =>
        res.url().includes(`/admin/subscription-offers/${offer.id}`) &&
        res.request().method() === "POST"
    );
    await drawer.getByRole("button", { name: "Save", exact: true }).click();

    const res = await responsePromise;
    expect(res.status(), await res.text()).toBe(200);
    // The body carries the whole form rather than a patch: a partial update
    // would silently drop the frequencies and discounts.
    expect(res.request().postDataJSON()).toMatchObject({
      name: renamed,
      is_enabled: true,
      allowed_frequencies: [
        { interval: "month", value: 1 },
        { interval: "year", value: 1 },
      ],
      discounts: [
        { interval: "month", frequency_value: 1, type: "percentage", value: 10 },
      ],
    });

    await expect(page.getByText("Plan offer updated")).toBeVisible({
      timeout: 10_000,
    });
    expect(
      await queryRows(`SELECT name FROM plan_offer WHERE id = '${offer.id}'`)
    ).toEqual([renamed]);

    await page.reload();
    await gotoAndSearch(page, renamed);
    await expect(rowFor(page, renamed)).toHaveCount(1);
    await expect(rowFor(page, offer.name)).toHaveCount(0);
  });

  test("enabling a trial without trial days is blocked before the POST", async ({
    page,
  }) => {
    const offer = await seedOffer();
    await gotoAndSearch(page, offer.name);

    const drawer = await openEditDrawer(page, offer.name);
    const posts = trackUpdates(page, offer.id);

    await switchBeside(drawer, "Trial enabled").click();
    await drawer.getByRole("button", { name: "Save", exact: true }).click();

    await expect(
      page.getByText("Trial days is required when trial is enabled")
    ).toBeVisible({ timeout: 10_000 });
    expect(posts).toHaveLength(0);

    // A half-applied trial would let a checkout claim a trial it never
    // configured, so the stored row must be untouched.
    expect(
      await queryRows(
        `SELECT rules->>'trial_enabled' FROM plan_offer WHERE id = '${offer.id}'`
      )
    ).toEqual(["false"]);
  });

  test("a discount with no value is blocked before the POST", async ({ page }) => {
    const offer = await seedOffer();
    await gotoAndSearch(page, offer.name);

    const drawer = await openEditDrawer(page, offer.name);
    const posts = trackUpdates(page, offer.id);

    // Row 0 (monthly) already carries a 10% discount; clearing its value must be
    // rejected locally rather than sent as null.
    await drawer
      .locator('input[name="frequency_rows.0.discount_value"]')
      .fill("");
    await drawer.getByRole("button", { name: "Save", exact: true }).click();

    await expect(page.getByText("Discount value is required")).toBeVisible({
      timeout: 10_000,
    });
    expect(posts).toHaveLength(0);
  });

  test("adding a duplicate frequency row is rejected before the POST", async ({
    page,
  }) => {
    const offer = await seedOffer();
    await gotoAndSearch(page, offer.name);

    const drawer = await openEditDrawer(page, offer.name);
    const posts = trackUpdates(page, offer.id);

    // "Add frequency" appends month × 1, which is exactly what row 0 already is.
    await drawer.getByRole("button", { name: "Add frequency" }).click();
    await drawer.getByRole("button", { name: "Save", exact: true }).click();

    await expect(page.getByText("Frequency must be unique")).toBeVisible({
      timeout: 10_000,
    });
    expect(posts).toHaveLength(0);
  });
});
