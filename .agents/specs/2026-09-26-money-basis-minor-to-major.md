# Spec: money basis switch (minor → major), aligned to Medusa's currency system

Status: **DESIGN — answers to Q1-Q8 recorded below; implementation not started.**
Supersedes the skeleton of the same date. Evidence sources are named inline; every rule this
document applies is either quoted from Medusa's own code/docs or measured read-only on production.

## TLDR & Overview

Medusa v2 stores money in **major units as `numeric`** — prices, line items, adjustments,
transactions, and payment amounts alike; order totals are not columns at all but `MathBN` sums
persisted as JSON; minor units exist only at the payment-provider boundary. Production stores
**minor** units today (`price.amount` = `9990|usd`, `69900|cny`; `paypal_subscription.locked_amount`
is `integer` holding `999`), while the **code half of the switch is already deployed** (image
`0.4.20`, built 2026-09-26 04:18, display/email no longer divide by 100; vendored
`@mengyyy369/medusa-paypal` at `3822be9` sends major with `decimal_digits`). The store is therefore
in the exact state commit `52f3e41`'s own message forbids: *"数据迁移与代码必须同窗口发布，单独上任何一边都会让金额差一百倍"*.

The fix, per the user's ruling, is **not** to choose a basis but to adopt Medusa's: convert the
stored data to major, per currency, and ship the remaining code set in the same window. There are
no customers, the current data is disposable, downtime is acceptable, and no rollback machinery is
required beyond the pre-upgrade dump.

## Decisions (user, 2026-09-26)

| # | Decision |
|---|---|
| Q1 | Align to Medusa's own currency system; do not invent a basis. (Reframed from my original question.) |
| Q2 | Convert existing rows. Current data is worthless — no customers. |
| Q3 | Use the latest `medusa-paypal` (user's own plugin); problems in it are to be raised, not worked around. |
| Q4 | Support all currency types, including zero-decimal (JPY/KRW) and three-decimal (BHD/KWD). |
| Q5 | Rounding/precision follows Medusa's currency rules, not a local preference. |
| Q6 | Maintenance window is acceptable. |
| Q7 | No rollback requirement; the dump is enough. |
| Q8 | Release unit and version number are unimportant. |

## The Medusa rule this plan follows (evidence)

- Docs: "Prices in Medusa are stored as major currency units… different from some other systems
  that store prices in minor currency units (for example, cents)" (data-models/big-numbers); v1→v2
  page: `$10.00` stored `1000` in v1, `10` in v2; storefront docs format directly with
  `Intl.NumberFormat`, no division.
- Installed 2.20.0 source: `price.amount` is `numeric not null` (`@medusajs/pricing/dist/models/price.js:14`);
  `money_amount` was **dropped** in v2 (`@medusajs/pricing/dist/migrations/Migration20240322094407.js:7`)
  — a `price` table is the conforming shape, so production's schema is right and its **values** are
  the defect; order money lives in `order_line_item.unit_price` etc. (`NUMERIC`, `Migration20240219102530.js:339-342`);
  totals are computed (`@medusajs/utils/dist/totals/cart/index.js:11-140`) and persisted only as
  `order_summary.totals` JSON; core hands providers `cart.raw_total` in **major**
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

## Design

**Conversion rule.** For every money value: `new = old / 10^decimal_digits(currency)`, rounded
half-up to `decimal_digits` at write. **Not a blanket ÷100** — that is only correct for 2-decimal
currencies and would 100×-corrupt JPY and 10×-corrupt BHD if such rows ever exist. Percentage
discounts are never divided; only `type:"fixed"` money is.

**Column handling.** In one transaction, per table:
1. `ALTER TABLE paypal_subscription ALTER COLUMN locked_amount TYPE numeric(20,6)` FIRST — it is
   `integer` today and a divide on an integer column truncates (`999/100 → 9`).
2. Convert the ~29 core numeric money columns identified in the host's own script
   (`price`, `payment`, `payment_session`, `payment_collection`, `capture`, `refund`,
   `order_transaction`, `credit_line`, `order_credit_line`, `order_change_action`, `order_exchange`,
   `order_claim`, cart/order line items `unit_price`/`compare_at_unit_price`, adjustments, shipping
   methods and their adjustments) joined to their currency where one exists on the row; rows without
   a resolvable currency must ABORT, not guess.
3. Regenerate every `raw_*` JSONB mirror of a converted column (Medusa's `bigNumber` writes both).
4. Convert JSONB money: variant `metadata.paypal_subscription.setup_fee` / `trial_periods[].price`,
   `plan_offer.discount_per_frequency` (fixed only), `subscription.pricing_snapshot` (fixed values +
   label string rebuild), `retention_offer_event.offer_payload`, `paypal_subscription.sales[]/refunds[]`,
   `order_summary.totals` (8 keys).
5. Delete for rebuild (derived, not converted): `subscription_metrics_daily` (MRR is recomputed
   wholesale by the plugin's rebuild job), `paypal_plan`.
6. Idempotency guard table `money_unit_migration` (as the host script already does); dry-run by
   default, commit only with `-v DO_COMMIT=1`.

**Rounding policy (Q5, made explicit).** Half-up to the currency's `decimal_digits`, applied once at
conversion and once at any write that follows. Medusa documents no rounding rule; this choice is
recorded here so it is a decision and not an accident of Postgres casting.

**The atomic code set** (nothing ships without the rest):
- Host `52f3e41` display/email change — already merged and deployed; correct under this plan.
- `medusa-paypal` at `3822be9` (major + `decimal_digits`), which needs, before it can ship:
  commit the `0.5.0` version bump (a committed `0.4.0` that behaves like 0.5.0 is exactly the
  version-string trap the rehearsal hit); relax `src/subscription/metadata.ts:15/:28`
  `z.number().int()` (9.99/1.99 currently fail validation); fix the stale "minor units" comment on
  `models/paypal-subscription.ts:23`; note the process-local digits cache (`currency-digits.ts:4`)
  is never invalidated and falls back to 2 digits with one warning — acceptable now, recorded as
  known behavior; update the untracked `docs/tutorial.zh-CN.md` money examples.
- Host seeds to major: `seed-saas.ts:36-37`, `seed.ts:27,36`, `upsert-prod-variants.ts:53-69`; and
  the seed that writes `paypal_subscription` metadata as a JSON **string** (`JSON.stringify`) must
  write an object, or the conversion's fail-closed assertion will (correctly) refuse.
- `reorder`: gains **no** ÷100/×100 compensation, ever (standing ruling,
  `docs/releases/1.6.0-host-upgrade.md:19-24`); its charge amounts derive from live `order.total`,
  so it inherits the basis. Fixture churn only: ~10 integration files + 3 e2e files carry minor
  literals; the `0.01`-epsilon tests are already major-scale and flip meaning on purpose.
- The host's `scripts/money-minor-to-major.sql` revision (+218 lines) is **uncommitted**; it must be
  committed, and its `:85` guard — which ABORTS when any non-2-decimal currency exists — must become
  the per-currency branch above, otherwise Q4 is refused rather than supported.

## Step-by-Step Implementation Plan

### Phase 0 — inventory and script (no production writes)
- [ ] Re-derive the money-column inventory against the live DB (read-only `information_schema`
      sweep: `%amount%|%total%|%price%|%fee%|%mrr%`), and reconcile it with the host script's list;
      anything in the DB but not in the script is a finding, not a silent skip. (This replaces a
      read-only audit agent whose artifacts were lost to an auth expiry; the plan does not depend on
      that agent's conclusions.)
- [ ] Commit the host SQL revision; rewrite `:85` from abort to per-currency conversion; add the
      per-currency sum assertion (post-sum = pre-sum / 10^digits, per currency, not global).
- [ ] In `medusa-paypal`: commit the version bump, relax the zod `.int()`, fix the comment, update
      the tutorial. Release `0.5.0` per its own release flow.

### Phase 1 — code set (repos, still no production writes)
- [ ] Host seeds to major + JSON-object metadata fix.
- [ ] `reorder` fixtures to major; verify the `0.01`-epsilon tests' new meaning is intended; both
      jest gates green; rebuild + `verify:package`.

### Phase 2 — rehearsal on a scratch restore (no production writes)
- [ ] Reuse the Task 25 pattern: restore the pre-upgrade dump into a scratch DB (a fresh one; do
      not reuse `medusa_rehearsal_161`, which holds the migrated-schema rehearsal).
- [ ] Run the conversion dry-run; then with `DO_COMMIT=1`; assert: per-currency sums, no truncation
      (`locked_amount` has no `= 9` rows, nothing `< 1` unexplained), fractional values actually
      present (`amount <> trunc(amount)`), percentage discounts untouched, `raw_*` regenerated,
      guard table written, second run refused.
- [ ] Rehearse the plugin 1.5.0 → 1.6.1 migrate on the converted scratch DB (the two migrations are
      orthogonal to money but share the window), asserting the two invariant queries from
      `docs/releases/1.6.0-host-upgrade.md`.
- [ ] **Migrate-only fence holds**: the app is never booted against the restored copy (restored
      payment references + live provider credentials can charge real money). End-to-end
      money-display verification happens on a freshly seeded test store, not on restored data.

### Phase 3 — production window (single stop-the-world batch; requires its own explicit
authorization at execution time, after Phase 2 output is shown to the user)
- [ ] Stop the store container → take a fresh dump (the rollback artifact) → run the conversion with
      `DO_COMMIT=1` → deploy the image containing the code set + vendored plugin 1.6.1 → run
      `medusa db:migrate` for the plugin's two migrations → assert both invariant queries and the
      money assertions from Phase 2 → start the store → smoke the changed contracts.
- [ ] Ordering inside the window is total; no step may run while the store serves traffic.

### Phase 4 — post-switch
- [ ] Rebuild analytics (`subscription_metrics_daily` repopulates from major-unit orders).
- [ ] Record the switch in `docs/releases/` and the host repo's runbook; update this spec's status.

## Verification & Testing

- Phase 2's assertion list is the acceptance gate; production repeats exactly those assertions.
- Two invariants carried from the 1.6.1 rehearsal: the partial unique index exists and is live, and
  no subscription holds more than one live `SCHEDULED` cycle.
- Gates: `corepack yarn build` 0; modules and http suites green with fixtures in major; no test
  asserts a value that passes at either scale (scale-blind asserts found during evidence —
  e.g. `analytics-workflows.spec.ts:127`, the whole of `src/modules/analytics/__tests__/admin-query.spec.ts`
  — must gain a literal that fixes the scale).

## Risks

- **Integer truncation** on `locked_amount` (and any other integer money column Phase 0 finds) —
  mitigated by the type ALTER first, asserted by the no-truncation checks.
- **A mixed-basis window** between code deploy and data conversion — eliminated by Phase 3's
  stop-the-world ordering; this is the risk that is live in production *today*.
- **Percentage vs fixed discounts** — a divide applied to a percentage corrupts pricing logic
  without any test noticing; handled by type-branching and an assertion.
- **Failed migration recovery**: a failed `medusa db:migrate --all-or-nothing` reverted 42 applied
  migrations in rehearsal and could not be re-run (core `Migration20240115152146` has no `down()`);
  the dump is the only recovery. Recorded from Task 25, not hypothesized.
- **Version-string ambiguity** in vendored `medusa-paypal` (committed `0.4.0` behaving as 0.5.0) —
  resolved by releasing 0.5.0 before the window, so the deployed version identifies its basis.
