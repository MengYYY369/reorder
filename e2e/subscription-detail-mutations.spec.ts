import { expect, test } from "@playwright/test";
import {
  deleteSubscriptionTree,
  insertSubscription,
  queryRows,
} from "./helpers/db";
import { SubscriptionDetailPage } from "./pages/SubscriptionDetailPage";

/**
 * The subscription detail page owns three money/fulfilment mutations that no
 * other spec opens: schedule plan change, edit shipping address and change
 * payment method. Each one is a POST plus an audit-log write, so the tests
 * below assert the persisted document, not just the toast.
 */
test.describe("Subscription detail mutations", () => {
  const created: { id: string }[] = [];

  test.afterEach(async () => {
    while (created.length) {
      await deleteSubscriptionTree(created.pop()!.id);
    }
  });

  async function seed() {
    const sub = await insertSubscription();
    created.push(sub);
    return sub;
  }

  test("renders the detail card set for an active subscription", async ({
    page,
  }) => {
    const sub = await seed();
    const detail = new SubscriptionDetailPage(page);

    await detail.goto(sub.id);

    for (const title of [
      "Subscription",
      "Shipping address",
      "Payment method",
      "Customer",
      "Product",
      "Orders",
      "Activity Log",
    ]) {
      await expect(page.getByText(title, { exact: true }).first()).toBeVisible();
    }

    await detail.expectStatus("Active");
    await expect(page.getByText("E2E Subscription Product")).toBeVisible();
  });

  test("editing the shipping address persists the new document and logs it", async ({
    page,
  }) => {
    const sub = await seed();
    const detail = new SubscriptionDetailPage(page);

    await detail.goto(sub.id);
    await detail.openActionMenu();
    await page.getByRole("menuitem", { name: "Edit shipping address" }).click();

    const drawer = page.getByRole("dialog");
    await expect(
      drawer.getByRole("heading", { name: "Edit shipping address" })
    ).toBeVisible();

    await drawer.getByRole("textbox", { name: "First name" }).fill("Karolina");
    await drawer.getByRole("textbox", { name: "Last name" }).fill("Nowak");
    await drawer.getByRole("textbox", { name: "Address line 1" }).fill("Nowy Swiat 1");
    await drawer.getByRole("textbox", { name: "City" }).fill("Krakow");
    await drawer.getByRole("textbox", { name: "Postal code" }).fill("30-001");
    // Typed upper-case: the payload lower-cases country_code before the POST.
    await drawer.getByRole("textbox", { name: "Country code" }).fill("DE");

    const responsePromise = page.waitForResponse((res) =>
      res.url().includes(`/admin/subscriptions/${sub.id}/update-shipping-address`)
    );
    await drawer.getByRole("button", { name: "Save", exact: true }).click();

    const res = await responsePromise;
    expect(res.status(), await res.text()).toBe(200);

    await detail.expectToast("Shipping address updated");

    expect(
      await queryRows(
        // Parentheses required: ->> and || share precedence, so an unparenthesised
        // chain parses as ((jsonb ->> text) || jsonb) ->> text and errors.
        `SELECT (shipping_address->>'country_code') || '|' || (shipping_address->>'city') || '|' || (shipping_address->>'first_name') FROM subscription WHERE id = '${sub.id}'`
      )
    ).toEqual(["de|Krakow|Karolina"]);

    expect(
      await queryRows(
        `SELECT count(*)::text FROM subscription_log WHERE subscription_id = '${sub.id}' AND event_type = 'subscription.shipping_address_updated'`
      )
    ).toEqual(["1"]);

    await page.reload();
    await detail.waitForLoaded();
    await expect(page.getByText("Krakow").first()).toBeVisible();
  });

  test("address validation blocks the request while a required field is empty", async ({
    page,
  }) => {
    const sub = await seed();
    const detail = new SubscriptionDetailPage(page);
    const posts: string[] = [];
    page.on("request", (req) => {
      if (req.method() === "POST" && req.url().includes("update-shipping-address")) {
        posts.push(req.url());
      }
    });

    await detail.goto(sub.id);
    await detail.openActionMenu();
    await page.getByRole("menuitem", { name: "Edit shipping address" }).click();

    const drawer = page.getByRole("dialog");
    await drawer.getByRole("textbox", { name: "First name" }).fill("");
    await drawer.getByRole("button", { name: "Save", exact: true }).click();

    await detail.expectToast("Fill in all required address fields");
    expect(posts).toHaveLength(0);
  });

  test("the payment method drawer cannot submit without a selection", async ({
    page,
  }) => {
    const sub = await seed();
    const detail = new SubscriptionDetailPage(page);

    await detail.goto(sub.id);
    await detail.openActionMenu();
    await page.getByRole("menuitem", { name: "Change payment method" }).click();

    const drawer = page.getByRole("dialog");
    await expect(
      drawer.getByRole("heading", { name: "Change payment method" })
    ).toBeVisible();

    // The seeded subscription has no vaulted reference, so the list is either
    // empty or has nothing selected — Save stays disabled in both cases.
    await expect(
      drawer.getByRole("button", { name: "Save", exact: true })
    ).toBeDisabled();
  });
});
