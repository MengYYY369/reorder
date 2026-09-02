# Simplified Chinese (zhCN) Support — Plan Index

This is the execution order for adding Simplified Chinese to the Reorder Admin UI,
plus the Medusa 2.19 upgrade that precedes it.

Each plan is self-contained and produces working, shippable software on its own.
Execute them in order — Plan 1 creates the infrastructure every later plan depends on.

| Order | Plan | Scope | Unique strings |
|-------|------|-------|----------------|
| 0 | [Medusa 2.19 upgrade](2026-09-02-plan-0-medusa-2.19-upgrade.md) | Dependency version bump only | — |
| 1 | [i18n foundation](2026-09-02-plan-1-i18n-foundation.md) | Namespace, JSON files, parity test, sidebar labels, breadcrumbs, 2 smallest files | 27 |
| 2 | [Subscriptions domain](2026-09-02-plan-2-i18n-subscriptions.md) | `subscriptions/page.tsx`, `subscriptions/[id]/page.tsx` | 106 |
| 3 | [Plans & Offers domain](2026-09-02-plan-3-i18n-plans-offers.md) | List page + create modal + edit drawer | 44 |
| 4 | [Renewals & Dunning domains](2026-09-02-plan-4-i18n-renewals-dunning.md) | 4 files (2 lists, 2 details) | 118 |
| 5 | [Cancellation & Retention domain](2026-09-02-plan-5-i18n-cancellations.md) | List + detail (largest single file) | 130 |
| 6 | [Activity Log, Analytics, Settings](2026-09-02-plan-6-i18n-observability-settings.md) | 3 files + docs finalization | 95 |

## Out of scope for all plans

Backend-generated English labels stay English. This was an explicit decision, not an
oversight. The following continue to emit English and are **not** touched:

- `src/modules/subscription/utils/admin-query.ts:205` — `formatFrequencyLabel` → `Every month`
- `src/modules/subscription/utils/admin-query.ts:224` — discount label → `10% off`
- `src/modules/plan-offer/utils/admin-query.ts:121` — `formatFrequencyLabel`
- `src/modules/plan-offer/utils/admin-query.ts:147` — discount label
- `src/modules/analytics/utils/admin-query.ts:110` — `METRIC_LABELS` → `MRR`, `Churn Rate`, `LTV`, `Active Subscriptions`, `Created Subscriptions`
- `src/api/store/customers/me/subscriptions/utils.ts:503,639` — storefront frequency labels
- `src/workflows/steps/validate-subscription-cart.ts:327` — discount label

Consequence: a few values rendered inside otherwise-Chinese pages remain English
(frequency labels, discount labels, analytics metric names). Where the Admin DTO also
carries structured fields, later plans note the option to render from those instead —
but no plan requires it.

Also unchanged: `integration-tests/http/plan-offers-routes.spec.ts:221,230,306,320`
assert those exact English label strings and must keep passing untouched.

## Verification available in this repo

There is no React test harness (jest runs in `node` environment; `testMatch` only covers
`integration-tests/http/` and `src/modules/*/__tests__/`). Plan 1 therefore adds a
**translation contract test** that runs in the existing node environment and enforces:

1. `zhCN.json` and `en.json` have identical key sets
2. no empty values in either file
3. every literal `t("...")` key used anywhere under `src/admin/` exists in `en.json`

Test 3 is what makes each later plan verifiable: migrate a file, run the test, and any
key you forgot to add to the JSON fails the build. Plans 2-6 all depend on it.
