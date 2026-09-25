import { expect, test } from "@playwright/test";
import { adminGet } from "./helpers/db";
import { AnalyticsPage } from "./pages/AnalyticsPage";

type ProductList = {
  products: { id: string; title: string; status?: string }[];
};

/**
 * Analytics is a read model: `subscription_metrics_daily` is populated by a
 * nightly job and an explicit rebuild endpoint, so card *values* are
 * environment-dependent and are deliberately not asserted. What is asserted is
 * the request contract the page must honour wherever it runs.
 */
test.describe("Subscription analytics", () => {
  let analytics: AnalyticsPage;

  test.beforeEach(({ page }) => {
    analytics = new AnalyticsPage(page);
  });

  test("requests KPIs, trends and the product filter on load", async ({
    page,
  }) => {
    const requested: string[] = [];
    page.on("request", (req) => {
      if (req.url().includes("/admin/")) requested.push(req.url());
    });

    await analytics.goto();

    await expect
      .poll(() => requested.filter((u) => u.includes("/admin/subscription-analytics/kpis")).length)
      .toBeGreaterThan(0);
    expect(requested.some((u) => u.includes("/admin/subscription-analytics/trends"))).toBeTruthy();
    expect(requested.some((u) => u.includes("/admin/products"))).toBeTruthy();

    const kpisCall = requested.find((u) =>
      u.includes("/admin/subscription-analytics/kpis")
    )!;
    const params = new URL(kpisCall).searchParams;
    expect(params.get("timezone")).toBe("UTC");
    // The page pre-seeds a 30-day window, so an unconfigured range never asks
    // the read model for all history.
    expect(params.get("date_from")).toBeTruthy();
    expect(params.get("date_to")).toBeTruthy();
  });

  test("offers the four metric series tabs", async () => {
    await analytics.goto();

    for (const tab of ["MRR", "Churn", "LTV", "Created"] as const) {
      await expect(analytics.metricTab(tab)).toBeVisible();
    }
  });

  test("selecting a product re-queries the KPI endpoint with product_id", async ({
    page,
  }) => {
    const { products } = await adminGet<ProductList>(
      "/admin/products?limit=20&fields=id,title"
    );

    test.skip(
      products.length === 0,
      "the environment has no products to filter by"
    );

    await analytics.goto();

    const responsePromise = page.waitForResponse((res) => {
      const url = new URL(res.url());
      return (
        url.pathname.endsWith("/admin/subscription-analytics/kpis") &&
        url.searchParams.get("product_id") !== null
      );
    });

    await analytics.selectProduct(products[0].title);
    await responsePromise;
  });

  test("CSV export goes through the admin export endpoint", async () => {
    await analytics.goto();

    const { status, url } = await analytics.exportCsv();

    expect(new URL(url).searchParams.get("format")).toBe("csv");
    expect(status).toBe(200);
    await analytics.expectToast("Analytics CSV export downloaded");
  });
});
