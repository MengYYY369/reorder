# Admin Translations (reorder namespace)

This directory owns the plugin's admin translation pipeline: catalogs for
English and Simplified Chinese, the namespace registration consumed by the
Medusa admin bundler, a `translate()` helper for non-component code, and a
contract test that enforces the key convention.

Medusa uses [react-i18next](https://react.i18next.com/) in the admin
dashboard. The dashboard deep-merges the resources exported from
`src/admin/i18n/index.ts` over its core translations and initializes the
default i18next singleton with the languages found in the resources
(`supportedLngs: Object.keys(resources)`).

## Files

| File | Role |
|------|------|
| `json/en.json` | English baseline. Source of truth for the key set. |
| `json/zhCN.json` | Simplified Chinese. Must have an identical key set. |
| `index.ts` | Default-exports `{ en: { reorder: en }, zhCN: { reorder: zhCN } }`. This is what the admin bundler feeds to `virtual:medusa/i18n`. |
| `translate.ts` | `translate()` for code outside React components, plus the shared `ReorderTranslate` type. |
| `__tests__/translations.spec.ts` | Contract test. Run with `yarn test:i18n`. |

## The `reorder` namespace

All plugin keys live under the private `reorder` namespace — never
`translation`. The dashboard's own keys live in the `translation` namespace;
registering there would let plugin keys shadow (or be shadowed by) dashboard
keys. A separate namespace makes collisions impossible.

## Key naming

Keys follow `<domain>.<area>.<key>` with lowerCamelCase leaves, e.g.
`subscriptions.orderWidget.loading`. The ten domain prefixes are:
`menuItems`, `common`, `subscriptions`, `planOffers`, `renewals`, `dunning`,
`cancellations`, `activityLog`, `analytics`, `settings`.

`menuItems.<domain>` is reserved for sidebar labels.

### Canonical ownership of shared fields

`common.fields` is the single owner of shared field labels: `sku`, `reason`,
`reference`, `customer`, `order`, `email`, `createdAt` (plus `id`, `product`,
`variant`, `status`, `frequency`, `discount`, `nextRenewal`,
`subscription`). No domain may redefine them — use
`t("common.fields.customer")`, not `subscriptions.fields.customer`.

### No computed keys

Every key must appear somewhere as a **full string literal** in `src/admin`.
Keys built at runtime (`` t(`a.${b}`) ``) are invisible to the contract test.
If a key must be picked dynamically, put the full literals in a `Record` map
(see `SUBSCRIPTION_STATUS_KEYS` in
`src/admin/widgets/order-subscription-summary.tsx`) — the map's values are
then caught by the contract test.

## Usage

### Inside React components

```tsx
import { useTranslation } from "react-i18next"

const MyComponent = () => {
  const { t } = useTranslation("reorder")

  return <Text>{t("common.fields.status")}</Text>
}
```

Always pass `"reorder"` as the namespace argument.

### Outside React components (route `handle`s, helpers)

Hooks require a component context. Route `handle` objects and helper
functions evaluate outside one, so use `translate()`:

```ts
import { translate } from "../../i18n/translate"

export const handle = {
  breadcrumb: () => translate("menuItems.subscriptions"),
}
```

`translate()` falls back to the raw key if the dashboard i18n instance is not
initialized yet (route modules evaluate at import time), so it is safe at
module scope.

### Helper-function signatures

When a helper receives `t` as a parameter, type it as `ReorderTranslate`:

```ts
import type { ReorderTranslate } from "../i18n/translate"

function buildRows(t: ReorderTranslate) { ... }
```

Do **not** import `TFunction` from `i18next` — `i18next` is a transitive
dependency of `@medusajs/dashboard` and is not declared in this package's
`package.json`, so importing it is fragile. `ReorderTranslate` is derived
from the real `useTranslation` return type instead.

### Interpolation

Use i18next interpolation, never string concatenation:

```tsx
t("planOffers.pickers.selectVariantHint", { productTitle })
```

with `"selectVariantHint": "Choose a variant from {{productTitle}}."` in
`en.json`. Concatenated sentences cannot be reordered by translators.

## Sidebar route configs

Every route that contributes a sidebar item uses
`defineRouteConfig` with a translation-key label and the namespace hint:

```ts
export const config = defineRouteConfig({
  label: "menuItems.dunning",
  translationNs: "reorder",
  rank: 3,
})
```

The dashboard renders the label as `t(label)` bound to `translationNs`
(`item.translationNs ? t5(item.label) : item.label` in
`@medusajs/dashboard`), so the key resolves through our catalogs while the
icon and rank stay plain values.

## Contract test

```bash
yarn test:i18n
```

Five tests enforce the pipeline:

1. **Namespace registration** — `index.ts` registers both `en` and `zhCN`,
   each exposing the `reorder` namespace.
2. **Identical key sets** — `zhCN.json` and `en.json` contain exactly the
   same keys (no missing, no extra).
3. **No empty values** — no catalog entry has a blank value.
4. **Key-literal resolution** — every string literal in `src/admin/**` that
   looks like a translation key (any of the ten domain prefixes followed by
   dot segments, single- or double-quoted) exists in `en.json`. This one net
   catches `t()` calls, key-map values, zod `message:` strings, and
   `defineRouteConfig` labels.
5. **Route-config namespaces** — every sidebar route config carrying a
   `menuItems.*` label also declares `translationNs: "reorder"`.

Run it after any change under `src/admin` — it fails fast when a key is used
but not defined.

## Rules for future changes

### Frozen English baseline

`en.json` values are byte-for-byte copies of the UI text that existed before
i18n was introduced. Do not reword English copy while migrating a file; a
wording change must go through a separate review. The single disclosed
exception: the order widget's discount fallback was the raw
`"subscription_discount"` identifier (a bug) and became
`subscriptions.orderWidget.noDiscount` = `"No discount"`.

### Deliberate exceptions

- The five `dunning.*` event-type identifiers
  (`dunning.started`, `dunning.retry_executed`, `dunning.recovered`,
  `dunning.unrecovered`, `dunning.retry_schedule_updated`) are backend
  event-bus contract strings, not translation keys. They are excluded from
  the contract test's key-literal net via `NON_TRANSLATION_KEYS`.
- `summary.subscription.frequency_label` in the order widget is a
  backend-provided English label and intentionally not translated yet.

### Terminology baseline (English to Simplified Chinese)

The zhCN catalog uses a fixed English-to-Chinese terminology mapping, and
later translations must keep it. The authoritative Chinese renderings live in
`json/zhCN.json` — use the exact strings found there; do not re-translate
these terms. The mapping, with romanized glossary keys:

| Domain (en) | Glossary key (romanized) |
|-------------|--------------------------|
| subscription | ding yue |
| renewal | xu ding |
| dunning | cui shou |
| retention | wan liu |
| product | shang pin |
| variant | bian ti |
| recovered / payment recovery | hui fu |

Trailing ellipses in zhCN.json use the full-width ellipsis character
(U+2026, doubled) rather than three ASCII periods. `ID`, `MRR`, `LTV`, and
`SKU` remain Latin in the Chinese text.

Learn more about Medusa admin translations in the
[Translate Admin Customizations](https://docs.medusajs.com/learn/fundamentals/admin/translations)
documentation.
