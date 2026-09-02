# Plan 3: Plans & Offers Domain

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans`. Checkbox syntax. Browser checks main-agent-only.

**Goal:** Translate the Plans & Offers list page, create modal, and edit drawer —
including the `Discount range` filter label Rev 1 missed.

**Architecture:** Plan 1/2 patterns. zod schemas stay at module scope; their
`message:` values become translation **keys**, resolved by each file's `FieldError`
component via `t(message)` — no schema restructuring. The two files' `FieldError`
components are edited identically; extracting a shared component is deliberately
deferred (refactor beyond scope).

**Tech Stack:** react-i18next, react-hook-form + `@hookform/resolvers/zod`.

## Global Constraints

- Prerequisite: Plan 2 accepted.
- **English frozen** — extract `en.json` values from source verbatim.
- `common.intervals.*` owns Weekly/Monthly/Yearly; the existing
  `subscriptions.intervals.*` stays (values identical; noted duplication).
- Backend labels English: `frequency.label` in the Frequencies column, discount
  labels.
- Preflight: `docs/architecture/plan-offers.md`, `docs/admin/plan-offers.md`,
  `docs/testing/plan-offers.md`.
- One commit at plan end.

## Complete string inventory

### List page (`plans-offers/page.tsx`)

- Title `Plans & Offers` (×2), description `Configure product-level and variant-level subscription offers.` (×2), `Back to Subscriptions`, `Create`, `Failed to load plan offers.`
- Columns: Name / Target / Status / Frequencies / Effective source / Updated; cells `All variants`, `Enabled`/`Disabled`, `-` placeholder, `+{{count}} more`
- Filters: Status / Scope / Frequency / **`Discount range`** (Rev 1 miss; labels `1-9`, `10-24`, `25+` stay numeric), `Add filter`, `Clear all`, `Clear all filters`
- Format helpers: `Product`/`Variant` scope, `Enabled`/`Disabled`, `Weekly`/`Monthly`/`Yearly` (→ `common.intervals.*`), `Inactive`, `Up to {{max}}` discount range
- Actions: Edit / Enable / Enabling... / Disable / Disabling...
- Toggle prompt + toasts: `Enable plan offer?` / `Disable plan offer?`, descriptions, `Plan offer enabled` / `Plan offer disabled`, `Failed to update plan offer`
- Empty states (filtered + unfiltered pairs)
- `FilterChip` literal `is`

### Create modal (`create-plan-offer-modal.tsx`)

Header (`Create plan offer`, description), target section (Product/Variant boxes,
`No product selected` / `No variant selected`, `Change`/`Select`), scope select
items, `Offer enabled` + hint, `Offer rules` + hint, `Minimum cycles` + hint,
`Stacking policy` + hint + 3 option labels, `Trial enabled` + hint, `Trial days`,
`Frequencies` + hint, `Add frequency`, row labels (`Interval`, `Value`,
`Discount for this frequency` + hint, `Discount type`, `Percentage`, `Fixed`,
`Discount value`), `Remove frequency?` prompt (title/description/confirm),
`Cancel`, `Create`, toasts `Plan offer created` / `Failed to create plan offer`,
zod messages (5): `Select a variant`, `Frequency must be unique`,
`Discount value is required`, `Trial days is required when trial is enabled`,
`Trial days must be greater than 0`.

### Edit drawer (`edit-plan-offer-drawer.tsx`)

Same sections as the modal minus scope select, plus: `Edit plan offer`,
`Loading plan offer...`, `Failed to load plan offer.`, `Target`,
`Product-level configuration` / `Variant-level configuration`,
`Update allowed frequencies and their discounts.`,
`Update minimum period, trial behavior, and stacking policy.`, `Save`,
toasts `Plan offer updated` / `Failed to update plan offer`, zod messages (4 —
no variant check in this file).

## Task 1: Catalog keys

**Files:** both JSON files.

Add `planOffers.*` areas per the inventory: `list`, `columns`, `filters` (incl.
`discountRange` label key and `discountRangeUpTo`), `status` (`enabled`, `disabled`,
`inactive`), `scope`, `actions`, `toast`, `errors`, `prompt` (enable/disable/remove
frequency), `form` (all labels/hints/options incl. stacking option labels,
`productLevelConfig`, `variantLevelConfig`, `change`, `select`,
`noProductSelected`, `noVariantSelected`, `offerEnabled` + both hint variants),
`validation` (5 keys).

Also add to `common.fields`: nothing new required this plan (`discount` exists).

Rules: byte-for-byte extraction (source wins over this inventory on conflict);
zhCN per Plan 1 terminology (启用/停用, 叠加策略, 试用天数, 按百分比/固定金额,
还有 {{count}} 项). Run `yarn test:i18n`.

## Task 2: List page

- [ ] Restructure first, zero string changes (same pattern as Plan 2 Task 2);
  keep `columnHelper`/`filterHelper`/`PAGE_SIZE` at module scope.
- [ ] Hook + key maps: `PLAN_OFFER_STATUS_KEYS`, `PLAN_OFFER_SCOPE_KEYS`,
  `PLAN_OFFER_INTERVAL_KEYS` (→ `common.intervals.*`).
- [ ] Delete `formatScope` / `formatStatusFilter` / `formatFrequencyFilter`
  (line refs 906/910/914 pre-edit); convert `formatEffectiveSource(planOffer, t)`
  and `formatDiscountRange(t, min?, max?)` — `t` first, trailing optional params.
- [ ] Columns per inventory; `+N more` → `t("planOffers.columns.moreCount", { count })`;
  `{frequency.label}` stays English.
- [ ] Toggle mutation/prompt/toasts; empty states; chrome; `FilterChip` (own hook).
- [ ] Verify: grep sweeps clean; `yarn build && yarn test:i18n` green; browser
  (main agent): filters incl. Discount range, toggle dialog, 生效来源 column values.

## Task 3: Create modal

- [ ] Schema `message:` values → keys (`planOffers.validation.*`), **conditions and
  `path` arrays byte-identical**.
- [ ] `FieldError` (line 782) resolves keys: `const { t } = useTranslation("reorder")`
  + `{t(message)}`. Consequence (documented): zod's built-in messages pass through
  `t` unchanged (fall-through), still readable.
- [ ] All form labels/hints/options per inventory; interpolation-only where the
  source interpolates.
- [ ] Verify: greps clean; build + `yarn test:i18n` green.
- [ ] Browser (main agent) — **trigger all five validation errors** (the schema keys
  are only covered by the contract test as literals, which they are; still verify
  rendering): variant required, duplicate frequency, discount value required, trial
  days required, trial days ≤ 0.

## Task 4: Edit drawer

- [ ] Same treatment: 4 schema messages → keys; identical `FieldError` change
  (line 706); all labels/hints incl. the two `Update ...` hint variants; toasts;
  remove-frequency prompt; `Save`.
- [ ] Verify: greps clean; build + `yarn test:i18n` green; browser (main agent):
  edit drawer fully Chinese, 4 validation errors render, remove-frequency dialog.

## Completion: single commit

```
feat(i18n): translate plans and offers screens
```
