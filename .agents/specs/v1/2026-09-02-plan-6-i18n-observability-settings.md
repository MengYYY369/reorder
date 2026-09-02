# Plan 6: Activity Log, Analytics, Settings + Docs

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Translate the remaining three surfaces — the global activity-log page, the analytics page, and the subscription-settings page — and finalize the user-facing i18n documentation.

**Architecture:** Three independent pages treated in one plan because they are the last three files of the migration and each is small. The analytics page has one deliberate exception: the metric-name values (`MRR`, `Churn Rate`, `LTV`, `Active Subscriptions`, `Created Subscriptions`) are backend labels that stay English by the plan-level decision, so KPI cards keep English names while the page chrome is Chinese.

**Tech Stack:** react-i18next 13.5.0, `@medusajs/ui`.

## Global Constraints

- **Prerequisite: Plans 1-5 are complete.** `yarn test:i18n` green.
- All code, comments, JSON keys, docs, and commit messages in English. Chinese only as JSON values.
- Conventional Commits `type(scope): description`; propose and wait for explicit user approval before committing.
- Key convention `<domain>.<area>.<key>`. Domains here are `activityLog`, `analytics`, `settings`.
- Reuse `common.*` and `subscriptions.status.*` where the meaning matches exactly.
- Do not refactor unrelated files.
- Backend labels stay English: analytics metric names specifically. See Task 3.

## File Structure

| File | Unique strings | Task |
|------|----------------|------|
| `src/admin/i18n/json/en.json` + `zhCN.json` | — | 1, 3, 4 |
| `src/admin/routes/subscriptions/activity-log/page.tsx` (1010 lines) | 35 | 2 |
| `src/admin/routes/subscriptions/analytics/page.tsx` (1172 lines) | 53 | 3 |
| `src/admin/routes/settings/subscription-settings/page.tsx` (655 lines) | 25 | 4 |
| `docs/admin/i18n.md`, `docs/README.md`, `README.md`, `.agents/AGENTS.md` | — | 5 |

These are the last three `.tsx` files holding translatable strings. After Task 4, running the Plan 1 grep across `src/admin` must find only the explicitly-kept-English strings listed under "Known remaining English".

---

## Task 1: Add the activity-log keys

**Files:**
- Modify: `src/admin/i18n/json/en.json`
- Modify: `src/admin/i18n/json/zhCN.json`

**Interfaces:**
- Consumes: nothing new.
- Produces: `activityLog.*` top-level area. Task 2 consumes it.

- [ ] **Step 1: Add to en.json, as a sibling of `common` and `menuItems`**

```json
    "activityLog": {
      "list": {
        "title": "Activity Log",
        "description": "Review subscription lifecycle events across renewals, dunning, cancellations, and retention.",
        "loadError": "Failed to load activity log entries.",
        "emptyFiltered": "No log entries match the current filters",
        "emptyFilteredHint": "Try changing the search term or active filters.",
        "empty": "No activity log entries yet",
        "emptyHint": "Activity log entries will appear here as subscription workflows run."
      },
      "columns": {
        "created": "Created",
        "actor": "Actor",
        "event": "Event",
        "reason": "Reason",
        "summary": "Summary"
      },
      "filters": {
        "addFilter": "Add filter",
        "quickPresets": "Quick presets",
        "eventType": "Event type",
        "preset": "Preset",
        "createdFrom": "Created from",
        "createdTo": "Created to"
      },
      "actor": {
        "admin": "Admin",
        "customer": "Customer",
        "system": "System",
        "scheduler": "Scheduler"
      },
      "domain": {
        "subscriptions": "Subscriptions",
        "renewals": "Renewals",
        "dunning": "Dunning",
        "cancellations": "Cancellation & Retention",
        "unknown": "Activity"
      },
      "summaryFields": {
        "subscriptionCreated": "Subscription created",
        "pendingUpdateData": "Scheduled plan change",
        "status": "Status changed",
        "recipient": "Recipient updated",
        "address": "Address",
        "addressLinesChanged": "Address updated",
        "postalCodeChanged": "Postal code updated",
        "phoneChanged": "Phone updated",
        "countryCode": "Country updated",
        "province": "Province updated",
        "city": "City updated"
      },
      "eventDetail": {
        "title": "Activity Log Event",
        "loading": "Loading event details...",
        "loadError": "Failed to load activity log detail.",
        "close": "Close",
        "overview": "Overview",
        "event": "Event",
        "domain": "Domain",
        "actor": "Actor",
        "created": "Created",
        "reason": "Reason",
        "summary": "Summary",
        "subscriptionSnapshot": "Subscription Snapshot",
        "reference": "Reference",
        "customer": "Customer",
        "product": "Product",
        "variant": "Variant",
        "changedFields": "Changed Fields",
        "noChangedFields": "No changed fields captured",
        "previousState": "Previous State",
        "newState": "New State",
        "metadata": "Metadata",
        "noData": "No data"
      }
    }
```

Note the duplicated keys with Plan 2's `subscriptions.timeline.*` — this page has its own copies of the same formatters, and Plan 2's keys are bound to `subscriptions.*`. Reusing `subscriptions.timeline.*` here is tempting but couples the activity-log domain to the subscriptions namespace; the plan keeps them separate. The duplication is a known, accepted cost.

- [ ] **Step 2: Add the same keys to zhCN.json**

```json
    "activityLog": {
      "list": {
        "title": "操作日志",
        "description": "查看续订、催款、取消与挽留等流程中的订阅生命周期事件。",
        "loadError": "加载操作日志条目失败。",
        "emptyFiltered": "没有日志条目与当前筛选匹配",
        "emptyFilteredHint": "请尝试修改搜索词或调整筛选条件。",
        "empty": "暂无操作日志条目",
        "emptyHint": "订阅工作流执行后，操作日志条目将显示在这里。"
      },
      "columns": {
        "created": "创建时间",
        "actor": "操作者",
        "event": "事件",
        "reason": "原因",
        "summary": "摘要"
      },
      "filters": {
        "addFilter": "添加筛选",
        "quickPresets": "快捷预设",
        "eventType": "事件类型",
        "preset": "预设",
        "createdFrom": "创建时间起",
        "createdTo": "创建时间至"
      },
      "actor": {
        "admin": "管理员",
        "customer": "客户",
        "system": "系统",
        "scheduler": "调度器"
      },
      "domain": {
        "subscriptions": "订阅",
        "renewals": "续订",
        "dunning": "催款",
        "cancellations": "取消与挽留",
        "unknown": "活动"
      },
      "summaryFields": {
        "subscriptionCreated": "订阅已创建",
        "pendingUpdateData": "已安排方案变更",
        "status": "状态已变更",
        "recipient": "收件人已更新",
        "address": "地址",
        "addressLinesChanged": "地址已更新",
        "postalCodeChanged": "邮政编码已更新",
        "phoneChanged": "电话已更新",
        "countryCode": "国家已更新",
        "province": "省份已更新",
        "city": "城市已更新"
      },
      "eventDetail": {
        "title": "操作日志事件",
        "loading": "正在加载事件详情……",
        "loadError": "加载操作日志详情失败。",
        "close": "关闭",
        "overview": "概览",
        "event": "事件",
        "domain": "所属域",
        "actor": "操作者",
        "created": "创建时间",
        "reason": "原因",
        "summary": "摘要",
        "subscriptionSnapshot": "订阅快照",
        "reference": "订阅编号",
        "customer": "客户",
        "product": "商品",
        "variant": "变体",
        "changedFields": "变更字段",
        "noChangedFields": "未记录变更字段",
        "previousState": "变更前状态",
        "newState": "变更后状态",
        "metadata": "元数据",
        "noData": "无数据"
      }
    }
```

- [ ] **Step 3: Verify parity and commit**

```bash
yarn test:i18n
```

Propose to the user and wait for approval:

```
feat(i18n): add activity log translation keys
```

```bash
git add src/admin/i18n/json
git commit -m "feat(i18n): add activity log translation keys"
```

---

## Task 2: Translate the activity-log page

**Files:**
- Modify: `src/admin/routes/subscriptions/activity-log/page.tsx:37-110` (module scope), `:814-1000` (formatters), and JSX

**Interfaces:**
- Consumes: Task 1 keys.
- Produces, local to this file:
  - `ACTIVITY_ACTOR_KEYS: Record<ActivityLogAdminActorType, string>`
  - `ACTIVITY_DOMAIN_KEYS: Record<string, string>` — keyed by the event-type *prefix* (`"subscription."`, `"renewal."`, `"dunning."`, `"cancellation."`)
  - `ACTIVITY_SUMMARY_FIELD_KEYS: Record<string, string>`
  - `formatDomainLabel(value: string, t: TFunction): string`
  - `formatActorType(value: ActivityLogAdminActorType, t: TFunction): string`
  - `formatSummaryField(value: string, t: TFunction): string`
  - `formatDateTime(value: string | null, emptyValue: string): string`
  - `formatUnknown(value: unknown, emptyValue: string): string`

- [ ] **Step 1: Move module-scope definitions inside the component**

Keep `columnHelper` (line 37) and `DEFAULT_DATE_TO` at module scope. Move `actorFilterOptions` (39), `domainPresetOptions` (46), and `baseColumns` (95) into `ActivityLogPage` as `useMemo` with zero string changes. Verify `yarn build` before continuing.

- [ ] **Step 2: Add imports, hook, and three key maps**

```tsx
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
```

```tsx
const ACTIVITY_ACTOR_KEYS: Record<ActivityLogAdminActorType, string> = {
  [ActivityLogAdminActorType.USER]: "activityLog.actor.admin",
  [ActivityLogAdminActorType.CUSTOMER]: "activityLog.actor.customer",
  [ActivityLogAdminActorType.SYSTEM]: "activityLog.actor.system",
  [ActivityLogAdminActorType.SCHEDULER]: "activityLog.actor.scheduler",
};

const ACTIVITY_DOMAIN_KEYS: Record<string, string> = {
  "subscription.": "activityLog.domain.subscriptions",
  "renewal.": "activityLog.domain.renewals",
  "dunning.": "activityLog.domain.dunning",
  "cancellation.": "activityLog.domain.cancellations",
};

const ACTIVITY_SUMMARY_FIELD_KEYS: Record<string, string> = {
  subscription_created: "activityLog.summaryFields.subscriptionCreated",
  pending_update_data: "activityLog.summaryFields.pendingUpdateData",
  status: "activityLog.summaryFields.status",
  recipient: "activityLog.summaryFields.recipient",
  address: "activityLog.summaryFields.address",
  address_lines_changed: "activityLog.summaryFields.addressLinesChanged",
  postal_code_changed: "activityLog.summaryFields.postalCodeChanged",
  phone_changed: "activityLog.summaryFields.phoneChanged",
  country_code: "activityLog.summaryFields.countryCode",
  province: "activityLog.summaryFields.province",
  city: "activityLog.summaryFields.city",
};
```

Add `const { t } = useTranslation("reorder");` as the first line of the component body.

- [ ] **Step 3: Convert the formatters**

`formatDomainLabel` (line 823):

```tsx
function formatDomainLabel(value: string, t: TFunction) {
  for (const [prefix, key] of Object.entries(ACTIVITY_DOMAIN_KEYS)) {
    if (value.startsWith(prefix)) {
      return t(key);
    }
  }

  return t("activityLog.domain.unknown");
}
```

`formatEventType` (line 814) title-cases backend strings — leave it; same decision as Plan 2.

`getActorDisplay` (line 846) calls `formatActorType` — add `, t`.

`formatSummary` (line 849) — same shape as Plan 2's `formatActivitySummary`: `t("activityLog.eventDetail.noData")` is not right here; the "No summary" string needs a key. Add `"noSummary": "No summary"` / `"无摘要"` to `activityLog.eventDetail` in both JSON files, then:

```tsx
function formatSummary(
  log: Pick<ActivityLogAdminListItem, "change_summary" | "reason">,
  t: TFunction,
) {
  if (log.reason) {
    return log.reason;
  }

  if (!log.change_summary) {
    return t("activityLog.eventDetail.noSummary");
  }

  return log.change_summary
    .split(",")
    .map((part) => formatSummaryField(part.trim(), t))
    .filter(Boolean)
    .join(", ");
}
```

`formatSummaryField` (line 868):

```tsx
function formatSummaryField(value: string, t: TFunction) {
  const key = ACTIVITY_SUMMARY_FIELD_KEYS[value];

  if (key) {
    return t(key);
  }

  return value
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}
```

`formatActorType` (line 923):

```tsx
function formatActorType(value: ActivityLogAdminActorType, t: TFunction) {
  return t(ACTIVITY_ACTOR_KEYS[value]);
}
```

`formatDateTime` (line 949) gains `emptyValue`, plus the `Number.isNaN` guard returns `emptyValue` too. `formatUnknown` (line 966) gains `emptyValue`. The `getActorColor`, `getEventColor`, `addDays`, `removeFilter`, `toLocalDateTimeInputValue` helpers stay untouched.

- [ ] **Step 4: Translate options, columns, filters, and JSX**

`actorFilterOptions` (inside the component now) → `{ label: t("activityLog.actor.admin"), value: ActivityLogAdminActorType.USER }` etc.

`domainPresetOptions` — the four presets have a `label` plus a list of backend event-type strings. Translate only the labels: `t("activityLog.domain.subscriptions")` etc. Copy every `eventTypes` array verbatim.

Columns (in the `columns` useMemo):

| Line | Change |
|------|--------|
| 121, 123 | `t("activityLog.columns.created")` |
| 131, 133 | `t("activityLog.columns.actor")` |
| 141, 143 | `t("activityLog.columns.event")` |
| 154, 156 | `t("activityLog.columns.reason")` |

Header:

| Line | Change |
|------|--------|
| 266, 296 | `{t("activityLog.list.title")}` |
| 268, 298 | `{t("activityLog.list.description")}` |
| 278 | fallback → `t("activityLog.list.loadError")` |
| 308 | `label={t("activityLog.filters.preset")}` |
| 353 | `{t("activityLog.filters.addFilter")}` |
| 359 | `{t("activityLog.filters.quickPresets")}` |
| 383 | `{t("activityLog.filters.eventType")}` |
| 408 | `<DropdownMenu.SubMenuTrigger>{t("activityLog.columns.actor")}</DropdownMenu.SubMenuTrigger>` |
| 446 | `{t("common.filters.clearAll")}` |
| 455 | `{t("activityLog.filters.createdFrom")}` |
| 474 | `{t("activityLog.filters.createdTo")}` |
| 494 | `placeholder={t("common.actions.search")}` |
| 572-573 | `{hasActiveFilters \|\| search ? t("activityLog.list.emptyFiltered") : t("activityLog.list.empty")}` |
| 577-578 | `{hasActiveFilters \|\| search ? t("activityLog.list.emptyFilteredHint") : t("activityLog.list.emptyHint")}` |

The activity-log page also has its own `FilterChip` with the literal `is` — apply the `t("common.filters.is")` pattern and its own hook call.

- [ ] **Step 5: Translate the event drawer**

The drawer at lines 598-625 and the `ActivityLogDetailContent`-style block after it mirror Plan 2's structure. Translate: `Drawer.Title` → `t("activityLog.eventDetail.title")`; `"Loading event details..."` → `t("activityLog.eventDetail.loading")`; load error → `t("activityLog.eventDetail.loadError")`; `Close` → `t("activityLog.eventDetail.close")`; and the block titles/rows: `Overview` → `t("activityLog.eventDetail.overview")`, row labels `Event`/`Domain`/`Actor`/`Created`/`Reason`/`Summary`, `Subscription Snapshot` → `t("activityLog.eventDetail.subscriptionSnapshot")` with its four rows, `Changed Fields` → `t("activityLog.eventDetail.changedFields")`, `"No changed fields captured"` → `t("activityLog.eventDetail.noChangedFields")`, and the three JsonBlock titles `Previous State` / `New State` / `Metadata` → `t("activityLog.eventDetail.previousState")` etc. The `"No data"` fallback inside JsonBlock → `t("activityLog.eventDetail.noData")`.

Where the block is a separate component (like Plan 2's `ActivityLogDetailContent`), it needs its own `useTranslation("reorder")` call.

- [ ] **Step 6: Verify, build, test, commit**

```bash
grep -nE '(header|label|title|placeholder|sortLabel)(:|=) *"[A-Z]' src/admin/routes/subscriptions/activity-log/page.tsx
grep -nE '>[A-Z][a-zA-Z ]{3,}<' src/admin/routes/subscriptions/activity-log/page.tsx
grep -nE 'return "[A-Z]' src/admin/routes/subscriptions/activity-log/page.tsx
yarn build && yarn test:i18n
```

Propose to the user and wait for approval:

```
feat(i18n): translate activity log page
```

```bash
git add src/admin/routes/subscriptions/activity-log/page.tsx
git commit -m "feat(i18n): translate activity log page"
```

---

## Task 3: Add analytics keys and translate the analytics page

**Files:**
- Modify: `src/admin/i18n/json/en.json`, `src/admin/i18n/json/zhCN.json`
- Modify: `src/admin/routes/subscriptions/analytics/page.tsx` (1172 lines, 53 strings)

**Interfaces:**
- Consumes: `subscriptions.status.*` from Plan 2.
- Produces: `analytics.*` area, `ANALYTICS_STATUS_KEYS`, `ANALYTICS_GROUP_BY_KEYS` maps, and converted formatters.

**Backend-label exception.** `metric.label` — the KPI names `MRR`, `Churn Rate`, `LTV`, `Active Subscriptions`, `Created Subscriptions` — comes from `METRIC_LABELS` in `src/modules/analytics/utils/admin-query.ts:110` and stays English by the plan-level decision. The KPI cards will show Chinese page chrome with English metric names. Accept that; do not attempt a client-side metric-name map — the `AnalyticsMetricKey` enum is available in the DTO but the mapping was explicitly removed from scope.

- [ ] **Step 1: Add to en.json, as a sibling of `common`**

```json
    "analytics": {
      "list": {
        "title": "Analytics",
        "description": "Track subscription KPIs, trends, churn, and revenue over time.",
        "loadError": "Failed to load analytics data.",
        "trendOverview": "Trend overview",
        "noDataRange": "No analytics data for this range",
        "noBuckets": "No buckets returned for the current range.",
        "noComparisonWindow": "No comparison window available yet.",
        "noDailyBuckets": "No daily buckets available",
        "noTrendPoints": "No trend points available",
        "insufficientSnapshot": "This metric does not have enough snapshot data for the selected filters.",
        "invalidDateRange": "Pick a valid date range to inspect daily subscription creation."
      },
      "filters": {
        "addFilter": "Add filter",
        "dateFrom": "Date from",
        "dateTo": "Date to",
        "groupBy": "Group by"
      },
      "groupBy": {
        "day": "Day",
        "week": "Week",
        "month": "Month"
      },
      "status": {
        "active": "Active",
        "paused": "Paused",
        "pastDue": "Past due",
        "cancelled": "Cancelled"
      },
      "frequency": {
        "weekly": "Weekly",
        "every2Weeks": "Every 2 weeks",
        "monthly": "Monthly",
        "quarterly": "Quarterly",
        "yearly": "Yearly",
        "everyNWeeks": "Every {{value}} weeks",
        "everyNMonths": "Every {{value}} months",
        "everyNYears": "Every {{value}} years"
      },
      "units": {
        "currency": "Currency",
        "percent": "Percent",
        "count": "Subscriptions",
        "unavailable": "Unavailable"
      },
      "trend": {
        "flat": "Flat vs previous window · {{delta}}",
        "up": "Trending up vs previous window · {{delta}}",
        "down": "Trending down vs previous window · {{delta}}"
      }
    }
```

- [ ] **Step 2: Add the same keys to zhCN.json**

```json
    "analytics": {
      "list": {
        "title": "数据分析",
        "description": "追踪订阅关键指标、趋势、流失和收入。",
        "loadError": "加载数据分析失败。",
        "trendOverview": "趋势概览",
        "noDataRange": "此时间范围内没有数据分析结果",
        "noBuckets": "当前范围未返回任何数据分桶。",
        "noComparisonWindow": "暂无可比较的上一个窗口。",
        "noDailyBuckets": "暂无每日数据分桶",
        "noTrendPoints": "暂无趋势数据点",
        "insufficientSnapshot": "当前筛选条件下，此指标的快照数据不足。",
        "invalidDateRange": "请选择有效的日期范围以查看每日订阅创建情况。"
      },
      "filters": {
        "addFilter": "添加筛选",
        "dateFrom": "开始日期",
        "dateTo": "结束日期",
        "groupBy": "分组方式"
      },
      "groupBy": {
        "day": "按天",
        "week": "按周",
        "month": "按月"
      },
      "status": {
        "active": "生效中",
        "paused": "已暂停",
        "pastDue": "已逾期",
        "cancelled": "已取消"
      },
      "frequency": {
        "weekly": "每周",
        "every2Weeks": "每两周",
        "monthly": "每月",
        "quarterly": "每季度",
        "yearly": "每年",
        "everyNWeeks": "每 {{value}} 周",
        "everyNMonths": "每 {{value}} 个月",
        "everyNYears": "每 {{value}} 年"
      },
      "units": {
        "currency": "货币",
        "percent": "百分比",
        "count": "订阅数",
        "unavailable": "不可用"
      },
      "trend": {
        "flat": "与上一窗口持平 · {{delta}}",
        "up": "较上一窗口上升 · {{delta}}",
        "down": "较上一窗口下降 · {{delta}}"
      }
    }
```

Note `analytics.status.cancelled` uses the British spelling because it must match the backend key suffix used by `formatStatus` in this file, which switches on `"cancelled"`. Plan 2's `subscriptions.status.cancelled` is reused for the KPI status filter where the value is the same.

- [ ] **Step 3: Add the key maps and hook**

```tsx
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
```

```tsx
const ANALYTICS_STATUS_KEYS: Record<AnalyticsSubscriptionStatus, string> = {
  active: "analytics.status.active",
  paused: "analytics.status.paused",
  past_due: "analytics.status.pastDue",
  cancelled: "analytics.status.cancelled",
};

const ANALYTICS_GROUP_BY_KEYS: Record<AnalyticsGroupBy, string> = {
  [AnalyticsGroupBy.DAY]: "analytics.groupBy.day",
  [AnalyticsGroupBy.WEEK]: "analytics.groupBy.week",
  [AnalyticsGroupBy.MONTH]: "analytics.groupBy.month",
};
```

Add `const { t } = useTranslation("reorder");` as the first line of the component body.

- [ ] **Step 4: Convert the formatters**

`formatStatus` (line 1117) → `t(ANALYTICS_STATUS_KEYS[value])`:

```tsx
function formatStatus(value: AnalyticsSubscriptionStatus, t: TFunction) {
  return t(ANALYTICS_STATUS_KEYS[value]);
}
```

`formatGroupBy` (line 1130):

```tsx
function formatGroupBy(value: AnalyticsGroupBy, t: TFunction) {
  return t(ANALYTICS_GROUP_BY_KEYS[value]);
}
```

`formatFrequency` (line 1141):

```tsx
function formatFrequency(value: AnalyticsFrequencyFilter, t: TFunction) {
  switch (value.interval) {
    case "week":
      return value.value === 1
        ? t("analytics.frequency.weekly")
        : t("analytics.frequency.everyNWeeks", { value: value.value });
    case "month":
      return value.value === 1
        ? t("analytics.frequency.monthly")
        : value.value === 3
          ? t("analytics.frequency.quarterly")
          : t("analytics.frequency.everyNMonths", { value: value.value });
    case "year":
      return value.value === 1
        ? t("analytics.frequency.yearly")
        : t("analytics.frequency.everyNYears", { value: value.value });
  }
}
```

`formatMetricValue` (line 1025) — the `"Unavailable"` return becomes `t("analytics.units.unavailable")`; the `Intl.NumberFormat` calls stay (currency/count formatting is locale-aware via `undefined`, and the `en-US` for USD stays by decision — see the Task 3 header).

`formatMetricDelta` (line 1053) — the `"No comparison window available yet."` return becomes `t("analytics.list.noComparisonWindow")`; the `Trending up/Flat` sentence becomes:

```tsx
  if (direction === "flat") {
    return t("analytics.trend.flat", { delta });
  }

  return t(`analytics.trend.${direction}`, { delta });
```

`formatUnitLabel` (line 1072) — the three unit strings become `t("analytics.units.currency")`, `t("analytics.units.percent")`, `t("analytics.units.count")`.

`formatTrendValue` (line 1083) — `"Unavailable"` → `t("analytics.units.unavailable")`.

`formatSeriesRangeSummary` (line 1095) — builds `A to B`; leave it, since both sides are already locale-formatted dates and the `to` is punctuation-level. If you want it translated, add `analytics.trend.rangeFromTo` — but it is not in the required scope.

`formatDateLabel` (line 1105) — locale-aware via `Intl`, no English; leave.

- [ ] **Step 5: Translate the JSX**

| Line | Change |
|------|--------|
| page heading | `{t("analytics.list.title")}` |
| page description | `{t("analytics.list.description")}` |
| load error fallback | `t("analytics.list.loadError")` |
| `Trend overview` heading | `{t("analytics.list.trendOverview")}` |
| `Date from` / `Date to` | `label={t("analytics.filters.dateFrom")}` / `t("analytics.filters.dateTo")` |
| `Group by` | `label={t("analytics.filters.groupBy")}` |
| `Add filter` | `{t("analytics.filters.addFilter")}` |
| status filter options | `t("analytics.status.active")` etc., from `ANALYTICS_STATUS_KEYS` |
| frequency filter options | `t("analytics.frequency.weekly")`, `t("analytics.frequency.every2Weeks")`, etc. |
| `No analytics data for this range` | `t("analytics.list.noDataRange")` |
| `No buckets returned for the current range.` | `t("analytics.list.noBuckets")` |
| `No daily buckets available` | `t("analytics.list.noDailyBuckets")` |
| `No trend points available` | `t("analytics.list.noTrendPoints")` |
| insufficient-snapshot message | `t("analytics.list.insufficientSnapshot")` |
| invalid-date-range message | `t("analytics.list.invalidDateRange")` |

Every `formatStatus(...)`, `formatGroupBy(...)`, `formatFrequency(...)`, `formatMetricValue(...)`, `formatMetricDelta(...)`, `formatUnitLabel(...)`, `formatTrendValue(...)` call site gains `, t` (or `t` in a position that type-checks).

- [ ] **Step 6: Verify, build, test, commit**

```bash
grep -nE '(header|label|title|placeholder|sortLabel)(:|=) *"[A-Z]' src/admin/routes/subscriptions/analytics/page.tsx
grep -nE '>[A-Z][a-zA-Z ]{3,}<' src/admin/routes/subscriptions/analytics/page.tsx
grep -nE 'return "[A-Z]' src/admin/routes/subscriptions/analytics/page.tsx
yarn build && yarn test:i18n
```

Propose to the user and wait for approval:

```
feat(i18n): translate analytics page
```

```bash
git add src/admin/routes/subscriptions/analytics/page.tsx src/admin/i18n/json
git commit -m "feat(i18n): translate analytics page"
```

- [ ] **Step 7: Verify analytics in the browser**

In Chinese: page title 数据分析, filters 开始日期 / 结束日期 / 分组方式, the `MRR` / `Churn Rate` / `LTV` KPI cards keep English names (expected — backend), the "Unavailable" metric value reads 不可用, and the chart's empty states are Chinese.

---

## Task 4: Add settings keys and translate the subscription-settings page

**Files:**
- Modify: `src/admin/i18n/json/en.json`, `src/admin/i18n/json/zhCN.json`
- Modify: `src/admin/routes/settings/subscription-settings/page.tsx` (655 lines, 25 strings)

**Interfaces:**
- Consumes: nothing new.
- Produces: `settings.*` area, and converted `renewalBehaviorOptions` / `cancellationBehaviorOptions` inside the component.

- [ ] **Step 1: Add to en.json**

```json
    "settings": {
      "list": {
        "title": "Subscription Settings",
        "description": "Manage runtime defaults for trials, dunning, renewals, and cancellation flows.",
        "loadError": "Failed to load subscription settings.",
        "applyHint": "Changes apply to future operations and newly created process state."
      },
      "toast": {
        "updated": "Subscription settings updated"
      },
      "errors": {
        "updateFailed": "Failed to update subscription settings",
        "concurrentEdit": "Settings changed in another session. Refresh the page and try saving again."
      },
      "fields": {
        "defaultTrialDays": "Default trial days",
        "retryIntervals": "Retry intervals",
        "retryIntervalsHint": "Values are stored in minutes and must be strictly increasing.",
        "addInterval": "Add interval",
        "maxDunningAttempts": "Max dunning attempts",
        "defaultRenewalBehavior": "Default renewal behavior",
        "defaultCancellationBehavior": "Default cancellation behavior",
        "processImmediately": "Process immediately",
        "processImmediatelyHint": "New renewal cycles default to immediate processing when no reviewable change is pending.",
        "reviewPendingChanges": "Review pending changes",
        "reviewPendingChangesHint": "New renewal cycles require approval when a pending subscription update becomes applicable.",
        "recommendRetentionFirst": "Recommend retention first",
        "recommendRetentionFirstHint": "New cancellation cases default to the retention evaluation stage.",
        "allowDirectCancellation": "Allow direct cancellation",
        "allowDirectCancellationHint": "Customers can finalize a cancellation without a retention step."
      },
      "sections": {
        "trial": "Trial",
        "dunning": "Dunning",
        "renewals": "Renewals",
        "cancellation": "Cancellation Defaults",
        "trialDescription": "Configure the default trial period applied to future subscription operations.",
        "dunningDescription": "Define the retry schedule used when a new dunning case is created.",
        "renewalsDescription": "Choose the default behavior used when a new renewal cycle is created.",
        "cancellationDescription": "Define how newly created cancellation cases should start."
      },
      "validation": {
        "retryIntervalPositive": "Retry interval must be a positive integer",
        "retryIntervalsIncreasing": "Retry intervals must be strictly increasing",
        "maxAttemptsMatchIntervals": "Max dunning attempts must match the number of retry intervals"
      }
    }
```

- [ ] **Step 2: Add the same keys to zhCN.json**

```json
    "settings": {
      "list": {
        "title": "订阅设置",
        "description": "管理试用、催款、续订和取消流程的运行时默认值。",
        "loadError": "加载订阅设置失败。",
        "applyHint": "更改将应用于未来的操作和新建的流程状态。"
      },
      "toast": {
        "updated": "订阅设置已更新"
      },
      "errors": {
        "updateFailed": "更新订阅设置失败",
        "concurrentEdit": "设置已在其他会话中更改。请刷新页面后重试保存。"
      },
      "fields": {
        "defaultTrialDays": "默认试用天数",
        "retryIntervals": "重试间隔",
        "retryIntervalsHint": "数值以分钟为单位，且必须严格递增。",
        "addInterval": "添加间隔",
        "maxDunningAttempts": "最大催款尝试次数",
        "defaultRenewalBehavior": "默认续订行为",
        "defaultCancellationBehavior": "默认取消行为",
        "processImmediately": "立即处理",
        "processImmediatelyHint": "当没有可审核的变更时，新的续订周期默认立即处理。",
        "reviewPendingChanges": "审核待处理变更",
        "reviewPendingChangesHint": "当待处理的订阅更新生效时，新的续订周期需要审批。",
        "recommendRetentionFirst": "优先建议挽留",
        "recommendRetentionFirstHint": "新的取消案例默认进入挽留评估阶段。",
        "allowDirectCancellation": "允许直接取消",
        "allowDirectCancellationHint": "客户无需挽留步骤即可完成取消。"
      },
      "sections": {
        "trial": "试用",
        "dunning": "催款",
        "renewals": "续订",
        "cancellation": "取消默认设置",
        "trialDescription": "配置应用于未来订阅操作的默认试用期。",
        "dunningDescription": "定义新建催款案例时使用的重试排期。",
        "renewalsDescription": "选择新建续订周期时使用的默认行为。",
        "cancellationDescription": "定义新建取消案例的初始阶段。"
      },
      "validation": {
        "retryIntervalPositive": "重试间隔必须为正整数",
        "retryIntervalsIncreasing": "重试间隔必须严格递增",
        "maxAttemptsMatchIntervals": "最大催款尝试次数必须与重试间隔数量一致"
      }
    }
```

- [ ] **Step 3: Move the two behavior option arrays into the component**

`renewalBehaviorOptions` (line 30) and `cancellationBehaviorOptions` (line 47) are module-scope arrays of `{ value, label, hint }`. Move both into `SubscriptionSettingsPage` as `useMemo` values with `[t]` deps, replacing `label` and `hint` with `t()` calls using the `settings.fields.*` and `settings.fields.*Hint` keys. Keep the `value` strings byte-for-byte — they are API values:

```tsx
  const renewalBehaviorOptions = useMemo(
    () => [
      {
        value: "process_immediately",
        label: t("settings.fields.processImmediately"),
        hint: t("settings.fields.processImmediatelyHint"),
      },
      {
        value: "require_review_for_pending_changes",
        label: t("settings.fields.reviewPendingChanges"),
        hint: t("settings.fields.reviewPendingChangesHint"),
      },
    ],
    [t],
  );

  const cancellationBehaviorOptions = useMemo(
    () => [
      {
        value: "recommend_retention_first",
        label: t("settings.fields.recommendRetentionFirst"),
        hint: t("settings.fields.recommendRetentionFirstHint"),
      },
      {
        value: "allow_direct_cancellation",
        label: t("settings.fields.allowDirectCancellation"),
        hint: t("settings.fields.allowDirectCancellationHint"),
      },
    ],
    [t],
  );
```

Verify the exact `value` strings first:

```bash
sed -n '30,62p' src/admin/routes/settings/subscription-settings/page.tsx
```

This file has no DataTable, so no column/filter restructuring — only these two arrays.

- [ ] **Step 4: Convert the zod validation messages**

The schema in this file (around lines 80-115) has three `message:` strings. They surface through the same `FieldError`-style renderer used elsewhere. Replace them with keys and make the renderer resolve keys:

| Current message | Key |
|-----------------|-----|
| `"Retry interval must be a positive integer"` | `settings.validation.retryIntervalPositive` |
| `"Retry intervals must be strictly increasing"` | `settings.validation.retryIntervalsIncreasing` |
| `"Max dunning attempts must match the number of retry intervals"` | `settings.validation.maxAttemptsMatchIntervals` |

Check whether this file has a `FieldError` component:

```bash
grep -n "FieldError\|form.formState.errors" src/admin/routes/settings/subscription-settings/page.tsx
```

If it renders errors through a local component, apply the resolve-keys pattern from Plan 3 Task 3 Step 2. If it renders `error.message` directly, wrap the render in `t(...)`.

- [ ] **Step 5: Translate the JSX**

| Line | Change |
|------|--------|
| 131, 138, 142, 146 | the four `sections.push(...)` calls inside the "changed sections" computation → `t("settings.sections.trial")`, `t("settings.sections.dunning")`, `t("settings.sections.renewals")`, `t("settings.sections.cancellation")` — read the actual strings (the inventory showed `"Trial"`, `"Dunning"`, `"Renewals"`, `"Cancellation"`) |
| 207 | `t("settings.toast.updated")` |
| 214 | fallback → `t("settings.errors.updateFailed")` |
| 221 | `t("settings.errors.concurrentEdit")` |
| 252, 269, 295 | `{t("settings.list.title")}` |
| 276 | fallback → `t("settings.list.loadError")` |
| 301 | `{t("settings.list.description")}` |
| 309 | `{t("settings.list.applyHint")}` |
| 321 | `{t("common.actions.save")}` — if the button reads `Save` |
| 331-332 | `{form.formState.isDirty ? "Changes will apply after this save completes." : "No unsaved changes."}` — reads as two distinct ephemeral strings; add `settings.save.applyHint` / `settings.save.clean` keys? They map to `"Changes will apply after this save completes."` → `t("settings.list.cleanHint")` and `"No unsaved changes."` → `t("settings.list.saved")`. Add those two keys to both files: `"cleanHint": "Changes will apply after this save completes."` / `"保存完成后更改将生效。"`, `"saved": "No unsaved changes."` / `"没有未保存的更改。"` |
| 344 | `"Using fallback defaults until the first save"` — add `settings.list.fallbackHint` / `"首次保存前使用回退默认值。"` |
| 355 | `"No persisted settings record exists yet."` — add `settings.list.noRecordHint` / `"尚无已持久化的设置记录。"` |
| 364 | `"Updated by system bootstrap or no actor recorded."` — add `settings.list.systemUpdatedHint` / `"由系统引导更新，或未记录操作者。"` |
| 372 | `t("settings.list.resetNotSupported")` — add `"resetNotSupported": "Reset to defaults is not supported yet in the admin UI."` / `"管理界面暂不支持重置为默认值。"` |
| 388 | `"These changes update global defaults for future subscription operations."` — the wide-impact variant at 384 adds the "affects defaults for future renewal, dunning, or cancellation" wording; add `settings.list.wideImpactHint` / `"这些更改影响未来续订、催款或取消操作的默认值。"` and `settings.list.globalDefaultsHint` / `"这些更改更新未来订阅操作的全局默认值。"` — read lines 376-390 to assign exactly |
| 399-400 | `title="Trial"` → `title={t("settings.sections.trial")}`, `description="Configure the default trial period..."` → `description={t("settings.sections.trialDescription")}` |
| 403 | `{t("settings.fields.defaultTrialDays")}` |
| 418-419 | `title={t("settings.sections.dunning")}`, `description={t("settings.sections.dunningDescription")}` |
| 424 | `{t("settings.fields.retryIntervals")}` |
| 430 | `{t("settings.fields.retryIntervalsHint")}` |
| 445 | `{t("settings.fields.addInterval")}` |
| 488 | `{t("settings.fields.maxDunningAttempts")}` |
| 506-507 | `title={t("settings.sections.renewals")}`, `description={t("settings.sections.renewalsDescription")}` |
| 511 | `{t("settings.fields.defaultRenewalBehavior")}` |
| 554-555 | `title={t("settings.sections.cancellation")}`, `description={t("settings.sections.cancellationDescription")}` |
| 559 | `{t("settings.fields.defaultCancellationBehavior")}` |

- [ ] **Step 6: Verify, build, test, commit**

```bash
grep -nE '(header|label|title|placeholder)(:|=) *"[A-Z]' src/admin/routes/settings/subscription-settings/page.tsx
grep -nE '>[A-Z][a-zA-Z ]{3,}<' src/admin/routes/settings/subscription-settings/page.tsx
yarn build && yarn test:i18n
```

Propose to the user and wait for approval:

```
feat(i18n): translate subscription settings page
```

```bash
git add src/admin/routes/settings/subscription-settings/page.tsx src/admin/i18n/json
git commit -m "feat(i18n): translate subscription settings page"
```

---

## Task 5: Final documentation and repo-wide verification

**Files:**
- Create: `docs/admin/i18n.md`
- Modify: `docs/README.md` (add the i18n doc to the admin list)
- Modify: `src/admin/i18n/README.md` (already rewritten in Plan 1; add nothing here)

**Interfaces:**
- Consumes: the finished implementation.
- Produces: user-facing documentation.

- [ ] **Step 1: Create `docs/admin/i18n.md`**

Document, for a reader who knows the plugin but not the i18n work: which languages are supported, that the language is per-user (set in the admin user profile), what the `reorder` namespace is, how to add a string (three rules: key converges on `<domain>.<area>.<key>`, both JSON files updated, `yarn test:i18n` run), the deliberately-English surfaces (backend frequency/discount labels, analytics metric names, event-type title-casing), and a short "known gaps" section (offer-payload descriptions in Plan 5, the `"en-US"` USD formatting).

- [ ] **Step 2: Update `docs/README.md`**

Find the line listing `docs/admin/*.md` (the section that currently lists `docs/admin/subscriptions.md`, `docs/admin/plan-offers.md`, etc.) and add:

```
- `docs/admin/i18n.md`
```

- [ ] **Step 3: Full-repo final sweep**

```bash
grep -rn "label: \"[A-Z]" src/admin --include="*.tsx"
grep -rn ">[A-Z][a-zA-Z ][^<]{2,}" src/admin --include="*.tsx" | grep -v translate
yarn build && yarn test:i18n && yarn test:integration:http
```

Expected: the first grep finds only the `menuItems.*` keys and the `defineRouteConfig` labels; the second finds either nothing or only the known-kept-English strings (backend labels rendered directly, `metric.label`, event-type title-casing); the build and both test suites pass.

- [ ] **Step 4: Commit**

Propose to the user and wait for approval:

```
docs(i18n): document Simplified Chinese admin support
```

```bash
git add docs/admin/i18n.md docs/README.md
git commit -m "docs(i18n): document Simplified Chinese admin support"
```

- [ ] **Step 5: Browser final sweep**

In Chinese, walk every sidebar item one last time and confirm no raw `key.string` literals appear anywhere. Then switch back to English and confirm the UI recovers fully. This is the acceptance gate for the entire six-plan sequence.

---

## Verification summary

```bash
yarn build && yarn test:i18n && yarn test:integration:http
```

With this plan, every `.tsx` file under `src/admin/routes/`, `src/admin/widgets/`, and `src/admin/settings/` routes through i18n. The repo-wide sweep in Task 5 Step 3 is the final gate.

## What Plans 1-6 together produce

- A `reorder` i18n namespace with `en` baseline and `zhCN` translation, contract-tested for key parity and key usage.
- All 16 admin UI files routed through `useTranslation("reorder")` or `translate(...)`, with module-scope column/filter definitions moved into components where hooks require it.
- Backend-generated labels (frequency, discount, analytics metrics) deliberately left English, documented in `docs/admin/i18n.md`.
- A `yarn test:i18n` command that fails the moment a developer uses an undeclared translation key anywhere under `src/admin/`.