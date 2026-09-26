# Money Basis Switch (minor → major) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert the production store's stored money from minor to major units — per currency, following Medusa's own conventions — in one rehearsed stop-the-world window, so the already-deployed major-unit code reads correct values.

**Architecture:** Three repositories move as one atomic set: the host app (`medusa-saas`) owns the conversion SQL, the seeds and the image build; the payment provider (`medusa-paypal`) must validate and store major amounts; this plugin (`reorder`) carries fixture churn only, because it deliberately contains no rescaling. The conversion is one transactional SQL script that resolves each table's currency through an explicit, verified join chain, divides by `10^decimal_digits`, regenerates the `raw_*` JSONB mirrors, and asserts per-currency sum identities. It runs on a restored copy of production first, and on production only with the store stopped and explicit authorization.

**Tech Stack:** PostgreSQL 17 (`numeric` money), Medusa v2 (2.20.0 pinned), pnpm workspace + Docker (host), TypeScript + jest, MikroORM migrations.

**Spec:** `.agents/specs/2026-09-26-money-basis-minor-to-major.md` — read it with this plan. The plan argues from the spec; where they disagree, the spec wins and the disagreement is a finding.

## Global Constraints

- No customers exist; current data is disposable; downtime is acceptable (user decisions Q1-Q8, spec's Decisions table).
- All stored money follows Medusa's canonical basis: **major units in `numeric`**. Minor units exist only at the payment-provider boundary.
- Conversion factor is `10^decimal_digits` **per currency** — never a blanket ÷100.
- `reorder` gains **no** ÷100/×100 compensation, ever (`docs/releases/1.6.0-host-upgrade.md:19-24`).
- Sibling repos (`D:\Projects\medusa-saas`, `D:\Projects\medusa-paypal`) are **edits-only**: both carry the owner's uncommitted work. No `git add`/`commit`/`stash`/`checkout` there without the user's explicit word.
- Production writes (the window, the conversion, `medusa db:migrate`) require their own explicit authorization at execution time, after the rehearsal output has been shown to the user.
- **Never boot the app against a restored copy of production** — restored payment references plus live provider credentials can charge real money. Rehearsals are migrate-only and SQL-only.
- **Deadline:** the earliest due renewal cycle is **2026-10-18** and the scheduler runs every 5 minutes. The window completes before that date and re-asserts `due = 0` inside the window.
- Prod DB access is read-only unless a step says otherwise: `ssh ubuntu@170.106.132.210`, `sudo -n docker exec medusa-prod-db-1 psql -U medusa -d medusa_store`. Role `medusa`, database `medusa_store`. Never print a credential.
- Local gates need `DB_HOST=localhost` (never `127.0.0.1` — it wedges `PgConnection`) and the four `DB_*` exported in the same shell as jest.
- English for every artifact (repo rule).

---

### Task 1: Verify the join table and the money-column inventory against the live database

**Files:**
- Modify: `.agents/specs/2026-09-26-money-basis-minor-to-major.md` (append "Appendix A: verified join paths and inventory")
- Read-only against production `medusa_store`

**Interfaces:**
- Consumes: the spec's currency-resolution table (its draft form).
- Produces: a verified, query-backed join path **per money table**, and the complete inventory of money columns — the exact list Task 2 implements against. Later tasks reference Appendix A by table name.

- [ ] **Step 1: Inventory every money-bearing column**

```bash
ssh ubuntu@170.106.132.210 "sudo -n docker exec medusa-prod-db-1 psql -U medusa -d medusa_store -Atc \"select table_name||' | '||column_name||' | '||data_type||' | '||coalesce(numeric_precision::text,'-')||' | '||coalesce(numeric_scale::text,'-') from information_schema.columns where table_schema='public' and (column_name ilike '%amount%' or column_name ilike '%total%' or column_name ilike '%price%' or column_name ilike '%fee%' or column_name ilike '%mrr%' or column_name ilike '%cost%' or column_name ilike '%balance%') order by table_name, column_name\""
```

Record the output verbatim in Appendix A. Reconcile against the spec's ~29-column list: **any column present in the DB but absent from the list, or vice versa, is a finding** — write it down, do not skip it silently.

- [ ] **Step 2: Discover the real parent links for tables that lack `currency_code`**

```bash
ssh ubuntu@170.106.132.210 "sudo -n docker exec medusa-prod-db-1 psql -U medusa -d medusa_store -Atc \"select table_name||' | '||column_name from information_schema.columns where table_schema='public' and table_name in ('order_line_item','order_transaction','order_claim','order_exchange','order_credit_line','credit_line','order_change_action','order_line_item_adjustment','order_shipping_method','order_shipping_method_adjustment','cart_line_item','capture','refund','payment_session') and (column_name like '%_id' or column_name = 'currency_code') order by table_name, column_name\""
```

- [ ] **Step 3: Prove each join returns rows**

For every table that resolves through a parent, count through the join you intend to use; line items shown, every other table gets its own query:

```bash
ssh ubuntu@170.106.132.210 "sudo -n docker exec medusa-prod-db-1 psql -U medusa -d medusa_store -Atc \"select count(*) from order_line_item li join \\\"order\\\" o on o.id = li.order_id\""
```

A join returning 0 rows where the table itself has rows means the path is wrong — fix it before writing it down. Record every proven path in Appendix A as `table → parent → currency column` with its proving query.

- [ ] **Step 4: Record the currency set and the guard's baseline**

```bash
ssh ubuntu@170.106.132.210 "sudo -n docker exec medusa-prod-db-1 psql -U medusa -d medusa_store -Atc \"select code||' dd='||decimal_digits from currency where code in (select distinct currency_code from price) order by 1\""
```

Expected today: `cny dd=2`, `usd dd=2`. Record it; Task 2's store-default guard is built on this.

- [ ] **Step 5: Append Appendix A and commit**

```bash
git add .agents/specs/2026-09-26-money-basis-minor-to-major.md
git commit -m "docs(spec): verify the money join paths and column inventory against production"
```

---

### Task 2: Rewrite the host conversion SQL — per currency, guarded, per-currency assertions

**Files:**
- Modify: `D:\Projects\medusa-saas\scripts\money-minor-to-major.sql` (edits only — no commit in that repo)
- Read: the script's existing structure (`money_unit_migration` guard, `DO_COMMIT` gate, `raw_*` regeneration, jsonb conversions, DELETE-for-rebuild)

**Interfaces:**
- Consumes: Appendix A's verified join paths (Task 1).
- Produces: a script whose conversion expressions divide by `power(10, c.decimal_digits)` through the verified joins, with the mixed-basis guard and per-currency assertions. Task 8 runs it against the rehearsal copy; Task 10 runs it against production.

- [ ] **Step 1: Replace the blanket divisor with per-currency division, table by table**

The pattern (line items shown; every table in Appendix A gets its own instance with its own join):

```sql
UPDATE order_line_item li
   SET unit_price = li.unit_price / power(10, c.decimal_digits)
  FROM "order" o
  JOIN currency c ON c.code = o.currency_code
 WHERE o.id = li.order_id
   AND li.unit_price IS NOT NULL;
```

Rules: `power(10, c.decimal_digits)` everywhere; `IS NOT NULL` guards on nullable columns; the six tables carrying `currency_code` on the row join `currency` directly; an unresolved join must ABORT (Step 3). Apply to every money column of every table in Appendix A — including `compare_at_unit_price`, adjustments, shipping methods, transactions, claims, exchanges, credit lines, captures, refunds, and `paypal_subscription.locked_amount`.

- [ ] **Step 2: Keep the type ALTER first, and make it idempotent**

Confirm the script still runs the `paypal_subscription.locked_amount` type change **before** any division, and make it conditional so a second run does not error:

```sql
DO $$
BEGIN
  IF (SELECT data_type FROM information_schema.columns
       WHERE table_name='paypal_subscription' AND column_name='locked_amount') = 'integer' THEN
    ALTER TABLE paypal_subscription ALTER COLUMN locked_amount TYPE numeric(20,6);
  END IF;
END $$;
```

- [ ] **Step 3: Add the mixed-basis guard and the store-default guard**

```sql
-- Mixed-basis guard: major-unit code has been live since this timestamp.
DO $$
DECLARE v_bad bigint;
BEGIN
  SELECT count(*) INTO v_bad FROM (
    SELECT 1 FROM "order"              WHERE created_at > '2026-09-26T04:18:56Z'
    UNION ALL SELECT 1 FROM price      WHERE created_at > '2026-09-26T04:18:56Z'
    UNION ALL SELECT 1 FROM payment    WHERE created_at > '2026-09-26T04:18:56Z'
    UNION ALL SELECT 1 FROM payment_collection WHERE created_at > '2026-09-26T04:18:56Z'
  ) t;
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'mixed basis: % money row(s) written after the major-unit code went live; converting them would destroy their value', v_bad;
  END IF;
END $$;

-- Store-default guard: currency-less jsonb money converts only while every live currency has 2 decimals.
DO $$
DECLARE v_bad text;
BEGIN
  SELECT string_agg(code, ', ') INTO v_bad FROM currency
   WHERE decimal_digits <> 2 AND code IN (SELECT DISTINCT currency_code FROM price);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'currency-less jsonb money cannot be converted per-currency; live currencies with dd<>2: %', v_bad;
  END IF;
END $$;
```

Extend the first guard's table list to every table with `created_at` in Appendix A — the four shown are the minimum.

- [ ] **Step 4: Convert the currency-less jsonb money under the store default**

For variant `metadata.paypal_subscription.setup_fee` / `trial_periods[].price`, `plan_offer.discount_per_frequency` (fixed only), `subscription.pricing_snapshot` (fixed values + label rebuild), `retention_offer_event.offer_payload` (fixed only): divide by 100 **only after Step 3's guard has proven every live currency is dd=2**, and say so in a comment. Percentage discounts are untouched.

- [ ] **Step 5: Replace the assertions with per-currency ones**

- Sum identity per currency (post = pre / 10^dd, exact), not a global `/100`.
- The "still looks like cents" threshold becomes per currency: abort only when a value is implausibly large **for its currency** — a legitimate ¥15,000 JPY price must not trip a dd=2-shaped threshold.
- Fractional presence (`amount <> trunc(amount)`) asserts only for dd>0 rows; for dd=0 rows assert values are whole.
- Remove the `post_sum > 0 AND …` skip: a table with `pre_sum = 0` must be asserted genuinely empty (0 rows) rather than skipping the check.

- [ ] **Step 6: Prove no blanket divisor remains**

```bash
cd /d/Projects/medusa-saas && grep -nE "/ *100\b|\* *100\b" scripts/money-minor-to-major.sql
```

Every surviving hit must be a comment or a guard/assertion naming the old convention; list each with a one-line justification in the report.

- [ ] **Step 7: Report the diff; hand the commit to the owner**

```bash
cd /d/Projects/medusa-saas && git diff --stat scripts/money-minor-to-major.sql
```

Do **not** commit. Report the diff summary and the grep result.

---

### Task 3: Verify and complete the provider edits (`medusa-paypal`)

**Files:**
- Verify (already edited in the working tree, uncommitted, unreviewed): `src/subscription/metadata.ts`, `src/modules/paypal-subscription/models/paypal-subscription.ts`, `src/modules/paypal-subscription/migrations/Migration20260919000001.ts`, `docs/tutorial.zh-CN.md`
- Create: `src/subscription/__tests__/metadata-money.test.ts`

**Interfaces:**
- Consumes: the spec's atomic-set requirements for the provider.
- Produces: money-field validation accepting `9.99` and rejecting `"9.99"`-as-string / `9.9999` / negatives; counts still integers; migration declaring `NUMERIC(20,6)`; a permanent regression test.

- [ ] **Step 1: Read the four in-tree diffs and judge each against the spec**

```bash
cd /d/Projects/medusa-paypal && git diff src/subscription/metadata.ts src/modules/paypal-subscription/models/paypal-subscription.ts src/modules/paypal-subscription/migrations/Migration20260919000001.ts docs/tutorial.zh-CN.md
```

Check: `moneyAmountSchema` allows at most 3 decimals and non-negatives; `count`/`interval_count` remain `.int()`; the migration's `NUMERIC(20,6)` matches the conversion script's ALTER target; no comment still claims minor units. Any mismatch is fixed here.

- [ ] **Step 2: Write the regression test**

Create `src/subscription/__tests__/metadata-money.test.ts`:

```ts
import { paypalSubscriptionMetadataSchema } from "../metadata"

const base = {
  interval_unit: "MONTH" as const,
  interval_count: 1,
  product_type: "SERVICE" as const,
}

describe("paypal subscription metadata money fields", () => {
  it("accepts two-decimal major amounts", () => {
    expect(
      paypalSubscriptionMetadataSchema.parse({ ...base, setup_fee: 9.99 })
    ).toBeTruthy()
    expect(
      paypalSubscriptionMetadataSchema.parse({
        ...base,
        trial_periods: [{ unit: "DAY", count: 7, price: 1.99 }],
      })
    ).toBeTruthy()
  })

  it("accepts zero-decimal and three-decimal amounts", () => {
    expect(
      paypalSubscriptionMetadataSchema.parse({ ...base, setup_fee: 100 })
    ).toBeTruthy()
    expect(
      paypalSubscriptionMetadataSchema.parse({ ...base, setup_fee: 9.999 })
    ).toBeTruthy()
  })

  it("rejects non-numeric, over-precise and negative amounts", () => {
    expect(() =>
      paypalSubscriptionMetadataSchema.parse({ ...base, setup_fee: "9.99" as never })
    ).toThrow()
    expect(() =>
      paypalSubscriptionMetadataSchema.parse({ ...base, setup_fee: 9.9999 })
    ).toThrow()
    expect(() =>
      paypalSubscriptionMetadataSchema.parse({ ...base, setup_fee: -1 })
    ).toThrow()
  })

  it("keeps counts and intervals integers", () => {
    expect(() =>
      paypalSubscriptionMetadataSchema.parse({ ...base, interval_count: 1.5 })
    ).toThrow()
  })
})
```

- [ ] **Step 3: Run the test**

```bash
cd /d/Projects/medusa-paypal && npx jest src/subscription/__tests__/metadata-money.test.ts
```

Expected: PASS if the in-tree edit is correct. A FAIL here is the finding — fix the schema, not the test.

- [ ] **Step 4: Typecheck the touched sources**

```bash
cd /d/Projects/medusa-paypal && npx tsc --noEmit 2>&1 | head -20
```

Zero errors in the four touched files (pre-existing errors elsewhere are recorded, not fixed).

- [ ] **Step 5: Report; hand the commit to the owner**

```bash
cd /d/Projects/medusa-paypal && git diff --stat
```

Do **not** commit — the tree also holds the owner's own `0.5.0` bump and CHANGELOG work.

---

### Task 4: Host seeds to major units and the storefront cleanup (`medusa-saas`)

**Files:**
- Modify: `apps/backend/src/scripts/seed-saas.ts`, `apps/backend/src/scripts/seed.ts`, `apps/backend/src/scripts/upsert-prod-variants.ts`
- Modify: the storefront constant `noDivisionCurrencies` in `apps/storefront/**/constants.tsx` (dead since `52f3e41` — delete it)
- Edits only; no commit in that repo

**Interfaces:**
- Consumes: nothing from earlier tasks (independent).
- Produces: seeds that write major amounts, so a fresh environment matches a converted production; the JSON-object metadata fix that Task 8's fail-closed assertion depends on.

- [ ] **Step 1: Convert each seeded money literal**

Divide every money literal by 100 (all seeded currencies are dd=2) and keep the same semantic value: `999 → 9.99`, `9990 → 99.9`, `6900 → 69`, `69900 → 699`, `9900 → 99`, `990 → 9.9`. Every site: `seed-saas.ts:36-37`, `seed.ts:27,36`, `upsert-prod-variants.ts:53-69`, and any other literal the files contain — grep each file for `\b\d{3,}\b` and classify every hit as money or not before editing.

- [ ] **Step 2: Fix the JSON-string metadata write**

Find the seed that writes `paypal_subscription` variant metadata via `JSON.stringify` and make it write an object instead. The conversion script's fail-closed assertion refuses JSON strings (correctly); a fresh seed must not create one.

- [ ] **Step 3: Delete the dead constant**

```bash
cd /d/Projects/medusa-saas && grep -rn "noDivisionCurrencies" apps/ | head
```

Delete the declaration and any remaining reference; confirm the grep is empty afterwards.

- [ ] **Step 4: Prove the edits**

```bash
cd /d/Projects/medusa-saas && git diff --stat && grep -rn "JSON.stringify" apps/backend/src/scripts/ | grep -i paypal
```

The second command must return nothing. Report both outputs.

---

### Task 5: `reorder` fixtures to major units, and the scale-blind assertions

**Files:**
- Modify: `integration-tests/http/saas-bridge.spec.ts` (`unit_price: 1800`, `amount: 1800` at `:162,:176,:1118`), `integration-tests/http/dunning-workflows.spec.ts` (`129`/`250`, `0.01` epsilons at `:360,:370`), `integration-tests/http/renewals-workflows.spec.ts` (`0.01` at `:136,:180`), `integration-tests/http/manual-renewal.spec.ts` (`0.01` at `:291`), `integration-tests/http/analytics-workflows.spec.ts:127` (scale-blind), `src/modules/analytics/__tests__/admin-query.spec.ts` (scale-blind), `integration-tests/helpers/checkout-fixtures.ts:86-115`, and the three `e2e/` files carrying minor literals
- Test: the same files

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: fixtures in major units and scale-fixing literals, so the gates stop passing at either scale.

- [ ] **Step 1: Convert fixture literals**

`1800 → 18`, `129 → 1.29`, `250 → 2.5` — divide by 100, same semantic value. Grep each file for `\b\d{3,}\b` first and classify every hit (money vs count vs id) before editing; ids and counts stay.

- [ ] **Step 2: Fix the scale-blind assertions**

`analytics-workflows.spec.ts:127` compares `total: 129` to `mrr_amount: 129`; `admin-query.spec.ts` derives values from each other. Add one literal that fixes the scale in each — e.g. assert the converted value against `18` rather than against a value computed from the same input.

- [ ] **Step 3: Confirm the epsilon tests' new meaning**

The `0.01`-epsilon tests assert that a total lands exactly on the currency epsilon. In major units `0.01` is the smallest USD cent — the tests keep working but now test a different magnitude. Read each and state in the commit body whether the intent still holds.

- [ ] **Step 4: Gates**

```bash
cd /d/Projects/reorder && corepack yarn build && TEST_TYPE=integration:modules NODE_OPTIONS=--experimental-vm-modules corepack yarn jest --forceExit
```

Then the http gate with the union-of-runs protocol (one file per invocation where a single file is being iterated; the full gate loses ~2 suites per run to `SIGTERM` — re-run the killed names isolated). Baselines before this task: modules 32/312, http 36/255 — every delta named.

- [ ] **Step 5: Commit**

```bash
git add integration-tests src/modules/analytics e2e
git commit -m "test(money): move fixtures to major units"
```

---

### Task 6: Vendor swap and image build (`medusa-saas`)

**Files:**
- Modify: `D:\Projects\medusa-saas\vendor\@mengyyy369\reorder` (replace with the 1.6.1 tree), `vendor\@mengyyy369\medusa-paypal` (replace with the committed 0.5.0 tree)
- Build: the backend image off-box, per `docs/releases/1.6.0-host-upgrade.md` (Production rehearsal section)

**Interfaces:**
- Consumes: Tasks 3-5 (the trees being vendored must already carry their changes).
- Produces: a built image whose vendored versions are provably `reorder 1.6.1` + `medusa-paypal 0.5.0`, tagged for Task 10.

- [ ] **Step 1: Swap the vendored trees**

Copy the `reorder` 1.6.1 sources (the published tarball's contents or a fresh `medusa plugin:build` output) over `vendor/@mengyyy369/reorder`, preserving the empty `saas-bridge/migrations/` directory shape the host needs (Task 25's rehearsal proved umzug mkdirs it — a writable tree is fine, but do not delete the directory if present). Copy the `medusa-paypal` working tree over its vendor path.

- [ ] **Step 2: Build the image**

Follow the runbook's off-box build (recent tags were built from this local checkout, not on the host). Record the exact command and the resulting image tag.

- [ ] **Step 3: Prove the versions INSIDE the image**

```bash
docker run --rm --entrypoint sh <image>:<tag> -c "cat /app/apps/backend/vendor/@mengyyy369/reorder/package.json | head -3; cat /app/apps/backend/vendor/@mengyyy369/medusa-paypal/package.json | head -3; grep -c '100' /app/apps/backend/src/lib/transactional-emails.ts"
```

Expected: `1.6.1`, `0.5.0`, and the email formatter shows no `/100`. Paste the output.

- [ ] **Step 4: Record the tag and stop**

Report the image tag and the proof. Do not deploy — Task 10 owns deployment.

---

### Task 7: Rehearsal part 1 — fresh scratch restore, completeness, currency coverage

**Files:**
- Create: `docs/releases/2026-09-money-basis-switch.md` in `reorder` (the tracked runbook for this switch)
- Scratch DB on the prod host: a NEW name (never reuse `medusa_rehearsal_161`)

**Interfaces:**
- Consumes: the pre-upgrade dump retained by the 1.6.1 rehearsal (on the host, `chmod 600`).
- Produces: a restored, completeness-asserted scratch copy seeded with dd=0 and dd=3 rows — the fixture Tasks 8-9 run against.

- [ ] **Step 1: Create the scratch DB and restore**

```bash
ssh ubuntu@170.106.132.210 "sudo -n docker exec medusa-prod-db-1 createdb -U medusa medusa_money_rehearsal"
ssh ubuntu@170.106.132.210 "sudo -n docker exec medusa-prod-db-1 pg_restore -U medusa -d medusa_money_rehearsal /tmp/prod-pre-1.6.0.dump"
```

- [ ] **Step 2: Assert restore completeness before anything else**

```bash
ssh ubuntu@170.106.132.210 "sudo -n docker exec medusa-prod-db-1 psql -U medusa -d medusa_money_rehearsal -Atc \"select (select count(*) from subscription), (select count(*) from renewal_cycle), (select count(*) from renewal_cycle where status='scheduled' and deleted_at is null), (select count(*) from mikro_orm_migrations)\""
```

Expected: `16|18|13|208`. Any other numbers = the restore is partial; **stop**, because every later assertion would be vacuously green.

- [ ] **Step 3: Seed the currency coverage the production data does not have**

Prod holds only usd/cny (both dd=2). The per-currency branches must be exercised here. Insert, directly in the scratch DB:

```sql
-- a JPY (dd=0) and a KWD (dd=3) price row, with obviously-cents-scale values
INSERT INTO price (id, title, status, amount, currency_code, created_at, updated_at)
VALUES ('price_jpy_probe', 'JPY probe', 'active', 15000, 'jpy', now(), now()),
       ('price_kwd_probe', 'KWD probe', 'active', 9999, 'kwd', now(), now());
```

Plus one order line item and one variant-metadata `setup_fee` in each currency, so every conversion branch (direct column, parent join, currency-less jsonb) runs at least once. Record the exact statements in the runbook.

- [ ] **Step 4: Start the runbook and record part 1**

Create `docs/releases/2026-09-money-basis-switch.md` with: the scratch name, the restore command, the completeness assertion with its actual output, the seeding statements, and a "not yet run" marker for the conversion. Commit:

```bash
git add docs/releases/2026-09-money-basis-switch.md
git commit -m "docs(release): start the money basis switch runbook with the rehearsal restore"
```

---

### Task 8: Rehearsal part 2 — run the conversion on the scratch copy and assert per currency

**Files:**
- Run: `scripts/money-minor-to-major.sql` from `D:\Projects\medusa-saas` (Task 2's rewrite) against `medusa_money_rehearsal`
- Modify: `docs/releases/2026-09-money-basis-switch.md` (record results)

**Interfaces:**
- Consumes: Task 2's script, Task 7's restored+seeded scratch DB.
- Produces: the rehearsal evidence the user sees before authorizing the production window.

- [ ] **Step 1: Dry run (default rollback) and read the output**

```bash
ssh ubuntu@170.106.132.210 "sudo -n docker exec -i medusa-prod-db-1 psql -U medusa -d medusa_money_rehearsal -v ON_ERROR_STOP=1 < /path/to/money-minor-to-major.sql"
```

Copy the script to the host first (a scratch path, never into the app). Expected: every assertion runs, the run ends with ROLLBACK, and nothing changed. Capture the full output.

- [ ] **Step 2: Assert the guards actually fire — negative tests**

Three deliberate violations, each in its own transaction, each expected to ABORT:
(a) temporarily insert a JPY price row with `created_at = now()` and re-run → the mixed-basis guard must fire (the seeded probe rows from Task 7 use `now()`, so they will — if the guard does NOT fire, that is a finding: the guard's table list is incomplete);
(b) temporarily set `currency.decimal_digits = 3` for `jpy` and re-run → the store-default guard must fire;
(c) temporarily set `price.amount = 15000` on a USD row and re-run → the per-currency "looks like cents" assertion must fire.
Roll back each violation after the check. Record the exact error text of each.

- [ ] **Step 3: Commit run**

```bash
ssh ubuntu@170.106.132.210 "sudo -n docker exec -i medusa-prod-db-1 psql -U medusa -d medusa_money_rehearsal -v ON_ERROR_STOP=1 -v DO_COMMIT=1 < /path/to/money-minor-to-major.sql"
```

Expected: COMMIT, no exception.

- [ ] **Step 4: Verify the result independently of the script's own assertions**

```sql
-- spot checks, run by hand:
select currency_code, count(*), min(amount), max(amount) from price group by 1 order by 1;
select count(*) from price where amount <> trunc(amount) and currency_code in ('usd','cny');  -- expect > 0 (fractions exist)
select count(*) from price where amount <> trunc(amount) and currency_code in ('jpy','krw');  -- expect 0 (whole units)
select count(*) from paypal_subscription where locked_amount = 9;                              -- expect 0 (no truncation)
select * from money_unit_migration;                                                            -- expect exactly one row
```

Then re-run the script once more: expected to refuse with the idempotency error, proving the guard table works.

- [ ] **Step 5: Record and commit**

Append to the runbook: the dry-run output, the three negative tests with their error texts, the commit output, the five spot checks with actual values. Commit:

```bash
git add docs/releases/2026-09-money-basis-switch.md
git commit -m "docs(release): record the money conversion rehearsal on the restored copy"
```

---

### Task 9: Rehearsal part 3 — the plugin migration on the converted copy

**Files:**
- Run: `medusa db:migrate` (or the image's equivalent) against `medusa_money_rehearsal`, migrate-only
- Modify: `docs/releases/2026-09-money-basis-switch.md`

**Interfaces:**
- Consumes: Task 8's converted scratch DB, Task 6's image.
- Produces: proof that the two plugin migrations (`Migration20260922120000`, `Migration20260924120000`) still apply cleanly on a converted database, and the two invariants hold.

- [ ] **Step 1: Migrate, migrate-only**

Run the image's `medusa db:migrate` against the scratch DB with the app never started (the fence: restored payment references + live credentials must never reach a running scheduler). Capture the output; expected delta is exactly the two plugin migrations.

- [ ] **Step 2: The two invariants**

```sql
select indexname from pg_indexes where indexname = 'renewal_cycle_one_scheduled_per_subscription';
select subscription_id, count(*) from renewal_cycle where status='scheduled' and deleted_at is null group by subscription_id having count(*) > 1;
```

Expected: one row; zero rows.

- [ ] **Step 3: Record and commit**

Append to the runbook; commit:

```bash
git add docs/releases/2026-09-money-basis-switch.md
git commit -m "docs(release): record the plugin migration on the converted rehearsal copy"
```

- [ ] **Step 4: STOP — present the evidence and ask for the window**

This is the plan's designated authorization point. Present to the user: the dry-run output, the three negative-test errors, the spot checks, the migration delta, the two invariants, and the image tag. **Do not proceed to Task 10 without the user's explicit word.**

---

### Task 10: The production window (stop-the-world)

**Files:**
- Run: the same script against `medusa_store`
- Modify: `docs/releases/2026-09-money-basis-switch.md`

**Interfaces:**
- Consumes: everything above; the user's explicit authorization from Task 9 Step 4.
- Produces: production running major-unit data on the new image, with all assertions repeated.

- [ ] **Step 1: Preconditions, asserted not assumed**

```bash
ssh ubuntu@170.106.132.210 "docker ps --format '{{.Names}}' | grep -c medusa-prod-store"   # expect 1
ssh ubuntu@170.106.132.210 "sudo -n docker exec medusa-prod-db-1 psql -U medusa -d medusa_store -Atc \"select count(*) from renewal_cycle where status='scheduled' and scheduled_for <= now()\""   # expect 0
ssh ubuntu@170.106.132.210 "sudo -n docker exec medusa-prod-db-1 psql -U medusa -d medusa_store -Atc \"select count(*) from \\\"order\\\" where created_at > '2026-09-26T04:18:56Z'\""   # expect 0 (the mixed-basis guard's own precondition, checked before the window opens)
```

If any number is not as expected, **stop and report** — do not open the window.

- [ ] **Step 2: Stop the store, then dump**

```bash
ssh ubuntu@170.106.132.210 "sudo -n docker stop medusa-prod-store-1"
ssh ubuntu@170.106.132.210 "sudo -n docker exec medusa-prod-db-1 pg_dump -U medusa -d medusa_store -Fc > /tmp/prod-pre-money-switch.dump && chmod 600 /tmp/prod-pre-money-switch.dump && ls -l /tmp/prod-pre-money-switch.dump"
```

Record size and `sha256sum`. This dump is the recovery of last resort.

- [ ] **Step 3: Convert, then assert**

```bash
ssh ubuntu@170.106.132.210 "sudo -n docker exec -i medusa-prod-db-1 psql -U medusa -d medusa_store -v ON_ERROR_STOP=1 -v DO_COMMIT=1 < /path/to/money-minor-to-major.sql"
```

Then repeat Task 8 Step 4's five spot checks against `medusa_store`. Any deviation from the rehearsal's numbers is a stop-and-restore, not a judgement call.

- [ ] **Step 4: Deploy the image, migrate, assert**

Deploy Task 6's image (compose tag swap), run `medusa db:migrate`, then re-assert the two invariants (Task 9 Step 2).

- [ ] **Step 5: Failure branch — written down before it is needed**

If any step fails: restore `/tmp/prod-pre-money-switch.dump` into `medusa_store`, leave the store **stopped** (restored data is minor under an image whose code expects major), and restart the window from Step 2 with a rebuilt image. Never attempt `medusa migrate down` — the 1.6.1 rehearsal proved a failed `--all-or-nothing` migrate is unrecoverable by re-run.

- [ ] **Step 6: Start the store and smoke the enumerated contracts**

```bash
ssh ubuntu@170.106.132.210 "sudo -n docker start medusa-prod-store-1"
```

Then, in order: (a) admin loads and a known product shows its price at the correct magnitude; (b) a saas-bridge response's `total` for a seeded order reads major; (c) the transactional email for that order renders the converted amount; (d) the duplicate-cycle query returns nothing; (e) watch the scheduler's first run — with no due cycles it must write nothing (check `renewal_cycle` for new `PROCESSING` rows after 5 minutes).

- [ ] **Step 7: Record and commit**

Append the whole window to the runbook; commit:

```bash
git add docs/releases/2026-09-money-basis-switch.md
git commit -m "docs(release): record the production money basis switch window"
```

---

### Task 11: Post-switch — analytics rebuild and close-out

**Files:**
- Modify: `docs/releases/2026-09-money-basis-switch.md`, `.agents/specs/2026-09-26-money-basis-minor-to-major.md` (status line)

**Interfaces:**
- Consumes: Task 10's production state.
- Produces: analytics repopulated from major-unit orders; the spec marked implemented; the residual list written down.

- [ ] **Step 1: Rebuild analytics**

Trigger the plugin's `subscription_metrics_daily` rebuild (the table was deleted by the conversion) and verify it repopulates with major-unit values:

```sql
select count(*), min(mrr_amount), max(mrr_amount) from subscription_metrics_daily;
```

- [ ] **Step 2: Close out the documents**

Update the spec's status line to implemented, and append to the runbook: what was not verified (the scheduler charge path against a real renewal — none was due), the currency-less jsonb limitation, and the follow-ups (variant-metadata currency column; the `medusa-paypal` release if the user wants one).

- [ ] **Step 3: Commit**

```bash
git add docs/releases/2026-09-money-basis-switch.md .agents/specs/2026-09-26-money-basis-minor-to-major.md
git commit -m "docs(release): close out the money basis switch"
```

---

## Self-Review

**Spec coverage:** every spec section maps to a task — currency resolution (Task 1 verifies it, Task 2 implements it), mixed-basis guard (Task 2 Step 3, asserted in Task 10 Step 1), column handling incl. the `locked_amount` ALTER (Task 2 Steps 1-2) and `raw_*`/jsonb (Task 2 Step 4), derived-table rebuilds (Task 11 Step 1), atomic set: host code (already deployed), provider (Task 3), seeds (Task 4), plugin fixtures (Task 5), image assembly (Task 6); phases: Phase 0 = Tasks 1-4, Phase 1 = Tasks 5-6, Phase 2 = Tasks 7-9, Phase 3 = Task 10, Phase 4 = Task 11. The spec's "no independent re-review of revision 2" gap is closed by Task 1's verification-by-construction.

**Placeholder scan:** no TBD/TODO; every code step carries its actual SQL/TS/command. Two places deliberately say "every table in Appendix A" rather than inlining 29 statements — Appendix A is Task 1's deliverable and the pattern is given in full.

**Type consistency:** `moneyAmountSchema`, `paypalSubscriptionMetadataSchema`, `medusa_money_rehearsal`, `money_unit_migration`, `DO_COMMIT`, `/tmp/prod-pre-money-switch.dump`, image tag from Task 6 — each name is introduced once and reused verbatim.

## Execution Handoff

Plan saved to `.agents/specs/2026-09-26-money-basis-plan.md`. Two execution options:

**1. Subagent-Driven (recommended)** — a fresh subagent per task, review between tasks, fast iteration.
**2. Inline Execution** — execute in this session with checkpoints.

Which approach?
