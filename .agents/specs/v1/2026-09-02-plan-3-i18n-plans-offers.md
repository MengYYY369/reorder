# Plan 3: Plans & Offers Domain

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Translate the Plans & Offers list page, the create modal, and the edit drawer — 44 unique strings across three files.

**Architecture:** Same pattern as Plan 2. One new wrinkle: both the create modal and the edit drawer validate with zod schemas declared at module scope, whose `message` strings surface directly in the UI through a `FieldError` component. Those messages cannot call `t()` where they are, so they become translation keys that `FieldError` resolves at render time.

**Tech Stack:** react-i18next 13.5.0, react-hook-form with `@hookform/resolvers/zod`, `@medusajs/ui`.

## Global Constraints

- **Prerequisite: Plans 1 and 2 are complete.** `yarn test:i18n` green, namespace `reorder` verified working in the browser.
- All code, comments, JSON keys, and commit messages in English. Chinese only as JSON values.
- Conventional Commits `type(scope): description`; propose and wait for explicit user approval before committing.
- Key convention `<domain>.<area>.<key>`. Domain here is `planOffers`.
- Reuse `common.*` and `planOffers.pickers.*` from Plan 1. Reuse `subscriptions.intervals.*` — see the note below.
- Backend labels stay English: `frequency.label` in the Frequencies column, and every `discount.label`.
- Do not refactor unrelated files.

## Reused keys

From Plan 1: `common.actions.cancel`, `common.actions.apply`, `common.actions.save`, `common.actions.search`, `common.fields.id`, `common.fields.product`, `common.fields.variant`, `common.fields.status`, `common.fields.frequency`, `common.fields.discount`, `common.placeholders.searchProducts`, `common.empty.noValue`, `common.filters.is`, `common.filters.clearAll`, `common.filters.clearAllFilters`, `planOffers.pickers.*`, `menuItems.planOffers`.

Plans & Offers has its own `PlanOfferFrequencyInterval` enum, distinct from `SubscriptionFrequencyInterval`, but both render the same three words (Weekly / Monthly / Yearly). Rather than duplicate them, this plan promotes them to `common.intervals.*` in Task 1 and leaves `subscriptions.intervals.*` in place — Plan 2's code already references those keys and rewriting it here would violate the "do not refactor unrelated files" constraint. The two key sets hold identical values; that duplication is deliberate and cheap.

## File Structure

| File | Unique strings | Task |
|------|----------------|------|
| `src/admin/i18n/json/en.json` + `zhCN.json` | — | 1 |
| `src/admin/routes/subscriptions/plans-offers/page.tsx` (953 lines) | 25 | 2 |
| `.../components/create-plan-offer-modal.tsx` (792 lines) | 16 + 5 validation | 3 |
| `.../components/edit-plan-offer-drawer.tsx` (716 lines) | 16 + 4 validation | 4 |

---

## Task 1: Add the Plans & Offers keys

**Files:**
- Modify: `src/admin/i18n/json/en.json`
- Modify: `src/admin/i18n/json/zhCN.json`

**Interfaces:**
- Consumes: the `planOffers` object created by Plan 1 (currently holds only `pickers`).
- Produces: `planOffers.list.*`, `planOffers.columns.*`, `planOffers.filters.*`, `planOffers.status.*`, `planOffers.scope.*`, `planOffers.actions.*`, `planOffers.toast.*`, `planOffers.errors.*`, `planOffers.prompt.*`, `planOffers.form.*`, `planOffers.validation.*`, and `common.intervals.*`. Tasks 2-4 consume these.

- [ ] **Step 1: Add to en.json inside the `planOffers` object, as siblings of `pickers`**

```json
    "list": {
      "title": "Plans & Offers",
      "description": "Configure product-level and variant-level subscription offers.",
      "backToSubscriptions": "Back to Subscriptions",
      "create": "Create",
      "loadError": "Failed to load plan offers.",
      "emptyFiltered": "No matching plan offers",
      "emptyFilteredHint": "Try changing the search term or active filters.",
      "empty": "No plan offers yet",
      "emptyHint": "Create a product-level or variant-level subscription offer to get started."
    },
    "columns": {
      "name": "Name",
      "target": "Target",
      "frequencies": "Frequencies",
      "effectiveSource": "Effective source",
      "updated": "Updated",
      "allVariants": "All variants",
      "moreCount": "+{{count}} more"
    },
    "filters": {
      "scope": "Scope",
      "discountRange1To9": "1-9",
      "discountRange10To24": "10-24",
      "discountRange25Plus": "25+",
      "discountRangeUpTo": "Up to {{max}}"
    },
    "status": {
      "enabled": "Enabled",
      "disabled": "Disabled",
      "inactive": "Inactive"
    },
    "scope": {
      "product": "Product",
      "variant": "Variant"
    },
    "actions": {
      "edit": "Edit",
      "enable": "Enable",
      "enabling": "Enabling...",
      "disable": "Disable",
      "disabling": "Disabling...",
      "remove": "Remove",
      "addFrequency": "Add frequency"
    },
    "toast": {
      "created": "Plan offer created",
      "updated": "Plan offer updated",
      "enabled": "Plan offer enabled",
      "disabled": "Plan offer disabled"
    },
    "errors": {
      "createFailed": "Failed to create plan offer",
      "updateFailed": "Failed to update plan offer",
      "loadFailed": "Failed to load plan offer."
    },
    "prompt": {
      "enableTitle": "Enable plan offer?",
      "enableDescription": "You are about to enable this plan offer. Do you want to continue?",
      "disableTitle": "Disable plan offer?",
      "disableDescription": "You are about to disable this plan offer. Do you want to continue?",
      "removeFrequencyTitle": "Remove frequency?",
      "removeFrequencyDescription": "This frequency row and its discount configuration will be removed."
    },
    "form": {
      "createTitle": "Create plan offer",
      "createDescription": "Create a product-level or variant-level subscription offer.",
      "editTitle": "Edit plan offer",
      "loading": "Loading plan offer...",
      "name": "Name",
      "scope": "Scope",
      "target": "Target",
      "noProductSelected": "No product selected",
      "noVariantSelected": "No variant selected",
      "change": "Change",
      "select": "Select",
      "productLevelConfig": "Product-level configuration",
      "variantLevelConfig": "Variant-level configuration",
      "offerEnabled": "Offer enabled",
      "offerEnabledHintCreate": "Enable this offer as soon as it is created.",
      "offerEnabledHintEdit": "Enable or disable this configuration.",
      "offerRules": "Offer rules",
      "offerRulesHintCreate": "Define optional offer constraints such as minimum period, trial behavior, and stacking policy.",
      "offerRulesHintEdit": "Update minimum period, trial behavior, and stacking policy.",
      "minimumCycles": "Minimum cycles",
      "minimumCyclesHint": "Leave empty if there is no minimum subscription period.",
      "stackingPolicy": "Stacking policy",
      "stackingPolicyHint": "Control whether this offer can stack with other discounts.",
      "stackingAllowed": "Allowed",
      "stackingDisallowAll": "Disallow all",
      "stackingDisallowSubscriptionDiscounts": "Disallow subscription discounts",
      "trialEnabled": "Trial enabled",
      "trialEnabledHint": "Allow a trial period for this offer.",
      "trialDays": "Trial days",
      "frequencies": "Frequencies",
      "frequenciesHintCreate": "Define allowed frequencies and optional discounts.",
      "frequenciesHintEdit": "Update allowed frequencies and their discounts.",
      "interval": "Interval",
      "value": "Value",
      "discountForFrequency": "Discount for this frequency",
      "discountForFrequencyHint": "Enable only if this frequency should have a discount.",
      "discountType": "Discount type",
      "discountValue": "Discount value",
      "discountPercentage": "Percentage",
      "discountFixed": "Fixed"
    },
    "validation": {
      "variantRequired": "Select a variant",
      "frequencyUnique": "Frequency must be unique",
      "discountValueRequired": "Discount value is required",
      "trialDaysRequired": "Trial days is required when trial is enabled",
      "trialDaysPositive": "Trial days must be greater than 0"
    }
```

And add a new top-level area to `common`:

```json
    "intervals": {
      "week": "Weekly",
      "month": "Monthly",
      "year": "Yearly"
    },
```

Three entries need explanation. `planOffers.columns.moreCount` replaces the `+N more` template literal at `page.tsx:169` — Chinese renders this as `还有 N 项`, so the number must be interpolated. `planOffers.filters.discountRangeUpTo` covers the `Up to ${max}` branch of `formatDiscountRange`; the other branches produce pure numbers (`1-9`, `25+`) and need no translation, so the function keeps building those itself. `planOffers.status.inactive` is the `formatEffectiveSource` return when no scope resolves — it means "no configuration is in effect", not "disabled", so it is a separate key from `status.disabled`.

- [ ] **Step 2: Add the same keys to zhCN.json**

```json
    "list": {
      "title": "计划与优惠",
      "description": "配置商品级和变体级的订阅优惠。",
      "backToSubscriptions": "返回订阅列表",
      "create": "新建",
      "loadError": "加载优惠配置失败。",
      "emptyFiltered": "没有匹配的优惠配置",
      "emptyFilteredHint": "请尝试修改搜索词或调整筛选条件。",
      "empty": "暂无优惠配置",
      "emptyHint": "创建一个商品级或变体级的订阅优惠即可开始。"
    },
    "columns": {
      "name": "名称",
      "target": "作用对象",
      "frequencies": "可选频率",
      "effectiveSource": "生效来源",
      "updated": "更新时间",
      "allVariants": "所有变体",
      "moreCount": "还有 {{count}} 项"
    },
    "filters": {
      "scope": "作用范围",
      "discountRange1To9": "1-9",
      "discountRange10To24": "10-24",
      "discountRange25Plus": "25+",
      "discountRangeUpTo": "最多 {{max}}"
    },
    "status": {
      "enabled": "已启用",
      "disabled": "已停用",
      "inactive": "未生效"
    },
    "scope": {
      "product": "商品",
      "variant": "变体"
    },
    "actions": {
      "edit": "编辑",
      "enable": "启用",
      "enabling": "正在启用……",
      "disable": "停用",
      "disabling": "正在停用……",
      "remove": "移除",
      "addFrequency": "添加频率"
    },
    "toast": {
      "created": "优惠配置已创建",
      "updated": "优惠配置已更新",
      "enabled": "优惠配置已启用",
      "disabled": "优惠配置已停用"
    },
    "errors": {
      "createFailed": "创建优惠配置失败",
      "updateFailed": "更新优惠配置失败",
      "loadFailed": "加载优惠配置失败。"
    },
    "prompt": {
      "enableTitle": "确认启用此优惠配置？",
      "enableDescription": "即将启用此优惠配置，是否继续？",
      "disableTitle": "确认停用此优惠配置？",
      "disableDescription": "即将停用此优惠配置，是否继续？",
      "removeFrequencyTitle": "确认移除此频率？",
      "removeFrequencyDescription": "此频率行及其折扣配置将被移除。"
    },
    "form": {
      "createTitle": "新建优惠配置",
      "createDescription": "创建一个商品级或变体级的订阅优惠。",
      "editTitle": "编辑优惠配置",
      "loading": "正在加载优惠配置……",
      "name": "名称",
      "scope": "作用范围",
      "target": "作用对象",
      "noProductSelected": "未选择商品",
      "noVariantSelected": "未选择变体",
      "change": "更换",
      "select": "选择",
      "productLevelConfig": "商品级配置",
      "variantLevelConfig": "变体级配置",
      "offerEnabled": "启用优惠",
      "offerEnabledHintCreate": "创建后立即启用此优惠。",
      "offerEnabledHintEdit": "启用或停用此配置。",
      "offerRules": "优惠规则",
      "offerRulesHintCreate": "定义可选的优惠约束，例如最短周期、试用行为和叠加策略。",
      "offerRulesHintEdit": "更新最短周期、试用行为和叠加策略。",
      "minimumCycles": "最少周期数",
      "minimumCyclesHint": "如无最短订阅周期要求，可留空。",
      "stackingPolicy": "叠加策略",
      "stackingPolicyHint": "控制此优惠是否可与其他折扣叠加。",
      "stackingAllowed": "允许叠加",
      "stackingDisallowAll": "禁止所有叠加",
      "stackingDisallowSubscriptionDiscounts": "禁止与订阅折扣叠加",
      "trialEnabled": "启用试用",
      "trialEnabledHint": "为此优惠开启试用期。",
      "trialDays": "试用天数",
      "frequencies": "可选频率",
      "frequenciesHintCreate": "定义允许的频率及可选折扣。",
      "frequenciesHintEdit": "更新允许的频率及其折扣。",
      "interval": "频率单位",
      "value": "数值",
      "discountForFrequency": "此频率的折扣",
      "discountForFrequencyHint": "仅当此频率需要折扣时启用。",
      "discountType": "折扣类型",
      "discountValue": "折扣数值",
      "discountPercentage": "按百分比",
      "discountFixed": "固定金额"
    },
    "validation": {
      "variantRequired": "请选择变体",
      "frequencyUnique": "频率不能重复",
      "discountValueRequired": "请填写折扣数值",
      "trialDaysRequired": "启用试用时必须填写试用天数",
      "trialDaysPositive": "试用天数必须大于 0"
    }
```

And in `common`:

```json
    "intervals": {
      "week": "每周",
      "month": "每月",
      "year": "每年"
    },
```

- [ ] **Step 3: Verify parity**

```bash
yarn test:i18n
```

Expected: 3 passing.

- [ ] **Step 4: Commit**

Propose to the user and wait for approval:

```
feat(i18n): add plan offer translation keys
```

```bash
git add src/admin/i18n/json
git commit -m "feat(i18n): add plan offer translation keys"
```

---

## Task 2: Translate the Plans & Offers list page

**Files:**
- Modify: `src/admin/routes/subscriptions/plans-offers/page.tsx:56-98` (module-scope options and filters), `:100-193` (`baseColumns`), `:895-953` (five formatter functions), and the JSX

**Interfaces:**
- Consumes: Task 1 keys.
- Produces, all local to this file:
  - `PLAN_OFFER_STATUS_KEYS: Record<PlanOfferAdminStatus, string>`
  - `PLAN_OFFER_SCOPE_KEYS: Record<PlanOfferScope, string>`
  - `PLAN_OFFER_INTERVAL_KEYS: Record<PlanOfferFrequencyInterval, string>`
  - `formatDateTime(value: string | null, emptyValue: string): string`
  - `formatEffectiveSource(planOffer: PlanOfferAdminListItem, t: TFunction): string`
  - `formatDiscountRange(t: TFunction, min?: number, max?: number): string`

- [ ] **Step 1: Move the module-scope definitions into the component**

Same restructuring as Plan 2 Task 2, and for the same reason — hooks cannot be called at module scope. Keep `PAGE_SIZE` (line 51), `columnHelper` (53), and `filterHelper` (54) where they are. Move lines 56-98 (four option arrays, three filter accessors, the `filters` array) and lines 100-193 (`baseColumns`) inside `PlansOffersPage`.

The component already has a `columns` useMemo — fold `baseColumns` into it the same way Plan 2 did.

Do this move with **zero string changes**, verify `yarn build` passes, then continue to Step 2. Unlike Plan 2 this is not a separate commit — the file is smaller and the whole task lands in one commit at Step 8 — but keep the two edits distinct in your own working order so a mistake is easy to localize.

- [ ] **Step 2: Add the hook, key maps, and imports**

```tsx
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
```

Add at module scope:

```tsx
const PLAN_OFFER_STATUS_KEYS: Record<PlanOfferAdminStatus, string> = {
  [PlanOfferAdminStatus.ENABLED]: "planOffers.status.enabled",
  [PlanOfferAdminStatus.DISABLED]: "planOffers.status.disabled",
};

const PLAN_OFFER_SCOPE_KEYS: Record<PlanOfferScope, string> = {
  [PlanOfferScope.PRODUCT]: "planOffers.scope.product",
  [PlanOfferScope.VARIANT]: "planOffers.scope.variant",
};

const PLAN_OFFER_INTERVAL_KEYS: Record<PlanOfferFrequencyInterval, string> = {
  [PlanOfferFrequencyInterval.WEEK]: "common.intervals.week",
  [PlanOfferFrequencyInterval.MONTH]: "common.intervals.month",
  [PlanOfferFrequencyInterval.YEAR]: "common.intervals.year",
};
```

Add `const { t } = useTranslation("reorder");` as the first line of the component body.

- [ ] **Step 3: Replace three formatter functions with the key maps**

Delete `formatScope` (line 906) and `formatStatusFilter` (line 910) and `formatFrequencyFilter` (line 914) entirely — each is a two-or-three-branch English mapping now covered by a key map. Their call sites become `t(PLAN_OFFER_SCOPE_KEYS[scope])`, `t(PLAN_OFFER_STATUS_KEYS[status])`, and `t(PLAN_OFFER_INTERVAL_KEYS[frequency])`.

Find the call sites with:

```bash
grep -n "formatScope\|formatStatusFilter\|formatFrequencyFilter" src/admin/routes/subscriptions/plans-offers/page.tsx
```

Expected: `formatStatusFilter` at line 528 (inside a `FilterChip` value), plus the definitions. Replace each.

- [ ] **Step 4: Change three formatter signatures**

```tsx
function formatDateTime(value: string | null, emptyValue: string) {
  if (!value) {
    return emptyValue;
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}
```

```tsx
function formatEffectiveSource(
  planOffer: PlanOfferAdminListItem,
  t: TFunction,
) {
  const scope = planOffer.effective_config_summary.source_scope;

  if (!scope) {
    return t("planOffers.status.inactive");
  }

  return t(PLAN_OFFER_SCOPE_KEYS[scope]);
}
```

```tsx
function formatDiscountRange(t: TFunction, min?: number, max?: number) {
  if (typeof min === "number" && typeof max === "number") {
    return `${min}-${max}`;
  }

  if (typeof min === "number") {
    return `${min}+`;
  }

  if (typeof max === "number") {
    return t("planOffers.filters.discountRangeUpTo", { max });
  }

  return t("common.empty.noValue");
}
```

`t` goes first in `formatDiscountRange` because `min` and `max` are both optional — appending a required parameter after optional ones is a type error.

- [ ] **Step 5: Translate the options, filters, and columns**

Option arrays (now inside the component, each `useMemo` with `[t]`):

```tsx
  const statusFilterOptions = useMemo(
    () => [
      { label: t("planOffers.status.enabled"), value: PlanOfferAdminStatus.ENABLED },
      { label: t("planOffers.status.disabled"), value: PlanOfferAdminStatus.DISABLED },
    ],
    [t],
  );

  const scopeFilterOptions = useMemo(
    () => [
      { label: t("planOffers.scope.product"), value: PlanOfferScope.PRODUCT },
      { label: t("planOffers.scope.variant"), value: PlanOfferScope.VARIANT },
    ],
    [t],
  );

  const frequencyFilterOptions = useMemo(
    () => [
      { label: t("common.intervals.week"), value: PlanOfferFrequencyInterval.WEEK },
      { label: t("common.intervals.month"), value: PlanOfferFrequencyInterval.MONTH },
      { label: t("common.intervals.year"), value: PlanOfferFrequencyInterval.YEAR },
    ],
    [t],
  );

  const discountRangeFilterOptions = useMemo(
    () => [
      { label: t("planOffers.filters.discountRange1To9"), min: 1, max: 9 },
      { label: t("planOffers.filters.discountRange10To24"), min: 10, max: 24 },
      { label: t("planOffers.filters.discountRange25Plus"), min: 25 },
    ],
    [t],
  );
```

Filter accessors: `statusFilter` → `label: t("common.fields.status")`; `scopeFilter` → `label: t("planOffers.filters.scope")`; `frequencyFilter` → `label: t("common.fields.frequency")`. Each gains `t` in its dependency array.

Columns:

| Column | Change |
|--------|--------|
| `name` (102) | `header` and `sortLabel` → `t("planOffers.columns.name")` |
| `target` (118) | `header: t("planOffers.columns.target")`, `sortLabel: t("common.fields.product")`, and the cell's `"All variants"` at line 128 → `t("planOffers.columns.allVariants")` |
| `status` (137) | `header` and `sortLabel` → `t("common.fields.status")`; the badge at line 147 renders `{t(PLAN_OFFER_STATUS_KEYS[getValue()])}` |
| `frequencies` (153) | `header: t("planOffers.columns.frequencies")`; the `-` at line 164 → `{t("common.empty.noValue")}`; the `+N more` at line 169 → `{t("planOffers.columns.moreCount", { count: row.original.allowed_frequencies.length - 2 })}`. The `{frequency.label}` at line 159 stays English — backend label. |
| `effective_source` (177) | `header: t("planOffers.columns.effectiveSource")`; cell calls `formatEffectiveSource(row.original, t)` |
| `updated_at` (185) | `header` and `sortLabel` → `t("planOffers.columns.updated")`; cell calls `formatDateTime(getValue(), t("common.empty.noValue"))` |

The action column at line 355-380: `label: t("planOffers.actions.edit")` for edit, and the enable/disable entry becomes

```tsx
                    label: isPending
                      ? row.original.status === PlanOfferAdminStatus.ENABLED
                        ? t("planOffers.actions.disabling")
                        : t("planOffers.actions.enabling")
                      : row.original.status === PlanOfferAdminStatus.ENABLED
                        ? t("planOffers.actions.disable")
                        : t("planOffers.actions.enable"),
```

Read lines 361-378 before writing this — the existing nested ternary has its own variable names for the pending and status checks, and those must be preserved. Only the four string literals change.

- [ ] **Step 6: Translate the toggle mutation and its prompt**

Line 291: `toast.success(variables.is_enabled ? t("planOffers.toast.enabled") : t("planOffers.toast.disabled"))`.

Line 298: error fallback → `t("planOffers.errors.updateFailed")`.

Lines 332-337 build the confirmation dialog inline inside the component, so `t` is already in scope:

```tsx
      title: nextEnabled
        ? t("planOffers.prompt.enableTitle")
        : t("planOffers.prompt.disableTitle"),
      description: nextEnabled
        ? t("planOffers.prompt.enableDescription")
        : t("planOffers.prompt.disableDescription"),
      confirmText: nextEnabled
        ? t("planOffers.actions.enable")
        : t("planOffers.actions.disable"),
      cancelText: t("common.actions.cancel"),
```

- [ ] **Step 7: Translate the page chrome**

| Line | Change |
|------|--------|
| 426, 502 | `{t("planOffers.list.title")}` |
| 433, 509 | `{t("planOffers.list.description")}` |
| 436 | `<Link to="/subscriptions">{t("planOffers.list.backToSubscriptions")}</Link>` |
| 445 | fallback → `t("planOffers.list.loadError")` |
| 518 | the Create button's text → `{t("planOffers.list.create")}` |
| 554 | `label="Product"` → `label={t("common.fields.product")}` |
| 574 | `label="Variant"` → `label={t("common.fields.variant")}` |
| 586 | `label="Discount"` → `label={t("common.fields.discount")}` |
| 760 | `placeholder={t("common.actions.search")}` |
| 832-833 | `{hasActiveFilters \|\| search ? t("planOffers.list.emptyFiltered") : t("planOffers.list.empty")}` |
| 837-838 | `{hasActiveFilters \|\| search ? t("planOffers.list.emptyFilteredHint") : t("planOffers.list.emptyHint")}` |

The heading and description appear twice — once in the `isError` return at 419-448, once in the main render at 499. Both need changing.

This file also has a `FilterChip` component and `Clear all` / `Clear all filters` controls mirroring the subscriptions list. Find them and apply the same keys Plan 2 used:

```bash
grep -n "Clear all\|const FilterChip" src/admin/routes/subscriptions/plans-offers/page.tsx
```

Translate to `t("common.filters.clearAll")`, `t("common.filters.clearAllFilters")`, and `t("common.filters.is")` inside `FilterChip` (which needs its own hook call).

- [ ] **Step 8: Verify, build, test, commit**

```bash
grep -nE '(header|label|title|placeholder|sortLabel|confirmText|cancelText)(:|=) *"[A-Z]' src/admin/routes/subscriptions/plans-offers/page.tsx
grep -nE '>[A-Z][a-zA-Z ]{3,}<' src/admin/routes/subscriptions/plans-offers/page.tsx
grep -nE 'toast\.(success|error)\("' src/admin/routes/subscriptions/plans-offers/page.tsx
yarn build && yarn test:i18n
```

Expected: no grep output, build succeeds, 3 tests pass.

Propose to the user and wait for approval:

```
feat(i18n): translate plan offers list page
```

```bash
git add src/admin/routes/subscriptions/plans-offers/page.tsx
git commit -m "feat(i18n): translate plan offers list page"
```

---

## Task 3: Translate the create plan offer modal

**Files:**
- Modify: `src/admin/routes/subscriptions/plans-offers/components/create-plan-offer-modal.tsx` (792 lines)

**Interfaces:**
- Consumes: Task 1 keys.
- Produces: the `FieldError` pattern — `FieldError` resolves a translation key rather than rendering a message directly. **Task 4 copies this exact pattern**, because the edit drawer has its own separate `FieldError` component with the same shape.

**The zod problem and how this task solves it.** The schema at lines 34-113 is declared at module scope and its `message` values render straight into the UI through `<FieldError message={form.formState.errors.name?.message} />`. There are five such messages here (lines 65, 78, 88, 97, and one more at ~107 for `trialDaysPositive`). Three options were considered:

1. Move the schema inside the component and build it with `t()` — makes the schema a new object on every render, which `zodResolver` re-registers, and risks resetting form state.
2. Wrap `zodResolver` to post-process messages — indirection for no benefit.
3. Put translation **keys** in the `message` fields and resolve them in `FieldError` — no schema restructuring, and the resolution happens exactly where the string is displayed.

Option 3 is what this task does. The tradeoff is that `form.formState.errors.*.message` now holds a key rather than English prose, which matters if anything other than `FieldError` ever reads it. Nothing does today.

- [ ] **Step 1: Replace the schema messages with keys**

In the `superRefine` block, change the five `message` values to keys. Everything else in the schema — `code`, `path`, the conditions — stays identical:

| Line | Current message | New value |
|------|-----------------|-----------|
| 65 | `"Select a variant"` | `"planOffers.validation.variantRequired"` |
| 78 | `"Frequency must be unique"` | `"planOffers.validation.frequencyUnique"` |
| 88 | `"Discount value is required"` | `"planOffers.validation.discountValueRequired"` |
| 97 | `"Trial days is required when trial is enabled"` | `"planOffers.validation.trialDaysRequired"` |
| ~107 | `"Trial days must be greater than 0"` | `"planOffers.validation.trialDaysPositive"` |

- [ ] **Step 2: Make FieldError resolve keys**

`FieldError` at line 782 currently renders `message` verbatim. Replace it:

```tsx
const FieldError = ({ message }: { message?: string }) => {
  const { t } = useTranslation("reorder")

  if (!message) {
    return null
  }

  return (
    <Text size="small" leading="compact" className="text-ui-fg-error">
      {t(message)}
    </Text>
  )
}
```

The prop name stays `message` — renaming it to `messageKey` would be more honest but would touch all seven call sites for no functional gain, and the constraint is to keep changes local.

One consequence worth knowing: zod's own built-in messages (from `z.string().min(1)` and friends on lines 44-59) are not keys. When one of those fires, `t()` receives something like `"String must contain at least 1 character(s)"`, finds no matching key, and returns the input unchanged — so it still displays, in English. That is acceptable: these are schema-level guards that the UI mostly prevents from firing, and i18next's fall-through behavior handles them gracefully.

- [ ] **Step 3: Add the hook and imports**

```tsx
import { useTranslation } from "react-i18next"
```

Add `const { t } = useTranslation("reorder")` as the first line of the modal component's body. `FieldError` gets its own call, per Step 2.

- [ ] **Step 4: Translate the header, toasts, and prompt**

| Line | Change |
|------|--------|
| 203 | `toast.success(t("planOffers.toast.created"))` |
| 209 | fallback → `t("planOffers.errors.createFailed")` |
| 251 | `title: t("planOffers.prompt.removeFrequencyTitle")` |
| 253 | `description: t("planOffers.prompt.removeFrequencyDescription")` |
| 254 | `confirmText: t("planOffers.actions.remove")` |
| 255 | `cancelText: t("common.actions.cancel")` |
| 303 | `{t("common.actions.cancel")}` |
| 311 | `{t("planOffers.list.create")}` |
| 319 | `<Heading>{t("planOffers.form.createTitle")}</Heading>` |
| 325 | `{t("planOffers.form.createDescription")}` |

- [ ] **Step 5: Translate the name, scope, and target sections**

| Line | Change |
|------|--------|
| 331 | `<Label htmlFor="create-name">{t("planOffers.form.name")}</Label>` |
| 337 | `<Label htmlFor="create-scope">{t("planOffers.form.scope")}</Label>` |
| 357 | Select.Item content → `{t("planOffers.scope.product")}` |
| 360 | Select.Item content → `{t("planOffers.scope.variant")}` |
| 372 | the `Product` heading → `{t("common.fields.product")}` |
| 379 | `{productTitle \|\| t("planOffers.form.noProductSelected")}` |
| 388 | `{productId ? t("planOffers.form.change") : t("planOffers.form.select")}` |
| 404 | the `Variant` heading → `{t("common.fields.variant")}` |
| 411 | `{variantTitle \|\| t("planOffers.form.noVariantSelected")}` |
| 421 | `{variantId ? t("planOffers.form.change") : t("planOffers.form.select")}` |
| 432 | `{t("planOffers.form.offerEnabled")}` |
| 439 | `{t("planOffers.form.offerEnabledHintCreate")}` |

- [ ] **Step 6: Translate the offer rules section**

| Line | Change |
|------|--------|
| 457 | `<Heading level="h2">{t("planOffers.form.offerRules")}</Heading>` |
| 463-464 | the two-line description → `{t("planOffers.form.offerRulesHintCreate")}` |
| 470 | `<Label htmlFor="minimum-cycles">{t("planOffers.form.minimumCycles")}</Label>` |
| 486-487 | the two-line hint → `{t("planOffers.form.minimumCyclesHint")}` |
| 494 | `<Label htmlFor="stacking-policy">{t("planOffers.form.stackingPolicy")}</Label>` |
| 508 | `{t("planOffers.form.stackingAllowed")}` |
| 511 | `{t("planOffers.form.stackingDisallowAll")}` |
| 514 | `{t("planOffers.form.stackingDisallowSubscriptionDiscounts")}` |
| 525 | `{t("planOffers.form.stackingPolicyHint")}` |
| 534 | `{t("planOffers.form.trialEnabled")}` |
| 541 | `{t("planOffers.form.trialEnabledHint")}` |
| 565 | `<Label htmlFor="trial-days">{t("planOffers.form.trialDays")}</Label>` |

Lines 463-464 and 486-487 are single sentences that JSX has wrapped across two source lines. Replacing them with one `{t(...)}` expression collapses each to a single line — that is correct, not a formatting mistake.

- [ ] **Step 7: Translate the frequencies section**

| Line | Change |
|------|--------|
| 594 | `<Heading level="h2">{t("planOffers.form.frequencies")}</Heading>` |
| 600 | `{t("planOffers.form.frequenciesHintCreate")}` |
| 618 | the Add frequency button text → `{t("planOffers.actions.addFrequency")}` |
| 630 | `<Label>{t("planOffers.form.interval")}</Label>` |
| 644 | `{t("common.intervals.week")}` |
| 647 | `{t("common.intervals.month")}` |
| 650 | `{t("common.intervals.year")}` |
| 658 | `<Label>{t("planOffers.form.value")}</Label>` |
| 687 | `{t("planOffers.form.discountForFrequency")}` |
| 694 | `{t("planOffers.form.discountForFrequencyHint")}` |
| 712 | `<Label>{t("planOffers.form.discountType")}</Label>` |
| 728 | `{t("planOffers.form.discountPercentage")}` |
| 733 | `{t("planOffers.form.discountFixed")}` |
| 741 | `<Label>{t("planOffers.form.discountValue")}</Label>` |

These are inside a `fields.map((field, index) => ...)` render, which is a callback inside the component body — `t` is in scope there with no extra work.

- [ ] **Step 8: Verify, build, test, commit**

```bash
grep -nE '(header|label|title|placeholder|confirmText|cancelText)(:|=) *"[A-Z]' src/admin/routes/subscriptions/plans-offers/components/create-plan-offer-modal.tsx
grep -nE '^\s+[A-Z][A-Za-z ]{3,}$' src/admin/routes/subscriptions/plans-offers/components/create-plan-offer-modal.tsx
grep -nE 'message: "[A-Z]' src/admin/routes/subscriptions/plans-offers/components/create-plan-offer-modal.tsx
yarn build && yarn test:i18n
```

The second grep finds bare JSX text nodes — lines that are nothing but a capitalized phrase. Expect it to still match the import list at the top of the file (`Button,`, `FocusModal,` etc.); anything below line 35 is a missed string. The third grep must return nothing: every `message:` value should now be a lowercase-prefixed key.

Note that `yarn test:i18n` **does** verify the five validation keys, because `t(message)` in `FieldError` is not a literal — but the keys appear as literals in the schema's `message:` fields, which the test's regex does not match. So the validation keys are unverified by the test. Check them by eye against `en.json` once, or trigger each error in the browser in Step 9.

Propose to the user and wait for approval:

```
feat(i18n): translate create plan offer modal
```

```bash
git add src/admin/routes/subscriptions/plans-offers/components/create-plan-offer-modal.tsx
git commit -m "feat(i18n): translate create plan offer modal"
```

- [ ] **Step 9: Verify the validation messages in the browser**

The five validation keys are the one thing no automated check covers. In Chinese, open Plans & Offers → 新建 and trigger each:

1. Set scope to 变体, pick a product but no variant, submit → 请选择变体
2. Add two frequency rows with the same interval and value → 频率不能重复
3. Enable a frequency discount but leave the value empty → 请填写折扣数值
4. Toggle 启用试用 on and leave试用天数 empty → 启用试用时必须填写试用天数
5. Set 试用天数 to 0 → 试用天数必须大于 0

If any shows a raw key like `planOffers.validation.variantRequired`, that key is missing from `en.json` or misspelled in the schema.

---

## Task 4: Translate the edit plan offer drawer

**Files:**
- Modify: `src/admin/routes/subscriptions/plans-offers/components/edit-plan-offer-drawer.tsx` (716 lines)

**Interfaces:**
- Consumes: Task 1 keys, and the `FieldError`-resolves-keys pattern established in Task 3.
- Produces: nothing new.

This file is the create modal's sibling and shares most of its structure — a zod schema at module scope, its own `FieldError` at line 706, the same offer-rules and frequencies sections. Four differences: no scope selector (scope is fixed once created), a read-only Target display, its own loading state, and distinct hint wording ("Update..." rather than "Define...").

- [ ] **Step 1: Replace the four schema messages with keys**

| Line | Current message | New value |
|------|-----------------|-----------|
| 62 | `"Frequency must be unique"` | `"planOffers.validation.frequencyUnique"` |
| 72 | `"Discount value is required"` | `"planOffers.validation.discountValueRequired"` |
| 81 | `"Trial days is required when trial is enabled"` | `"planOffers.validation.trialDaysRequired"` |
| 93 | `"Trial days must be greater than 0"` | `"planOffers.validation.trialDaysPositive"` |

There is no `variantRequired` here — the drawer cannot change scope, so that check does not exist.

- [ ] **Step 2: Make this file's FieldError resolve keys**

`FieldError` at line 706 is a separate declaration from the create modal's. Apply the identical change:

```tsx
const FieldError = ({ message }: { message?: string }) => {
  const { t } = useTranslation("reorder")

  if (!message) {
    return null
  }

  return (
    <Text size="small" leading="compact" className="text-ui-fg-error">
      {t(message)}
    </Text>
  )
}
```

Extracting a shared `FieldError` into a common module would be the DRY move, but it would mean creating a new shared component file and rewiring both — a refactor beyond this plan's scope. Two five-line components with the same body is the smaller cost.

- [ ] **Step 3: Add the hook and import**

```tsx
import { useTranslation } from "react-i18next"
```

`const { t } = useTranslation("reorder")` as the first line of the drawer component's body.

- [ ] **Step 4: Translate the drawer chrome, toasts, and prompt**

| Line | Change |
|------|--------|
| 208 | `toast.success(t("planOffers.toast.updated"))` |
| 215 | fallback → `t("planOffers.errors.updateFailed")` |
| 251 | `title: t("planOffers.prompt.removeFrequencyTitle")` |
| 253 | `description: t("planOffers.prompt.removeFrequencyDescription")` |
| 254 | `confirmText: t("planOffers.actions.remove")` |
| 255 | `cancelText: t("common.actions.cancel")` |
| 284 | `<Drawer.Title>{t("planOffers.form.editTitle")}</Drawer.Title>` |
| 292 | `{t("planOffers.form.loading")}` |
| 298 | fallback → `t("planOffers.errors.loadFailed")` |
| 687 | `{t("common.actions.cancel")}` |
| 696 | `{t("common.actions.save")}` |

- [ ] **Step 5: Translate the form body**

| Line | Change |
|------|--------|
| 305 | `<Label htmlFor="edit-name">{t("planOffers.form.name")}</Label>` |
| 313 | the `Target` heading → `{t("planOffers.form.target")}` |
| 331-332 | `{scope === PlanOfferScope.PRODUCT ? t("planOffers.form.productLevelConfig") : t("planOffers.form.variantLevelConfig")}` — read the surrounding lines for the exact condition variable |
| 341 | `{t("planOffers.form.offerEnabled")}` |
| 348 | `{t("planOffers.form.offerEnabledHintEdit")}` |
| 368 | `<Heading level="h2">{t("planOffers.form.frequencies")}</Heading>` |
| 374 | `{t("planOffers.form.frequenciesHintEdit")}` |
| 391 | the Add frequency button → `{t("planOffers.actions.addFrequency")}` |
| 397 | `<Heading level="h2">{t("planOffers.form.offerRules")}</Heading>` |
| 403-404 | `{t("planOffers.form.offerRulesHintEdit")}` |
| 410 | `<Label htmlFor="edit-minimum-cycles">{t("planOffers.form.minimumCycles")}</Label>` |
| 426-427 | `{t("planOffers.form.minimumCyclesHint")}` |
| 434 | `<Label htmlFor="edit-stacking-policy">{t("planOffers.form.stackingPolicy")}</Label>` |
| 447 | `{t("planOffers.form.stackingAllowed")}` |
| 449 | `{t("planOffers.form.stackingDisallowAll")}` |
| 452 | `{t("planOffers.form.stackingDisallowSubscriptionDiscounts")}` |
| 463 | `{t("planOffers.form.stackingPolicyHint")}` |
| 472 | `{t("planOffers.form.trialEnabled")}` |
| 479 | `{t("planOffers.form.trialEnabledHint")}` |
| 503 | `<Label htmlFor="edit-trial-days">{t("planOffers.form.trialDays")}</Label>` |
| 537 | `<Label>{t("planOffers.form.interval")}</Label>` |
| 551 | `{t("common.intervals.week")}` |
| 554 | `{t("common.intervals.month")}` |
| 557 | `{t("common.intervals.year")}` |
| 565 | `<Label>{t("planOffers.form.value")}</Label>` |
| 594 | `{t("planOffers.form.discountForFrequency")}` |
| 601 | `{t("planOffers.form.discountForFrequencyHint")}` |
| 619 | `<Label>{t("planOffers.form.discountType")}</Label>` |
| 635 | `{t("planOffers.form.discountPercentage")}` |
| 638 | `{t("planOffers.form.discountFixed")}` |
| 646 | `<Label>{t("planOffers.form.discountValue")}</Label>` |

Note the ordering difference from the create modal: this file puts Frequencies before Offer rules, so the line numbers interleave differently. Work top to bottom rather than by section.

- [ ] **Step 6: Verify, build, test**

```bash
grep -nE '(header|label|title|placeholder|confirmText|cancelText)(:|=) *"[A-Z]' src/admin/routes/subscriptions/plans-offers/components/edit-plan-offer-drawer.tsx
grep -nE '^\s+[A-Z][A-Za-z ]{3,}$' src/admin/routes/subscriptions/plans-offers/components/edit-plan-offer-drawer.tsx
grep -nE 'message: "[A-Z]' src/admin/routes/subscriptions/plans-offers/components/edit-plan-offer-drawer.tsx
yarn build && yarn test:i18n
```

Expected: the second grep matches only the import list above line 35; the other two return nothing; build and tests green.

- [ ] **Step 7: Verify the full domain in the browser**

In Chinese, open 计划与优惠:

- Page title 计划与优惠, description, 返回订阅列表 button, 新建 button
- Column headers: 名称, 作用对象, 状态, 可选频率, 生效来源, 更新时间
- Status badges 已启用 / 已停用; the 生效来源 column shows 商品 / 变体 / 未生效
- The frequency column still shows English backend labels like `Every month` — expected
- A configuration with more than two frequencies shows 还有 1 项 rather than `+1 more`
- Filters: 状态, 作用范围, 频率
- Row menu: 编辑, 启用 / 停用; confirm the toggle dialog and toast are Chinese
- Open 编辑: all labels Chinese, 作用对象 shows 商品级配置 or 变体级配置, the stacking select offers 允许叠加 / 禁止所有叠加 / 禁止与订阅折扣叠加
- Remove a frequency row and confirm the dialog reads 确认移除此频率？
- Trigger the four validation errors listed in Task 3 Step 9 that apply here (all but variantRequired)

- [ ] **Step 8: Commit**

Propose to the user and wait for approval:

```
feat(i18n): translate edit plan offer drawer
```

```bash
git add src/admin/routes/subscriptions/plans-offers/components/edit-plan-offer-drawer.tsx
git commit -m "feat(i18n): translate edit plan offer drawer"
```

---

## Verification summary

```bash
yarn build && yarn test:i18n && yarn test:integration:http
```

`plan-offers-routes.spec.ts` must stay green without modification. It asserts the English strings `Every month` (line 221), `10% off` (230), `Every 2 months` (306), and `12% off` (320) in API responses — this plan does not touch label generation in `src/modules/plan-offer/utils/admin-query.ts`, so those assertions are unaffected. If they fail, something in the backend was changed by mistake.

## Known remaining English after this plan

- Frequency labels in the Frequencies column and anywhere `frequency.label` is rendered
- Discount labels (`10% off`)
- zod's built-in schema messages, if one fires (see Task 3 Step 2)
