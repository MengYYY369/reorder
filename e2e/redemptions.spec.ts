import { test, expect, request } from "@playwright/test";
import {
  RedemptionBatchDetailPage,
  RedemptionBatchesPage,
} from "./pages/RedemptionPages";

const BASE_URL = process.env.ADMIN_BASE_URL ?? "http://localhost:9000";
const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? "admin@medusa-test.com";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "supersecret";

const CUSTOM_CODE_BASE = "E2ECODE";

test.describe("Redemption Codes - batch lifecycle through the Admin UI", () => {
  let seededVariantId: string;
  let seededProductTitle: string;
  let seededVariantTitle: string;
  let customCode: string;

  test.beforeEach(async ({}) => {
    const api = await request.newContext({ baseURL: BASE_URL });

    // 1. Authenticate
    const authRes = await api.post("/auth/user/emailpass", {
      data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    });
    expect(authRes.ok()).toBeTruthy();
    const { token } = await authRes.json();
    const headers = { Authorization: `Bearer ${token}` };

    // 2. Seed a product with a variant via the Medusa API
    const productRes = await api.post(
      "/admin/products",
      {
        headers,
        data: {
          title: `E2E Redemption Product ${Date.now()}`,
          options: [{ title: "Default", values: ["Default"] }],
          variants: [
            {
              title: "E2E Redemption Variant",
              prices: [{ currency_code: "usd", amount: 1000 }],
              options: { Default: "Default" },
            },
          ],
        },
      },
    );
    expect(productRes.ok()).toBeTruthy();
    const productData = await productRes.json();
    seededProductTitle = productData.product.title;
    customCode = `${CUSTOM_CODE_BASE}${Date.now()}${Math.floor(Math.random() * 1000)}`;
    seededVariantId = productData.product.variants[0].id;
    seededVariantTitle = productData.product.variants[0].title;

    // 3. Seed an enabled plan offer for the variant through the admin API
    const offerRes = await api.post(
      "/admin/subscription-offers",
      {
        headers,
        data: {
          name: `E2E Redemption Offer ${Date.now()}`,
          scope: "variant",
          product_id: productData.product.id,
          variant_id: seededVariantId,
          is_enabled: true,
          allowed_frequencies: [{ interval: "month", value: 1 }],
          rules: {
            minimum_cycles: null,
            trial_enabled: false,
            trial_days: null,
            stacking_policy: "allowed",
          },
        },
      },
    );
    expect(offerRes.ok()).toBeTruthy();

    await api.dispose();
  });

  test("creates a batch with generated and custom codes", async ({ page }) => {
    const batchesPage = new RedemptionBatchesPage(page);
    const batchName = `E2E Batch ${Date.now()}`;

    const apiPromise = page.waitForResponse(
      (response) =>
        response.url().includes("/admin/redemptions/batches") &&
        response.request().method() === "POST",
    );

    await batchesPage.goto();
    await batchesPage.openCreateModal();
    await batchesPage.fillName(batchName);
    await batchesPage.selectVariant(seededProductTitle, seededVariantTitle);
    await batchesPage.fillFreeCycles(3);
    await batchesPage.fillGeneratedCount(2);
    await batchesPage.addCustomCode(customCode);
    await batchesPage.submit();

    // Validate the outgoing payload against the backend contract.
    const response = await apiPromise;
    expect(response.ok()).toBeTruthy();
    const payload = response.request().postDataJSON();
    expect(payload.variant_id).toEqual(seededVariantId);
    expect(payload.free_cycles).toEqual(3);
    expect(payload.generated_code_count).toEqual(2);
    expect(payload.custom_codes).toEqual([customCode]);

    await batchesPage.expectToast("Redemption batch created");

    // The batch appears in the list.
    await expect(batchesPage.rowForBatch(batchName)).toBeVisible({
      timeout: 10_000,
    });
  });

  test("shows codes on the batch detail and disables a code and the batch", async ({
    page,
  }) => {
    const batchesPage = new RedemptionBatchesPage(page);
    const detailPage = new RedemptionBatchDetailPage(page);
    const batchName = `E2E Disable Batch ${Date.now()}`;

    // Create the batch through the UI first.
    await batchesPage.goto();
    await batchesPage.openCreateModal();
    await batchesPage.fillName(batchName);
    await batchesPage.selectVariant(seededProductTitle, seededVariantTitle);
    await batchesPage.fillFreeCycles(1);
    await batchesPage.fillGeneratedCount(2);
    await batchesPage.addCustomCode(customCode);
    await batchesPage.submit();
    await batchesPage.expectToast("Redemption batch created");

    // Open the detail page.
    await batchesPage.openBatch(batchName);
    await expect(detailPage.heading).toBeVisible();

    // Codes table lists all three codes with statuses.
    await expect(
      page.getByRole("row").filter({ hasText: customCode }).first(),
    ).toBeVisible({ timeout: 10_000 });

    // Disable the custom code; assert toast and row state.
    const codeDisabledResponse = page.waitForResponse(
      (response) =>
        response.url().includes("/disable") &&
        response.url().includes("/codes/") &&
        response.request().method() === "POST",
    );
    await detailPage.disableCode(customCode);
    const codeResponse = await codeDisabledResponse;
    expect(codeResponse.ok()).toBeTruthy();
    expect((await codeResponse.json()).code.status).toEqual("disabled");
    await page
      .getByText("Code disabled", { exact: false })
      .first()
      .waitFor({ timeout: 10_000 });

    // Disable the whole batch; assert toast and status badge.
    const batchDisabledResponse = page.waitForResponse(
      (response) =>
        response.url().includes(`/batches/`) &&
        response.url().includes("/disable") &&
        response.request().method() === "POST",
    );
    await detailPage.disableBatch();
    const batchResponse = await batchDisabledResponse;
    expect(batchResponse.ok()).toBeTruthy();
    expect((await batchResponse.json()).redemption_batch.status).toEqual(
      "disabled",
    );
    await page
      .getByText("Batch disabled", { exact: false })
      .first()
      .waitFor({ timeout: 10_000 });
  });
});
