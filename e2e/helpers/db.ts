import { Pool, types } from "pg";

// `numeric` / `bigint` columns come back as strings, but so does anything a
// spec hands back through `queryRows`. Parsing every result into a string is
// what the callers want (`max_attempts::text || ...`, `(status = 'x')::text`),
// so the default text handling is left alone — only the JSON/JSONB passthrough
// matters below.
const jsonTypes = [114, 3802]; // json, jsonb
for (const typeId of jsonTypes) {
  types.setTypeParser(typeId, (value) => value);
}

/**
 * E2E data layer.
 *
 * Reorder has no admin "create subscription / dunning case / cancellation case"
 * endpoints (they are created by the store checkout and the renewal-failure
 * flow), so rows are written straight to the module tables — the same approach
 * the Jest integration fixtures take.
 *
 * Everything here talks to Postgres over the `pg` driver rather than shelling
 * out to `psql`, for two reasons: the suite has to run on machines with no
 * Postgres client installed (Windows), and a connection string in the repo is a
 * credential. `DATABASE_URL` is therefore mandatory and has no fallback.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const ADMIN_BASE_URL = process.env.ADMIN_BASE_URL ?? "http://localhost:9000";
const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? "admin@medusa-test.com";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "supersecret";

let pool: Pool | undefined;

function getPool(): Pool {
  if (!DATABASE_URL) {
    throw new Error(
      "DATABASE_URL is not set. The e2e data layer writes plugin tables directly; " +
        "point it at the same database the backend under test uses."
    );
  }

  if (!pool) {
    pool = new Pool({ connectionString: DATABASE_URL });
  }

  return pool;
}

/** Called from Playwright's `globalTeardown` so the run exits cleanly. */
export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}

export function quote(value: string | number | boolean | null): string {
  if (value === null) return "NULL";
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  return `'${value.replace(/'/g, "''")}'`;
}

export function json(value: unknown): string {
  return `${quote(JSON.stringify(value))}::jsonb`;
}

export async function runSql(statements: string): Promise<void> {
  try {
    await getPool().query(statements);
  } catch (error) {
    const details = error as { message?: string; detail?: string; where?: string };
    throw new Error(
      `e2e seed failed: ${details.message ?? String(error)}${
        details.detail ? ` (${details.detail})` : ""
      }${details.where ? ` at ${details.where}` : ""}`
    );
  }
}

/** Reads rows back from the database, for asserting the server-side effect of a
 *  UI action rather than trusting optimistic DOM state. */
export async function queryRows(sql: string): Promise<string[]> {
  try {
    const result = await getPool().query(sql);
    return result.rows.map((row) =>
      Object.values(row)
        .map((value) => (value === null ? "" : String(value)))
        .join("|")
    );
  } catch (error) {
    const details = error as { message?: string };
    throw new Error(`e2e read-back failed: ${details.message ?? String(error)}`);
  }
}

const stamp = () => Date.now();

export type SeededSubscription = {
  id: string;
  reference: string;
  customerId: string;
  productId: string;
  variantId: string;
};

export async function insertSubscription(
  overrides: Partial<{
    status: string;
    reference: string;
    skip_next_cycle: boolean;
    is_trial: boolean;
    next_renewal_at: string | null;
    payment_context: Record<string, unknown> | null;
    shipping_address: Record<string, unknown>;
  }> = {}
): Promise<SeededSubscription> {
  const ts = stamp();
  const id = `sub_e2e_${ts}`;
  const sub: SeededSubscription = {
    id,
    reference: overrides.reference ?? `SUB-E2E-${ts}`,
    customerId: `cus_e2e_${ts}`,
    productId: `prod_e2e_${ts}`,
    variantId: `variant_e2e_${ts}`,
  };
  const now = new Date().toISOString();

  await runSql(`
    INSERT INTO subscription (
      id, reference, status,
      customer_id, cart_id, product_id, variant_id,
      frequency_interval, frequency_value,
      started_at, next_renewal_at,
      skip_next_cycle, is_trial,
      customer_snapshot, product_snapshot, pricing_snapshot,
      shipping_address, payment_context,
      created_at, updated_at
    ) VALUES (
      ${quote(sub.id)}, ${quote(sub.reference)}, ${quote(overrides.status ?? "active")},
      ${quote(sub.customerId)}, ${quote(`cart_e2e_${ts}`)}, ${quote(sub.productId)}, ${quote(sub.variantId)},
      'month', 1,
      ${quote(now)}, ${quote(overrides.next_renewal_at ?? new Date(Date.now() + 30 * 864e5).toISOString())},
      ${quote(overrides.skip_next_cycle ?? false)}, ${quote(overrides.is_trial ?? false)},
      ${json({ email: "e2e@reorder.test", full_name: "E2E Customer" })},
      ${json({
        product_id: sub.productId,
        product_title: "E2E Subscription Product",
        variant_id: sub.variantId,
        variant_title: "Monthly",
        sku: `E2E-${ts}`,
      })},
      ${json({ discount_type: "percentage", discount_value: 0, label: null })},
      ${json(
        overrides.shipping_address ?? {
          first_name: "E2E",
          last_name: "Tester",
          address_1: "Test St 1",
          city: "Warsaw",
          postal_code: "00-001",
          country_code: "PL",
        }
      )},
      ${overrides.payment_context === null ? "NULL" : json(overrides.payment_context ?? { payment_provider_id: "pp_stripe_stripe" })},
      ${quote(now)}, ${quote(now)}
    );
  `);

  return sub;
}

export async function insertRenewalCycle(
  subscriptionId: string,
  options: {
    status?: string;
    scheduledFor?: string;
    approvalRequired?: boolean;
    approvalStatus?: string | null;
  } = {}
): Promise<string> {
  const id = `cycle_e2e_${stamp()}`;
  const now = new Date().toISOString();

  await runSql(`
    INSERT INTO renewal_cycle (
      id, subscription_id, scheduled_for, status,
      approval_required, approval_status, attempt_count,
      created_at, updated_at
    ) VALUES (
      ${quote(id)}, ${quote(subscriptionId)},
      ${quote(options.scheduledFor ?? new Date(Date.now() - 864e5).toISOString())},
      ${quote(options.status ?? "scheduled")},
      ${quote(options.approvalRequired ?? false)}, ${quote(options.approvalStatus ?? null)}, 0,
      ${quote(now)}, ${quote(now)}
    );
  `);

  return id;
}

export async function insertDunningCase(
  subscriptionId: string,
  renewalCycleId: string,
  options: {
    status?: string;
    attemptCount?: number;
    maxAttempts?: number;
    nextRetryAt?: string | null;
    errorCode?: string | null;
  } = {}
): Promise<{ caseId: string; attemptId: string }> {
  const ts = stamp();
  const caseId = `dun_e2e_${ts}`;
  const attemptId = `dunatt_e2e_${ts}`;
  const now = new Date().toISOString();

  await runSql(`
    INSERT INTO dunning_case (
      id, subscription_id, renewal_cycle_id, renewal_order_id,
      status, attempt_count, max_attempts, retry_schedule, next_retry_at,
      last_payment_error_code, last_payment_error_message, last_attempt_at,
      created_at, updated_at
    ) VALUES (
      ${quote(caseId)}, ${quote(subscriptionId)}, ${quote(renewalCycleId)}, NULL,
      ${quote(options.status ?? "retry_scheduled")},
      ${quote(options.attemptCount ?? 1)}, ${quote(options.maxAttempts ?? 3)},
      ${json([1440, 4320, 10080])},
      ${quote(options.nextRetryAt ?? new Date(Date.now() + 864e5).toISOString())},
      ${quote(options.errorCode ?? "CARD_DECLINED")}, ${quote("The card was declined by the issuer.")},
      ${quote(now)},
      ${quote(now)}, ${quote(now)}
    );

    INSERT INTO dunning_attempt (
      id, dunning_case_id, attempt_no, started_at, finished_at,
      status, error_code, error_message, payment_reference,
      created_at, updated_at
    ) VALUES (
      ${quote(attemptId)}, ${quote(caseId)}, 1, ${quote(now)}, ${quote(now)},
      'failed', ${quote(options.errorCode ?? "CARD_DECLINED")},
      ${quote("The card was declined by the issuer.")}, ${quote(`pay_e2e_${ts}`)},
      ${quote(now)}, ${quote(now)}
    );
  `);

  return { caseId, attemptId };
}

export async function insertCancellationCase(
  subscriptionId: string,
  options: {
    status?: string;
    reason?: string;
    reasonCategory?: string;
  } = {}
): Promise<string> {
  const id = `case_e2e_${stamp()}`;
  const now = new Date().toISOString();

  await runSql(`
    INSERT INTO cancellation_case (
      id, subscription_id, status, reason, reason_category, metadata,
      created_at, updated_at
    ) VALUES (
      ${quote(id)}, ${quote(subscriptionId)}, ${quote(options.status ?? "requested")},
      ${quote(options.reason ?? "Customer requested cancellation")},
      ${quote(options.reasonCategory ?? "price")},
      ${json({})},
      ${quote(now)}, ${quote(now)}
    );
  `);

  return id;
}

export type SeededLogEvent = {
  id: string;
  dedupeKey: string;
  eventType: string;
};

export async function insertSubscriptionLog(
  subscription: SeededSubscription,
  event: {
    eventType: string;
    actorType?: string;
    reason?: string | null;
    createdAt?: string;
    changedFields?: string[] | null;
  }
): Promise<SeededLogEvent> {
  const ts = stamp();
  const id = `sublog_e2e_${ts}`;
  const dedupeKey = `e2e:${subscription.reference}:${event.eventType}:${ts}`;
  const createdAt = event.createdAt ?? new Date().toISOString();

  await runSql(`
    INSERT INTO subscription_log (
      id, subscription_id, subscription_reference, customer_id,
      event_type, actor_type, actor_id,
      customer_name, product_title, variant_title,
      reason, dedupe_key, changed_fields,
      created_at, updated_at
    ) VALUES (
      ${quote(id)}, ${quote(subscription.id)}, ${quote(subscription.reference)}, ${quote(subscription.customerId)},
      ${quote(event.eventType)}, ${quote(event.actorType ?? "user")}, ${quote("user_e2e")},
      ${quote("E2E Customer")}, ${quote("E2E Subscription Product")}, ${quote("Monthly")},
      ${quote(event.reason ?? null)}, ${quote(dedupeKey)},
      ${event.changedFields ? json(event.changedFields) : "NULL"},
      ${quote(createdAt)}, ${quote(createdAt)}
    );
  `);

  return { id, dedupeKey, eventType: event.eventType };
}

/** Removes every row a spec inserted, in FK-safe order. */
export async function deleteSubscriptionTree(subscriptionId: string): Promise<void> {
  await runSql(`
    DELETE FROM subscription_log WHERE subscription_id = ${quote(subscriptionId)};
    DELETE FROM dunning_attempt
      WHERE dunning_case_id IN (SELECT id FROM dunning_case WHERE subscription_id = ${quote(subscriptionId)});
    DELETE FROM dunning_case WHERE subscription_id = ${quote(subscriptionId)};
    DELETE FROM renewal_attempt
      WHERE renewal_cycle_id IN (SELECT id FROM renewal_cycle WHERE subscription_id = ${quote(subscriptionId)});
    DELETE FROM renewal_cycle WHERE subscription_id = ${quote(subscriptionId)};
    DELETE FROM retention_offer_event
      WHERE cancellation_case_id IN (SELECT id FROM cancellation_case WHERE subscription_id = ${quote(subscriptionId)});
    DELETE FROM cancellation_case WHERE subscription_id = ${quote(subscriptionId)};
    DELETE FROM subscription WHERE id = ${quote(subscriptionId)};
  `);
}

export type SeededPlanOffer = { id: string; name: string };

/**
 * Plan offers are insertable directly (`plan_offer` has no FK to the product
 * table), but `IDX_plan_offer_product_target_unique` allows only one
 * `scope = 'product'` row per product, so callers must pass a product that has
 * no offer yet.
 */
export async function insertPlanOffer(
  productId: string,
  options: { name?: string; isEnabled?: boolean } = {}
): Promise<SeededPlanOffer> {
  const ts = stamp();
  const id = `plo_e2e_${ts}`;
  const name = options.name ?? `E2E Plan ${ts}`;
  const now = new Date().toISOString();

  await runSql(`
    INSERT INTO plan_offer (
      id, name, scope, product_id, variant_id, is_enabled,
      allowed_frequencies, frequency_intervals, discount_per_frequency, rules,
      created_at, updated_at
    ) VALUES (
      ${quote(id)}, ${quote(name)}, 'product', ${quote(productId)}, NULL,
      ${quote(options.isEnabled ?? true)},
      ${json([{ interval: "month", value: 1 }, { interval: "year", value: 1 }])},
      ARRAY['month','year']::text[],
      ${json([{ interval: "month", value: 1, discount_type: "percentage", discount_value: 10 }])},
      ${json({
        minimum_cycles: null,
        trial_enabled: false,
        trial_days: null,
        trial_requires_payment_method: false,
        stacking_policy: "allowed",
      })},
      ${quote(now)}, ${quote(now)}
    );
  `);

  return { id, name };
}

export async function deletePlanOffer(id: string): Promise<void> {
  await runSql(`DELETE FROM plan_offer WHERE id = ${quote(id)};`);
}

/**
 * A plan offer can only be scoped to a product that has no product-scoped offer
 * yet (`IDX_plan_offer_product_target_unique`), so specs that need an offer
 * create their own product instead of hunting through whatever the environment
 * happens to hold. Leftover products from an older run would otherwise starve
 * the search.
 */
export type SeededProduct = {
  id: string;
  title: string;
  variantId: string;
};

export async function createAdminProduct(title: string): Promise<SeededProduct> {
  const res = await fetch(`${ADMIN_BASE_URL}/admin/products`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${await adminToken()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      title,
      options: [{ title: "Default", values: ["Default"] }],
      variants: [
        {
          title: "Default Variant",
          prices: [{ currency_code: "usd", amount: 1000 }],
          options: { Default: "Default" },
        },
      ],
    }),
  });

  if (!res.ok) {
    throw new Error(`POST /admin/products failed (${res.status}): ${await res.text()}`);
  }

  const { product } = (await res.json()) as {
    product: { id: string; title: string; variants: { id: string }[] };
  };

  return { id: product.id, title: product.title, variantId: product.variants[0].id };
}

export async function deleteAdminProduct(id: string): Promise<void> {
  const res = await fetch(`${ADMIN_BASE_URL}/admin/products/${id}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${await adminToken()}` },
  });

  // A product the suite never created (or already removed) is not worth failing
  // a green test over — cleanup is best-effort by design.
  if (!res.ok && res.status !== 404) {
    throw new Error(`DELETE /admin/products/${id} failed (${res.status}): ${await res.text()}`);
  }
}

/** Admin-scoped JSON fetch, for asserting server state rather than DOM text. */
async function adminToken(): Promise<string> {
  const res = await fetch(`${ADMIN_BASE_URL}/auth/user/emailpass`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  });

  if (!res.ok) {
    throw new Error(`Admin auth failed (${res.status}): ${await res.text()}`);
  }

  return (await res.json()).token as string;
}

export async function adminGet<T = unknown>(path: string): Promise<T> {
  const res = await fetch(`${ADMIN_BASE_URL}${path}`, {
    headers: { Authorization: `Bearer ${await adminToken()}` },
  });

  if (!res.ok) {
    throw new Error(`GET ${path} failed (${res.status}): ${await res.text()}`);
  }

  return (await res.json()) as T;
}

export async function adminPost<T = unknown>(
  path: string,
  body?: unknown
): Promise<T> {
  const res = await fetch(`${ADMIN_BASE_URL}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${await adminToken()}` },
    body: JSON.stringify(body ?? {}),
  });

  if (!res.ok) {
    throw new Error(`POST ${path} failed (${res.status}): ${await res.text()}`);
  }

  return (await res.json()) as T;
}
