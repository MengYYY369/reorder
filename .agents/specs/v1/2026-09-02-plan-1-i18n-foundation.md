# Plan 1: i18n Foundation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the whole Simplified Chinese translation pipeline end to end — namespace, JSON files, an enforcing contract test, sidebar labels, breadcrumbs — and prove it by fully migrating the two smallest admin files.

**Architecture:** Medusa's admin dashboard owns the i18next instance; a plugin contributes resources by default-exporting a language map from `src/admin/i18n/index.ts`, which the bundler picks up through its `virtual:medusa/i18n` module. Translations register under a private namespace `reorder` rather than the default `translation` namespace, so plugin keys can never collide with or silently override Medusa's built-in admin keys. Components read them with `useTranslation("reorder")`. Code that runs outside a React component (breadcrumb functions) reads them through a small helper wrapping `getI18n()`.

**Tech Stack:** react-i18next 13.5.0 and i18next 23.7.11 (both already resolved in `yarn.lock` as transitive dependencies of `@medusajs/dashboard`, and `.npmrc` already lists `public-hoist-pattern[]=react-i18next`), Jest 29 + `@swc/jest` for the contract test.

## Global Constraints

- **Prerequisite: Plan 0 is complete.** Medusa is on `2.19.0` and `yarn build` is green.
- All code, comments, JSON keys, docs, and commit messages in English (`.agents/AGENTS.md`). Chinese appears only as JSON *values* in `zhCN.json`, which is translated content, not code.
- Commit messages use Conventional Commits `type(scope): description`. Propose the message and wait for explicit user approval before committing or pushing.
- Namespace is exactly `reorder`. Never register under `translation`.
- Language key is exactly `zhCN` — camelCase, no hyphen or underscore. This matches Medusa's own convention (`enGB`, `ptBR`, `ptPT`, `zhTW`); the dashboard's i18n provider converts camelCase to a hyphenated locale internally via `code.replace(/([a-z])([A-Z])/g, "$1-$2")`, so `zh-CN` as a key would break that.
- Do not add new packages to `package.json` without asking the user. This plan adds no packages.
- Never touch backend label generation. See the "Out of scope" section of the plan index.
- Do not refactor unrelated files.

## Key naming convention

Every later plan follows this, so it is normative here.

```
<domain>.<area>.<key>
```

- `domain` is one of `subscriptions`, `planOffers`, `renewals`, `dunning`, `cancellations`, `activityLog`, `analytics`, `settings`, or `common` for strings genuinely shared across domains.
- `area` groups by purpose: `columns`, `filters`, `actions`, `fields`, `status`, `toast`, `prompt`, `sections`, `errors`, `empty`.
- `key` is lowerCamelCase derived from the English text.
- `menuItems.<domain>` is reserved for sidebar labels (matches the example in the `@medusajs/admin-sdk` `RouteConfig.translationNs` docblock).

Examples: `subscriptions.status.active`, `dunning.toast.retryStarted`, `common.actions.cancel`.

Put a string in `common` only when at least two domains use it with the same meaning. `Cancel` the button and `Cancel subscription` the action are different strings — the first is `common.actions.cancel`, the second is `subscriptions.actions.cancel`. Getting this wrong produces a mistranslation that no test can catch, so when in doubt, keep it domain-scoped.

## File Structure

| File | Responsibility |
|------|----------------|
| `src/admin/i18n/json/en.json` | English baseline. Every key the plugin uses, in nesting order. Source of truth for key existence. |
| `src/admin/i18n/json/zhCN.json` | Simplified Chinese. Identical key set to `en.json`, Chinese values. |
| `src/admin/i18n/index.ts` | Default-exports `{ en: { reorder: en }, zhCN: { reorder: zhCN } }`. Replaces the current `export default {}`. |
| `src/admin/i18n/translate.ts` | `translate(key, options?)` — namespace-bound lookup for non-component code (breadcrumbs). |
| `src/admin/i18n/README.md` | Rewritten: how this plugin does i18n, not the generic Medusa example. |
| `src/admin/i18n/__tests__/translations.spec.ts` | Contract test: key parity, no empty values, no missing keys. |
| `jest.config.js` | New `TEST_TYPE=i18n` branch so the contract test can run. |

Splitting `en.json` per domain was considered and rejected: `index.ts` would need to deep-merge eight files, and i18next already namespaces by the top-level domain key. One file per language, nested by domain, keeps the parity test trivial.

---

## Task 1: Create the translation files and register the namespace

**Files:**
- Create: `src/admin/i18n/json/en.json`
- Create: `src/admin/i18n/json/zhCN.json`
- Modify: `src/admin/i18n/index.ts` (currently the single line `export default {}`)

**Interfaces:**
- Consumes: nothing (first task).
- Produces:
  - `src/admin/i18n/index.ts` default export of type `Record<string, { reorder: object }>` with keys `en` and `zhCN`. The Medusa admin bundler consumes this; no plugin code imports it.
  - `en.json` / `zhCN.json` with top-level keys `common` and `menuItems`. Tasks 2-5 and Plans 2-6 add sibling domain keys.

- [ ] **Step 1: Confirm the starting state**

```bash
cat src/admin/i18n/index.ts && ls src/admin/i18n/
```

Expected: `export default {}` and two entries (`README.md`, `index.ts`). There is no `json/` directory yet.

- [ ] **Step 2: Create the English baseline**

Create `src/admin/i18n/json/en.json`. This covers the sidebar labels (all 8 routes), the 11 breadcrumbs, and the strings in the two files Task 5 migrates:

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
      "apply": "Apply"
    },
    "fields": {
      "id": "ID",
      "product": "Product",
      "variant": "Variant",
      "status": "Status",
      "frequency": "Frequency",
      "discount": "Discount",
      "nextRenewal": "Next renewal",
      "subscription": "Subscription"
    },
    "placeholders": {
      "searchProducts": "Search products..."
    },
    "empty": {
      "noValue": "-"
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
    "orderWidget": {
      "title": "Subscription",
      "badge": "Subscription order",
      "loading": "Loading subscription summary...",
      "loadError": "Failed to load subscription summary",
      "oneTimeOrder": "One-time order",
      "noDiscount": "No discount"
    }
  },
  "renewals": {
    "breadcrumb": "Renewal"
  },
  "dunning": {
    "breadcrumb": "Dunning"
  },
  "cancellations": {
    "breadcrumb": "Cancellation"
  }
}
```

Two notes on specific entries. `common.empty.noValue` is the `"-"` placeholder that eleven `formatDateTime` helpers return for null dates — routing it through i18n now means later plans do not each invent their own. And `subscriptions.orderWidget.noDiscount` replaces the current fallback in `order-subscription-summary.tsx:129`, which renders the literal string `"subscription_discount"` — that is a bug visible to users today, and Task 5 fixes it as part of the migration.

- [ ] **Step 3: Create the Simplified Chinese file**

Create `src/admin/i18n/json/zhCN.json` with the identical key structure:

```json
{
  "menuItems": {
    "subscriptions": "订阅",
    "planOffers": "计划与优惠",
    "renewals": "续订",
    "dunning": "催款",
    "cancellations": "取消与挽留",
    "analytics": "数据分析",
    "activityLog": "操作日志",
    "settings": "订阅设置"
  },
  "common": {
    "actions": {
      "cancel": "取消",
      "apply": "应用"
    },
    "fields": {
      "id": "ID",
      "product": "商品",
      "variant": "变体",
      "status": "状态",
      "frequency": "频率",
      "discount": "折扣",
      "nextRenewal": "下次续订",
      "subscription": "订阅"
    },
    "placeholders": {
      "searchProducts": "搜索商品……"
    },
    "empty": {
      "noValue": "-"
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
    "orderWidget": {
      "title": "订阅",
      "badge": "订阅订单",
      "loading": "正在加载订阅摘要……",
      "loadError": "加载订阅摘要失败",
      "oneTimeOrder": "一次性订单",
      "noDiscount": "无折扣"
    }
  },
  "renewals": {
    "breadcrumb": "续订"
  },
  "dunning": {
    "breadcrumb": "催款"
  },
  "cancellations": {
    "breadcrumb": "取消"
  }
}
```

Translation conventions to carry into every later plan: use `订阅` for subscription, `续订` for renewal, `催款` for dunning, `挽留` for retention, `商品` for product, `变体` for variant. Use the full-width ellipsis `……` in Chinese, not `...`. Keep `ID`, `MRR`, `LTV`, and `SKU` as Latin — translating them hurts more than it helps.

- [ ] **Step 4: Register both languages under the `reorder` namespace**

Replace the entire contents of `src/admin/i18n/index.ts`:

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

The `with { type: "json" }` import attribute is what Medusa's documentation specifies for these files; `tsconfig.json:18` already sets `resolveJsonModule: true`.

`reorder` here is the namespace, not the default `translation`. That is deliberate: under `translation`, any key matching a Medusa built-in would silently override the dashboard's own string.

- [ ] **Step 5: Verify both JSON files parse and have identical key sets**

```bash
node -e "
const a=require('./src/admin/i18n/json/en.json');
const b=require('./src/admin/i18n/json/zhCN.json');
const flat=(o,p='')=>Object.entries(o).flatMap(([k,v])=>
  v&&typeof v==='object'?flat(v,p+k+'.'):[p+k]);
const ka=flat(a).sort(), kb=flat(b).sort();
console.log('en keys:', ka.length, 'zhCN keys:', kb.length);
const onlyEn=ka.filter(k=>!kb.includes(k));
const onlyZh=kb.filter(k=>!ka.includes(k));
console.log('only in en:', onlyEn);
console.log('only in zhCN:', onlyZh);
if(onlyEn.length||onlyZh.length) process.exit(1);
console.log('PARITY OK');
"
```

Expected: both counts equal (33), both `only in` arrays empty, and `PARITY OK`. Task 2 makes this permanent as a real test; this step is the immediate check.

- [ ] **Step 6: Build**

```bash
yarn build
```

Expected: success. This confirms the bundler accepts the `with { type: "json" }` import attributes and the new `index.ts` shape. A failure here is about module syntax, not translations.

- [ ] **Step 7: Commit**

Propose to the user and wait for approval:

```
feat(i18n): add en and zhCN translation resources under reorder namespace
```

```bash
git add src/admin/i18n
git commit -m "feat(i18n): add en and zhCN translation resources under reorder namespace"
```

---

## Task 2: Add the translation contract test

**Files:**
- Create: `src/admin/i18n/__tests__/translations.spec.ts`
- Modify: `jest.config.js:26-30` (the `TEST_TYPE` branch block)
- Modify: `package.json:35-36` (add a test script)

**Interfaces:**
- Consumes: `en.json` and `zhCN.json` from Task 1.
- Produces: `yarn test:i18n` as a runnable command. Every subsequent task in this plan and every task in Plans 2-6 uses it as their verification gate.

**Why this task exists and why it comes second:** there is no React test harness in this repo — `jest.config.js` sets `testEnvironment: "node"` and `testMatch` only ever points at `integration-tests/http/` or `src/modules/*/__tests__/`. So no test can render a component and assert on Chinese text. What *can* be tested in a node environment is the thing that actually breaks during a large mechanical migration: a `t("some.key")` call whose key was never added to the JSON. i18next does not throw on a missing key — it silently renders the key string itself, so `subscriptions.status.active` appears in the UI where `Active` should be. That failure is invisible to `yarn build` and to every existing test. This test catches it.

- [ ] **Step 1: Write the failing test**

Create `src/admin/i18n/__tests__/translations.spec.ts`:

```ts
import { readFileSync, readdirSync, statSync } from "fs"
import { join } from "path"

const I18N_DIR = join(__dirname, "..")
const ADMIN_DIR = join(I18N_DIR, "..")

type TranslationTree = { [key: string]: string | TranslationTree }

const en = JSON.parse(
  readFileSync(join(I18N_DIR, "json/en.json"), "utf-8")
) as TranslationTree
const zhCN = JSON.parse(
  readFileSync(join(I18N_DIR, "json/zhCN.json"), "utf-8")
) as TranslationTree

function flattenKeys(tree: TranslationTree, prefix = ""): string[] {
  return Object.entries(tree).flatMap(([key, value]) =>
    typeof value === "object" && value !== null
      ? flattenKeys(value, `${prefix}${key}.`)
      : [`${prefix}${key}`]
  )
}

function flattenEntries(
  tree: TranslationTree,
  prefix = ""
): Array<[string, string]> {
  return Object.entries(tree).flatMap(([key, value]) =>
    typeof value === "object" && value !== null
      ? flattenEntries(value, `${prefix}${key}.`)
      : ([[`${prefix}${key}`, value as string]] as Array<[string, string]>)
  )
}

function collectSourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry)

    if (statSync(full).isDirectory()) {
      return entry === "__tests__" ? [] : collectSourceFiles(full)
    }

    return /\.tsx?$/.test(entry) && !entry.endsWith(".d.ts") ? [full] : []
  })
}

function collectUsedKeys(): Array<{ key: string; file: string }> {
  const pattern = /\bt\(\s*"([a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)+)"/g

  return collectSourceFiles(ADMIN_DIR).flatMap((file) => {
    const source = readFileSync(file, "utf-8")
    const found: Array<{ key: string; file: string }> = []
    let match: RegExpExecArray | null

    while ((match = pattern.exec(source)) !== null) {
      found.push({ key: match[1], file })
    }

    return found
  })
}

describe("translation resources", () => {
  it("has identical key sets in en and zhCN", () => {
    const enKeys = flattenKeys(en).sort()
    const zhKeys = flattenKeys(zhCN).sort()

    expect(zhKeys.filter((key) => !enKeys.includes(key))).toEqual([])
    expect(enKeys.filter((key) => !zhKeys.includes(key))).toEqual([])
  })

  it("has no empty values", () => {
    const empty = [
      ...flattenEntries(en).map(([k, v]) => ["en", k, v] as const),
      ...flattenEntries(zhCN).map(([k, v]) => ["zhCN", k, v] as const),
    ].filter(([, , value]) => typeof value !== "string" || value.trim() === "")

    expect(empty).toEqual([])
  })

  it("resolves every literal t() key used in src/admin", () => {
    const enKeys = new Set(flattenKeys(en))
    const missing = collectUsedKeys()
      .filter(({ key }) => !enKeys.has(key))
      .map(({ key, file }) => `${key} (${file})`)

    expect(missing).toEqual([])
  })
})
```

Two deliberate limitations, so nobody is surprised later. The regex only matches literal single-quoted-free `t("...")` calls, so a computed key like `t(\`subscriptions.status.${status}\`)` is invisible to it — that is exactly why later plans specify explicit key maps instead of template literals. And it requires at least one dot in the key, which is why the convention mandates `<domain>.<area>.<key>` and forbids bare top-level keys.

- [ ] **Step 2: Add the jest branch**

`jest.config.js` currently ends with an if/else that only handles two `TEST_TYPE` values, and neither `testMatch` would pick up a spec under `src/admin/`. Add a third branch. Replace lines 26-30:

```js
if (process.env.TEST_TYPE === "integration:http") {
  config.testMatch = ["**/integration-tests/http/*.spec.[jt]s"]
} else if (process.env.TEST_TYPE === "integration:modules") {
  config.testMatch = ["**/src/modules/*/__tests__/**/*.spec.[jt]s"]
} else if (process.env.TEST_TYPE === "i18n") {
  config.testMatch = ["**/src/admin/i18n/__tests__/**/*.spec.[jt]s"]
  config.setupFiles = []
}
```

`setupFiles` is cleared for this branch on purpose: the default `./integration-tests/setup.js` calls `MetadataStorage.clear()` from MikroORM, which the contract test has no use for and which pulls the framework into a test that only reads files.

- [ ] **Step 3: Add the test script**

In `package.json`, add a line after the `test:integration:modules` script at line 36 (remember the comma on the preceding line):

```json
    "test:i18n": "TEST_TYPE=i18n jest --silent=false"
```

No `--runInBand` or `--forceExit` here — unlike the integration suites, this test opens no database connection and no HTTP server.

- [ ] **Step 4: Run the test to verify it passes**

```bash
yarn test:i18n
```

Expected: 3 passing tests.

This is the one place in the plan where a passing test on first run is correct rather than suspicious: Task 1 already created valid, in-parity JSON, and no `t()` calls exist in `src/admin` yet, so the third test passes over an empty set. The test's value is in Tasks 3-5, where it starts failing the moment a key is used but not declared.

- [ ] **Step 5: Prove the test actually fails when it should**

A test that has never failed is not yet known to work. Temporarily add a bogus key to a real file — append this to `src/admin/lib/client.ts`:

```ts
export const i18nSelfCheck = () => t("subscriptions.thisKeyDoesNotExist")
```

Then run:

```bash
yarn test:i18n
```

Expected: FAIL on "resolves every literal t() key used in src/admin", with `subscriptions.thisKeyDoesNotExist` and the `client.ts` path in the diff.

Now remove those two lines from `src/admin/lib/client.ts` and re-run:

```bash
yarn test:i18n
```

Expected: 3 passing again, and `git diff src/admin/lib/client.ts` shows nothing.

- [ ] **Step 6: Commit**

Propose to the user and wait for approval:

```
test(i18n): add translation key parity and usage contract test
```

```bash
git add src/admin/i18n/__tests__ jest.config.js package.json
git commit -m "test(i18n): add translation key parity and usage contract test"
```

---

## Task 3: Translate the sidebar labels

**Files:**
- Modify: `src/admin/routes/subscriptions/page.tsx:833-836`
- Modify: `src/admin/routes/subscriptions/plans-offers/page.tsx:849-852`
- Modify: `src/admin/routes/subscriptions/renewals/page.tsx:548-551`
- Modify: `src/admin/routes/subscriptions/dunning/page.tsx:583-586`
- Modify: `src/admin/routes/subscriptions/cancellations/page.tsx:523-526`
- Modify: `src/admin/routes/subscriptions/analytics/page.tsx:497-500`
- Modify: `src/admin/routes/subscriptions/activity-log/page.tsx:779-781`
- Modify: `src/admin/routes/settings/subscription-settings/page.tsx:651-653`

**Interfaces:**
- Consumes: `menuItems.*` keys from Task 1's `en.json` / `zhCN.json`.
- Produces: nothing other code imports. Each file's `export const config` keeps its existing shape plus one property.

**How this works:** `RouteConfig` in `@medusajs/admin-sdk@2.19.0` has a `translationNs?: string` property. Its docblock states: *"An optional i18n namespace for translating the label. When provided, the label will be treated as a translation key."* The example given is `label: "menuItems.customFeature"` with `translationNs: "my-plugin"`, resolving as `t("menuItems.customFeature", { ns: "my-plugin" })`. Confirmed present in the 2.19.0 type definitions.

This is the only mechanism available here — sidebar labels are read at module scope by the bundler, outside any React tree, so `useTranslation` cannot reach them.

- [ ] **Step 1: Convert the eight route configs**

Each edit replaces the string `label` with a key and adds `translationNs: "reorder"`. Preserve every other property exactly, including `icon`, `rank`, and each file's existing semicolon style (some files use semicolons, some do not — match the file).

`src/admin/routes/subscriptions/page.tsx:833-836`:

```tsx
export const config = defineRouteConfig({
  label: "menuItems.subscriptions",
  translationNs: "reorder",
  icon: Calendar,
});
```

`src/admin/routes/subscriptions/plans-offers/page.tsx:849-852`:

```tsx
export const config = defineRouteConfig({
  label: "menuItems.planOffers",
  translationNs: "reorder",
  rank: 1,
});
```

`src/admin/routes/subscriptions/renewals/page.tsx:548-551`:

```tsx
export const config = defineRouteConfig({
  label: "menuItems.renewals",
  translationNs: "reorder",
  rank: 2,
});
```

`src/admin/routes/subscriptions/dunning/page.tsx:583-586`:

```tsx
export const config = defineRouteConfig({
  label: "menuItems.dunning",
  translationNs: "reorder",
  rank: 3,
})
```

`src/admin/routes/subscriptions/cancellations/page.tsx:523-526`:

```tsx
export const config = defineRouteConfig({
  label: "menuItems.cancellations",
  translationNs: "reorder",
  rank: 4,
})
```

`src/admin/routes/subscriptions/analytics/page.tsx:497-500`:

```tsx
export const config = defineRouteConfig({
  label: "menuItems.analytics",
  translationNs: "reorder",
  rank: 5,
})
```

`src/admin/routes/subscriptions/activity-log/page.tsx:779-781`:

```tsx
export const config = defineRouteConfig({
  label: "menuItems.activityLog",
  translationNs: "reorder",
})
```

`src/admin/routes/settings/subscription-settings/page.tsx:651-653`:

```tsx
export const config = defineRouteConfig({
  label: "menuItems.settings",
  translationNs: "reorder",
})
```

- [ ] **Step 2: Verify all eight were converted and none were missed**

```bash
grep -rn "label: \"menuItems\." src/admin --include="*.tsx" | wc -l
grep -rn "translationNs: \"reorder\"" src/admin --include="*.tsx" | wc -l
grep -rn -A2 "defineRouteConfig({" src/admin --include="*.tsx" | grep "label: \"[A-Z]"
```

Expected: `8`, `8`, and no output from the third command. The third is the real check — it finds any `label` still holding a capitalized English string, which means a route was missed.

- [ ] **Step 3: Build**

```bash
yarn build
```

Expected: success. A TypeScript error naming `translationNs` would mean the installed `@medusajs/admin-sdk` predates the property — check that Plan 0 actually landed 2.19.0 before doing anything else.

- [ ] **Step 4: Run the contract test**

```bash
yarn test:i18n
```

Expected: 3 passing. The `menuItems.*` keys already exist from Task 1. Note that the third test does not cover these — they are `label:` strings, not `t()` calls — so a typo like `menuItems.subscription` would slip through here and surface as literal key text in the sidebar. Step 2's third grep is what guards this; read the eight keys against `en.json` once by eye.

- [ ] **Step 5: Commit**

Propose to the user and wait for approval:

```
feat(i18n): translate admin sidebar labels via translationNs
```

```bash
git add src/admin/routes
git commit -m "feat(i18n): translate admin sidebar labels via translationNs"
```

---

## Task 4: Add the non-component translate helper and convert breadcrumbs

**Files:**
- Create: `src/admin/i18n/translate.ts`
- Modify: `src/admin/routes/subscriptions/page.tsx:838-840`
- Modify: `src/admin/routes/subscriptions/[id]/page.tsx:2251-2254`
- Modify: `src/admin/routes/subscriptions/plans-offers/page.tsx:854-856`
- Modify: `src/admin/routes/subscriptions/renewals/page.tsx:553-555`
- Modify: `src/admin/routes/subscriptions/renewals/[id]/page.tsx:695-698`
- Modify: `src/admin/routes/subscriptions/dunning/page.tsx:588-590`
- Modify: `src/admin/routes/subscriptions/dunning/[id]/page.tsx:901-904`
- Modify: `src/admin/routes/subscriptions/cancellations/page.tsx:528-530`
- Modify: `src/admin/routes/subscriptions/cancellations/[id]/page.tsx:1389-1392`
- Modify: `src/admin/routes/subscriptions/analytics/page.tsx:502-504`
- Modify: `src/admin/routes/subscriptions/activity-log/page.tsx:783-785`

**Interfaces:**
- Consumes: `menuItems.*` and `<domain>.breadcrumb` keys from Task 1.
- Produces: `translate(key: string, options?: Record<string, unknown>): string` exported from `src/admin/i18n/translate.ts`. Plans 2-6 use this for any string produced outside a React component. Component code must keep using `useTranslation("reorder")` — `translate` is not a general-purpose replacement, it is a fallback for module-scope code.

**Why a helper rather than `useTranslation`:** `export const handle = { breadcrumb: () => "..." }` is a plain function invoked by the router, not a hook call inside a component render. React's rules forbid `useTranslation` there. react-i18next exports `getI18n()`, which returns the live instance the dashboard initialized, and that works from anywhere.

- [ ] **Step 1: Create the helper**

Create `src/admin/i18n/translate.ts`:

```ts
import { getI18n } from "react-i18next"

const NAMESPACE = "reorder"

/**
 * Reads a translation outside a React component, where hooks are unavailable.
 * Falls back to the key itself if the dashboard i18n instance is not ready.
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

The null guard is not defensive padding: `getI18n()` returns undefined if called before the dashboard mounts its provider, and route modules are evaluated at import time. Without the guard a breadcrumb can throw during startup.

- [ ] **Step 2: Convert the four list-page breadcrumbs and three more static ones**

Seven breadcrumbs return a constant that duplicates the sidebar label, so they reuse the `menuItems.*` keys.

`src/admin/routes/subscriptions/page.tsx:838-840`:

```tsx
export const handle = {
  breadcrumb: () => translate("menuItems.subscriptions"),
};
```

`src/admin/routes/subscriptions/plans-offers/page.tsx:854-856`:

```tsx
export const handle = {
  breadcrumb: () => translate("menuItems.planOffers"),
};
```

`src/admin/routes/subscriptions/renewals/page.tsx:553-555`:

```tsx
export const handle = {
  breadcrumb: () => translate("menuItems.renewals"),
};
```

`src/admin/routes/subscriptions/dunning/page.tsx:588-590`:

```tsx
export const handle = {
  breadcrumb: () => translate("menuItems.dunning"),
}
```

`src/admin/routes/subscriptions/cancellations/page.tsx:528-530`:

```tsx
export const handle = {
  breadcrumb: () => translate("menuItems.cancellations"),
}
```

`src/admin/routes/subscriptions/analytics/page.tsx:502-504`:

```tsx
export const handle = {
  breadcrumb: () => translate("menuItems.analytics"),
}
```

`src/admin/routes/subscriptions/activity-log/page.tsx:783-785`:

```tsx
export const handle = {
  breadcrumb: () => translate("menuItems.activityLog"),
}
```

- [ ] **Step 3: Convert the four detail-page breadcrumbs**

These take a `UIMatch` argument and fall back to a constant only when the record is unavailable. Keep the data-driven part — an ID or a reference is not translatable — and translate only the fallback.

`src/admin/routes/subscriptions/[id]/page.tsx:2251-2254`:

```tsx
export const handle = {
  breadcrumb: ({ data }: UIMatch<SubscriptionAdminDetailResponse>) =>
    data?.subscription?.reference || translate("subscriptions.breadcrumb"),
};
```

`src/admin/routes/subscriptions/renewals/[id]/page.tsx:695-698`:

```tsx
export const handle = {
  breadcrumb: ({ params, data }: UIMatch<RenewalCycleAdminDetailResponse>) =>
    params?.id || data?.renewal?.id || translate("renewals.breadcrumb"),
};
```

`src/admin/routes/subscriptions/dunning/[id]/page.tsx:901-904`:

```tsx
export const handle = {
  breadcrumb: ({ params, data }: UIMatch<DunningCaseAdminDetailResponse>) =>
    params?.id || data?.dunning_case?.id || translate("dunning.breadcrumb"),
}
```

`src/admin/routes/subscriptions/cancellations/[id]/page.tsx:1389-1392`:

```tsx
export const handle = {
  breadcrumb: ({ params, data }: UIMatch<CancellationCaseAdminDetailResponse>) =>
    params?.id || data?.cancellation?.id || translate("cancellations.breadcrumb"),
}
```

- [ ] **Step 4: Add the import to all eleven files**

Each modified file needs `translate` imported. The relative depth differs by directory — get this wrong and the build fails with an unresolved module, which is at least a loud failure.

- `routes/subscriptions/page.tsx` → `import { translate } from "../../i18n/translate";`
- `routes/subscriptions/[id]/page.tsx` → `import { translate } from "../../../i18n/translate";`
- `routes/subscriptions/plans-offers/page.tsx` → `import { translate } from "../../../i18n/translate";`
- `routes/subscriptions/renewals/page.tsx` → `import { translate } from "../../../i18n/translate";`
- `routes/subscriptions/renewals/[id]/page.tsx` → `import { translate } from "../../../../i18n/translate";`
- `routes/subscriptions/dunning/page.tsx` → `import { translate } from "../../../i18n/translate"`
- `routes/subscriptions/dunning/[id]/page.tsx` → `import { translate } from "../../../../i18n/translate"`
- `routes/subscriptions/cancellations/page.tsx` → `import { translate } from "../../../i18n/translate"`
- `routes/subscriptions/cancellations/[id]/page.tsx` → `import { translate } from "../../../../i18n/translate"`
- `routes/subscriptions/analytics/page.tsx` → `import { translate } from "../../../i18n/translate"`
- `routes/subscriptions/activity-log/page.tsx` → `import { translate } from "../../../i18n/translate"`

Place each next to the file's other relative imports and match its semicolon style.

- [ ] **Step 5: Verify no breadcrumb still returns a literal**

```bash
grep -rn "breadcrumb:" src/admin --include="*.tsx" | grep -c "translate("
grep -rn "breadcrumb: () => \"" src/admin --include="*.tsx"
grep -rn "|| \"[A-Z]" src/admin --include="*.tsx" | grep -i breadcrumb
```

Expected: `11`, then no output from either of the last two commands.

- [ ] **Step 6: Build and test**

```bash
yarn build && yarn test:i18n
```

Expected: build succeeds, 3 tests pass.

The contract test now genuinely covers something: `translate("...")` matches the test's `\bt\(` regex boundary check? No — it does not, because the function is named `translate`, not `t`. Widen the regex in `src/admin/i18n/__tests__/translations.spec.ts` to catch both. Change the `pattern` line in `collectUsedKeys` to:

```ts
  const pattern = /\b(?:t|translate)\(\s*"([a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)+)"/g
```

Then re-run `yarn test:i18n` and expect 3 passing with the 11 breadcrumb keys now actually verified against `en.json`.

- [ ] **Step 7: Commit**

Propose to the user and wait for approval:

```
feat(i18n): translate route breadcrumbs via namespace-bound helper
```

```bash
git add src/admin/i18n src/admin/routes
git commit -m "feat(i18n): translate route breadcrumbs via namespace-bound helper"
```

---

## Task 5: Migrate the two smallest files end to end

**Files:**
- Modify: `src/admin/widgets/order-subscription-summary.tsx` (155 lines, 2 unique strings)
- Modify: `src/admin/routes/subscriptions/plans-offers/components/selection-modals.tsx` (283 lines, 6 unique strings)
- Modify: `src/admin/i18n/json/en.json` (add `subscriptions.status.*`)
- Modify: `src/admin/i18n/json/zhCN.json` (same keys)

**Interfaces:**
- Consumes: `common.*`, `planOffers.pickers.*`, `subscriptions.orderWidget.*` from Task 1; `translate` is *not* used here (both files are React components, so both use the hook).
- Produces:
  - `subscriptions.status.active` / `.paused` / `.cancelled` / `.pastDue` in both JSON files. **Plan 2 consumes these** for `formatStatus` in `subscriptions/page.tsx` and the subscription detail page — do not redefine them there.
  - The `useTranslation("reorder")` call pattern that Plans 2-6 copy.

**Why these two files:** they are the smallest (2 and 6 unique strings) and between them exercise every mechanism the later plans need — a plain lookup, an interpolated value, a status enum mapped to a key, and a component that is a widget rather than a route. If Chinese appears in these two after switching the admin language, the pipeline is proven and Plans 2-6 are mechanical.

- [ ] **Step 1: Add the status keys to both JSON files**

Add to `src/admin/i18n/json/en.json` inside the existing `subscriptions` object, as a sibling of `breadcrumb` and `orderWidget`:

```json
    "status": {
      "active": "Active",
      "paused": "Paused",
      "cancelled": "Cancelled",
      "pastDue": "Past due"
    },
```

And the same position in `src/admin/i18n/json/zhCN.json`:

```json
    "status": {
      "active": "生效中",
      "paused": "已暂停",
      "cancelled": "已取消",
      "pastDue": "已逾期"
    },
```

- [ ] **Step 2: Run the test to confirm parity still holds**

```bash
yarn test:i18n
```

Expected: 3 passing. If the first test fails, one file got the keys and the other did not.

- [ ] **Step 3: Migrate the order widget**

`src/admin/widgets/order-subscription-summary.tsx` has three separate things to fix.

Add the import alongside the existing ones near the top:

```tsx
import { useTranslation } from "react-i18next"
```

Add the hook as the first line of the component body, immediately after the `({ data: order }: DetailWidgetProps<AdminOrder>) => {` opening at line 41:

```tsx
  const { t } = useTranslation("reorder")
```

`formatDateTime` at lines 31-37 sits at module scope and returns `"-"` for null. Leave the function where it is but route the placeholder through i18n by giving it the fallback as an argument. Replace lines 31-37:

```tsx
const formatDateTime = (value: string | null, emptyValue: string) => {
  if (!value) {
    return emptyValue;
  }

  return new Date(value).toLocaleString();
};
```

Then replace the eleven English strings in the JSX. The mapping, in file order:

| Line | Current | Replacement |
|------|---------|-------------|
| 54 | `Subscription` (heading) | `{t("subscriptions.orderWidget.title")}` |
| 61 | `Loading subscription summary...` | `{t("subscriptions.orderWidget.loading")}` |
| 66 | `Failed to load subscription summary` | `{t("subscriptions.orderWidget.loadError")}` |
| 70 | `One-time order` | `{t("subscriptions.orderWidget.oneTimeOrder")}` |
| 75 | `Subscription order` (badge) | `{t("subscriptions.orderWidget.badge")}` |
| 95 | `Subscription` (card subtitle) | `{t("common.fields.subscription")}` |
| 107 | `Status` | `{t("common.fields.status")}` |
| 112 | `{summary.subscription.status}` | see below |
| 117 | `Frequency` | `{t("common.fields.frequency")}` |
| 125 | `Discount` | `{t("common.fields.discount")}` |
| 134 | `Next renewal` | `{t("common.fields.nextRenewal")}` |

Line 112 is not a translation of English text — it currently renders the raw enum value, so the badge reads `active` in lowercase where every other page reads `Active`. Fix it by mapping the enum to a key. Add this module-scope map next to `getSubscriptionStatusColor`:

```tsx
const SUBSCRIPTION_STATUS_KEYS: Record<SubscriptionAdminStatus, string> = {
  [SubscriptionAdminStatus.ACTIVE]: "subscriptions.status.active",
  [SubscriptionAdminStatus.PAUSED]: "subscriptions.status.paused",
  [SubscriptionAdminStatus.CANCELLED]: "subscriptions.status.cancelled",
  [SubscriptionAdminStatus.PAST_DUE]: "subscriptions.status.pastDue",
};
```

and render line 112 as:

```tsx
                  {t(SUBSCRIPTION_STATUS_KEYS[summary.subscription.status])}
```

Line 120 renders `{summary.subscription.frequency_label}` — leave it exactly as is. That is a backend-generated English label and it stays English by decision.

Line 128-130 currently falls back to the literal `"subscription_discount"` when there is no discount, which is an internal identifier leaking into the UI. Replace with:

```tsx
                  {summary.subscription.discount?.label ??
                    t("subscriptions.orderWidget.noDiscount")}
```

Finally, the `formatDateTime` call at lines 137-140 now needs the second argument:

```tsx
                  {formatDateTime(
                    summary.subscription.effective_next_renewal_at ??
                      summary.subscription.next_renewal_at,
                    t("common.empty.noValue")
                  )}
```

- [ ] **Step 4: Migrate the selection modals**

`src/admin/routes/subscriptions/plans-offers/components/selection-modals.tsx` has two components, each needing its own hook call.

Add the import:

```tsx
import { useTranslation } from "react-i18next"
```

In `PlanOfferProductPickerModal`, add the hook as the first line of the body (after the destructured props at line 40) and replace six strings:

```tsx
  const { t } = useTranslation("reorder")
```

| Line | Current | Replacement |
|------|---------|-------------|
| 72 | `header: "Product"` | `header: t("common.fields.product")` |
| 75 | `header: "ID"` | `header: t("common.fields.id")` |
| 116 | `Select product` | `{t("planOffers.pickers.selectProduct")}` |
| 122-123 | `Search and select the product that this configuration belongs to.` | `{t("planOffers.pickers.selectProductHint")}` |
| 129 | `placeholder="Search products..."` | `placeholder={t("common.placeholders.searchProducts")}` |
| 142 | `Cancel` | `{t("common.actions.cancel")}` |
| 157 | `Apply` | `{t("common.actions.apply")}` |

Lines 66-82 build `columnHelper` and the column array inside the component body already, so the `t()` calls at lines 72 and 75 are legal there — no restructuring needed. This is worth noticing because Plans 2-6 face the opposite situation: those files define columns at *module* scope, where hooks are unavailable, and each of those plans has to move them inside the component.

In `PlanOfferVariantPickerModal`, add the same hook line after line 174 and replace:

| Line | Current | Replacement |
|------|---------|-------------|
| 201 | `header: "Variant"` | `header: t("common.fields.variant")` |
| 208 | `row.original.sku \|\| "-"` | `row.original.sku \|\| t("common.empty.noValue")` |
| 239 | `Select variant` | `{t("planOffers.pickers.selectVariant")}` |
| 245-247 | the `productTitle ? ... : ...` ternary | see below |
| 260 | `Cancel` | `{t("common.actions.cancel")}` |
| 275 | `Apply` | `{t("common.actions.apply")}` |

Lines 245-247 interpolate a product title into a sentence, which is the one case that needs i18next interpolation rather than a plain lookup:

```tsx
                    {productTitle
                      ? t("planOffers.pickers.selectVariantHint", {
                          productTitle,
                        })
                      : t("planOffers.pickers.selectProductFirst")}
```

The `{{productTitle}}` placeholder in the JSON value from Task 1 is what receives it. Chinese and English put the variable in different positions in the sentence, which is exactly why this must be interpolation and not string concatenation.

- [ ] **Step 5: Verify no English literals remain in either file**

```bash
grep -nE '"[A-Z][a-z]+[a-zA-Z ,.]{2,}"' src/admin/widgets/order-subscription-summary.tsx src/admin/routes/subscriptions/plans-offers/components/selection-modals.tsx
grep -nE '>[A-Z][a-zA-Z ]{3,}<' src/admin/widgets/order-subscription-summary.tsx src/admin/routes/subscriptions/plans-offers/components/selection-modals.tsx
```

Expected: no output from either. Matches on `SUBSCRIPTION_STATUS_KEYS` values are fine — those are translation keys, not display text — but any capitalized English sentence means a string was missed.

- [ ] **Step 6: Build and test**

```bash
yarn build && yarn test:i18n
```

Expected: build succeeds, 3 tests pass. The third test now verifies roughly 20 real `t()` keys against `en.json`.

- [ ] **Step 7: Verify in a browser — this is the gate for the whole plan**

Everything up to here proves the keys are consistent. Nothing yet proves Medusa loads them. Start the dev environment (see `.agents/skills/local-dev/SKILL.md`; the plugin must be pushed to the backend via `./.agents/scripts/sync-local-env.sh` first) and open the Admin dashboard at http://localhost:9000/app.

Check three things, in this order:

1. **English still correct.** With the admin language on English, the sidebar reads `Subscriptions`, `Plans & Offers`, `Renewals`, `Dunning`, `Cancellation & Retention`, `Analytics`, `Activity Log`, and `Subscription Settings` under Settings. If any item shows a literal `menuItems.something`, the namespace is not registered and Task 1 Step 4 is wrong.
2. **Switch to 简体中文** in the admin user's profile settings. The eight sidebar items should become 订阅, 计划与优惠, 续订, 催款, 取消与挽留, 数据分析, 操作日志, 订阅设置.
3. **The two migrated surfaces.** Open any order that came from a subscription and confirm the side widget renders in Chinese with a translated status badge (生效中 rather than `active`), and that the frequency line still shows the English backend label — that mixed state is expected, not a defect. Then open Plans & Offers, start creating an offer, and confirm the product and variant pickers are in Chinese, including the interpolated hint sentence.

If step 2 shows English while step 1 was fine, the `zhCN` key is wrong (check for `zh-CN` or `zh_CN` in `index.ts`).

- [ ] **Step 8: Commit**

Propose to the user and wait for approval:

```
feat(i18n): translate order subscription widget and plan offer pickers
```

```bash
git add src/admin/i18n src/admin/widgets src/admin/routes/subscriptions/plans-offers/components
git commit -m "feat(i18n): translate order subscription widget and plan offer pickers"
```

---

## Task 6: Rewrite the i18n README

**Files:**
- Modify: `src/admin/i18n/README.md` (currently 57 lines of generic Medusa boilerplate about a fictional "brands" widget)

**Interfaces:**
- Consumes: the working implementation from Tasks 1-5.
- Produces: the reference document Plans 2-6 point contributors at. No code symbols.

- [ ] **Step 1: Replace the whole file**

The current content is the stock Medusa example, describing a `brands` widget that does not exist in this repo and the default `translation` namespace this plugin deliberately avoids. Replace it entirely:

````markdown
# Admin Translations

The Reorder Admin UI is translated through Medusa's admin i18n support. Translations
register under the private `reorder` namespace so plugin keys cannot collide with the
dashboard's built-in keys.

## Files

- `json/en.json` — English baseline and the source of truth for which keys exist.
- `json/zhCN.json` — Simplified Chinese. Must have the identical key set.
- `index.ts` — registers both languages under the `reorder` namespace.
- `translate.ts` — namespace-bound lookup for code that runs outside a React component.

## Adding a language

Add `json/<code>.json` with the same keys as `en.json`, then register it in `index.ts`.
Language codes are camelCase with no separator, matching Medusa's own convention:
`zhCN`, not `zh-CN`. The dashboard converts camelCase to a hyphenated locale internally,
so a hyphenated key breaks locale detection.

## Key naming

```
<domain>.<area>.<key>
```

`domain` is a plugin domain (`subscriptions`, `planOffers`, `renewals`, `dunning`,
`cancellations`, `activityLog`, `analytics`, `settings`) or `common` for strings shared
across at least two domains. `area` groups by purpose (`columns`, `filters`, `actions`,
`fields`, `status`, `toast`, `prompt`, `sections`, `errors`, `empty`). `menuItems.<domain>`
is reserved for sidebar labels.

## Reading a translation in a component

```tsx
import { useTranslation } from "react-i18next"

const SubscriptionsPage = () => {
  const { t } = useTranslation("reorder")

  return <Heading>{t("subscriptions.list.title")}</Heading>
}
```

Pass the namespace to `useTranslation`. Without it, lookups go to `translation` and
return the key string.

## Reading a translation outside a component

Route `handle.breadcrumb` functions and other module-scope code cannot call hooks:

```ts
import { translate } from "../../i18n/translate"

export const handle = {
  breadcrumb: () => translate("menuItems.subscriptions"),
}
```

## Sidebar labels

`defineRouteConfig` treats `label` as a translation key when `translationNs` is set:

```tsx
export const config = defineRouteConfig({
  label: "menuItems.subscriptions",
  translationNs: "reorder",
  icon: Calendar,
})
```

## Interpolation

Define the placeholder in the JSON value and pass the variable at the call site. Do not
build sentences by concatenation — languages order clauses differently:

```json
{ "selectVariantHint": "Choose a variant from {{productTitle}}." }
```

```tsx
t("planOffers.pickers.selectVariantHint", { productTitle })
```

## Verifying

```bash
yarn test:i18n
```

This enforces that `en.json` and `zhCN.json` have identical key sets, that no value is
empty, and that every literal `t("...")` or `translate("...")` key used under
`src/admin/` exists in `en.json`. A missing key does not throw at runtime — i18next
renders the key string itself — so this test is the only thing that catches it.

## What is not translated

Some labels are generated by the backend and returned in Admin API responses. They
remain English by decision:

- subscription and plan-offer frequency labels (`Every month`, `Every 2 weeks`)
- discount labels (`10% off`)
- analytics metric labels (`MRR`, `Churn Rate`, `LTV`)

Where a response carries structured fields alongside the label — for example
`SubscriptionAdminFrequency` has `interval` and `value`, and `AnalyticsTrendSeries` has
`metric` — the UI can render from those instead of the label if full translation is
wanted later.
````

- [ ] **Step 2: Verify the documented commands and paths are real**

```bash
grep -n "test:i18n" package.json
ls src/admin/i18n/json/ src/admin/i18n/translate.ts
grep -n "useTranslation(\"reorder\")" src/admin/widgets/order-subscription-summary.tsx
```

Expected: the script exists, `en.json`/`zhCN.json`/`translate.ts` all exist, and the widget uses the documented hook form. The README must describe what the code actually does — `.agents/AGENTS.md` forbids documenting intended future behavior.

- [ ] **Step 3: Commit**

Propose to the user and wait for approval:

```
docs(i18n): document the plugin translation setup
```

```bash
git add src/admin/i18n/README.md
git commit -m "docs(i18n): document the plugin translation setup"
```

---

## Verification summary

```bash
yarn build && yarn test:i18n && yarn test:integration:http
```

The HTTP suite is included not because this plan changes API behavior — it does not — but because Plan 0 just moved zod a major version and the admin build now pulls in new files; a green HTTP suite confirms nothing regressed underneath.

The real gate is Task 5 Step 7. A green test suite with a broken namespace registration looks identical to a working one: the JSON is consistent either way, and the UI silently renders key strings. Only the browser check distinguishes them, and it must pass before Plan 2 starts — every later plan assumes this pipeline works and none of them re-verify it.

## What Plans 2-6 inherit from this plan

- `useTranslation("reorder")` in components; `translate(key)` outside them.
- `yarn test:i18n` as the per-file verification gate.
- `common.*` keys already defined: `actions.cancel`, `actions.apply`, `fields.id`, `fields.product`, `fields.variant`, `fields.status`, `fields.frequency`, `fields.discount`, `fields.nextRenewal`, `fields.subscription`, `placeholders.searchProducts`, `empty.noValue`.
- `subscriptions.status.*` already defined for all four `SubscriptionAdminStatus` values — Plan 2 reuses these rather than redefining them.
- The pattern for enum-to-key maps (`SUBSCRIPTION_STATUS_KEYS`), which every later plan needs for its `formatStatus`-style functions.
- The known constraint that module-scope column and filter definitions must move inside the component before they can call `t()`.
