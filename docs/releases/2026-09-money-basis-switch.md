# Money Basis Switch Runbook (minor → major)

Tracked runbook for the production money basis switch, per
`.agents/specs/2026-09-26-money-basis-plan.md` (Tasks 7–11). Companion evidence:
`.agents/specs/2026-09-26-money-basis-appendix-a.md` (verified join paths).

**Deadline:** the earliest due renewal cycle is 2026-10-18; the scheduler runs
every 5 minutes. The window must complete before that date.

**Image produced for the switch:** `medusa-saas-backend:0.4.22`
(built off-box on the developer machine from the medusa-saas workspace, with
vendored `@mengyyy369/reorder` 1.6.1 + `@mengyyy369/medusa-paypal` 0.5.0; proof
in Task 6 evidence below). Not deployed yet — Task 10 owns deployment.

---

## Task 6 evidence — image build

Command (from the medusa-saas repo root, following `docs/deploy.md` 方式 A):

```bash
docker build -f apps/backend/Dockerfile.prod \
  --secret id=npmrc,src=$HOME/.npmrc \
  -t medusa-saas-backend:0.4.22 .
```

Proof inside the image:

```text
$ docker run --rm --entrypoint sh medusa-saas-backend:0.4.22 -c \
    "grep version vendor/@mengyyy369/reorder/package.json |
     grep version vendor/@mengyyy369/medusa-paypal/package.json; ..."
  "version": "1.6.1",
  "version": "0.5.0",
  --- /100 in transactional-emails.ts: 0 occurrences
  --- admin bundle: public/admin/{index.html,assets} present
```

Build fixes made to get here (all uncommitted, edits-only repo):

1. The vendored `@mengyyy369/reorder` 1.6.1 tree was a **source tree** missing
   the compiled `.medusa/server` output that its own `package.json` exports map
   points at (`./admin` → `.medusa/server/src/admin/index.mjs`), so the admin
   vite build failed resolving `@mengyyy369/reorder/admin`. Fixed by copying a
   fresh `medusa plugin:build` output (`.medusa/`) from the reorder repo into
   `apps/backend/vendor/@mengyyy369/reorder/.medusa/` — exactly the "published
   tarball contents or a fresh medusa plugin:build output" shape the plan names.
2. An earlier agent had added
   `VITE_BUILD_EXTERNAL="@mengyyy369/reorder,@mengyyy369/medusa-paypal"` to the
   build RUN line; it breaks the admin build (rollup cannot resolve
   `react/jsx-dev-runtime` for the externalized vendor packages). Reverted to
   the plain `pnpm build` that produced 0.4.20.
3. `pnpm install --frozen-lockfile` fails because the vendored trees' manifests
   moved past the lockfile; kept the working-tree `--no-frozen-lockfile`.
4. A stale local `medusa-saas-backend:0.4.21` tag (built ~13 h before this
   session, BEFORE the vendor swap) contains **reorder 1.5.0 + paypal 0.4.0**.
   It is misleading and must not be deployed; 0.4.22 supersedes it.

---

## Task 7 — rehearsal part 1: scratch restore, completeness, currency seeding

**Scratch DB:** `medusa_money_rehearsal` on the prod host's
`medusa-prod-db-1` container. A scratch of this name already existed from an
earlier agent attempt with unverifiable provenance; it was **dropped and
recreated**, then restored from the retained 1.6.1-rehearsal dump (never from
the old DB):

```bash
ssh ubuntu@170.106.132.210 "sudo -n docker exec medusa-prod-db-1 dropdb -U medusa --if-exists medusa_money_rehearsal"
ssh ubuntu@170.106.132.210 "sudo -n docker exec medusa-prod-db-1 createdb -U medusa medusa_money_rehearsal"
# source dump: /home/ubuntu/reorder-161-rehearsal-20260926/prod-20260926T1814Z-medusa_store.dump
#   (655894 bytes, mode 600, taken 2026-09-26T18:14Z — after the major-unit code
#    went live but before any major-unit data existed: prod has 0 orders, prices,
#    payments, payment_collections created after the 2026-09-26T04:18:56Z cutoff)
ssh ubuntu@170.106.132.210 "sudo -n docker cp /home/ubuntu/reorder-161-rehearsal-20260926/prod-20260926T1814Z-medusa_store.dump medusa-prod-db-1:/tmp/prod-pre-money-basis.dump"
ssh ubuntu@170.106.132.210 "sudo -n docker exec medusa-prod-db-1 chmod 600 /tmp/prod-pre-money-basis.dump"
ssh ubuntu@170.106.132.210 "sudo -n docker exec medusa-prod-db-1 pg_restore -U medusa -d medusa_money_rehearsal -j 2 --no-owner /tmp/prod-pre-money-basis.dump"
```

**Completeness assertion (before anything else):**

```text
select (select count(*) from subscription),
       (select count(*) from renewal_cycle),
       (select count(*) from renewal_cycle where status='scheduled' and deleted_at is null),
       (select count(*) from mikro_orm_migrations);
→ 16|18|13|208
```

Exactly the plan's expected values — the restore is complete.

**Currency coverage seeding** (plan Task 7 Step 3, with two documented
adaptations): production holds only usd/cny (both dd=2), so dd=0/dd=3 probes
are inserted directly in the scratch DB. Adaptations:

- `price.price_set_id` is NOT NULL, so each probe price gets its own
  `price_set` row (the plan's literal INSERT would fail the constraint).
- The probe prices are inserted **soft-deleted** (`deleted_at` backdated) so the
  store-default guard's live set (`price WHERE deleted_at IS NULL`) still
  reflects production's usd/cny; the per-currency conversion branches still
  process them. All probe rows carry `created_at = '2026-09-25 12:00:00+00'`,
  before the mixed-basis cutoff, so Guard 1 passes.

Seeded (full statements in `/tmp/seed-probes.sql` on the host):

- `price_set`: `pset_jpy_probe`, `pset_kwd_probe`.
- `price`: `price_jpy_probe` = 15000 jpy, `price_kwd_probe` = 9999 kwd, both
  soft-deleted.
- `order`: `order_jpy_probe`, `order_kwd_probe` (status pending, version 1).
- `order_line_item`: `li_jpy_probe` = 15000, `li_kwd_probe` = 9999 (raw mirrors
  `{"value":"…","precision":20}`).
- `order_item`: `oi_jpy_probe`, `oi_kwd_probe` bridging line items to orders,
  unit_price 15000 / 9999 (parent-join branch).
- `order_summary`: `osum_jpy_probe` on the jpy order with all 8 money keys +
  raw mirrors set to 150000-scale values (order_summary branch, factor 1).
- `product_variant`: `variant_money_probe` with
  `metadata.paypal_subscription = {"setup_fee": 999, "trial_periods": [{"unit":"DAY","count":7,"price":199}]}}`
  (currency-less jsonb branch).

**Conversion:** NOT YET RUN on this copy (see Task 8 below).

---

## Task 8 — rehearsal part 2: conversion on the scratch copy

Conversion script: `D:\Projects\medusa-saas\scripts\money-minor-to-major.sql`
(rewritten this session; copied to the container as
`/tmp/money-minor-to-major.sql`). This is the plan's Task 2 deliverable and it
replaces the earlier broken rewrite: the previous tree carried an unterminated
`EXECUTE format(...)` string (the script could not parse), top-level
`RAISE NOTICE` statements (not valid SQL outside PL/pgSQL), a global `÷100`
sum assertion, and blanket `÷100` conversions for the six direct-currency
tables — the rewrite divides every table with a resolvable currency path by
`10::numeric ^ decimal_digits` and asserts per-currency identities.

**Step 1 — dry run (default rollback): PASSED.**

```text
$ psql -U medusa -d medusa_money_rehearsal -v ON_ERROR_STOP=1 -f /tmp/money-minor-to-major.sql
  mixed-basis guard passed: no money rows created after 2026-09-26 04:18:56+00
  unresolved-join guard passed: every money row resolves to a currency
  currency baseline: all active currencies have decimal_digits in [0, 3]
  store-default guard passed: every live price currency has dd=2
  paypal_subscription.locked_amount altered to numeric(20,6)
  normalized string-form variant metadata without money keys to objects
  ... 42 × "sum identity ok: <table> [<currency>] pre -> post (factor N)" ...
  magnitude ok / precision ok / locked_amount ok / ALL ASSERTIONS PASSED
  ROLLBACK
  === Dry run complete: all validations passed, nothing changed ===
```

Sample identities (full list in the run output): `price [usd] 34457 -> 344.57
(factor 100)`, `price [jpy] 15000 -> 15000 (factor 1)`, `price [kwd] 9999 ->
9.999 (factor 1000)`, `order_line_item [jpy] 15000 -> 15000`,
`order_summary [jpy] 750000 -> 750000`, `variant_setup_fee [(default)] 1199 ->
11.99`, `osd_shipping [(default)] 2500 -> 25`. Post-run scale check confirmed
nothing changed (usd max 9990 → still minor).

**Step 2 — negative tests: all three guards fire, each violation rolled back.**

(a) mixed-basis guard — `price_jpy_probe` made live with `created_at = now()`:

```text
ERROR:  mixed basis: 1 money row(s) in price created after the major-unit code
        went live (2026-09-26 04:18:56+00); converting them would destroy their value
```

(b) store-default guard — `price_jpy_probe` made live (created_at backdated),
then with `currency.decimal_digits = 3` for jpy per the plan; the guard fires
identically in both shapes:

```text
ERROR:  currency-less jsonb money cannot be converted per-currency;
        live currencies with dd<>2: jpy
```

(c) per-currency "still looks like cents" assertion — a USD price row set to
1500000 minor (post-conversion 15000 major):

```text
ERROR:  1 price row(s) in dd=2 currencies still look like cents (>= 10000)
```

Deviation note: the plan's literal (c) value (`15000` minor → 150 major, still
below the 10000 threshold) cannot trip a post-conversion assertion; the
×100-scaled value exercises the same code path honestly. Documented as a plan
finding.

**Step 3 — commit run: PASSED.** `psql … -v DO_COMMIT=1` → exit 0, all 42
identities, `ALL ASSERTIONS PASSED`, `COMMIT`, "Migration committed
successfully".

**Step 4 — independent verification (run by hand, not by the script):**

```text
price: cny n=7 5..699   usd n=8 5..99.9   jpy n=1 15000   kwd n=1 9.999
dd>0 fractional rows (expect >0): 10
dd=0 fractional rows (expect 0):   0
paypal_subscription locked_amount = 9 (expect 0): 0
locked_amount values after: 9.99 ×6  (was 999 minor ×6 — no truncation)
money_unit_migration rows (expect 1): 1
jpy probe line item (expect 15000):   15000   (dd=0: divided by 10^0)
kwd probe line item (expect 9.999):   9.999   (dd=3: divided by 10^3)
order_summary jpy probe paid_total (expect 150000): 150000 (factor 1 via order)
variant probe setup_fee (expect 9.99): 9.99   trial price (expect 1.99): 1.99
string-form metadata remaining (expect 0): 0
```

**Idempotency re-run: refused, as designed.**

```text
ERROR:  money basis migration already completed at 2026-09-27 06:27:45.108505+00;
        refusing to run twice
```

---

## Task 9 — rehearsal part 3: plugin migration on the converted copy

**Step 1 — migrate, migrate-only: PASSED (exit 0).**

The converted scratch copy was migrated with the 0.4.22 image, app never
started (no scheduler, no credentials beyond DATABASE_URL):

```bash
DB_PASSWORD=$(grep -E '^DB_PASSWORD=' /opt/medusa-prod/.env | head -1 | cut -d= -f2- | tr -d '"')
MEDUSA_DOMAIN_VAL=$(grep -E '^MEDUSA_DOMAIN=' /opt/medusa-prod/.env | head -1 | cut -d= -f2- | tr -d '"')
sudo -n docker run --rm --user root --network medusa-prod_default \
  --env-file /opt/medusa-prod/.env \
  -e DATABASE_URL="postgres://medusa:$DB_PASSWORD@db:5432/medusa_money_rehearsal?ssl_mode=disable" \
  -e EPAY_NOTIFY_URL="https://$MEDUSA_DOMAIN_VAL/epay/notify" \
  -e EPAY_DEFAULT_RETURN_URL="https://dayzcloud.com/payment/return" \
  -e EPAY_DEFAULT_CLIENTIP="127.0.0.1" -e EPAY_ALLOW_HTTP="false" \
  medusa-saas-backend:0.4.22 npx medusa db:migrate --all-or-nothing --execute-safe-links
```

Command notes (each earned by a rehearsal failure):
- `--user root`: the compose store service already runs as `root`
  (`compose.yaml`), so production's migrate has this implicitly; a plain
  `docker run` from the image runs as `node` and Medusa's migration loader
  fails with EACCES mkdir-ing module migrations dirs under the read-only
  node_modules. Production must keep using the compose path (`docker compose
  run --rm --no-deps store npx medusa db:migrate --all-or-nothing
  --execute-safe-links`), which inherits `user: root`.
- `EPAY_*`/`*_RETURN_URL`/`EPAY_ALLOW_HTTP`: these exist only in compose's
  `environment:` block (interpolated from `MEDUSA_DOMAIN`), not in `.env`; a
  plain `--env-file` run cannot load the Payment module without them. The
  compose path gets them automatically.
- `Migration20260919000001` (paypal) is already registered in the restored
  database under its pre-0.5.0 content — MikroORM tracks by name and will not
  re-run it, which is why the conversion script's own conditional
  `locked_amount` ALTER (numeric(20,6)) is load-bearing. Verified: prod's
  `locked_amount` is still integer today, and the rehearsal's ALTER ran first.

Result: `Migrations completed`; exactly the plan's expected delta applied —

```text
MODULE: activityLog  → ● Migrating Migration20260922120000 → ✔ Migrated
MODULE: renewal      → ● Migrating Migration20260924120000 → ✔ Migrated
mikro_orm_migrations: 208 → 210 (exactly two rows added)
```

**Step 2 — the two invariants: both hold.**

```text
select count(*) from pg_indexes where indexname='renewal_cycle_one_scheduled_per_subscription';
→ 1   (index exists; pg_index.indisvalid = true)

select subscription_id from renewal_cycle where status='scheduled' and deleted_at is null
group by subscription_id having count(*) > 1;
→ 0 rows   (and scheduled cycles still 13 — untouched)
```

**Rehearsal finding — what a failed migrate does to a database (why the fence
matters).** Two earlier rehearsal attempts failed mid-run (a plain-`docker
run` EACCES as user `node`, then a module-loader failure for the Payment
module) and each time `--all-or-nothing`'s failure path ran `down()` for
migrations in its transaction scope and **deleted their rows from
`mikro_orm_migrations`** (208 → 179), damaging the scratch schema. The
database was rebuilt from the dump each time (the restore → seed → convert
pipeline is fully scripted and reproducible, ~3 minutes). No production data
was touched at any point. Consequence for the window: if the production
migrate fails mid-run, do not retry blindly — restore
`/tmp/prod-pre-money-switch.dump` per Task 10 Step 5 and restart the window.

**Image transfer:** 0.4.22 has been loaded on the prod host
(`docker images` → `0.4.22 5bfb28596d73`). The stale `0.4.21` tag exists both
locally and on the host and carries vendor reorder **1.5.0** + paypal **0.4.0**;
production currently RUNS 0.4.21 (started 2026-09-26T17:31Z). The window's
deploy step swaps compose from 0.4.21 → 0.4.22.

---

## Task 10 — production window

NOT PERFORMED. Requires the user's explicit authorization after Task 9's
evidence is presented (plan Task 9 Step 4 is the designated stop point).
