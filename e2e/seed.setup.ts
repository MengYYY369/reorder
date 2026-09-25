import { test as setup, expect, request } from "@playwright/test";

const BASE_URL = process.env.ADMIN_BASE_URL ?? "http://localhost:9000";
const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? "admin@medusa-test.com";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "supersecret";

/**
 * Preflight, not a seeder.
 *
 * Every spec inserts the rows it needs through `helpers/db.ts` and deletes them
 * again, so this step does not write to the database at all. What it buys is a
 * single, early, legible failure: if the backend is down, admin login does not
 * work, or `DATABASE_URL` is unset, the run stops here instead of failing once
 * per spec at first navigation.
 */
setup("backend is reachable and admin login works", async () => {
  if (!process.env.DATABASE_URL) {
    throw new Error(
      "DATABASE_URL is not set — the e2e specs seed plugin tables directly, " +
        "so it must point at the database the backend under test uses."
    );
  }

  const api = await request.newContext({ baseURL: BASE_URL });

  const health = await api.get("/health");
  expect(health.ok(), `GET /health -> ${health.status()}`).toBeTruthy();

  const authRes = await api.post("/auth/user/emailpass", {
    data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  expect(
    authRes.ok(),
    `POST /auth/user/emailpass -> ${authRes.status()} ${await authRes.text()}`
  ).toBeTruthy();

  const { token } = await authRes.json();
  const listRes = await api.get("/admin/subscriptions?limit=1", {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(
    listRes.ok(),
    `GET /admin/subscriptions -> ${listRes.status()} ${await listRes.text()}`
  ).toBeTruthy();

  await api.dispose();
});
