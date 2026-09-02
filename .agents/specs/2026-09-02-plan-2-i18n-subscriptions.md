# Plan 2: Subscriptions Domain

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans`. Checkbox syntax for tracking. Browser checks are main-agent-only.

**Goal:** Translate the subscriptions list page, detail page, and the remaining
untranslated strings of the order widget — with a **complete** string inventory
(Rev 1 missed 7 strings and the address-line labels).

**Architecture:** Plan 1's patterns. New structural requirement: the list page's
columns/filters/option arrays move from module scope into the component (`useMemo`,
`[t]` dependency) — done as a separate no-string-change task so review can separate
restructuring from translation.

**Tech Stack:** react-i18next 13.5.0 (`useTranslation("reorder")`), `ReorderTranslate`
from `src/admin/i18n/translate.ts` for helper signatures.

## Global Constraints

- Prerequisite: Plan 1 accepted (contract test green; pipeline browser-verified or
  user-acknowledged as deferred).
- **English frozen:** every `en.json` value is byte-for-byte from current UI text.
- `ReorderTranslate` for helper `t` parameters; `t` is a required parameter except
  where trailing optional params force it first (`formatDiscountRange`-style — none
  in this plan).
- Backend labels stay English: `frequency.label`, `discount.label`,
  `frequency_label`.
- Preflight: read `docs/architecture/subscriptions.md`, `docs/admin/subscriptions.md`,
  `docs/testing/subscriptions.md`.
- One commit at plan end (after user approval).

## Complete string inventory (source of truth for Task 1 keys)

Verified against source; every literal below maps to exactly one key.

### List page (`src/admin/routes/subscriptions/page.tsx`)

- Status options: Active / Paused / Cancelled / Past due → `subscriptions.status.*` (Plan 1)
- Boolean options: Yes / No → `common.filters.yes|no`
- Renewal options: Overdue / Next 7 days / Next 30 days / Next 90 days → `subscriptions.filters.overdue|next7Days|next30Days|next90Days`
- Columns: Reference / Product / Status / Frequency / Next renewal → `subscriptions.columns.reference`, `common.fields.*`
- Cell: `Projected after skipped cycle` / `Scheduled` → `subscriptions.columns.projectedAfterSkip|scheduled`
- Filters: Status / Trial / Skip next cycle / Next renewal → `common.fields.status`, `subscriptions.filters.trial|skipNextCycle`, `common.fields.nextRenewal`
- Actions: Pause / Pausing... / Resume / Resuming... / Cancel / Cancelling... → `subscriptions.actions.*`
- Prompts (3): titles, descriptions, confirmText/cancelText → `subscriptions.prompt.*`
- Toasts (3) + error fallbacks (3) → `subscriptions.toast.*`, `subscriptions.errors.*`
- Chrome: h1 `Subscriptions` (×2), description `Monitor subscription status, cadence, and upcoming renewals.` (×2), `Failed to load subscriptions.`, `Clear all filters`, `Clear all`, `Add filter`, placeholder `Search`
- Empty states: `No matching subscriptions` / `No subscriptions yet` / `Try changing the search term or active filters.` / `Subscriptions will appear here once customers start recurring orders.`
- `FilterChip`: the literal `is`

### Detail page (`src/admin/routes/subscriptions/[id]/page.tsx`)

Includes everything from Rev 1 plus the previously missed items:

- Three early-return headings `Subscription`, `Loading subscription details...`, `Failed to load subscription details.`, `Subscription details are unavailable.`
- Header description: `Subscription details and upcoming plan changes.` ← **previously missed**
- Action buttons + three prompts (same key set as list page)
- Toasts: plan-change/pause/resume/cancel/address success + 5 error fallbacks; client validation: `Select a variant`, `Frequency value must be a positive integer`, `Fill in all required address fields`, `Enter a valid postal code and 2-letter country code`
- Overview rows: Status / Frequency / Next renewal / Started at / Last renewal / Recipient / Address / City / Phone / Country
- Pending plan change block: heading, Variant / Frequency / Effective at / Variant ID rows, empty text `No pending plan change is scheduled for this subscription.` ← **previously missed**
- Activity log timeline: heading, columns (Created/Event/Actor/Summary), sort menu duplicates, filters Domain/Actor, Created from/to, loading `Loading activity log...`, error `Failed to load activity log.`, empty `No activity log events found.` ← **previously missed**, event drawer (`Activity Log Event`, `Loading activity event...`, `Failed to load activity event details.`), detail blocks (Overview / Subscription snapshot / Changed fields / Previous state / New state / Metadata, `No changed fields captured`, `No data`)
- Customer/product blocks: headings `Customer` / `Product`, rows Email / Customer ID / SKU
- Orders block: heading `Orders`, `Initial order`, `Latest renewal`, `Renewal {{index}}`, `No linked orders yet`
- Plan-change drawer: all labels + `Loading variants...`, `Failed to load product variants.`, `No variants are available for this product.`
- Address drawer: **`Address line 1` and `Address line 2` are distinct labels (source lines 1595, 1605) — dedicated keys**, plus First name / Last name / Company / City / Postal code / Province / State / Country code / Phone, hints `Leave empty to let the backend use the default effective date.` ← missed, `Use the two-letter ISO country code, for example PL or US.` ← missed, `Save`
- Formatters: status map, `formatFrequency` deleted (render `{{interval}} × {{value}}` from structured fields), `formatDateTime`/`formatUnknown` gain `emptyValue`, activity helpers gain `t`

## Task 1: Catalog keys (both JSON files)

**Files:** `src/admin/i18n/json/en.json`, `zhCN.json`

Add under `subscriptions` (siblings of `breadcrumb`, `status`, `orderWidget`):

- `list`: `title`, `description`, `loadError`, `emptyFiltered`, `emptyFilteredHint`, `empty`, `emptyHint` — English values copied verbatim from the page
- `columns`: `reference`, `projectedAfterSkip`, `scheduled`
- `filters`: `trial`, `skipNextCycle`, `overdue`, `next7Days`, `next30Days`, `next90Days`
- `actions`: `pause`, `pausing`, `resume`, `resuming`, `cancel`, `cancelling`, `cancelSubscription`, `keepSubscription`
- `prompt`: `pauseTitle`, `pauseDescription`, `resumeTitle`, `resumeDescription`, `cancelTitle`, `cancelDescription`
- `toast`: `paused`, `resumed`, `cancelled`
- `errors`: `pauseFailed`, `resumeFailed`, `cancelFailed`, `planChange`, `planChangeFailed`, `addressUpdated`, `addressFailed`
- `detail`: `title`, `description` (`Subscription details and upcoming plan changes.`), `loading`, `loadError`, `unavailable`, `noPendingChange`, `noActivityEvents`, `noLinkedOrders`, `sections` (`customer`, `product`, `orders`, `pendingPlanChange`, `activityLog`, `subscriptionSnapshot`, `changedFields`, `previousState`, `newState`, `metadata`), `latestRenewal`, `initialOrder`, `renewalNumbered` (`Renewal {{index}}`)
- `fields`: `startedAt`, `lastRenewal`, `effectiveAt`, `variantId`, `customerId`, `event`, `actor`, `created`, `createdFrom`, `createdTo`, `summary`, `domain`, `recipient`, `address`, `addressLine1`, `addressLine2`, `city`, `postalCode`, `province`, `countryCode`, `country`, `phone`, `company`, `firstName`, `lastName`
- `addressHints`: `effectiveAtOptional` (`Leave empty to let the backend use the default effective date.`), `countryCodeIso` (`Use the two-letter ISO country code, for example PL or US.`)
- `planChange`: `title`, `frequencyInterval`, `frequencyValue`, `selectVariant`, `selectInterval`, `loadingVariants`, `variantLoadError`, `noVariants`, `toast`, `error`, `errors.variantRequired`, `errors.frequencyValueInvalid`
- `timeline`: `loading`, `loadError`, `empty`, `eventTitle`, `eventLoading`, `eventLoadError`, `noSummary`, `noChangedFields`, `noData`, `actors` (admin/customer/system/scheduler), `domains` (subscriptions/renewals/dunning/cancellations), `summaryFields` (subscriptionCreated, pendingUpdateData, status, recipient, address, addressLinesChanged, postalCodeChanged, phoneChanged, countryCode, province, city — same English values as the source switch)

Rules:

- Extract each English value from the source file at migration time, byte-for-byte.
  If a value in this inventory differs from the source, **the source wins** — update
  the JSON, not the UI text.
- zhCN follows Plan 1's terminology table; pluralized/interpolated keys use
  `{{index}}` (e.g. `第 {{index}} 次续订`).
- Run `yarn test:i18n` — parity must stay green.

## Task 2: List page restructure (no string changes)

Move `statusFilterOptions` (48), `booleanFilterOptions` (55), `nextRenewalFilterOptions`
(60), `baseColumns` (67), the four `filterHelper.accessor` defs (140-163), and
`filters` (166) inside `SubscriptionsPage` as `useMemo` values; fold `baseColumns`
into the existing `columns` useMemo. Keep `columnHelper`, `filterHelper`, `PAGE_SIZE`,
and `SubscriptionActionType` at module scope.

- [ ] Verify `git diff` shows **zero** string-literal additions/removals
  (`git diff -U0 src/admin/routes/subscriptions/page.tsx | grep -E '^[+-]"'`).
- [ ] `yarn build` green. Browser sanity check (main agent): table renders, filters
  apply/clear, row actions fire.

## Task 3: List page translation

- [ ] Hook + imports: `useTranslation("reorder")`; no `TFunction` import.
- [ ] Delete `formatStatus` (lines 809-820); replace with
  `SUBSCRIPTION_STATUS_KEYS` map + `t(SUBSCRIPTION_STATUS_KEYS[status])` call sites.
  Keep `getStatusColor`.
- [ ] `formatDateTime` gains `emptyValue`; its call sites pass
  `t("common.empty.noValue")`.
- [ ] `getSubscriptionActionPromptConfig(action, t: ReorderTranslate)` — required `t`,
  no default. Update the single call site.
- [ ] Options/filters/columns per the Task 1 inventory; every `useMemo` that calls
  `t` lists `t` in its dependency array.
- [ ] Toasts: success strings + error fallbacks translated; `error.message` itself
  untouched.
- [ ] Chrome, empty states, `FilterChip` (own hook; `t("common.filters.is")`).
- [ ] Verify: the three grep sweeps from Plan 1 (literals in props, JSX text nodes,
  raw `return "..."` returns) come back clean; `yarn build && yarn test:i18n` green.
- [ ] Browser (main agent): columns/badges/filters/prompts/toasts in Chinese;
  `状态：生效中` chip format; frequency column still `Every month` (expected);
  switching language back to English live-updates all labels (catches missing
  `[t]` deps).

## Task 4: Detail page translation

- [ ] Hook in `SubscriptionDetailPage`; **separate hooks** in `DetailRow`,
  `JsonBlock`, `FilterChip`, and the activity-log event content component —
  `DetailBlock` takes translated props and needs none.
- [ ] Convert module-scope formatters first (compile errors then enumerate the JSX
  call sites): status/actor/summary-field key maps; `formatFrequency` deleted →
  `` `${t(INTERVAL_KEYS[interval])} × ${value}` `` at the pending-plan-change call
  site; `formatDateTime`/`formatUnknown` gain `emptyValue`;
  `getSubscriptionActionPromptConfig(action, t)`; `formatActivityEventType` left
  English (documented exception).
- [ ] Move `intervalOptions`, `activityLogActorFilterOptions`,
  `activityLogDomainFilterOptions` inside the component (`useMemo`, `[t]`); copy
  every `eventTypes` array verbatim (API values).
- [ ] JSX per the Task 1 inventory, **including the previously missed strings**:
  header description (line 673), `No pending plan change...` (864),
  `No activity log events found.` (1206), effective-date hint (1525),
  `Address line 1` (1595) / `Address line 2` (1605), ISO country-code hint (1658).
- [ ] Every `formatDateTime(...)` call gains `, t("common.empty.noValue")`; every
  bare `|| "-"` becomes `|| t("common.empty.noValue")`.
- [ ] Renewal-order subtitle template literals keep `order.status` raw (Medusa
  value) and pass `emptyValue` to `formatDateTime`.
- [ ] Verify: four grep sweeps clean; `yarn build && yarn test:i18n` green.
- [ ] Browser (main agent): overview rows, both drawers (including the two address
  lines and their hints), timeline columns/actor badges/domain filter, event drawer
  sections, `第 2 次续订` interpolation, plan-change validation toast
  请选择变体, address validation 请填写所有必填地址字段.

## Completion: single commit

Propose (wait for approval):

```
feat(i18n): translate subscriptions list and detail pages
```
