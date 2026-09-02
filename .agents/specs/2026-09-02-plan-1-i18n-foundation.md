# Plan 1: i18n Foundation

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. All browser verification is main-agent-only.

**Goal:** Stand up the complete translation pipeline — namespace, catalogs, a
strong key-literal contract test, the shared translate type, sidebar labels,
breadcrumbs — and prove it by migrating the two smallest admin files.

**Architecture:** The plugin contributes i18next resources through
`src/admin/i18n/index.ts` (default export), which the Medusa admin bundler feeds to
`virtual:medusa/i18n`; the dashboard deep-merges plugin resources over its core
translations and initializes the **default i18next singleton** with
`initReactI18next` and `supportedLngs: Object.keys(resources)` (verified against the
published `@medusajs/dashboard@2.19.0` source). Keys register under the private
`reorder` namespace, never `translation`, so plugin keys cannot shadow dashboard keys.
Components use `useTranslation("reorder")`; module-scope code uses a `translate()`
helper wrapping `getI18n()`. A shared `ReorderTranslate` type avoids importing
`i18next` (an undeclared transitive dependency).

**Tech Stack:** react-i18next 13.5.0 + i18next 23.7.11 (transitive via
`@medusajs/dashboard`, hoisted; no new package.json entries), Jest 29 + `@swc/jest`.

## Global Constraints

- **Prerequisite: Plan 0 accepted** (Medusa 2.19.0, build green).
- English baseline frozen: `en.json` values are byte-for-byte copies of current UI
  text. One disclosed exception: the order widget's `"subscription_discount"`
  fallback (a bug) becomes `subscriptions.orderWidget.noDiscount` = `"No discount"`.
- Key convention `<domain>.<area>.<key>`, lowerCamelCase leaves; `menuItems.<domain>`
  reserved for sidebar labels. Canonical ownership table lives in the plan index —
  `common.fields` owns `sku`, `reason`, `reference`, `customer`, `order`, `email`,
  `createdAt`; no domain redefines them.
- Conventional Commits; exactly one commit at plan end after user approval.
- Language key is `zhCN` (camelCase; the dashboard normalizes camelCase to `zh-CN`
  for locale purposes internally).

## File Structure

| File | Responsibility |
|------|----------------|
| `src/admin/i18n/json/en.json` | English baseline; source of truth for keys |
| `src/admin/i18n/json/zhCN.json` | Simplified Chinese; identical key set |
| `src/admin/i18n/index.ts` | Default-exports `{ en: { reorder: en }, zhCN: { reorder: zhCN } }` |
| `src/admin/i18n/translate.ts` | `translate()` for non-component code + `ReorderTranslate` type |
| `src/admin/i18n/__tests__/translations.spec.ts` | Contract test (Task 2) |
| `jest.config.js`, `package.json` | `TEST_TYPE=i18n` branch + `test:i18n` script |
| `src/admin/i18n/README.md` | Rewritten plugin-specific guide (Task 6) |

---

## Task 1: Catalogs and namespace registration

**Files:**
- Create: `src/admin/i18n/json/en.json`, `src/admin/i18n/json/zhCN.json`
- Modify: `src/admin/i18n/index.ts` (currently `export default {}`)

**Interfaces:**
- Produces: top-level keys `common` and `menuItems` (pilot files extend this in
  Task 4). `index.ts` default export of type `Record<"en" | "zhCN", { reorder: ... }>`.

- [ ] **Step 1: Create en.json (byte-for-byte copies of current UI text)**

```json
{
  "menuItems": {
    "subscriptions": "Subscriptions",
    "planOffers": "Plans & Offers",
    "renewals": "Renewals",
    "dunning": "Dunning",
    "cancellations": "Cancellation & Retention",
    "analytics": "Analytics",
    "activityLog": "Activity Log",
    "settings": "Subscription Settings"
  },
  "common": {
    "actions": {
      "cancel": "Cancel",
      "apply": "Apply",
      "save": "Save",
      "search": "Search"
    },
    "fields": {
      "id": "ID",
      "product": "Product",
      "variant": "Variant",
      "status": "Status",
      "frequency": "Frequency",
      "discount": "Discount",
      "nextRenewal": "Next renewal",
      "subscription": "Subscription",
      "reference": "Reference",
      "customer": "Customer",
      "order": "Order",
      "sku": "SKU",
      "reason": "Reason",
      "email": "Email",
      "createdAt": "Created"
    },
    "filters": {
      "yes": "Yes",
      "no": "No",
      "is": "is",
      "clearAll": "Clear all",
      "clearAllFilters": "Clear all filters"
    },
    "placeholders": {
      "searchProducts": "Search products..."
    },
    "empty": {
      "noValue": "-"
    },
    "intervals": {
      "week": "Weekly",
      "month": "Monthly",
      "year": "Yearly"
    }
  },
  "planOffers": {
    "pickers": {
      "selectProduct": "Select product",
      "selectProductHint": "Search and select the product that this configuration belongs to.",
      "selectVariant": "Select variant",
      "selectVariantHint": "Choose a variant from {{productTitle}}.",
      "selectProductFirst": "Select a product first."
    }
  },
  "subscriptions": {
    "breadcrumb": "Subscription",
    "status": {
      "active": "Active",
      "paused": "Paused",
      "cancelled": "Cancelled",
      "pastDue": "Past due"
    },
    "orderWidget": {
      "title": "Subscription",
      "badge": "Subscription order",
      "loading": "Loading subscription summary...",
      "loadError": "Failed to load subscription summary",
      "oneTimeOrder": "One-time order",
      "noDiscount": "No discount"
    }
  },
  "renewals": { "breadcrumb": "Renewal" },
  "dunning": { "breadcrumb": "Dunning" },
  "cancellations": { "breadcrumb": "Cancellation" }
}
```

All values are copied verbatim from the current UI. `noDiscount` is the single
disclosed fix (the widget currently renders the raw `"subscription_discount"`
identifier — see `src/admin/widgets/order-subscription-summary.tsx:129`).

- [ ] **Step 2: Create zhCN.json (identical structure)**

Same shape; translated values. Terminology baseline (used by every later plan):
订阅=subscription, 续订=renewal, 催收=dunning, 挽留=retention, 商品=product,
变体=variant, 恢复=recovered/payment recovery. Full-width ellipsis `……`; keep
`ID`/`MRR`/`LTV`/`SKU` Latin.

```json
{
  "menuItems": {
    "subscriptions": "订阅",
    "planOffers": "计划与优惠",
    "renewals": "续订",
    "dunning": "催收",
    "cancellations": "取消与挽留",
    "analytics": "数据分析",
    "activityLog": "操作日志",
    "settings": "订阅设置"
  },
  "common": {
    "actions": {
      "cancel": "取消",
      "apply": "应用",
      "save": "保存",
      "search": "搜索"
    },
    "fields": {
      "id": "ID",
      "product": "商品",
      "variant": "变体",
      "status": "状态",
      "frequency": "频率",
      "discount": "折扣",
      "nextRenewal": "下次续订",
      "subscription": "订阅",
      "reference": "订阅编号",
      "customer": "客户",
      "order": "订单",
      "sku": "SKU",
      "reason": "原因",
      "email": "邮箱",
      "createdAt": "创建时间"
    },
    "filters": {
      "yes": "是",
      "no": "否",
      "is": "：",
      "clearAll": "全部清除",
      "clearAllFilters": "清除所有筛选"
    },
    "placeholders": {
      "searchProducts": "搜索商品……"
    },
    "empty": { "noValue": "-" },
    "intervals": {
      "week": "每周",
      "month": "每月",
      "year": "每年"
    }
  },
  "planOffers": {
    "pickers": {
      "selectProduct": "选择商品",
      "selectProductHint": "搜索并选择此配置所属的商品。",
      "selectVariant": "选择变体",
      "selectVariantHint": "从 {{productTitle}} 中选择一个变体。",
      "selectProductFirst": "请先选择商品。"
    }
  },
  "subscriptions": {
    "breadcrumb": "订阅",
    "status": {
      "active": "生效中",
      "paused": "已暂停",
      "cancelled": "已取消",
      "pastDue": "已逾期"
    },
    "orderWidget": {
      "title": "订阅",
      "badge": "订阅订单",
      "loading": "正在加载订阅摘要……",
      "loadError": "加载订阅摘要失败",
      "oneTimeOrder": "一次性订单",
      "noDiscount": "无折扣"
    }
  },
  "renewals": { "breadcrumb": "续订" },
  "dunning": { "breadcrumb": "催收" },
  "cancellations": { "breadcrumb": "取消" }
}
```

- [ ] **Step 3: Register the namespace**

Replace `src/admin/i18n/index.ts` entirely:

```ts
import en from "./json/en.json" with { type: "json" }
import zhCN from "./json/zhCN.json" with { type: "json" }

export default {
  en: {
    reorder: en,
  },
  zhCN: {
    reorder: zhCN,
  },
}
```

- [ ] **Step 4: Build**

```bash
yarn build
```

Expected: success (validates the JSON import attributes and export shape).

## Task 2: Contract test — key-literal scanning, not just t() calls

**Files:**
- Create: `src/admin/i18n/__tests__/translations.spec.ts`
- Modify: `jest.config.js` (TEST_TYPE branches), `package.json` (`test:i18n` script)

**Interfaces:**
- Consumes: Task 1 catalogs.
- Produces: `yarn test:i18n`. The enforcement used by every later plan.

**Design change from Rev 1:** Rev 1 only scanned literal `t("...")` calls, which
missed key maps, zod `message:` values, and route labels. Rev 2 scans **every string
literal** in `src/admin/**` that looks like a translation key (any of the ten
namespace prefixes, single- or double-quoted) — that covers `t()` calls, key-map
values, schema messages, and `defineRouteConfig` labels in one net. It also asserts
namespace registration (`en`+`zhCN` both expose `reorder`) and that all route configs
carry `translationNs: "reorder"`.

- [ ] **Step 1: Write the test**

Create `src/admin/i18n/__tests__/translations.spec.ts`:

```ts
import { readFileSync, readdirSync, statSync } from "fs"
import { join } from "path"

const I18N_DIR = join(__dirname, "..")
const ADMIN_DIR = join(I18N_DIR, "..")

type Tree = { [k: string]: string | Tree }

const en = JSON.parse(readFileSync(join(I18N_DIR, "json/en.json"), "utf-8")) as Tree
const zh = JSON.parse(readFileSync(join(I18N_DIR, "json/zhCN.json"), "utf-8")) as Tree

const PREFIXES = [
  "menuItems", "common", "subscriptions", "planOffers", "renewals",
  "dunning", "cancellations", "activityLog", "analytics", "settings",
]

function flat(tree: Tree, prefix = ""): Array<[string, string]> {
  return Object.entries(tree).flatMap(([k, v]) =>
    typeof v === "object" && v !== null
      ? flat(v, `${prefix}${k}.`)
      : [[`${prefix}${k}`, v as string]]
  )
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      return entry === "__tests__" ? [] : sourceFiles(full)
    }
    return /\.tsx?$/.test(entry) && !entry.endsWith(".d.ts") ? [full] : []
  })
}

const KEY_RE = new RegExp(
  `["'](${PREFIXES.join("|")})(?:\\.[A-Za-z0-9_]+)+["']`,
  "g"
)

function usedKeys(): Array<{ key: string; file: string }> {
  return sourceFiles(ADMIN_DIR).flatMap((file) => {
    const src = readFileSync(file, "utf-8")
    const found: Array<{ key: string; file: string }> = []
    let m: RegExpExecArray | null
    while ((m = KEY_RE.exec(src)) !== null) {
      found.push({ key: m[1], file })
    }
    return found
  })
}

function routeConfigs(): Array<{ file: string; label: string; ns: boolean }> {
  return sourceFiles(join(ADMIN_DIR, "routes"))
    .map((file) => {
      const src = readFileSync(file, "utf-8")
      const label = src.match(/label:\s*"((?:menuItems\.)[A-Za-z0-9_.]+)"/)
      return label
        ? { file, label: label[1], ns: src.includes('translationNs: "reorder"') }
        : null
    })
    .filter((x): x is { file: string; label: string; ns: boolean } => x !== null)
}

describe("translation catalogs", () => {
  it("registers en and zhCN under the reorder namespace", () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require(join(I18N_DIR, "index.ts").replace(/\.ts$/, ""))

    expect(Object.keys(mod.default ?? mod).sort()).toEqual(["en", "zhCN"])
    expect(Object.keys((mod.default ?? mod).en)).toContain("reorder")
    expect(Object.keys((mod.default ?? mod).zhCN)).toContain("reorder")
  })

  it("keeps en and zhCN key sets identical", () => {
    const enKeys = flat(en).map(([k]) => k).sort()
    const zhKeys = flat(zh).map(([k]) => k).sort()

    expect(zhKeys.filter((k) => !enKeys.includes(k))).toEqual([])
    expect(enKeys.filter((k) => !zhKeys.includes(k))).toEqual([])
  })

  it("has no empty values", () => {
    const empty = [...flat(en), ...flat(zh)].filter(
      ([, v]) => typeof v !== "string" || v.trim() === ""
    )

    expect(empty).toEqual([])
  })

  it("resolves every translation-key literal used in src/admin", () => {
    const known = new Set(flat(en).map(([k]) => k))
    const missing = usedKeys()
      .filter(({ key }) => !known.has(key))
      .map(({ key, file }) => `${key} (${file})`)

    expect(missing).toEqual([])
  })

  it("uses translationNs on every sidebar route config", () => {
    const bad = routeConfigs().filter((r) => !r.ns)

    expect(bad.map((r) => r.file)).toEqual([])
  })
})
```

Notes on the design:

- The `require`-based first test reads `index.ts` through swc's jest transform; if the
  JSON import attributes fail to transform in the node environment, fall back to
  re-parsing the two JSON files plus a regex check that `index.ts` contains both
  `en: {` and `zhCN: {` and the string `reorder:` — state which approach was used in
  the PR description.
- Keys referenced through interpolation (`` t(`a.${b}`) ``) are invisible to this
  net; that is why the convention forbids computed keys — every key must appear as a
  full literal somewhere (usually in a `Record` map), which this regex then catches.

- [ ] **Step 2: Wire the jest branch and script**

`jest.config.js` — extend the existing `TEST_TYPE` if/else with:

```js
} else if (process.env.TEST_TYPE === "i18n") {
  config.testMatch = ["**/src/admin/i18n/__tests__/**/*.spec.[jt]s"]
  config.setupFiles = []
}
```

`setupFiles` cleared: the default `integration-tests/setup.js` clears MikroORM
metadata, irrelevant to a file-reading test.

`package.json` — add after `test:integration:modules`:

```json
    "test:i18n": "TEST_TYPE=i18n jest --silent=false",
```

- [ ] **Step 3: Run, then prove it fails**

```bash
yarn test:i18n
```

Expected: 5 passing (no key literals exist in `src/admin` yet; the route-config test
passes trivially over an empty set).

Now append a bogus line to `src/admin/lib/client.ts`:

```ts
export const i18nSelfCheck = () => t("subscriptions.doesNotExist")
```

Run `yarn test:i18n` — expect the key-literal test to FAIL naming
`subscriptions.doesNotExist`. Remove the line, re-run, expect green. A test that has
never failed is not known to work.

- [ ] **Step 4: Run existing suites for isolation**

```bash
yarn test:integration:http
```

Expected: green (24 specs), confirming the jest config edit did not disturb the
integration harness.

## Task 3: Shared translate helper and type

**Files:**
- Create: `src/admin/i18n/translate.ts`

**Interfaces:**
- Produces (used by Plans 2-6):
  - `translate(key: string, options?: Record<string, unknown>): string`
  - `export type ReorderTranslate = ReturnType<typeof useTranslation>["t"]`

- [ ] **Step 1: Create the helper**

```ts
import { getI18n, useTranslation } from "react-i18next"

const NAMESPACE = "reorder"

/** The `t` function bound to the reorder namespace. Plans 2-6 use this type for
 * helper-function parameters instead of importing `TFunction` from `i18next`
 * (which is an undeclared transitive dependency). */
export type ReorderTranslate = ReturnType<typeof useTranslation>["t"]

/**
 * Reads a translation outside a React component, where hooks are unavailable.
 * Falls back to the key itself if the dashboard i18n instance is not ready yet.
 */
export function translate(
  key: string,
  options?: Record<string, unknown>
): string {
  const i18n = getI18n()

  if (!i18n) {
    return key
  }

  return i18n.t(key, { ns: NAMESPACE, ...options })
}
```

The undefined-guard is load-bearing: `getI18n()` returns undefined before the
dashboard initializes i18next, and route modules evaluate at import time.

- [ ] **Step 2: Typecheck the admin layer**

```bash
yarn build
```

Expected: success — including the admin bundle, which validates `ReorderTranslate`
against the real hook return type.

## Task 4: Migrate the two pilot files

**Files:**
- Modify: `src/admin/widgets/order-subscription-summary.tsx` (9 raw JSX strings +
  fields)
- Modify: `src/admin/routes/subscriptions/plans-offers/components/selection-modals.tsx`
  (6 strings)

**Interfaces:**
- Consumes: `common.*`, `planOffers.pickers.*`, `subscriptions.orderWidget.*`,
  `subscriptions.status.*` from Task 1.
- Produces: the `useTranslation("reorder")` component pattern and the
  enum→key-map pattern copied by Plans 2-6.

- [ ] **Step 1: Order widget**

Add `import { useTranslation } from "react-i18next"` and, as the first line of the
component body: `const { t } = useTranslation("reorder")`.

Add next to `getSubscriptionStatusColor`:

```tsx
const SUBSCRIPTION_STATUS_KEYS: Record<SubscriptionAdminStatus, string> = {
  [SubscriptionAdminStatus.ACTIVE]: "subscriptions.status.active",
  [SubscriptionAdminStatus.PAUSED]: "subscriptions.status.paused",
  [SubscriptionAdminStatus.CANCELLED]: "subscriptions.status.cancelled",
  [SubscriptionAdminStatus.PAST_DUE]: "subscriptions.status.pastDue",
};
```

Replace (line refs from current source):

| Line | Current | Becomes |
|------|---------|---------|
| 54 | `<Heading level="h2">Subscription</Heading>` | `{t("subscriptions.orderWidget.title")}` |
| 61 | `Loading subscription summary...` | `{t("subscriptions.orderWidget.loading")}` |
| 66 | `Failed to load subscription summary` | `{t("subscriptions.orderWidget.loadError")}` |
| 70 | `One-time order` | `{t("subscriptions.orderWidget.oneTimeOrder")}` |
| 75 | `Subscription order` | `{t("subscriptions.orderWidget.badge")}` |
| 95 | `Subscription` (card subtitle) | `{t("common.fields.subscription")}` |
| 107 | `Status` | `{t("common.fields.status")}` |
| 112 | `{summary.subscription.status}` (raw enum) | `{t(SUBSCRIPTION_STATUS_KEYS[summary.subscription.status])}` |
| 117 | `Frequency` | `{t("common.fields.frequency")}` |
| 125 | `Discount` | `{t("common.fields.discount")}` |
| 128-130 | `{summary.subscription.discount?.label ?? "subscription_discount"}` | `{summary.subscription.discount?.label ?? t("subscriptions.orderWidget.noDiscount")}` |
| 134 | `Next renewal` | `{t("common.fields.nextRenewal")}` |

`formatDateTime` (lines 31-37) gains an `emptyValue` parameter:

```tsx
const formatDateTime = (value: string | null, emptyValue: string) => {
  if (!value) {
    return emptyValue;
  }

  return new Date(value).toLocaleString();
};
```

Its call site (137-140) passes `t("common.empty.noValue")` as the second argument.

Line 120 `{summary.subscription.frequency_label}` stays — backend label, English.

- [ ] **Step 2: Selection modals**

In both components add the hook after the destructured props.

`PlanOfferProductPickerModal`:

| Line | Current | Becomes |
|------|---------|---------|
| 72 | `header: "Product"` | `header: t("common.fields.product")` |
| 75 | `header: "ID"` | `header: t("common.fields.id")` |
| 116 | `Select product` | `{t("planOffers.pickers.selectProduct")}` |
| 122-123 | hint sentence | `{t("planOffers.pickers.selectProductHint")}` |
| 129 | `placeholder="Search products..."` | `placeholder={t("common.placeholders.searchProducts")}` |
| 142 | `Cancel` | `{t("common.actions.cancel")}` |
| 157 | `Apply` | `{t("common.actions.apply")}` |

`PlanOfferVariantPickerModal`:

| Line | Current | Becomes |
|------|---------|---------|
| 201 | `header: "Variant"` | `header: t("common.fields.variant")` |
| 208 | `row.original.sku || "-"` | `row.original.sku || t("common.empty.noValue")` |
| 239 | `Select variant` | `{t("planOffers.pickers.selectVariant")}` |
| 245-247 | ternary with product title | `{productTitle ? t("planOffers.pickers.selectVariantHint", { productTitle }) : t("planOffers.pickers.selectProductFirst")}` |
| 260 | `Cancel` | `{t("common.actions.cancel")}` |
| 275 | `Apply` | `{t("common.actions.apply")}` |

- [ ] **Step 3: Verify**

```bash
grep -nE '>[A-Z][a-zA-Z ]{3,}<' src/admin/widgets/order-subscription-summary.tsx src/admin/routes/subscriptions/plans-offers/components/selection-modals.tsx
yarn build && yarn test:i18n
```

Expected: no JSX-literal matches; build green; contract test green with ~30 key
literals now under the net.

## Task 5: Sidebar labels and breadcrumbs

**Files:**
- Modify: the 8 files with `defineRouteConfig` and the 11 files with
  `export const handle` (list in Steps 1-2)

**Interfaces:**
- Consumes: `menuItems.*`, `<domain>.breadcrumb` keys; `translate()` from Task 3.
- Produces: route configs with `label: "menuItems.<x>"` + `translationNs: "reorder"`;
  breadcrumbs returning `translate("menuItems.<x>")` or a domain fallback.

- [ ] **Step 1: Route configs (8 files)**

For each, replace the `label` value and add `translationNs: "reorder"`, keeping
`icon`/`rank` exactly as-is:

| File | label key |
|------|-----------|
| `routes/subscriptions/page.tsx` | `menuItems.subscriptions` |
| `routes/subscriptions/plans-offers/page.tsx` | `menuItems.planOffers` |
| `routes/subscriptions/renewals/page.tsx` | `menuItems.renewals` |
| `routes/subscriptions/dunning/page.tsx` | `menuItems.dunning` |
| `routes/subscriptions/cancellations/page.tsx` | `menuItems.cancellations` |
| `routes/subscriptions/analytics/page.tsx` | `menuItems.analytics` |
| `routes/subscriptions/activity-log/page.tsx` | `menuItems.activityLog` |
| `routes/settings/subscription-settings/page.tsx` | `menuItems.settings` |

- [ ] **Step 2: Breadcrumbs (11 files)**

Add `import { translate } from "<rel>/i18n/translate"` (relative depth: one level
deeper for `[id]` pages — `../../../` from list pages, `../../../../` from `[id]`
pages).

List pages (7): the breadcrumb becomes `translate("menuItems.<same key as above>")`.

Detail pages (4), translating only the fallback:

| File | Fallback |
|------|----------|
| `subscriptions/[id]/page.tsx` | `translate("subscriptions.breadcrumb")` |
| `renewals/[id]/page.tsx` | `translate("renewals.breadcrumb")` |
| `dunning/[id]/page.tsx` | `translate("dunning.breadcrumb")` |
| `cancellations/[id]/page.tsx` | `translate("cancellations.breadcrumb")` |

Data-driven parts (`data?.subscription?.reference`, `params?.id`) stay untouched.

- [ ] **Step 3: Verify**

```bash
grep -rn 'label: "menuItems\.' src/admin --include="*.tsx" | wc -l
grep -rn 'translationNs: "reorder"' src/admin --include="*.tsx" | wc -l
grep -rnE 'breadcrumb: \(\) => "[A-Z]' src/admin --include="*.tsx"
yarn build && yarn test:i18n
```

Expected: 8, 8, no output, build + contract test green (route-label keys are now
enforced by the contract test, not by eyeball).

## Task 6: README rewrite and browser gate

**Files:**
- Modify: `src/admin/i18n/README.md` (replace the stock Medusa example)

- [ ] **Step 1: Rewrite the README**

Document: files and their roles; the `reorder` namespace and why not `translation`;
key naming and canonical `common.fields` ownership; `useTranslation("reorder")` in
components vs `translate()` outside; `ReorderTranslate` for helper signatures and why
`TFunction` from `i18next` is not imported; `defineRouteConfig` +
`translationNs: "reorder"`; interpolation via `{{var}}` (no string concatenation);
`yarn test:i18n` and what the five tests enforce; the deliberate-exceptions list from
the plan index; the frozen-English rule (en.json values are byte-for-byte copies of
existing UI text).

- [ ] **Step 2: Browser gate (main agent only)**

This replaces Rev 1's unusable local-dev instruction. Environment is Windows; the
`local-dev` skill's script and paths are macOS-only and there is no adjacent Medusa
backend in this workspace. Therefore:

1. Ask the user how to verify: (a) their deployed Medusa 2.19 Admin URL + test
   account, (b) a Windows-adapted local dev setup they want prepared (separate task),
   or (c) skip browser verification this plan and rely on Task 6 of a later plan once
   an environment exists.
2. If (a) or (b): open the admin, confirm the eight sidebar items show English
   correctly (no `menuItems.*` literals), switch the profile language to 简体中文,
   confirm the sidebar switches to the Chinese labels, and confirm the two pilot
   surfaces (order subscription summary widget; plan-offer pickers) render Chinese —
   including the interpolated variant hint and the widget status badge 生效中 (not
   the raw `active` enum).
3. Record the chosen option in the PR description. If (c): Plans 2+ may proceed only
   with the user's explicit acknowledgement that UI rendering is unverified until a
   browser gate runs.

## Completion: single commit

Summary + proposed message (wait for approval):

```
feat(i18n): add reorder translation namespace, contract test, sidebar labels, and pilot screens
```
