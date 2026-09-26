# Spec: money basis switch (minor → major), aligned to Medusa's currency system

Status: **DESIGN, revision 3 — reviewed adversarially; implementation not started.**
Supersedes revisions 1-2 of the same date. Evidence sources are named inline; every rule this
document applies is either quoted from Medusa's own code/docs or measured read-only on production.
Revision 2 folded in an adversarial design review whose two Critical findings (currency resolution,
image ownership) are now first-class design sections. Revision 3 adds one section of measured fact —
the actual state of the three working trees on 2026-09-26 evening — because a plan that assumes a
clean start would be wrong: the provider half already carries uncommitted edits.

## TLDR & Overview

Medusa v2 stores money in **major units as `numeric`** — prices, line items, adjustments,
transactions, and payment amounts alike; order totals are not columns at all but `MathBN` sums
persisted as JSON; minor units exist only at the payment-provider boundary. Production stores
**minor** units today (`price.amount` = `9990|usd`, `69900|cny`; `paypal_subscription.locked_amount`
is `integer` holding `999`), while the **code half of the switch is already deployed** (image
`0.4.20`, built 2026-09-26 04:18 UTC, display/email no longer divide by 100; vendored
`@mengyyy369/medusa-paypal` at `3822be9` sends major with `decimal_digits`). The store is therefore
in the exact state commit `52f3e41`'s own message forbids: *"数据迁移与代码必须同窗口发布，单独上任何一边都会让金额差一百倍"*.

The fix, per the user's ruling, is **not** to choose a basis but to adopt Medusa's: convert the
stored data to major, per currency, and ship the remaining code set in the same window. There are
no customers, the current data is disposable, downtime is acceptable, and the only recovery
mechanism is the pre-upgrade dump taken inside the window (the user's "no rollback" ruling means no
inverse-migration machinery is built; the dump is cheap insurance against a failed window, and the
Risks section states exactly what restore does and does not undo).

## Decisions (user, 2026-09-26)

| # | Decision |
|---|---|
| Q1 | Align to Medusa's own currency system; do not invent a basis. |
| Q2 | Convert existing rows. Current data is worthless — no customers. |
| Q3 | Use the latest `medusa-paypal` (user's own plugin); problems in it are raised, not worked around. |
| Q4 | Support all currency types, including zero-decimal (JPY/KRW) and three-decimal (BHD/KWD). |
| Q5 | Rounding/precision follows Medusa's currency rules, not a local preference. |
| Q6 | Maintenance window is acceptable. |
| Q7 | No rollback machinery; the in-window dump is the recovery of last resort. |
| Q8 | Release unit and version numbers are unimportant — so version identity is fixed by **committing** the vendored package's version and re-vendoring it; publishing to a registry is optional and not a gate. |

## Working-tree state at revision 3 (measured 2026-09-26)

Measured directly with `git status`/`git diff` and file mtimes; the plan's starting point, not an
assumption:

| Repo | State |
|---|---|
| `D:\Projects\reorder` (this plugin) | clean on `main` at `e1b7eb8`; `v1.6.1` published and tagged. No money-switch work here beyond fixture churn (pending). |
| `D:\Projects\medusa-saas` (host) | DIRTY by its owner: `scripts/money-minor-to-major.sql` modified (the owner's own uncommitted revision — still the OLD global-÷100 semantics at `:85`/`:381`/`:388`/`:392`, i.e. **the per-currency rewrite has NOT been done**), plus the owner's doc changes. No commits by this workstream. |
| `D:\Projects\medusa-paypal` (provider) | DIRTY by its owner AND by a stopped Phase 0 agent. The agent's uncommitted, **unreviewed** edits: (1) `src/subscription/metadata.ts` gained `moneyAmountSchema = z.number().finite().min(0).multipleOf(0.001)` applied to `price` and `setup_fee`, counts left `.int()`; (2) the stale "minor units" comment on `models/paypal-subscription.ts` corrected to major/`numeric(20,6)`; (3) `Migration20260919000001.ts` `locked_amount` changed `INTEGER` → `NUMERIC(20,6)`; (4) `docs/tutorial.zh-CN.md` money examples moved to major (`9.99` not `999`). The owner's own uncommitted `0.5.0` bump + CHANGELOG remain alongside. |

Two consequences the plan must honour: the provider task is **verify-and-complete**, not
write-from-scratch, and no sibling-repo commit happens without the user's word — those trees hold
the owner's in-progress work.

## The Medusa rule this plan follows (evidence)

- Docs: "Prices in Medusa are stored as major currency units… different from some other systems
  that store prices in minor currency units (for example, cents)" (data-models/big-numbers); v1→v2
  page: `$10.00` stored `1000` in v1, `10` in v2; storefront docs format directly with
  `Intl.NumberFormat`, no division.
- Installed 2.20.0 source (`package.json` pins `@medusajs/framework 2.20.0`):
  `price.amount` is `numeric not null` (`@medusajs/pricing/dist/models/price.js:14`);
  `money_amount` was **dropped** in v2 (`@medusajs/pricing/dist/migrations/Migration20240322094407.js:7`)
  — a `price` table is the conforming shape, so production's schema is right and its **values** are
  the defect; order money lives in `order_line_item.unit_price` etc. (`NUMERIC`,
  `@medusajs/order/dist/migrations/Migration20240219102530.js:339-342`); totals are computed
  (`@medusajs/utils/dist/totals/cart/index.js:11-140`) and persisted only as `order_summary.totals`
  JSON; core hands providers `cart.raw_total` in **major**
  (`@medusajs/core-flows/dist/cart/workflows/create-payment-collection-for-cart.js:86`) and the
  official Stripe plugin converts to minor itself via `getSmallestUnit` (10^digits). No
  `convertToCents`/`amountToMinor` exists anywhere in core.
- Per-currency precision: `currency.decimal_digits` (`integer not null default 0`) is the only
  populated source — measured on prod: usd/cny = 2, jpy/krw = 0, bhd/kwd = 3, and `rounding numeric`
  is **0 for all 126 rows**, so it cannot be relied on. Authoritative list:
  `@medusajs/utils/dist/defaults/currencies.js`.
- Version caveat: the admin `getStylizedAmount`/`getDecimalDigits` utilities are documented as
  "available since v2.21.0"; this stack pins 2.20.0, so formatting stays hand-rolled against
  `decimal_digits`.
- The plugin's own standing ruling (`docs/releases/1.6.0-host-upgrade.md:19-24`): reorder contains
  no ÷100/×100 compensation **and must not gain one** (verified: the only `/100`/`*100` in `src/`
  are percentage/retry computations in `analytics/utils/*` and `redemption/utils/code-generator.ts`).

## Design

**Conversion rule.** For every money value: `new = old / 10^decimal_digits(currency)`. Division by
a power of ten is **exact** in Postgres `numeric` for the integer minor values this database holds,
so no rounding is applied on the conversion path at all; only a value that exceeds the currency's
`decimal_digits` after conversion (impossible for exact power-of-ten division of integers) would
need rounding, and that path uses `round(numeric, d)` — which is half-away-from-zero; this plan does
not claim half-up anywhere. **Not a blanket ÷100** — that is only correct for 2-decimal currencies
and would 100×-corrupt JPY and 10×-corrupt BHD rows. Percentage discounts are never divided; only
`type:"fixed"` money is.

**Currency resolution (per table — the load-bearing mechanism).** Only six covered tables carry
`currency_code` on the row. The script resolves every other table through an explicit join chain:

| Money table | Currency source |
|---|---|
| `price` | `price.currency_code` (own column) |
| `payment`, `payment_session`, `payment_collection`, `capture`, `refund` | own `currency_code` |
| `order_line_item`, `order_line_item_adjustment`, `order_shipping_method(+_adjustment)`, `order_transaction`, `order_change_action`, `order_claim`, `order_exchange`, `order_credit_line`, `credit_line`, `cart_line_item`, `cart_shipping_method(+_adjustment)` | join to parent: line items/transactions/claims/exchanges/credit lines → `order.currency_code` (cart-side → `cart.currency_code`) |
| `paypal_subscription.locked_amount` | `paypal_subscription.currency_code` |
| `subscription.pricing_snapshot`, `plan_offer.discount_per_frequency` (fixed), `retention_offer_event.offer_payload` (fixed), variant `metadata.paypal_subscription.setup_fee`/`trial_periods[].price` | **no currency column exists anywhere for these** — resolved as the store's default currency, asserted against the set of currencies actually present in `price`/`order` (prod today: usd, cny — both dd=2) |

An unresolved (NULL) join ABORTS the run. The jsonb-money assumption above is written as an
assumption and guarded: if the store's live currencies ever include a dd≠2 currency, the guard
ABORTS rather than guessing — those values need a currency column before they can be converted
per-currency, and that is recorded as a limitation, not hidden.

**Mixed-basis guard (new).** The code half has been live since 2026-09-26 04:18 UTC; any money row
written after that timestamp is already major and would be silently corrupted by the conversion
**while the 1/100 identity assertion still passes** (the math is self-consistent). The conversion
therefore ABORTS if any covered money table contains a row with `created_at` later than the code
deploy timestamp. Measured today: zero post-deploy money rows; the guard makes that a precondition
instead of a hope.

**Column handling.** In one transaction, per table:
1. `ALTER TABLE paypal_subscription ALTER COLUMN locked_amount TYPE numeric(20,6)` FIRST — it is
   `integer` today and a divide on an integer column truncates (`999/100 → 9`). Phase 0 also aligns
   the `medusa-paypal` model and its migration with this type, so a fresh environment does not
   recreate the INTEGER column.
2. Convert the ~29 core numeric money columns via the join table above.
3. Regenerate every `raw_*` JSONB mirror **from the NEW column value** (Medusa's `bigNumber` writes
   both). `raw_*` precision metadata is updated to the currency's `decimal_digits`.
4. Convert JSONB money: variant `metadata.paypal_subscription.setup_fee` / `trial_periods[].price`,
   `plan_offer.discount_per_frequency` (fixed only), `subscription.pricing_snapshot` (fixed values +
   label string rebuild), `retention_offer_event.offer_payload`, `paypal_subscription.sales[]/refunds[]`,
   `order_summary.totals` (8 keys) — the last is converted directly, not recomputed, because
   `transform-order.js:76-78` returns the stored JSONB as authoritative on read (verified by the
   adversarial review with citation).
5. Delete for rebuild (derived, not converted): `subscription_metrics_daily` (the plugin's rebuild
   job repopulates it wholesale from order totals), `paypal_plan`.
6. Idempotency guard table `money_unit_migration`; dry-run by default, commit only with
   `-v DO_COMMIT=1`.

**Assertions, per currency (not global).** Post-conversion checks run grouped by `decimal_digits`:
per-currency sum identity (post = pre / 10^dd); fractional presence
(`amount <> trunc(amount)` only for dd>0 rows — it is FALSE by definition for dd=0 currencies and
must never be asserted globally); the "still looks like cents" threshold (old `>= 10000` check)
becomes per-currency (a legitimate ¥15,000 JPY price is not suspicious; a $15,000 USD price is);
`locked_amount` has no `= 9` truncation rows; percentage discounts untouched; `raw_*` regenerated;
guard table written; second run refused. **Every assertion fails loudly on an empty result set** —
the inherited script's `post_sum > 0` skip, which turns a partial restore into vacuous green, is
removed: an empty table in a restored copy means the restore failed, and the dry-run says so.

**The atomic set** (nothing ships without the rest):
- Host `52f3e41` display/email change — already merged and deployed; correct under this plan.
- `medusa-paypal` at `3822be9` (major + `decimal_digits`), which needs, before the window:
  **commit** the `0.5.0` version bump (a committed `0.4.0` behaving as 0.5.0 is the version-string
  trap; the host consumes vendored artifacts, so the committed version is the identifier — registry
  publishing is optional per Q8); relax `src/subscription/metadata.ts:15/:28` `z.number().int()`
  (9.99/1.99 currently fail validation); fix the stale "minor units" comment on
  `models/paypal-subscription.ts:23`; **align the `locked_amount` model/migration with the
  `numeric(20,6)` ALTER** (fresh environments must not recreate INTEGER); note the process-local
  digits cache (`currency-digits.ts:4`) is never invalidated and falls back to 2 digits with one
  warning — accepted as known behavior; update the untracked `docs/tutorial.zh-CN.md` money examples.
- Host seeds to major: `seed-saas.ts:36-37`, `seed.ts:27,36`, `upsert-prod-variants.ts:53-69`; the
  seed that writes `paypal_subscription` metadata as a JSON **string** must write an object, or the
  conversion's fail-closed assertion refuses (correctly).
- `reorder`: gains no ÷100/×100 compensation, ever; fixture churn only: ~10 integration files + 3
  e2e files carry minor literals; the `0.01`-epsilon tests are already major-scale and flip meaning
  on purpose. Scale-blind asserts (e.g. `analytics-workflows.spec.ts:127`, all of
  `src/modules/analytics/__tests__/admin-query.spec.ts`) gain a literal that fixes the scale.
- The host's `scripts/money-minor-to-major.sql` revision is committed; its `:85` abort-on-non-2-dd
  guard becomes the per-currency branch; its assertions become per-currency per the section above.
- Storefront cleanup: the dead `noDivisionCurrencies` constant (`constants.tsx:149`) is removed —
  leftover scaling knowledge is exactly the class of thing this switch must not leave behind.
- Promotion fixed-value tables are NOT converted (they carry percentages by design) — recorded here
  explicitly so the exclusion is a decision, not a script comment.

## Step-by-Step Implementation Plan

### Phase 0 — inventory, script, provider (no production writes)
- [ ] Re-derive the money-column inventory against the live DB (read-only `information_schema`
      sweep: `%amount%|%total%|%price%|%fee%|%mrr%|%cost%|%balance%`), reconcile with the script's
      list, and reconcile the join table above against the live schema — a missing join path is a
      finding, not a silent skip. (This replaces a read-only audit agent lost to an auth expiry;
      the plan does not depend on that agent's conclusions.)
- [ ] Commit the host SQL revision; rewrite `:85` into the per-currency branch with the join table;
      make assertions per-currency; remove the `post_sum > 0` skip; add the mixed-basis
      `created_at` guard.
- [ ] `medusa-paypal`: commit the version bump, relax the zod `.int()`, fix the comment, align the
      `locked_amount` model/migration, update the tutorial. (Registry release optional, per Q8.)

### Phase 1 — code set and image assembly (repos; production untouched)
- [ ] Host seeds to major + JSON-object metadata fix; remove `noDivisionCurrencies`.
- [ ] `reorder` fixtures to major; scale-blind asserts gain scale-fixing literals; both jest gates
      green; rebuild + `verify:package`.
- [ ] **Vendor swap and image build (the step revision 1 assumed away):** in `D:\Projects\medusa-saas`,
      replace `vendor/@mengyyy369/reorder` with the 1.6.1 sources and `vendor/@mengyyy369/medusa-paypal`
      with the committed 0.5.0 tree; build the image off-box per the runbook
      (`docs/releases/1.6.0-host-upgrade.md:532-539`); verify INSIDE the built image, read-only,
      that `vendor/@mengyyy369/reorder/package.json` says `1.6.1` and `medusa-paypal` says `0.5.0`,
      and that the compiled email formatter still has no ÷100. Tag it for the window.

### Phase 2 — rehearsal on a scratch restore (no production writes)
- [ ] Restore the pre-upgrade dump into a FRESH scratch DB (not `medusa_rehearsal_161`, which holds
      the 1.6.1-migrated schema). Before anything runs, assert restore completeness with the
      Task 25 counter set (16 subs / 18 cycles / 13 live scheduled / 208 migration rows) — a
      partial restore aborts the rehearsal.
- [ ] **Seed currency coverage into the scratch copy**: prod is usd/cny only (both dd=2), so the
      rehearsal itself inserts dd=0 (JPY) and dd=3 (KWD) rows into `price`, one order line item,
      and a variant-metadata `setup_fee`, so the per-currency branches execute here — in production
      they would otherwise run for the first time during the window.
- [ ] Run the conversion dry-run, then with `DO_COMMIT=1`; assert the full per-currency list:
      sums, no truncation, fractional presence only where dd>0, per-currency suspicion thresholds,
      percentage discounts untouched, `raw_*` regenerated, guard table written, second run refused.
- [ ] Rehearse the plugin 1.5.0 → 1.6.1 migrate on the converted scratch DB, asserting the two
      invariant queries from `docs/releases/1.6.0-host-upgrade.md`.
- [ ] **Migrate-only fence holds**: the app is never booted against the restored copy (restored
      payment references + live provider credentials can charge real money). End-to-end
      money-display verification happens on a freshly seeded test store, not on restored data.

### Phase 3 — production window (single stop-the-world batch; requires its own explicit
authorization at execution time, after Phase 2 output is shown to the user)

**Deadline context (measured):** 13 `SCHEDULED` cycles, earliest due **2026-10-18**; the scheduler
runs every 5 minutes. The window must complete before that date, and asserts `due = 0` **inside**
the window immediately before the conversion — "due was 0 when the plan was written" is not a check.
- [ ] Stop the store container → **assert due = 0 and no money row has `created_at` after the code
      deploy** → take a fresh dump (recovery of last resort) → run the conversion with `DO_COMMIT=1`
      → assert the full Phase 2 list against production → deploy the Phase 1 image → run
      `medusa db:migrate` → assert the two invariant queries → start the store.
- [ ] **Failure branch (explicit):** if any step fails — restore the dump. Restoring undoes BOTH
      the conversion and the migrations, and the restored data is minor under an image whose code
      expects major, so **the store stays stopped**; the window restarts from the conversion step
      with a rebuilt image, not from `medusa migrate down` (a failed `--all-or-nothing` migrate is
      unrecoverable by re-run — proven in the Task 25 rehearsal).
- [ ] **Post-start smoke, enumerated (not "verify it works"):** store admin loads and shows a
      known price at the correct magnitude; the renewal workflow's charge path reads a converted
      `order.total` at major scale (asserted via the saas-bridge response's `total` field against a
      seeded order); the transactional email renders a converted amount; a `select … having
      count(*) > 1` duplicate-cycle query returns nothing. The scheduler's first post-start run is
      watched live; with no due cycles it must write nothing.

### Phase 4 — post-switch
- [ ] Rebuild analytics (`subscription_metrics_daily` repopulates from major-unit orders).
- [ ] Record the switch in `docs/releases/` and the host repo's runbook; update this spec's status.

## Verification & Testing

- Phase 2's assertion list is the acceptance gate; production repeats exactly those assertions.
- Two invariants carried from the 1.6.1 rehearsal: the partial unique index exists and is live, and
  no subscription holds more than one live `SCHEDULED` cycle.
- Gates: `corepack yarn build` 0; modules and http suites green with fixtures in major; no test
  asserts a value that passes at either scale.

## Risks

- **Integer truncation** on `locked_amount` — mitigated by the ALTER first and Phase 0's
  model/migration alignment.
- **A mixed-basis window** between code deploy and data conversion — live in production *today*;
  the `created_at` guard converts it from an invisible hazard to a loud abort.
- **Percentage vs fixed discounts** — handled by type-branching and an assertion.
- **Failed migration recovery**: dump restore is the only recovery, and it reverts the conversion
  too; the store stays stopped on restored minor data. Proven shape, not hypothesis.
- **Version-string ambiguity** in vendored `medusa-paypal` — resolved by the committed 0.5.0 bump
  re-vendored into the host (registry publishing optional per Q8).
- **Currency-less jsonb money** (variant metadata, plan-offer fixed values) — converted under the
  store-default-currency assumption with a guard that aborts if live currencies include dd≠2;
  a real fix needs a currency column there, recorded as a limitation.

## Review record

- Revision 1 was reviewed by two parallel seats; the adversarial design review returned
  "implementable core, not implementable as written" with 2 Critical findings (currency resolution,
  image ownership) and 6 Important ones, all folded into revision 2. The fact-check seat was
  lost to an infrastructure failure (model-service access); its target claims were re-verified
  directly (Medusa 2.20.0 pin, the no-÷100 ruling at `docs/releases/1.6.0-host-upgrade.md:19-24`,
  minor-literal fixtures, major-scale `0.01` epsilon tests) or stand on the controller's own
  read-only measurements recorded in the session ledger.
- **Open gap, stated rather than hidden:** revision 2's own edits were never independently
  re-reviewed. Revision 3 only adds measured working-tree state, so the gap now covers both.
  The plan's first task closes it by construction: its Phase 0 verifies each revision-2 rule
  against the live schema and the live trees before anything is written.
