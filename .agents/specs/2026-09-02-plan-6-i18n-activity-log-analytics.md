# Plan 6: Activity Log & Analytics

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans`. Checkbox syntax. Browser checks are main-agent-only.

**Goal:** Translate the global activity-log page and the analytics page — including
the export block, chart explanations, `Max`/`Min`, aria labels, and the local
metric-tab labels that Rev 1 missed.

**Architecture:** Plan 1/2 patterns, with one structural requirement the review made
non-negotiable: **`analytics/page.tsx` is not one component.** `MetricCard`,
`TrendChart`, and `CreatedSubscriptionsBarChart` each call the translated formatters
from their own component scope, so each gets its own `useTranslation("reorder")`
hook. The activity-log event-detail block is likewise a separate component.

**Tech Stack:** react-i18next, `ReorderTranslate`.

## Global Constraints

- Prerequisite: Plan 5 accepted.
- **English frozen; byte-for-byte extraction; source wins on any conflict.**
- Scope boundary for this plan: the **backend** metric labels (`metric.label` from
  `METRIC_LABELS`: `MRR`, `Churn Rate`, `LTV`, `Active Subscriptions`,
  `Created Subscriptions`) stay English. The **frontend** `metricTabs` labels
  (`MRR`, `Churn`, `LTV`, `Created`) are in scope and get translated. The visual
  mismatch (Chinese tab label above an English KPI card label) is accepted and
  documented; flipping that decision later is a one-key change.
- `analytics USD` formatting keeps its `"en-US"` hardcode (documented exception).
- Preflight: `docs/architecture/activity-log.md` + `analytics.md`, matching
  `docs/admin/*.md` and `docs/testing/*.md`.
- One commit at plan end.

## Task 1: Catalog keys (both JSON files)

**Files:** `src/admin/i18n/json/en.json`, `zhCN.json`

Add `activityLog.*` and `analytics.*` areas. English values transcribed verbatim
from source at migration time; the inventory below is the checklist.

### activityLog

- `list`: `title` (`Activity Log`, ×2), `description` — **exact source text**:
  `Review subscription lifecycle events across renewals, dunning, and cancellation workflows.` (×2), `loadError` (`Failed to load activity log entries.`), `emptyFiltered`, `emptyFilteredHint`, `empty`, `emptyHint`
- `columns`: `subscription` (`Subscription` — the first column header + sortLabel,
  maps to render via `common.fields.subscription` or this key; pick the domain key),
  `created`, `actor`, `event`, `reason`
- `filters`: `addFilter`, `quickPresets` (`Quick presets`), `eventType`
  (`Event type`), `preset` (`Preset` chip label), `createdFrom`, `createdTo`
- `actor`: admin / customer / system / scheduler
- `domains`: `subscriptions`, `renewals`, `dunning`, `cancellation`
  (`Cancellation` — the preset label), `cancellationFull`
  (`Cancellation & Retention` — the `formatDomainLabel` return), `unknown`
  (`Activity`)
- `summaryFields`: the 11 summary-field switches (exact source wording)
- `eventDetail`: `title` (`Activity Log Event`), `loading`, `loadError`, `close`,
  `overview`, `event`, `domain`, `actor`, `created`, `reason`, `summary`,
  `subscriptionSnapshot` (`Subscription Snapshot`), `reference`, `customer`,
  `product`, `variant`, `changedFields` (`Changed Fields`), `noChangedFields`,
  `previousState` (`Previous State`), `newState` (`New State`), `metadata`,
  `noData`, `noSummary`

### analytics

- `list`: `title` (`Analytics`), `description` — **exact**:
  `Review recurring revenue, churn, LTV, and subscription creation trends from the analytics read model.`, `loadError` (`Failed to load analytics.`), `exportError` (`Failed to export analytics`), `trendOverview` (`Trend overview`), `noDataRange`, `noDataRangeHint` (`Try widening the date range or removing filters to inspect a broader slice of subscription activity.`), `noBuckets` (`No buckets returned for the current range.`), `noComparisonWindow`, `noTrendPoints`, `noTrendPointsHint`, `noDailyBuckets`, `noDailyBucketsHint` (`Pick a valid date range to inspect daily subscription creation.`), `insufficientSnapshot`, `invalidDateRange`
- `filters`: `addFilter`, `dateFrom`, `dateTo`, `groupBy`, `status`, `frequency`,
  `product` (→ or `common.fields.product`; pick one and use it consistently)
- `metricTabs`: `mrr`, `churn` (`Churn`), `ltv`, `created` (`Created`) — frontend labels
- `status`: active / paused / pastDue / cancelled (keyed by the string-literal values)
- `groupBy`: day / week / month
- `frequency`: weekly, every2Weeks, monthly, quarterly, yearly,
  `everyNWeeks`/`everyNMonths`/`everyNYears` (`Every {{value}} ...`)
- `units`: `currency`, `percent`, `count`, `unavailable`
- `trend`: `rangeSummary` (`{{from}} to {{to}}` / `{{from}} 至 {{to}}`),
  `rangeEmpty` (`No buckets returned for the current range.`),
  `max` (`Max`), `min` (`Min`), `dailyBars` (`Daily bars`),
  `bucketsDay` / `bucketsWeek` / `bucketsMonth` (`Day buckets` / `Week buckets` /
  `Month buckets`), `createdUtcNote` (`Created always renders one UTC bar per day.`),
  `createdRangeNote` (`Created uses one UTC bar per day and only follows the selected date range.`),
  `trendUtcNote` (`Trends are bucketed in UTC and follow the same filters as the KPI cards.`),
  `ariaTrendChart` (`{{label}} trend chart`), `ariaBarChart` (`{{label}} bar chart`),
  `flat` (`Flat vs previous window · {{delta}}`), `up`, `down`
- `export`: `button` (`Export`), `csv` (`Export CSV`), `json` (`Export JSON`)

`All products` (product filter placeholder + option, source 375-378) gets
`analytics.filters.allProducts`.

Run `yarn test:i18n` after adding both languages.

## Task 2: Activity-log page

**Files:** `src/admin/routes/subscriptions/activity-log/page.tsx`

- [ ] Restructure module-scope `actorFilterOptions`, `domainPresetOptions`,
  `baseColumns` into the component (`useMemo`, zero string changes first; build green).
- [ ] Hook in `ActivityLogPage`; **a second hook in the event-detail content
  component** (the block rendering Overview / Subscription Snapshot / Changed
  Fields / JSON titles). `FilterChip` gets its own hook.
- [ ] Key maps + formatters: `ACTIVITY_ACTOR_KEYS`, `ACTIVITY_DOMAIN_KEYS`
  (prefix-based, **including the two cancellation variants** — preset label uses
  `domains.cancellation`, `formatDomainLabel` returns `domains.cancellationFull`),
  `ACTIVITY_SUMMARY_FIELD_KEYS`; `formatDomainLabel(value, t)`,
  `formatActorType(value, t)`, `formatSummary(log, t)`,
  `formatSummaryField(value, t)`; `formatDateTime`/`formatUnknown` gain
  `emptyValue`. `formatEventType` stays English (documented exception).
- [ ] JSX per inventory — including the first table column (`subscription.reference`,
  header `Subscription` → `common.fields.subscription`), the three FilterChip labels
  (`Preset` / `Event` / `Actor`), and the exact description text.
- [ ] Verify: grep sweeps clean (props, JSX text nodes, `return "..."`); build +
  `yarn test:i18n` green.
- [ ] Browser (main agent): columns incl. 订阅, chips 状态/预设/事件/操作者 wording
  matches keys, quick presets in Chinese, event drawer fully Chinese, empty states.

## Task 3: Analytics page

**Files:** `src/admin/routes/subscriptions/analytics/page.tsx`

- [ ] Hooks: `AnalyticsPage` **and** `MetricCard` **and** `TrendChart` **and**
  `CreatedSubscriptionsBarChart` — each `const { t } = useTranslation("reorder")`.
  `EmptyAnalyticsState` takes translated props (no hook needed).
- [ ] Formatters gain required `t` (`ReorderTranslate`), call sites updated in the
  same task: `formatStatus`, `formatGroupBy`, `formatFrequency`,
  `formatMetricValue`, `formatMetricDelta`, `formatUnitLabel`,
  `formatTrendValue`, `formatSeriesRangeSummary` (with the `rangeSummary`
  interpolation replacing the ` to ` literal). Keep the `en-US` USD branch.
- [ ] `metricTabs` becomes a `useMemo` producing labels from
  `analytics.metricTabs.*`.
- [ ] JSX per inventory — export block (`Export`, `Export CSV`, `Export JSON`,
  export-error fallback), `All products`, the three UTC/bucket explanation strings,
  `Daily bars` / bucket labels, `Max`/`Min`, both aria labels
  (`aria-label={t("analytics.trend.ariaTrendChart", { label: series.label })}` and
  the bar-chart variant), all empty states with their hint sentences.
- [ ] Verify: grep sweeps clean; `yarn build && yarn test:i18n` green;
  `yarn test:integration:http` unaffected (no backend changes).
- [ ] Browser (main agent): page title/description, filters, metric tabs in Chinese
  with English KPI-card labels above (expected), export menu, both chart variants'
  `Max`/`Min`/aria, all empty states.

## Completion: single commit

```
feat(i18n): translate activity log and analytics pages
```
