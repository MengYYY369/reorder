# Plan 2: Subscriptions Domain

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Translate the subscriptions list page and the subscription detail page — the two largest surfaces in the plugin, 106 unique strings between them.

**Architecture:** Both files follow the pattern proven in Plan 1: `useTranslation("reorder")` inside components, enum-to-key maps for status formatters. The list page needs one structural change that later plans repeat — its DataTable columns and filters are defined at module scope where hooks cannot reach, so they move inside the component wrapped in `useMemo`.

**Tech Stack:** react-i18next 13.5.0, `@medusajs/ui` DataTable helpers.

## Global Constraints

- **Prerequisite: Plan 1 is complete and its Task 5 Step 7 browser check passed.** Namespace `reorder`, language key `zhCN`, `yarn test:i18n` green.
- All code, comments, JSON keys, and commit messages in English. Chinese only as JSON values.
- Conventional Commits `type(scope): description`; propose the message and wait for explicit user approval before committing.
- Key convention `<domain>.<area>.<key>`, lowerCamelCase leaf. Domain here is `subscriptions`.
- Reuse `common.*` and `subscriptions.status.*` from Plan 1. Do not redefine them.
- Backend-generated labels stay English: `row.original.frequency.label`, `row.original.discount.label`, `frequency_label`. Never route them through `t()`.
- Do not refactor unrelated files.

## Keys already defined by Plan 1 — reuse, do not redeclare

`common.actions.cancel`, `common.actions.apply`, `common.fields.id`, `common.fields.product`, `common.fields.variant`, `common.fields.status`, `common.fields.frequency`, `common.fields.discount`, `common.fields.nextRenewal`, `common.fields.subscription`, `common.placeholders.searchProducts`, `common.empty.noValue`, `subscriptions.status.active`, `subscriptions.status.paused`, `subscriptions.status.cancelled`, `subscriptions.status.pastDue`, `subscriptions.breadcrumb`, `menuItems.subscriptions`.

## File Structure

| File | Unique strings | Task |
|------|----------------|------|
| `src/admin/routes/subscriptions/page.tsx` (910 lines) | 30 | 1-3 |
| `src/admin/routes/subscriptions/[id]/page.tsx` (2262 lines) | 93 | 4-6 |
| `src/admin/i18n/json/en.json` | — | 1, 4 |
| `src/admin/i18n/json/zhCN.json` | — | 1, 4 |

The detail page is split across three tasks because 2262 lines in one commit is not reviewable. Each task ends with a green `yarn test:i18n` and a working page.

---

## Task 1: Add the subscriptions list keys

**Files:**
- Modify: `src/admin/i18n/json/en.json`
- Modify: `src/admin/i18n/json/zhCN.json`

**Interfaces:**
- Consumes: the `subscriptions` object created by Plan 1 (holds `breadcrumb`, `orderWidget`, `status`).
- Produces: `subscriptions.list.*`, `subscriptions.columns.*`, `subscriptions.filters.*`, `subscriptions.actions.*`, `subscriptions.toast.*`, `subscriptions.prompt.*`, `subscriptions.errors.*` and two `common.*` additions. Tasks 2-3 consume these; Task 4 adds `subscriptions.detail.*` alongside.

- [ ] **Step 1: Add to en.json**

Add these as siblings of the existing `breadcrumb`, `orderWidget`, and `status` keys inside the `subscriptions` object:

```json
    "list": {
      "title": "Subscriptions",
      "description": "Monitor subscription status, cadence, and upcoming renewals.",
      "loadError": "Failed to load subscriptions.",
      "emptyFiltered": "No matching subscriptions",
      "emptyFilteredHint": "Try changing the search term or active filters.",
      "empty": "No subscriptions yet",
      "emptyHint": "Subscriptions will appear here once customers start recurring orders."
    },
    "columns": {
      "reference": "Reference",
      "projectedAfterSkip": "Projected after skipped cycle",
      "scheduled": "Scheduled"
    },
    "filters": {
      "trial": "Trial",
      "skipNextCycle": "Skip next cycle",
      "overdue": "Overdue",
      "next7Days": "Next 7 days",
      "next30Days": "Next 30 days",
      "next90Days": "Next 90 days"
    },
    "actions": {
      "pause": "Pause",
      "pausing": "Pausing...",
      "resume": "Resume",
      "resuming": "Resuming...",
      "cancel": "Cancel",
      "cancelling": "Cancelling...",
      "cancelSubscription": "Cancel subscription",
      "keepSubscription": "Keep subscription"
    },
    "toast": {
      "paused": "Subscription paused",
      "resumed": "Subscription resumed",
      "cancelled": "Subscription cancelled"
    },
    "errors": {
      "pauseFailed": "Failed to pause subscription",
      "resumeFailed": "Failed to resume subscription",
      "cancelFailed": "Failed to cancel subscription"
    },
    "prompt": {
      "pauseTitle": "Pause subscription?",
      "pauseDescription": "You are about to pause this subscription. Do you want to continue?",
      "resumeTitle": "Resume subscription?",
      "resumeDescription": "You are about to resume this subscription. Do you want to continue?",
      "cancelTitle": "Cancel subscription?",
      "cancelDescription": "You are about to cancel this subscription. This action cannot be undone."
    },
```

And add these to the existing `common` object — `filters` is a new area, `fields.trial` joins the existing `fields`:

```json
    "filters": {
      "yes": "Yes",
      "no": "No",
      "clearAll": "Clear all",
      "clearAllFilters": "Clear all filters",
      "is": "is"
    },
```

plus inside `common.actions`, add:

```json
      "search": "Search"
```

`common.filters.is` deserves a note. `FilterChip` at `src/admin/routes/subscriptions/page.tsx:855-859` renders three cells: label, the literal word `is`, then value — producing `Status is Active`. In Chinese the natural form is `状态：生效中`, so the value becomes a colon rather than a word. That is why this is a translated key and not left as punctuation in the JSX.

- [ ] **Step 2: Add the same keys to zhCN.json**

```json
    "list": {
      "title": "订阅",
      "description": "监控订阅状态、周期和即将到来的续订。",
      "loadError": "加载订阅列表失败。",
      "emptyFiltered": "没有匹配的订阅",
      "emptyFilteredHint": "请尝试修改搜索词或调整筛选条件。",
      "empty": "暂无订阅",
      "emptyHint": "当客户开始周期性订购后，订阅将显示在这里。"
    },
    "columns": {
      "reference": "订阅编号",
      "projectedAfterSkip": "跳过本期后预计",
      "scheduled": "已排期"
    },
    "filters": {
      "trial": "试用",
      "skipNextCycle": "跳过下一周期",
      "overdue": "已逾期",
      "next7Days": "未来 7 天",
      "next30Days": "未来 30 天",
      "next90Days": "未来 90 天"
    },
    "actions": {
      "pause": "暂停",
      "pausing": "正在暂停……",
      "resume": "恢复",
      "resuming": "正在恢复……",
      "cancel": "取消",
      "cancelling": "正在取消……",
      "cancelSubscription": "取消订阅",
      "keepSubscription": "保留订阅"
    },
    "toast": {
      "paused": "订阅已暂停",
      "resumed": "订阅已恢复",
      "cancelled": "订阅已取消"
    },
    "errors": {
      "pauseFailed": "暂停订阅失败",
      "resumeFailed": "恢复订阅失败",
      "cancelFailed": "取消订阅失败"
    },
    "prompt": {
      "pauseTitle": "确认暂停订阅？",
      "pauseDescription": "即将暂停此订阅，是否继续？",
      "resumeTitle": "确认恢复订阅？",
      "resumeDescription": "即将恢复此订阅，是否继续？",
      "cancelTitle": "确认取消订阅？",
      "cancelDescription": "即将取消此订阅，此操作无法撤销。"
    },
```

and in `common`:

```json
    "filters": {
      "yes": "是",
      "no": "否",
      "clearAll": "全部清除",
      "clearAllFilters": "清除所有筛选",
      "is": "："
    },
```

plus inside `common.actions`:

```json
      "search": "搜索"
```

- [ ] **Step 3: Verify parity**

```bash
yarn test:i18n
```

Expected: 3 passing. The third test still passes trivially — no `t()` calls added yet.

- [ ] **Step 4: Commit**

Propose to the user and wait for approval:

```
feat(i18n): add subscriptions list translation keys
```

```bash
git add src/admin/i18n/json
git commit -m "feat(i18n): add subscriptions list translation keys"
```

---

## Task 2: Move the list page columns and filters inside the component

**Files:**
- Modify: `src/admin/routes/subscriptions/page.tsx:44-172` (module-scope definitions), `:352-424` (existing `columns` useMemo), `:429-433` (the `useDataTable` call)

**Interfaces:**
- Consumes: nothing from the JSON yet — this task is pure restructuring with zero string changes.
- Produces: `columns` and `filters` as `useMemo` values inside `SubscriptionsPage`, and `statusFilterOptions` / `booleanFilterOptions` / `nextRenewalFilterOptions` / `statusFilter` / `trialFilter` / `skipNextCycleFilter` / `nextRenewalFilter` all reachable from inside the component. Task 3 adds `t()` calls to them.

**Why this is a separate task:** `baseColumns` (line 67), the four `filterHelper.accessor(...)` calls (lines 140-163), `filters` (line 166), and the three option arrays (lines 48-65) all live at module scope. Hooks cannot be called there. Doing the move and the string replacement in one commit produces a diff where a reviewer cannot tell a restructuring mistake from a translation mistake. This task moves code and changes no strings; Task 3 changes strings and moves no code. Each is separately reviewable.

- [ ] **Step 1: Confirm the current structure**

```bash
grep -nE "^const (statusFilterOptions|booleanFilterOptions|nextRenewalFilterOptions|baseColumns|statusFilter|trialFilter|skipNextCycleFilter|nextRenewalFilter|filters|columnHelper|filterHelper)" src/admin/routes/subscriptions/page.tsx
```

Expected: eleven module-scope declarations at lines 45, 46, 48, 55, 60, 67, 140, 146, 153, 159, 166.

- [ ] **Step 2: Keep the two helpers at module scope, move everything else**

`columnHelper` (line 45) and `filterHelper` (line 46) are factory instances with no strings and no hook dependency. Leave them exactly where they are.

Delete lines 48-172 — the three option arrays, `baseColumns`, the four filter accessors, and `filters` — but keep `type SubscriptionActionType = "pause" | "resume" | "cancel";` (line 173) at module scope, and keep `PAGE_SIZE` (line 43).

- [ ] **Step 3: Re-declare them inside the component**

Insert this immediately after `const navigate = useNavigate();` (line 188), before the existing `statusFilters` useMemo. The bodies are verbatim copies of what was deleted — same option values, same column definitions, same English strings. Only the location changes.

```tsx
  const statusFilterOptions = useMemo(
    () =>
      [
        { label: "Active", value: SubscriptionAdminStatus.ACTIVE },
        { label: "Paused", value: SubscriptionAdminStatus.PAUSED },
        { label: "Cancelled", value: SubscriptionAdminStatus.CANCELLED },
        { label: "Past due", value: SubscriptionAdminStatus.PAST_DUE },
      ] as const,
    [],
  );

  const booleanFilterOptions = useMemo(
    () =>
      [
        { label: "Yes", value: true },
        { label: "No", value: false },
      ] as const,
    [],
  );

  const nextRenewalFilterOptions = useMemo(
    () =>
      [
        { label: "Overdue", value: "overdue" },
        { label: "Next 7 days", value: "next_7_days" },
        { label: "Next 30 days", value: "next_30_days" },
        { label: "Next 90 days", value: "next_90_days" },
      ] as const,
    [],
  );
```

Then the four filter accessors and the `filters` array, still inside the component:

```tsx
  const statusFilter = useMemo(
    () =>
      filterHelper.accessor("status", {
        type: "multiselect",
        label: "Status",
        options: [...statusFilterOptions],
      }),
    [statusFilterOptions],
  );

  const trialFilter = useMemo(
    () =>
      filterHelper.accessor("trial.is_trial", {
        id: "is_trial",
        type: "radio",
        label: "Trial",
        options: [...booleanFilterOptions],
      }),
    [booleanFilterOptions],
  );

  const skipNextCycleFilter = useMemo(
    () =>
      filterHelper.accessor("skip_next_cycle", {
        type: "radio",
        label: "Skip next cycle",
        options: [...booleanFilterOptions],
      }),
    [booleanFilterOptions],
  );

  const nextRenewalFilter = useMemo(
    () =>
      filterHelper.accessor("next_renewal_at", {
        id: "next_renewal",
        type: "radio",
        label: "Next renewal",
        options: [...nextRenewalFilterOptions],
      }),
    [nextRenewalFilterOptions],
  );

  const filters = useMemo(
    () => [statusFilter, trialFilter, skipNextCycleFilter, nextRenewalFilter],
    [statusFilter, trialFilter, skipNextCycleFilter, nextRenewalFilter],
  );
```

- [ ] **Step 4: Fold baseColumns into the existing columns useMemo**

The component already has a `columns` useMemo at line 352 that spreads `baseColumns` and appends an action column. Replace the spread with the column definitions inline. The five accessor columns are copied verbatim from the deleted lines 67-138 — `reference`, `product_title`, `status`, `frequency`, `next_renewal_at` — followed by the existing `columnHelper.action({...})` block unchanged.

Because `formatStatus` and `formatDateTime` (both module-scope functions at lines 809 and 822) are called from inside these cells and neither takes a `t` argument yet, this task leaves both calls exactly as they are. Task 3 changes them.

The useMemo dependency array stays `[pendingActionBySubscriptionId]` — nothing new is referenced yet.

- [ ] **Step 5: Verify nothing changed behaviourally**

```bash
grep -c "Active\|Paused\|Cancelled\|Past due" src/admin/routes/subscriptions/page.tsx
yarn build
```

Expected: the grep count is unchanged from before this task (record it in Step 1 if you want the exact number), and the build succeeds. This task must produce zero string changes — if `git diff` shows a string being added or removed rather than moved, something went wrong.

- [ ] **Step 6: Verify the page still works in the browser**

Open http://localhost:9000/app/subscriptions. Confirm the table renders, all four filters open and apply, sorting works on Product/Status/Next renewal, and the row action menu still offers Pause/Resume/Cancel. A `useMemo` with a wrong dependency array shows up here as a filter that will not clear or a stale action menu.

- [ ] **Step 7: Commit**

Propose to the user and wait for approval:

```
refactor(admin): move subscription list columns and filters into component
```

```bash
git add src/admin/routes/subscriptions/page.tsx
git commit -m "refactor(admin): move subscription list columns and filters into component"
```

---

## Task 3: Translate the list page

**Files:**
- Modify: `src/admin/routes/subscriptions/page.tsx` (30 strings across the restructured file)

**Interfaces:**
- Consumes: `subscriptions.list.*`, `subscriptions.columns.*`, `subscriptions.filters.*`, `subscriptions.actions.*`, `subscriptions.toast.*`, `subscriptions.errors.*`, `subscriptions.prompt.*`, `subscriptions.status.*`, `common.*` from Task 1; the restructured component from Task 2.
- Produces:
  - `SUBSCRIPTION_STATUS_KEYS: Record<SubscriptionAdminStatus, string>` at module scope. **Task 5 imports nothing from here** — the detail page declares its own; these two files do not share module-scope constants today and this plan does not introduce coupling between them.
  - `formatDateTime(value: string | null, emptyValue: string): string` — signature change from one argument to two. Local to this file.
  - `getSubscriptionActionPromptConfig(action: SubscriptionActionType, t: TFunction): {...}` — signature change. Local to this file.

- [ ] **Step 1: Add the hook and the status key map**

Add the import next to the other imports:

```tsx
import { useTranslation } from "react-i18next";
```

Add the map at module scope, next to `getStatusColor` (around line 800):

```tsx
const SUBSCRIPTION_STATUS_KEYS: Record<SubscriptionAdminStatus, string> = {
  [SubscriptionAdminStatus.ACTIVE]: "subscriptions.status.active",
  [SubscriptionAdminStatus.PAUSED]: "subscriptions.status.paused",
  [SubscriptionAdminStatus.CANCELLED]: "subscriptions.status.cancelled",
  [SubscriptionAdminStatus.PAST_DUE]: "subscriptions.status.pastDue",
};
```

Delete the `formatStatus` function at lines 809-820 entirely. It is replaced by `t(SUBSCRIPTION_STATUS_KEYS[status])` at its one call site. Keep `getStatusColor` — colors are not translatable.

Add the hook as the first line of the component body:

```tsx
  const { t } = useTranslation("reorder");
```

- [ ] **Step 2: Change the two helper signatures**

`formatDateTime` returns `"-"` for null. Replace it with:

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

`getSubscriptionActionPromptConfig` builds the confirmation dialog copy. It is called from `handleSubscriptionAction` inside the component, so it can receive `t` as a parameter. Replace the whole function:

```tsx
function getSubscriptionActionPromptConfig(
  action: SubscriptionActionType,
  t: TFunction,
) {
  switch (action) {
    case "pause":
      return {
        title: t("subscriptions.prompt.pauseTitle"),
        description: t("subscriptions.prompt.pauseDescription"),
        confirmText: t("subscriptions.actions.pause"),
        cancelText: t("common.actions.cancel"),
        variant: "confirmation" as const,
      };
    case "resume":
      return {
        title: t("subscriptions.prompt.resumeTitle"),
        description: t("subscriptions.prompt.resumeDescription"),
        confirmText: t("subscriptions.actions.resume"),
        cancelText: t("common.actions.cancel"),
        variant: "confirmation" as const,
      };
    case "cancel":
      return {
        title: t("subscriptions.prompt.cancelTitle"),
        description: t("subscriptions.prompt.cancelDescription"),
        confirmText: t("subscriptions.actions.cancelSubscription"),
        cancelText: t("subscriptions.actions.keepSubscription"),
        variant: "danger" as const,
      };
  }
}
```

`TFunction` comes from i18next — add it to the imports:

```tsx
import type { TFunction } from "i18next";
```

Note that `i18next` is a transitive dependency (resolved at 23.7.11 via `@medusajs/dashboard`) and `.npmrc` hoists `react-i18next` but not `i18next` itself. If this type import fails to resolve, use `ReturnType<typeof useTranslation>["t"]` instead of importing `TFunction` — same type, no new import. Try the import first; it is clearer.

Update the call site in `handleSubscriptionAction` (around line 333):

```tsx
    const confirmed = await prompt(getSubscriptionActionPromptConfig(action, t));
```

- [ ] **Step 3: Translate the filter options and accessors**

In the three option arrays from Task 2, replace each `label` and drop the `as const` (the arrays are no longer literal constants once labels are computed):

```tsx
  const statusFilterOptions = useMemo(
    () => [
      { label: t("subscriptions.status.active"), value: SubscriptionAdminStatus.ACTIVE },
      { label: t("subscriptions.status.paused"), value: SubscriptionAdminStatus.PAUSED },
      { label: t("subscriptions.status.cancelled"), value: SubscriptionAdminStatus.CANCELLED },
      { label: t("subscriptions.status.pastDue"), value: SubscriptionAdminStatus.PAST_DUE },
    ],
    [t],
  );

  const booleanFilterOptions = useMemo(
    () => [
      { label: t("common.filters.yes"), value: true },
      { label: t("common.filters.no"), value: false },
    ],
    [t],
  );

  const nextRenewalFilterOptions = useMemo(
    () => [
      { label: t("subscriptions.filters.overdue"), value: "overdue" },
      { label: t("subscriptions.filters.next7Days"), value: "next_7_days" },
      { label: t("subscriptions.filters.next30Days"), value: "next_30_days" },
      { label: t("subscriptions.filters.next90Days"), value: "next_90_days" },
    ],
    [t],
  );
```

Every `useMemo` that now calls `t` must list `t` in its dependency array. Miss this and the labels freeze in the language that was active at first render — the bug appears only after switching language without a reload, which is easy to miss in testing.

Then the four filter accessors:

- `statusFilter` → `label: t("common.fields.status")`, deps `[statusFilterOptions, t]`
- `trialFilter` → `label: t("subscriptions.filters.trial")`, deps `[booleanFilterOptions, t]`
- `skipNextCycleFilter` → `label: t("subscriptions.filters.skipNextCycle")`, deps `[booleanFilterOptions, t]`
- `nextRenewalFilter` → `label: t("common.fields.nextRenewal")`, deps `[nextRenewalFilterOptions, t]`

- [ ] **Step 4: Translate the columns**

Inside the `columns` useMemo, replace the headers and cell strings:

| Column | Change |
|--------|--------|
| `reference` | `header: t("subscriptions.columns.reference")` |
| `product_title` | `header: t("common.fields.product")`, `sortLabel: t("common.fields.product")` |
| `status` | `header: t("common.fields.status")`, `sortLabel: t("common.fields.status")`, cell renders `{t(SUBSCRIPTION_STATUS_KEYS[getValue()])}` |
| `frequency` | `header: t("common.fields.frequency")` — the cell keeps `{getValue()}` and `{row.original.discount.label}` as backend English |
| `next_renewal_at` | `header: t("common.fields.nextRenewal")`, `sortLabel: t("common.fields.nextRenewal")`, cell's ternary becomes `{row.original.skip_next_cycle ? t("subscriptions.columns.projectedAfterSkip") : t("subscriptions.columns.scheduled")}`, and the `formatDateTime(...)` call gains `, t("common.empty.noValue")` |

In the action column, the three `label` values:

```tsx
                    label: pendingAction === "pause" ? t("subscriptions.actions.pausing") : t("subscriptions.actions.pause"),
```

```tsx
                    label: pendingAction === "resume" ? t("subscriptions.actions.resuming") : t("subscriptions.actions.resume"),
```

```tsx
                    label: pendingAction === "cancel" ? t("subscriptions.actions.cancelling") : t("subscriptions.actions.cancel"),
```

Update the useMemo dependency array to `[pendingActionBySubscriptionId, t]`.

- [ ] **Step 5: Translate the mutation toasts**

Six strings across the three mutations at lines 244-302:

- pause: `toast.success(t("subscriptions.toast.paused"))`, error fallback `t("subscriptions.errors.pauseFailed")`
- resume: `toast.success(t("subscriptions.toast.resumed"))`, error fallback `t("subscriptions.errors.resumeFailed")`
- cancel: `toast.success(t("subscriptions.toast.cancelled"))`, error fallback `t("subscriptions.errors.cancelFailed")`

Keep `error instanceof Error ? error.message : ...` intact. `error.message` is a server message and stays as-is; only the fallback is translated.

- [ ] **Step 6: Translate the page chrome**

| Location | Change |
|----------|--------|
| line 459 and 479 (both `Heading`) | `{t("subscriptions.list.title")}` |
| line 461 and 481 (both descriptions) | `{t("subscriptions.list.description")}` |
| line 468 (Alert fallback) | `t("subscriptions.list.loadError")` |
| line 682 (`Clear all filters`) | `{t("common.filters.clearAllFilters")}` |
| line 696 (`Clear all`) | `{t("common.filters.clearAll")}` |
| line 703 (`placeholder="Search"`) | `placeholder={t("common.actions.search")}` |
| lines 778-780 (empty state title ternary) | `{hasActiveFilters \|\| search ? t("subscriptions.list.emptyFiltered") : t("subscriptions.list.empty")}` |
| lines 783-785 (empty state hint ternary) | `{hasActiveFilters \|\| search ? t("subscriptions.list.emptyFilteredHint") : t("subscriptions.list.emptyHint")}` |

The heading and description appear twice — once in the `isError` early return at 455-471, once in the main return. Both need changing.

- [ ] **Step 7: Translate FilterChip**

`FilterChip` at line 844 is a separate component below `SubscriptionsPage`, so it needs its own hook. Add as the first line of its body:

```tsx
  const { t } = useTranslation("reorder");
```

and replace the literal `is` at lines 856-858:

```tsx
      <span className="border-ui-border-base border-r px-3 py-1.5 text-ui-fg-subtle">
        {t("common.filters.is")}
      </span>
```

- [ ] **Step 8: Verify no English literals remain**

```bash
grep -nE '(header|label|title|placeholder|sortLabel|confirmText|cancelText):? *=? *"[A-Z]' src/admin/routes/subscriptions/page.tsx
grep -nE '>[A-Z][a-zA-Z ]{3,}<' src/admin/routes/subscriptions/page.tsx
grep -nE 'toast\.(success|error)\("' src/admin/routes/subscriptions/page.tsx
```

Expected: no output from any of the three. The only permitted remaining capitalized strings are the `label: "menuItems.subscriptions"` in `defineRouteConfig` (a key, set by Plan 1) and the `SUBSCRIPTION_STATUS_KEYS` values (keys).

- [ ] **Step 9: Build and test**

```bash
yarn build && yarn test:i18n
```

Expected: build succeeds, 3 tests pass with roughly 40 new keys verified.

- [ ] **Step 10: Verify in the browser**

Open http://localhost:9000/app/subscriptions in Chinese. Check specifically:

- Column headers: 订阅编号, 商品, 状态, 频率, 下次续订
- Status badges show 生效中 / 已暂停 / 已取消 / 已逾期
- The frequency column still shows English `Every month` — expected, backend label
- Open the filter menu: 状态, 试用, 跳过下一周期, 下次续订; the trial filter offers 是 / 否
- Apply a filter and confirm the chip reads `状态：生效中` rather than `状态 is 生效中`
- Trigger Pause from the row menu and confirm the dialog is Chinese, then confirm the success toast reads 订阅已暂停
- **Switch the language back to English without reloading the page.** Every label should switch immediately. If any stay Chinese, a `useMemo` is missing `t` in its dependency array.

- [ ] **Step 11: Commit**

Propose to the user and wait for approval:

```
feat(i18n): translate subscriptions list page
```

```bash
git add src/admin/routes/subscriptions/page.tsx
git commit -m "feat(i18n): translate subscriptions list page"
```

---

## Task 4: Add the subscription detail keys

**Files:**
- Modify: `src/admin/i18n/json/en.json`
- Modify: `src/admin/i18n/json/zhCN.json`

**Interfaces:**
- Consumes: the `subscriptions` object as extended by Task 1.
- Produces: `subscriptions.detail.*`, `subscriptions.fields.*`, `subscriptions.planChange.*`, `subscriptions.address.*`, `subscriptions.timeline.*`, plus `common.fields.*` and `common.empty.*` additions. Tasks 5 and 6 consume these.

The detail page is `src/admin/routes/subscriptions/[id]/page.tsx`, 2262 lines, 93 unique strings. It contains the subscription overview, a customer block, a product block, an embedded Activity Log timeline with its own DataTable and filters, a plan-change drawer, a shipping-address drawer, and an activity-event detail drawer. The keys below are grouped to match those regions.

- [ ] **Step 1: Add to en.json inside the `subscriptions` object**

```json
    "detail": {
      "title": "Subscription",
      "loading": "Loading subscription details...",
      "loadError": "Failed to load subscription details.",
      "unavailable": "Subscription details are unavailable.",
      "noLinkedOrders": "No linked orders yet",
      "sections": {
        "overview": "Overview",
        "pendingPlanChange": "Pending plan change",
        "activityLog": "Activity Log",
        "customer": "Customer",
        "product": "Product",
        "orders": "Orders",
        "subscriptionSnapshot": "Subscription snapshot",
        "changedFields": "Changed fields",
        "previousState": "Previous state",
        "newState": "New state",
        "metadata": "Metadata"
      }
    },
    "fields": {
      "startedAt": "Started at",
      "lastRenewal": "Last renewal",
      "latestRenewal": "Latest renewal",
      "renewalNumbered": "Renewal {{index}}",
      "initialOrder": "Initial order",
      "effectiveAt": "Effective at",
      "variantId": "Variant ID",
      "customerId": "Customer ID",
      "email": "Email",
      "sku": "SKU",
      "reason": "Reason",
      "summary": "Summary",
      "event": "Event",
      "actor": "Actor",
      "created": "Created",
      "createdFrom": "Created from",
      "createdTo": "Created to",
      "domain": "Domain"
    },
    "planChange": {
      "title": "Schedule plan change",
      "frequencyInterval": "Frequency interval",
      "frequencyValue": "Frequency value",
      "selectVariant": "Select a variant",
      "selectInterval": "Select interval",
      "loadingVariants": "Loading variants...",
      "noVariants": "No variants are available for this product.",
      "variantLoadError": "Failed to load product variants.",
      "toast": "Plan change scheduled",
      "error": "Failed to schedule plan change",
      "errors": {
        "variantRequired": "Select a variant",
        "frequencyValueInvalid": "Frequency value must be a positive integer"
      }
    },
    "address": {
      "title": "Edit shipping address",
      "firstName": "First name",
      "lastName": "Last name",
      "company": "Company",
      "city": "City",
      "postalCode": "Postal code",
      "province": "Province / State",
      "countryCode": "Country code",
      "country": "Country",
      "phone": "Phone",
      "recipient": "Recipient",
      "address": "Address",
      "toast": "Shipping address updated",
      "error": "Failed to update shipping address",
      "errors": {
        "missingFields": "Fill in all required address fields",
        "invalidPostalOrCountry": "Enter a valid postal code and 2-letter country code"
      }
    },
    "timeline": {
      "eventTitle": "Activity Log Event",
      "eventLoading": "Loading activity event...",
      "eventLoadError": "Failed to load activity event details.",
      "loading": "Loading activity log...",
      "loadError": "Failed to load activity log.",
      "noSummary": "No summary",
      "noChangedFields": "No changed fields captured",
      "noData": "No data",
      "actors": {
        "admin": "Admin",
        "customer": "Customer",
        "system": "System",
        "scheduler": "Scheduler"
      },
      "domains": {
        "subscriptions": "Subscriptions",
        "renewals": "Renewals",
        "dunning": "Dunning",
        "cancellations": "Cancellation & Retention"
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
      }
    },
    "intervals": {
      "week": "Weekly",
      "month": "Monthly",
      "year": "Yearly"
    },
```

Also add to `common.fields`: `"reference": "Reference"`, `"customer": "Customer"`, `"order": "Order"`. And to `common.actions`: `"save": "Save"`.

`subscriptions.fields.renewalNumbered` uses `{{index}}` because line 1421 currently builds `` `Renewal ${index + 1}` `` by template literal. In Chinese the number precedes the noun (`第 2 次续订`), so concatenation cannot work.

- [ ] **Step 2: Add the same keys to zhCN.json**

```json
    "detail": {
      "title": "订阅",
      "loading": "正在加载订阅详情……",
      "loadError": "加载订阅详情失败。",
      "unavailable": "订阅详情不可用。",
      "noLinkedOrders": "暂无关联订单",
      "sections": {
        "overview": "概览",
        "pendingPlanChange": "待生效的方案变更",
        "activityLog": "操作日志",
        "customer": "客户",
        "product": "商品",
        "orders": "订单",
        "subscriptionSnapshot": "订阅快照",
        "changedFields": "变更字段",
        "previousState": "变更前状态",
        "newState": "变更后状态",
        "metadata": "元数据"
      }
    },
    "fields": {
      "startedAt": "开始时间",
      "lastRenewal": "上次续订",
      "latestRenewal": "最近一次续订",
      "renewalNumbered": "第 {{index}} 次续订",
      "initialOrder": "首次订单",
      "effectiveAt": "生效时间",
      "variantId": "变体 ID",
      "customerId": "客户 ID",
      "email": "邮箱",
      "sku": "SKU",
      "reason": "原因",
      "summary": "摘要",
      "event": "事件",
      "actor": "操作者",
      "created": "创建时间",
      "createdFrom": "创建时间起",
      "createdTo": "创建时间至",
      "domain": "所属域"
    },
    "planChange": {
      "title": "安排方案变更",
      "frequencyInterval": "频率单位",
      "frequencyValue": "频率数值",
      "selectVariant": "选择变体",
      "selectInterval": "选择频率单位",
      "loadingVariants": "正在加载变体……",
      "noVariants": "此商品没有可用的变体。",
      "variantLoadError": "加载商品变体失败。",
      "toast": "方案变更已安排",
      "error": "安排方案变更失败",
      "errors": {
        "variantRequired": "请选择变体",
        "frequencyValueInvalid": "频率数值必须为正整数"
      }
    },
    "address": {
      "title": "编辑收货地址",
      "firstName": "名",
      "lastName": "姓",
      "company": "公司",
      "city": "城市",
      "postalCode": "邮政编码",
      "province": "省 / 州",
      "countryCode": "国家代码",
      "country": "国家",
      "phone": "电话",
      "recipient": "收件人",
      "address": "地址",
      "toast": "收货地址已更新",
      "error": "更新收货地址失败",
      "errors": {
        "missingFields": "请填写所有必填地址字段",
        "invalidPostalOrCountry": "请输入有效的邮政编码和两位国家代码"
      }
    },
    "timeline": {
      "eventTitle": "操作日志事件",
      "eventLoading": "正在加载操作日志事件……",
      "eventLoadError": "加载操作日志事件详情失败。",
      "loading": "正在加载操作日志……",
      "loadError": "加载操作日志失败。",
      "noSummary": "无摘要",
      "noChangedFields": "未记录变更字段",
      "noData": "无数据",
      "actors": {
        "admin": "管理员",
        "customer": "客户",
        "system": "系统",
        "scheduler": "调度器"
      },
      "domains": {
        "subscriptions": "订阅",
        "renewals": "续订",
        "dunning": "催款",
        "cancellations": "取消与挽留"
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
      }
    },
    "intervals": {
      "week": "每周",
      "month": "每月",
      "year": "每年"
    },
```

And in `common.fields`: `"reference": "订阅编号"`, `"customer": "客户"`, `"order": "订单"`. And in `common.actions`: `"save": "保存"`.

- [ ] **Step 3: Verify parity**

```bash
yarn test:i18n
```

Expected: 3 passing.

- [ ] **Step 4: Commit**

Propose to the user and wait for approval:

```
feat(i18n): add subscription detail translation keys
```

```bash
git add src/admin/i18n/json
git commit -m "feat(i18n): add subscription detail translation keys"
```

---

## Task 5: Convert the detail page's module-scope formatters

**Files:**
- Modify: `src/admin/routes/subscriptions/[id]/page.tsx:73-77` (`intervalOptions`), `:82-87` (`activityLogActorFilterOptions`), `:89-135` (`activityLogDomainFilterOptions`), `:1987-1998` (`formatStatus`), `:2000-2010` (`formatFrequency`), `:2011-2020` (`formatDateTime`), `:2048-2079` (`getSubscriptionActionPromptConfig`), `:2142-2164` (`formatActivityEventType`, `formatActivityActorType`), `:2166-2170` (`getActivityActorDisplay`), `:2172-2220` (`formatActivitySummary`, `formatActivitySummaryField`), `:2235-2249` (`formatUnknown`)

**Interfaces:**
- Consumes: keys from Task 4.
- Produces, all local to this file — Task 6 calls every one of these:
  - `SUBSCRIPTION_STATUS_KEYS: Record<SubscriptionAdminStatus, string>`
  - `INTERVAL_KEYS: Record<SubscriptionFrequencyInterval, string>`
  - `ACTIVITY_ACTOR_KEYS: Record<ActivityLogAdminActorType, string>`
  - `ACTIVITY_SUMMARY_FIELD_KEYS: Record<string, string>`
  - `formatDateTime(value: string | null, emptyValue: string): string`
  - `formatUnknown(value: unknown, emptyValue: string): string`
  - `getActivityActorDisplay(log, t: TFunction): string`
  - `formatActivitySummary(log, t: TFunction): string`
  - `formatActivitySummaryField(value: string, t: TFunction): string`
  - `getSubscriptionActionPromptConfig(action: SubscriptionActionType, t: TFunction): {...}`

**Why formatters come before JSX:** this file has eleven module-scope functions returning English. Converting them first means Task 6's JSX changes are pure call-site edits, and any signature mistake surfaces here as a compile error rather than mixed in with 90 string replacements.

- [ ] **Step 1: Add the imports**

```tsx
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
```

If `TFunction` does not resolve (see the note in Task 3 Step 2 — `i18next` is transitive and not hoisted by `.npmrc`), substitute `type TFunction = ReturnType<typeof useTranslation>["t"]` declared locally at module scope.

- [ ] **Step 2: Replace the four enum-to-label functions with key maps**

Delete `formatStatus` (lines 1987-1998) and `formatActivityActorType` (lines 2153-2164) entirely. Add these maps at module scope near `getStatusColor`:

```tsx
const SUBSCRIPTION_STATUS_KEYS: Record<SubscriptionAdminStatus, string> = {
  [SubscriptionAdminStatus.ACTIVE]: "subscriptions.status.active",
  [SubscriptionAdminStatus.PAUSED]: "subscriptions.status.paused",
  [SubscriptionAdminStatus.CANCELLED]: "subscriptions.status.cancelled",
  [SubscriptionAdminStatus.PAST_DUE]: "subscriptions.status.pastDue",
};

const INTERVAL_KEYS: Record<SubscriptionFrequencyInterval, string> = {
  [SubscriptionFrequencyInterval.WEEK]: "subscriptions.intervals.week",
  [SubscriptionFrequencyInterval.MONTH]: "subscriptions.intervals.month",
  [SubscriptionFrequencyInterval.YEAR]: "subscriptions.intervals.year",
};

const ACTIVITY_ACTOR_KEYS: Record<ActivityLogAdminActorType, string> = {
  [ActivityLogAdminActorType.USER]: "subscriptions.timeline.actors.admin",
  [ActivityLogAdminActorType.CUSTOMER]: "subscriptions.timeline.actors.customer",
  [ActivityLogAdminActorType.SYSTEM]: "subscriptions.timeline.actors.system",
  [ActivityLogAdminActorType.SCHEDULER]: "subscriptions.timeline.actors.scheduler",
};

const ACTIVITY_SUMMARY_FIELD_KEYS: Record<string, string> = {
  subscription_created: "subscriptions.timeline.summaryFields.subscriptionCreated",
  pending_update_data: "subscriptions.timeline.summaryFields.pendingUpdateData",
  status: "subscriptions.timeline.summaryFields.status",
  recipient: "subscriptions.timeline.summaryFields.recipient",
  address: "subscriptions.timeline.summaryFields.address",
  address_lines_changed: "subscriptions.timeline.summaryFields.addressLinesChanged",
  postal_code_changed: "subscriptions.timeline.summaryFields.postalCodeChanged",
  phone_changed: "subscriptions.timeline.summaryFields.phoneChanged",
  country_code: "subscriptions.timeline.summaryFields.countryCode",
  province: "subscriptions.timeline.summaryFields.province",
  city: "subscriptions.timeline.summaryFields.city",
};
```

Keep `getStatusColor`, `getActivityEventColor`, and `getActivityActorColor` exactly as they are — colors are not text.

- [ ] **Step 3: Handle formatFrequency — delete it**

`formatFrequency` (lines 2000-2010) builds `Every month` / `Every 2 months` client-side, duplicating what the backend already returns in `subscription.frequency.label`. Since backend labels stay English by decision, translating this one would produce an inconsistency: the overview row would read Chinese while the frequency column on the list page reads English, for the same subscription.

Delete the function and change its call sites to render the structured values through `INTERVAL_KEYS` instead — that gives a genuinely Chinese frequency where the data allows it, without touching the backend:

```tsx
{`${t(INTERVAL_KEYS[interval])} × ${value}`}
```

Task 6 Step 5 identifies the exact call sites (the pending-plan-change block at line 847). The overview row at line 776 renders `subscription.frequency.label` directly and stays English.

- [ ] **Step 4: Add the emptyValue parameter to the two placeholder-returning functions**

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
function formatUnknown(value: unknown, emptyValue: string) {
  if (value === null || value === undefined) {
    return emptyValue;
  }

  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  return JSON.stringify(value);
}
```

`formatDateTimeInputValue` (line 2022) and `toDateTimeLocalValue` (line 2035) return no English and need no change.

- [ ] **Step 5: Thread `t` through the three activity helpers**

```tsx
function getActivityActorDisplay(
  log: Pick<ActivityLogAdminListItem, "actor" | "actor_id" | "actor_type">,
  t: TFunction,
) {
  return log.actor.display || log.actor_id || t(ACTIVITY_ACTOR_KEYS[log.actor_type]);
}
```

```tsx
function formatActivitySummary(
  log: Pick<ActivityLogAdminListItem, "change_summary" | "reason">,
  t: TFunction,
) {
  if (log.reason) {
    return log.reason;
  }

  if (!log.change_summary) {
    return t("subscriptions.timeline.noSummary");
  }

  return log.change_summary
    .split(",")
    .map((part) => formatActivitySummaryField(part.trim(), t))
    .filter(Boolean)
    .join(", ");
}
```

```tsx
function formatActivitySummaryField(value: string, t: TFunction) {
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

The `default` branch is preserved deliberately. It title-cases unmapped field names — a new event type added to the backend later renders as readable English rather than a blank or a raw snake_case key. Do not translate it; there is nothing to translate against.

`formatActivityEventType` (lines 2142-2151) does the same title-casing on event type strings like `subscription.plan_change_scheduled`. Leave it entirely unchanged. It has no fixed vocabulary to map — event types come from the backend and new ones appear without frontend changes. This means event-type badges stay English; note it in the browser check.

- [ ] **Step 6: Thread `t` through the prompt config**

Same shape as Task 3 Step 2, using the same key set — these two files have independent copies of this function and both need the change:

```tsx
function getSubscriptionActionPromptConfig(
  action: SubscriptionActionType,
  t: TFunction,
) {
  switch (action) {
    case "pause":
      return {
        title: t("subscriptions.prompt.pauseTitle"),
        description: t("subscriptions.prompt.pauseDescription"),
        confirmText: t("subscriptions.actions.pause"),
        cancelText: t("common.actions.cancel"),
        variant: "confirmation" as const,
      };
    case "resume":
      return {
        title: t("subscriptions.prompt.resumeTitle"),
        description: t("subscriptions.prompt.resumeDescription"),
        confirmText: t("subscriptions.actions.resume"),
        cancelText: t("common.actions.cancel"),
        variant: "confirmation" as const,
      };
    case "cancel":
      return {
        title: t("subscriptions.prompt.cancelTitle"),
        description: t("subscriptions.prompt.cancelDescription"),
        confirmText: t("subscriptions.actions.cancelSubscription"),
        cancelText: t("subscriptions.actions.keepSubscription"),
        variant: "danger" as const,
      };
  }
}
```

- [ ] **Step 7: Move the three option arrays inside the component**

`intervalOptions` (73-77), `activityLogActorFilterOptions` (82-87), and `activityLogDomainFilterOptions` (89-135) are module-scope arrays with English labels. Move all three inside `SubscriptionDetailPage` as `useMemo` values with `[t]` in the dependency array, replacing labels:

```tsx
  const intervalOptions = useMemo(
    () => [
      { label: t("subscriptions.intervals.week"), value: SubscriptionFrequencyInterval.WEEK },
      { label: t("subscriptions.intervals.month"), value: SubscriptionFrequencyInterval.MONTH },
      { label: t("subscriptions.intervals.year"), value: SubscriptionFrequencyInterval.YEAR },
    ],
    [t],
  );

  const activityLogActorFilterOptions = useMemo(
    () => [
      { label: t("subscriptions.timeline.actors.admin"), value: ActivityLogAdminActorType.USER },
      { label: t("subscriptions.timeline.actors.customer"), value: ActivityLogAdminActorType.CUSTOMER },
      { label: t("subscriptions.timeline.actors.system"), value: ActivityLogAdminActorType.SYSTEM },
      { label: t("subscriptions.timeline.actors.scheduler"), value: ActivityLogAdminActorType.SCHEDULER },
    ],
    [t],
  );
```

`activityLogDomainFilterOptions` is the awkward one: each entry pairs a label with an `eventTypes` array of backend event-type strings. Move it inside the component and replace only the four `label` values with `t("subscriptions.timeline.domains.subscriptions")`, `...renewals`, `...dunning`, `...cancellations`. Copy every `eventTypes` array verbatim — those are API values, not display text, and a typo there silently breaks filtering.

`activityLogColumnHelper` (lines 79-80) is a factory with no strings; leave it at module scope.

- [ ] **Step 8: Add the hook and verify it compiles**

Add as the first line of `SubscriptionDetailPage`'s body (line 152):

```tsx
  const { t } = useTranslation("reorder");
```

```bash
yarn build
```

Expected: **failure**, with errors at every call site of the changed signatures — `formatDateTime`, `formatUnknown`, `getActivityActorDisplay`, `formatActivitySummary`, `formatActivitySummaryField`, `getSubscriptionActionPromptConfig`, and the deleted `formatStatus` / `formatFrequency` / `formatActivityActorType`.

This failure is the point of the task split. The error list is the exact worklist for Task 6, produced by the compiler rather than by grep. Record it.

- [ ] **Step 9: Do not commit yet**

This task leaves the build red on purpose. Task 6 fixes every call site. Committing here would put a non-building commit in history — instead, run Tasks 5 and 6 back to back and commit once at the end of Task 6.

---

## Task 6: Translate the detail page JSX and fix every call site

**Files:**
- Modify: `src/admin/routes/subscriptions/[id]/page.tsx` (the ~90 remaining strings and all call sites the compiler flagged in Task 5 Step 8)

**Interfaces:**
- Consumes: every symbol Task 5 produced, and the keys from Task 4.
- Produces: a green build. Nothing exported.

Work through the compiler error list from Task 5 Step 8 in file order. The steps below group the work by region of the file.

- [ ] **Step 1: Translate the five mutation toast pairs**

Lines 241-337 hold five mutations. Each has a success toast and an error fallback:

| Line | Change |
|------|--------|
| 241 | `toast.success(t("subscriptions.planChange.toast"))` |
| 248 | fallback → `t("subscriptions.planChange.error")` |
| 264 | `toast.success(t("subscriptions.toast.paused"))` |
| 270 | fallback → `t("subscriptions.errors.pauseFailed")` |
| 286 | `toast.success(t("subscriptions.toast.resumed"))` |
| 292 | fallback → `t("subscriptions.errors.resumeFailed")` |
| 308 | `toast.success(t("subscriptions.toast.cancelled"))` |
| 314 | fallback → `t("subscriptions.errors.cancelFailed")` |
| 330 | `toast.success(t("subscriptions.address.toast"))` |
| 337 | fallback → `t("subscriptions.address.error")` |

Keep every `error instanceof Error ? error.message :` guard intact.

- [ ] **Step 2: Translate the three client-side validation toasts**

| Line | Change |
|------|--------|
| 610 | `toast.error(t("subscriptions.planChange.errors.variantRequired"))` |
| 615 | `toast.error(t("subscriptions.planChange.errors.frequencyValueInvalid"))` |
| 654 | `toast.error(t("subscriptions.address.errors.missingFields"))` |

Search the same region for the postal-code message (`Enter a valid postal code and 2-letter country code`) and replace it with `t("subscriptions.address.errors.invalidPostalOrCountry")`.

- [ ] **Step 3: Translate the embedded activity-log DataTable columns**

Lines 450-495 define four columns inside a `useMemo`. Each has both a `header` and a `sortLabel`:

| Column | header / sortLabel |
|--------|--------------------|
| `created_at` | `t("subscriptions.fields.created")` |
| `event_type` | `t("subscriptions.fields.event")` |
| `actor_display` | `t("subscriptions.fields.actor")` |
| `change_summary` | `t("subscriptions.fields.summary")` |

The `actor_display` cell calls `getActivityActorDisplay(row.original)` — add `, t`. The `change_summary` cell calls `formatActivitySummary(row.original)` — add `, t`. Add `t` to the useMemo dependency array.

The sort-menu options at lines 1069-1071 duplicate three of these labels as a separate array: `{ label: t("subscriptions.fields.created"), value: "created_at" }`, `{ label: t("subscriptions.fields.event"), value: "event_type" }`, `{ label: t("subscriptions.fields.actor"), value: "actor_display" }`.

- [ ] **Step 4: Translate the three page-state returns**

The component has three early returns before the main render — loading (529), error (545), and missing-data (562) — and each repeats the `Subscription` heading:

| Line | Change |
|------|--------|
| 533, 549, 566 | `{t("subscriptions.detail.title")}` |
| 538 | `{t("subscriptions.detail.loading")}` |
| 555 | fallback → `t("subscriptions.detail.loadError")` |
| 569 | `<Alert variant="warning">{t("subscriptions.detail.unavailable")}</Alert>` |

- [ ] **Step 5: Translate the action buttons and overview block**

| Line | Change |
|------|--------|
| 699 | `{pauseMutation.isPending ? t("subscriptions.actions.pausing") : t("subscriptions.actions.pause")}` |
| 711 | `{resumeMutation.isPending ? t("subscriptions.actions.resuming") : t("subscriptions.actions.resume")}` |
| 721 | `<span>{t("subscriptions.planChange.title")}</span>` |
| 730 | `<span>{t("subscriptions.address.title")}</span>` |
| 744 | `{cancelMutation.isPending ? t("subscriptions.actions.cancelling") : t("subscriptions.actions.cancel")}` |
| 766 | `label={t("common.fields.status")}` — the badge inside renders `{t(SUBSCRIPTION_STATUS_KEYS[subscription.status])}` |
| 776 | `label={t("common.fields.frequency")}` — `value={subscription.frequency.label}` stays English |
| 778 | `label={t("common.fields.nextRenewal")}` |
| 785 | `label={t("subscriptions.fields.startedAt")}` |
| 789 | `label={t("subscriptions.fields.lastRenewal")}` |
| 805 | `label={t("subscriptions.address.recipient")}` |
| 809 | `label={t("subscriptions.address.address")}` |
| 818 | `label={t("subscriptions.address.city")}` |
| 824 | `label={t("subscriptions.address.phone")}` |
| 828 | `label={t("subscriptions.address.country")}` |
| 837 | `{t("subscriptions.detail.sections.pendingPlanChange")}` |
| 843 | `label={t("common.fields.variant")}` |
| 847 | `label={t("common.fields.frequency")}` — see below |
| 854 | `label={t("subscriptions.fields.effectiveAt")}` |
| 858 | `label={t("subscriptions.fields.variantId")}` |
| 871 | `{t("subscriptions.detail.sections.activityLog")}` |
| 879 | `label={t("subscriptions.fields.domain")}` |
| 890 | `label={t("subscriptions.fields.actor")}` |
| 901 | `label={t("subscriptions.fields.createdFrom")}` |
| 912 | `label={t("subscriptions.fields.createdTo")}` |

Line 847 is the `formatFrequency` call site that Task 5 Step 3 deleted the function for. Replace the value with the interval-key form:

```tsx
                    value={`${t(
                      INTERVAL_KEYS[subscription.pending_plan_change.frequency_interval]
                    )} × ${subscription.pending_plan_change.frequency_value}`}
```

Every `formatDateTime(...)` call in this region needs `, t("common.empty.noValue")` appended. There are many; the compiler lists them all.

- [ ] **Step 6: Translate the timeline states, customer, product, and orders blocks**

| Line | Change |
|------|--------|
| 1079 | `<Label>{t("subscriptions.fields.createdFrom")}</Label>` |
| 1113 | `<Label>{t("subscriptions.fields.createdTo")}</Label>` |
| 1151 | `{t("subscriptions.timeline.loading")}` |
| 1158 | fallback → `t("subscriptions.timeline.loadError")` |
| 1305 | `label={t("subscriptions.fields.email")}` and `value={subscription.customer.email \|\| t("common.empty.noValue")}` |
| 1306 | `label={t("subscriptions.fields.customerId")}` |
| ~1310 | the `Product` section heading → `{t("subscriptions.detail.sections.product")}` |
| ~1290 | the `Customer` section heading → `{t("subscriptions.detail.sections.customer")}` |
| 1395 | `label={t("subscriptions.fields.sku")}` and `value={subscription.product.sku \|\| t("common.empty.noValue")}` |
| 1402 | `{t("subscriptions.detail.sections.orders")}` |
| 1409 | `label={t("subscriptions.fields.initialOrder")}` |
| 1421 | see below |
| 1433 | `{t("subscriptions.detail.noLinkedOrders")}` |

Line 1421 currently builds a numbered label by template literal:

```tsx
                      label={
                        index === 0
                          ? t("subscriptions.fields.latestRenewal")
                          : t("subscriptions.fields.renewalNumbered", {
                              index: index + 1,
                            })
                      }
```

The `subtitle` props at lines 1415 and 1424 embed `formatDateTime(...)` inside a template literal with the order status — add `, t("common.empty.noValue")` to each `formatDateTime` call. The order status itself (`order.status`) is a Medusa value and stays as-is.

- [ ] **Step 7: Translate the plan-change drawer**

| Line | Change |
|------|--------|
| 1446 | `<Drawer.Title>{t("subscriptions.planChange.title")}</Drawer.Title>` |
| 1451 | `<Label htmlFor="variant">{t("common.fields.variant")}</Label>` |
| 1454 | `placeholder={t("subscriptions.planChange.selectVariant")}` |
| 1468 | `{t("subscriptions.planChange.loadingVariants")}` |
| 1476 | fallback → `t("subscriptions.planChange.variantLoadError")` |
| 1484 | `{t("subscriptions.planChange.noVariants")}` |
| 1486 | `<Label htmlFor="frequency-interval">{t("subscriptions.planChange.frequencyInterval")}</Label>` |
| 1494 | `placeholder={t("subscriptions.planChange.selectInterval")}` |
| 1506 | `<Label htmlFor="frequency-value">{t("subscriptions.planChange.frequencyValue")}</Label>` |
| 1517 | `<Label htmlFor="effective-at">{t("subscriptions.fields.effectiveAt")}</Label>` |

The drawer footer has a `Drawer.Close` wrapping a Cancel button and a submit button. Translate them to `{t("common.actions.cancel")}` and `{t("common.actions.save")}`.

- [ ] **Step 8: Translate the shipping-address drawer**

| Line | Change |
|------|--------|
| 1558 | `<Drawer.Title>{t("subscriptions.address.title")}</Drawer.Title>` |
| 1564 | `{t("subscriptions.address.firstName")}` |
| 1574 | `{t("subscriptions.address.lastName")}` |
| 1585 | `{t("subscriptions.address.company")}` |
| 1616 | `{t("subscriptions.address.city")}` |
| 1626 | `{t("subscriptions.address.postalCode")}` |
| 1638 | `{t("subscriptions.address.province")}` |
| 1648 | `{t("subscriptions.address.countryCode")}` |
| 1663 | `{t("subscriptions.address.phone")}` |
| 1694 | `{t("common.actions.save")}` |

There are two address-line labels between 1585 and 1616 that the earlier grep did not surface (the `address_1` / `address_2` inputs). Read the region and translate them using `subscriptions.address.address` for the first; if the second has a distinct label such as `Address 2`, add `subscriptions.address.address2` to both JSON files following the same pattern as Task 4.

- [ ] **Step 9: Translate the activity-event drawer and its content component**

| Line | Change |
|------|--------|
| 1710 | `<Drawer.Title>{t("subscriptions.timeline.eventTitle")}</Drawer.Title>` |
| 1717 | `{t("subscriptions.timeline.eventLoading")}` |
| 1723 | `<Alert variant="error">{t("subscriptions.timeline.eventLoadError")}</Alert>` |

`ActivityLogDetailContent` at line 1853 is a separate component and needs its own `const { t } = useTranslation("reorder");`. Rewrite its body:

```tsx
      <DetailBlock
        title={t("subscriptions.detail.sections.overview")}
        rows={[
          {
            label: t("subscriptions.fields.event"),
            value: (
              <StatusBadge color={getActivityEventColor(log.event_type)}>
                {formatActivityEventType(log.event_type)}
              </StatusBadge>
            ),
          },
          {
            label: t("subscriptions.fields.actor"),
            value: getActivityActorDisplay(log, t),
          },
          {
            label: t("subscriptions.fields.created"),
            value: formatDateTime(log.created_at, t("common.empty.noValue")),
          },
          {
            label: t("subscriptions.fields.reason"),
            value: log.reason || t("common.empty.noValue"),
          },
          {
            label: t("subscriptions.fields.summary"),
            value: formatActivitySummary(log, t),
          },
        ]}
      />
      <DetailBlock
        title={t("subscriptions.detail.sections.subscriptionSnapshot")}
        rows={[
          { label: t("common.fields.reference"), value: log.subscription.reference },
          { label: t("common.fields.customer"), value: log.subscription.customer_name },
          { label: t("common.fields.product"), value: log.subscription.product_title },
          { label: t("common.fields.variant"), value: log.subscription.variant_title },
        ]}
      />
      <DetailBlock
        title={t("subscriptions.detail.sections.changedFields")}
        rows={
          log.changed_fields.length
            ? log.changed_fields.map((field) => ({
                label: formatActivitySummaryField(field.field, t),
                value: `${formatUnknown(
                  field.before,
                  t("common.empty.noValue")
                )} → ${formatUnknown(field.after, t("common.empty.noValue"))}`,
              }))
            : [
                {
                  label: t("subscriptions.detail.sections.changedFields"),
                  value: t("subscriptions.timeline.noChangedFields"),
                },
              ]
        }
      />
      <JsonBlock
        title={t("subscriptions.detail.sections.previousState")}
        value={log.previous_state}
      />
      <JsonBlock
        title={t("subscriptions.detail.sections.newState")}
        value={log.new_state}
      />
      <JsonBlock
        title={t("subscriptions.detail.sections.metadata")}
        value={log.metadata}
      />
```

`formatActivityEventType` stays untranslated — Task 5 Step 5 explains why.

- [ ] **Step 10: Translate the three small presentational components**

`JsonBlock` (line 1905) renders `"No data"` at line 1919 when the value is null. Add `const { t } = useTranslation("reorder");` and use `{value ? JSON.stringify(value, null, 2) : t("subscriptions.timeline.noData")}`.

`DetailRow` (line 1773) renders `{value || "-"}` at line 1786. Add the hook and use `{value || t("common.empty.noValue")}`.

`FilterChip` (line 1926) renders the literal `is` separator, same as the list page. Add the hook and use `{t("common.filters.is")}`.

`DetailBlock` (line 1741) has no literal strings — its `title` and row labels arrive as props. Leave it alone.

- [ ] **Step 11: Build until green**

```bash
yarn build
```

Repeat until it passes. Every remaining error is a call site of a signature Task 5 changed — most commonly a `formatDateTime` missing its second argument.

- [ ] **Step 12: Verify no English literals remain**

```bash
grep -nE '(header|label|title|placeholder|sortLabel|confirmText|cancelText)(:|=) *"[A-Z]' src/admin/routes/subscriptions/\[id\]/page.tsx
grep -nE '>[A-Z][a-zA-Z ]{3,}<' src/admin/routes/subscriptions/\[id\]/page.tsx
grep -nE 'toast\.(success|error)\("' src/admin/routes/subscriptions/\[id\]/page.tsx
grep -nE 'return "[A-Z]' src/admin/routes/subscriptions/\[id\]/page.tsx
```

Expected: no output from the first three. The fourth returns hits only from `getStatusColor`, `getActivityEventColor`, and `getActivityActorColor` — those return color names like `"green"`, which are lowercase, so a capitalized match means a formatter was missed.

- [ ] **Step 13: Run the contract test**

```bash
yarn test:i18n
```

Expected: 3 passing, now covering roughly 130 keys across both subscription files. A failure on the third test names the exact key and file — add the missing key to both JSON files.

- [ ] **Step 14: Verify in the browser**

Open a subscription detail page in Chinese. Walk through:

- Header actions: 暂停 / 恢复 / 安排方案变更 / 编辑收货地址 / 取消
- Overview rows: 状态 with a 生效中 badge, 频率 still showing the English backend label, 下次续订, 开始时间, 上次续订
- The customer block (客户) and product block (商品) with 邮箱, 客户 ID, SKU
- The orders block: 首次订单, 最近一次续订, then 第 2 次续订 for the next one — check the number lands inside the Chinese phrase, not appended after it
- Open the plan-change drawer: all labels Chinese, the variant select placeholder reads 选择变体, submit without picking a variant and confirm the toast reads 请选择变体
- Open the shipping-address drawer: all nine field labels Chinese, submit empty and confirm 请填写所有必填地址字段
- Scroll to the Activity Log timeline: column headers 创建时间 / 事件 / 操作者 / 摘要, actor badges 管理员 / 客户 / 系统 / 调度器, and the domain filter offering 订阅 / 续订 / 催款 / 取消与挽留
- Click a timeline row: the event drawer's section titles are Chinese (概览, 订阅快照, 变更字段, 变更前状态, 变更后状态, 元数据) and the event-type badge is still English — expected, see Task 5 Step 5
- Switch back to English without reloading and confirm everything flips

- [ ] **Step 15: Commit**

Tasks 5 and 6 commit together — Task 5 alone does not build.

Propose to the user and wait for approval:

```
feat(i18n): translate subscription detail page
```

```bash
git add src/admin/routes/subscriptions/\[id\]/page.tsx
git commit -m "feat(i18n): translate subscription detail page"
```

---

## Verification summary

```bash
yarn build && yarn test:i18n && yarn test:integration:http
```

The HTTP suite should be unaffected — this plan touches no API route, workflow, or module. Run it anyway: `subscriptions-admin-flow.spec.ts` exercises the same endpoints the detail page calls, so a green run confirms no accidental change to request shapes.

## Known remaining English after this plan

By decision, not omission:

- Frequency labels from the backend (`Every month`) in the list column and the overview row
- Discount labels (`10% off`)
- Activity event-type badges (`Plan Change Scheduled`) — derived by title-casing backend event type strings, no fixed vocabulary to map
- Unmapped activity summary fields — same reason

Plan 6 documents this in the user-facing docs.
