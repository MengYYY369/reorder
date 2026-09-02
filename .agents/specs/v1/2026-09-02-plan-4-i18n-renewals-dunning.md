# Plan 4: Renewals & Dunning Domains

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Translate the renewals queue and detail pages, and the dunning queue and detail pages — 118 unique strings across four files.

**Architecture:** Same pattern as Plans 2 and 3. Two domains share one plan because they are structurally near-identical (a filtered queue plus a detail page with attempt history) and because both detail pages reuse the same `subscriptions.status.*` keys for their embedded subscription summary block.

**Tech Stack:** react-i18next 13.5.0, `@medusajs/ui`.

## Global Constraints

- **Prerequisite: Plans 1-3 are complete.** `yarn test:i18n` green.
- All code, comments, JSON keys, and commit messages in English. Chinese only as JSON values.
- Conventional Commits `type(scope): description`; propose and wait for explicit user approval before committing.
- Key convention `<domain>.<area>.<key>`. Domains here are `renewals` and `dunning`.
- Reuse `common.*`, `subscriptions.status.*`, `subscriptions.fields.*` where the meaning matches exactly.
- Do not refactor unrelated files.

## Reused keys

From Plan 1: `common.actions.cancel`, `common.actions.save`, `common.actions.search`, `common.fields.status`, `common.fields.product`, `common.fields.variant`, `common.fields.customer`, `common.fields.subscription`, `common.fields.order`, `common.fields.reference`, `common.fields.frequency`, `common.fields.nextRenewal`, `common.empty.noValue`, `common.filters.yes`, `common.filters.no`, `common.filters.is`, `common.filters.clearAll`, `menuItems.renewals`, `menuItems.dunning`, `renewals.breadcrumb`, `dunning.breadcrumb`.

From Plan 2: `subscriptions.status.active` / `.paused` / `.cancelled` / `.pastDue` — both detail pages have their own `formatSubscriptionStatus` returning the same four words for the embedded subscription block. `subscriptions.fields.sku`, `subscriptions.fields.effectiveAt`, `subscriptions.fields.variantId`, `subscriptions.fields.reason`, `subscriptions.detail.sections.metadata`.

## A note on duplicated status vocabularies

`Scheduled`, `Processing`, `Succeeded`, and `Failed` appear in four separate enums across these two files: `RenewalCycleAdminStatus`, `RenewalAttemptAdminStatus`, and both are mirrored again inside the dunning detail page for its linked-renewal block. Rather than a shared `common.status.*`, each domain gets its own keys. Reason: `Processing` as a renewal *cycle* state means "the cycle is executing now" (正在处理), while as an *attempt* state it means "this attempt is in flight" (进行中) — Chinese distinguishes them and English does not. Sharing the key would lock in the wrong translation for one of them.

## File Structure

| File | Unique strings | Task |
|------|----------------|------|
| `src/admin/i18n/json/en.json` + `zhCN.json` | — | 1, 4 |
| `src/admin/routes/subscriptions/renewals/page.tsx` (740 lines) | 19 | 2 |
| `src/admin/routes/subscriptions/renewals/[id]/page.tsx` (884 lines) | 54 | 3 |
| `src/admin/routes/subscriptions/dunning/page.tsx` (759 lines) | 23 | 5 |
| `src/admin/routes/subscriptions/dunning/[id]/page.tsx` (1075 lines) | 74 | 6 |

---

## Task 1: Add the renewals keys

**Files:**
- Modify: `src/admin/i18n/json/en.json`
- Modify: `src/admin/i18n/json/zhCN.json`

**Interfaces:**
- Consumes: the `renewals` object created by Plan 1 (holds only `breadcrumb`).
- Produces: `renewals.list.*`, `renewals.columns.*`, `renewals.filters.*`, `renewals.cycleStatus.*`, `renewals.attemptStatus.*`, `renewals.approvalStatus.*`, `renewals.relativeStatus.*`, `renewals.detail.*`, `renewals.fields.*`, `renewals.actions.*`, `renewals.toast.*`, `renewals.errors.*`, `renewals.prompt.*`. Tasks 2-3 consume these.

- [ ] **Step 1: Add to en.json inside the `renewals` object**

```json
    "list": {
      "title": "Renewals",
      "description": "Monitor scheduled subscription renewal cycles and their latest attempts.",
      "loadError": "Failed to load renewals.",
      "emptyFiltered": "No matching renewal cycles",
      "emptyFilteredHint": "Try changing the search term or active filters.",
      "empty": "No renewal cycles yet",
      "emptyHint": "Renewal cycles will appear here once subscriptions are scheduled for processing."
    },
    "columns": {
      "scheduled": "Scheduled",
      "approval": "Approval",
      "lastAttempt": "Last attempt",
      "noAttempts": "No attempts yet"
    },
    "filters": {
      "addFilter": "Add filter",
      "approvalStatus": "Approval status",
      "lastAttemptResult": "Last attempt result",
      "scheduledFrom": "Scheduled from",
      "scheduledTo": "Scheduled to"
    },
    "cycleStatus": {
      "scheduled": "Scheduled",
      "processing": "Processing",
      "succeeded": "Succeeded",
      "failed": "Failed"
    },
    "attemptStatus": {
      "processing": "Processing",
      "succeeded": "Succeeded",
      "failed": "Failed"
    },
    "approvalStatus": {
      "notRequired": "Not required",
      "pending": "Pending",
      "pendingApproval": "Pending approval",
      "approved": "Approved",
      "rejected": "Rejected"
    },
    "relativeStatus": {
      "scheduled": "Awaiting processing",
      "processing": "Currently processing",
      "succeeded": "Processed",
      "failed": "Needs review"
    },
    "detail": {
      "title": "Renewal",
      "heading": "Renewal cycle",
      "description": "Review execution status, approval state, linked records, and attempt history.",
      "loading": "Loading renewal details...",
      "loadError": "Failed to load renewal details.",
      "unavailable": "Renewal details are unavailable.",
      "noPendingChanges": "No pending changes are attached to this renewal cycle.",
      "noAttemptsRecorded": "No attempts have been recorded for this renewal cycle yet.",
      "noMetadata": "No metadata was stored for this renewal cycle.",
      "noOrderGenerated": "No order generated",
      "sections": {
        "cycleOverview": "Cycle overview",
        "approvalSummary": "Approval summary",
        "pendingChanges": "Pending changes",
        "attemptHistory": "Attempt history",
        "technicalMetadata": "Technical metadata",
        "subscriptionSummary": "Subscription summary",
        "generatedOrderSummary": "Generated order summary"
      }
    },
    "fields": {
      "projectedDelivery": "Projected delivery",
      "operationalCycle": "Operational cycle",
      "processedAt": "Processed at",
      "createdAt": "Created at",
      "lastError": "Last error",
      "noErrorRecorded": "No error recorded",
      "noErrorMessage": "No error message",
      "required": "Required",
      "decidedAt": "Decided at",
      "decidedBy": "Decided by",
      "attempt": "Attempt",
      "started": "Started",
      "finished": "Finished",
      "error": "Error",
      "orderId": "Order ID",
      "orderStatus": "Order status"
    },
    "actions": {
      "forceRenewal": "Force renewal",
      "forcing": "Forcing...",
      "approveChanges": "Approve changes",
      "rejectChanges": "Reject changes",
      "approve": "Approve",
      "reject": "Reject"
    },
    "toast": {
      "forced": "Renewal forced",
      "approved": "Pending changes approved",
      "rejected": "Pending changes rejected"
    },
    "errors": {
      "forceFailed": "Failed to force renewal",
      "approveFailed": "Failed to approve changes",
      "rejectFailed": "Failed to reject changes",
      "reasonRequired": "Reason is required"
    },
    "prompt": {
      "forceTitle": "Force renewal?",
      "forceDescription": "You are about to manually trigger this renewal cycle. Do you want to continue?",
      "approveTitle": "Approve changes?",
      "approveDescription": "You are about to approve the pending changes for this renewal cycle.",
      "rejectTitle": "Reject changes?",
      "rejectDescription": "You are about to reject the pending changes for this renewal cycle.",
      "reasonLabelOptional": "Reason",
      "reasonLabelRequired": "Reason *",
      "reasonPlaceholderApprove": "Optional review note",
      "reasonPlaceholderReject": "Required rejection reason"
    }
```

`renewals.prompt.reasonLabelRequired` keeps the asterisk in the value rather than adding it in JSX. That keeps the required-field marker inside the translator's control — some locales place it before the label.

- [ ] **Step 2: Add the same keys to zhCN.json**

```json
    "list": {
      "title": "续订",
      "description": "监控已排期的订阅续订周期及其最近的执行尝试。",
      "loadError": "加载续订列表失败。",
      "emptyFiltered": "没有匹配的续订周期",
      "emptyFilteredHint": "请尝试修改搜索词或调整筛选条件。",
      "empty": "暂无续订周期",
      "emptyHint": "当订阅被排入处理队列后，续订周期将显示在这里。"
    },
    "columns": {
      "scheduled": "排期时间",
      "approval": "审批",
      "lastAttempt": "最近尝试",
      "noAttempts": "暂无尝试记录"
    },
    "filters": {
      "addFilter": "添加筛选",
      "approvalStatus": "审批状态",
      "lastAttemptResult": "最近尝试结果",
      "scheduledFrom": "排期时间起",
      "scheduledTo": "排期时间至"
    },
    "cycleStatus": {
      "scheduled": "已排期",
      "processing": "正在处理",
      "succeeded": "已成功",
      "failed": "已失败"
    },
    "attemptStatus": {
      "processing": "进行中",
      "succeeded": "成功",
      "failed": "失败"
    },
    "approvalStatus": {
      "notRequired": "无需审批",
      "pending": "待处理",
      "pendingApproval": "待审批",
      "approved": "已通过",
      "rejected": "已驳回"
    },
    "relativeStatus": {
      "scheduled": "等待处理",
      "processing": "正在处理中",
      "succeeded": "处理完成",
      "failed": "需要人工检查"
    },
    "detail": {
      "title": "续订",
      "heading": "续订周期",
      "description": "查看执行状态、审批状态、关联记录和尝试历史。",
      "loading": "正在加载续订详情……",
      "loadError": "加载续订详情失败。",
      "unavailable": "续订详情不可用。",
      "noPendingChanges": "此续订周期没有待处理的变更。",
      "noAttemptsRecorded": "此续订周期尚无尝试记录。",
      "noMetadata": "此续订周期未存储元数据。",
      "noOrderGenerated": "未生成订单",
      "sections": {
        "cycleOverview": "周期概览",
        "approvalSummary": "审批摘要",
        "pendingChanges": "待处理变更",
        "attemptHistory": "尝试历史",
        "technicalMetadata": "技术元数据",
        "subscriptionSummary": "订阅摘要",
        "generatedOrderSummary": "生成订单摘要"
      }
    },
    "fields": {
      "projectedDelivery": "预计交付",
      "operationalCycle": "运营周期",
      "processedAt": "处理时间",
      "createdAt": "创建时间",
      "lastError": "最近错误",
      "noErrorRecorded": "无错误记录",
      "noErrorMessage": "无错误信息",
      "required": "需要审批",
      "decidedAt": "决定时间",
      "decidedBy": "决定人",
      "attempt": "尝试",
      "started": "开始时间",
      "finished": "结束时间",
      "error": "错误",
      "orderId": "订单 ID",
      "orderStatus": "订单状态"
    },
    "actions": {
      "forceRenewal": "强制续订",
      "forcing": "正在执行……",
      "approveChanges": "通过变更",
      "rejectChanges": "驳回变更",
      "approve": "通过",
      "reject": "驳回"
    },
    "toast": {
      "forced": "已强制执行续订",
      "approved": "待处理变更已通过",
      "rejected": "待处理变更已驳回"
    },
    "errors": {
      "forceFailed": "强制续订失败",
      "approveFailed": "通过变更失败",
      "rejectFailed": "驳回变更失败",
      "reasonRequired": "请填写原因"
    },
    "prompt": {
      "forceTitle": "确认强制执行续订？",
      "forceDescription": "即将手动触发此续订周期，是否继续？",
      "approveTitle": "确认通过变更？",
      "approveDescription": "即将通过此续订周期的待处理变更。",
      "rejectTitle": "确认驳回变更？",
      "rejectDescription": "即将驳回此续订周期的待处理变更。",
      "reasonLabelOptional": "原因",
      "reasonLabelRequired": "原因 *",
      "reasonPlaceholderApprove": "可选的审核备注",
      "reasonPlaceholderReject": "必填的驳回原因"
    }
```

- [ ] **Step 3: Verify parity and commit**

```bash
yarn test:i18n
```

Propose to the user and wait for approval:

```
feat(i18n): add renewals translation keys
```

```bash
git add src/admin/i18n/json
git commit -m "feat(i18n): add renewals translation keys"
```

---

## Task 2: Translate the renewals queue page

**Files:**
- Modify: `src/admin/routes/subscriptions/renewals/page.tsx:36-53` (three option arrays), `:55-140` (`baseColumns`), `:594-700` (formatters), and the JSX

**Interfaces:**
- Consumes: Task 1 keys.
- Produces, local to this file:
  - `RENEWAL_CYCLE_STATUS_KEYS: Record<RenewalCycleAdminStatus, string>`
  - `RENEWAL_ATTEMPT_STATUS_KEYS: Record<RenewalAttemptAdminStatus, string>`
  - `RENEWAL_APPROVAL_STATUS_KEYS: Record<RenewalApprovalStatus, string>`
  - `RENEWAL_RELATIVE_STATUS_KEYS: Record<RenewalCycleAdminStatus, string>`
  - `formatApprovalStatus(approval: RenewalAdminApprovalSummary, t: TFunction): string`
  - `formatDateTime(value: string | null, emptyValue: string): string`

- [ ] **Step 1: Move module-scope definitions inside the component**

Same restructuring as Plan 2 Task 2 and Plan 3 Task 2 Step 1. Keep `PAGE_SIZE` (line 32) and `columnHelper` (line 34) at module scope; move `statusFilterOptions` (36), `approvalFilterOptions` (43), `attemptFilterOptions` (49), and `baseColumns` (55) into `RenewalsPage` as `useMemo` values.

Do the move with no string changes first, confirm `yarn build`, then continue.

- [ ] **Step 2: Add imports, hook, and the four key maps**

```tsx
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
```

```tsx
const RENEWAL_CYCLE_STATUS_KEYS: Record<RenewalCycleAdminStatus, string> = {
  [RenewalCycleAdminStatus.SCHEDULED]: "renewals.cycleStatus.scheduled",
  [RenewalCycleAdminStatus.PROCESSING]: "renewals.cycleStatus.processing",
  [RenewalCycleAdminStatus.SUCCEEDED]: "renewals.cycleStatus.succeeded",
  [RenewalCycleAdminStatus.FAILED]: "renewals.cycleStatus.failed",
};

const RENEWAL_ATTEMPT_STATUS_KEYS: Record<RenewalAttemptAdminStatus, string> = {
  [RenewalAttemptAdminStatus.PROCESSING]: "renewals.attemptStatus.processing",
  [RenewalAttemptAdminStatus.SUCCEEDED]: "renewals.attemptStatus.succeeded",
  [RenewalAttemptAdminStatus.FAILED]: "renewals.attemptStatus.failed",
};

const RENEWAL_APPROVAL_STATUS_KEYS: Record<RenewalApprovalStatus, string> = {
  [RenewalApprovalStatus.PENDING]: "renewals.approvalStatus.pending",
  [RenewalApprovalStatus.APPROVED]: "renewals.approvalStatus.approved",
  [RenewalApprovalStatus.REJECTED]: "renewals.approvalStatus.rejected",
};

const RENEWAL_RELATIVE_STATUS_KEYS: Record<RenewalCycleAdminStatus, string> = {
  [RenewalCycleAdminStatus.SCHEDULED]: "renewals.relativeStatus.scheduled",
  [RenewalCycleAdminStatus.PROCESSING]: "renewals.relativeStatus.processing",
  [RenewalCycleAdminStatus.SUCCEEDED]: "renewals.relativeStatus.succeeded",
  [RenewalCycleAdminStatus.FAILED]: "renewals.relativeStatus.failed",
};
```

Add `const { t } = useTranslation("reorder");` as the first line of the component body.

- [ ] **Step 3: Delete four formatters, convert two**

Delete `formatCycleStatus` (line 594), `formatAttemptStatus` (line 607), `formatApprovalFilterStatus` (line 618), and `formatRelativeCycleStatus` (line 665) — each is now a key map. Their call sites become `t(RENEWAL_CYCLE_STATUS_KEYS[status])` and so on.

Find every call site:

```bash
grep -n "formatCycleStatus\|formatAttemptStatus\|formatApprovalFilterStatus\|formatRelativeCycleStatus\|formatApprovalStatus\|formatDateTime" src/admin/routes/subscriptions/renewals/page.tsx
```

`formatApprovalStatus` (line 630) has a `!approval.required` branch and cannot become a plain map. Convert it:

```tsx
function formatApprovalStatus(
  approval: RenewalAdminApprovalSummary,
  t: TFunction,
) {
  if (!approval.required || !approval.status) {
    return t("renewals.approvalStatus.notRequired");
  }

  if (approval.status === RenewalApprovalStatus.PENDING) {
    return t("renewals.approvalStatus.pendingApproval");
  }

  return t(RENEWAL_APPROVAL_STATUS_KEYS[approval.status]);
}
```

The `PENDING` case is special-cased because the queue shows `Pending approval` in the column while the *filter* offers just `Pending` — two different strings for the same enum value, which is why both keys exist.

`formatDateTime` (line 595 region) gains the `emptyValue` parameter, same as every other file.

`formatSubscriptionContext` (line 655) joins product title, variant title, and SKU with `·`. It contains no English — leave it alone. `getCycleStatusColor` and `getAttemptStatusColor` are colors — leave them.

- [ ] **Step 4: Translate options, columns, and JSX**

Option arrays (each `useMemo` with `[t]`):

- `statusFilterOptions` → the four `t(RENEWAL_CYCLE_STATUS_KEYS[...])` values, or write the keys directly: `t("renewals.cycleStatus.scheduled")` etc.
- `approvalFilterOptions` → `t("renewals.approvalStatus.pending")`, `.approved`, `.rejected`
- `attemptFilterOptions` → `t("renewals.attemptStatus.processing")`, `.succeeded`, `.failed`

Columns:

| Line | Change |
|------|--------|
| 57, 59 | `t("renewals.columns.scheduled")` |
| 75, 77 | `t("common.fields.subscription")` |
| 93, 95 | `t("common.fields.status")` |
| 104, 106 | `t("renewals.columns.approval")` |
| 117, 119 | `t("renewals.columns.lastAttempt")` |
| 124 | `{t("renewals.columns.noAttempts")}` |

JSX:

| Line | Change |
|------|--------|
| 224, 256 | `{t("renewals.list.title")}` |
| 230, 258 | `{t("renewals.list.description")}` |
| 238 | fallback → `t("renewals.list.loadError")` |
| 269 | `label={t("common.fields.status")}` |
| 282 | `label={t("renewals.columns.approval")}` |
| 297 | `label={t("renewals.columns.lastAttempt")}` |
| 312 | `{t("renewals.filters.addFilter")}` |
| 317 | `<DropdownMenu.SubMenuTrigger>{t("common.fields.status")}</DropdownMenu.SubMenuTrigger>` |
| 344 | `{t("renewals.filters.approvalStatus")}` |
| 372 | `{t("renewals.filters.lastAttemptResult")}` |
| 408 | `{t("common.filters.clearAll")}` |
| 416 | `{t("renewals.filters.scheduledFrom")}` |
| 435 | `{t("renewals.filters.scheduledTo")}` |
| 455 | `placeholder={t("common.actions.search")}` |
| 532-533 | `{hasActiveFilters \|\| search ? t("renewals.list.emptyFiltered") : t("renewals.list.empty")}` |
| 537-538 | `{hasActiveFilters \|\| search ? t("renewals.list.emptyFilteredHint") : t("renewals.list.emptyHint")}` |

Lines 230 and 258 are a single sentence wrapped across two source lines — collapsing each to one `{t(...)}` is expected.

This file also has a `FilterChip` at the bottom with the literal `is`. Add the hook and use `t("common.filters.is")`.

- [ ] **Step 5: Verify, build, test, commit**

```bash
grep -nE '(header|label|title|placeholder|sortLabel|confirmText|cancelText)(:|=) *"[A-Z]' src/admin/routes/subscriptions/renewals/page.tsx
grep -nE '>[A-Z][a-zA-Z ]{3,}<' src/admin/routes/subscriptions/renewals/page.tsx
grep -nE 'return "[A-Z]' src/admin/routes/subscriptions/renewals/page.tsx
yarn build && yarn test:i18n
```

Expected: no output from the first two; the third matches nothing (the two remaining `get*Color` functions return lowercase color names).

Propose to the user and wait for approval:

```
feat(i18n): translate renewals queue page
```

```bash
git add src/admin/routes/subscriptions/renewals/page.tsx
git commit -m "feat(i18n): translate renewals queue page"
```

---

## Task 3: Translate the renewal detail page

**Files:**
- Modify: `src/admin/routes/subscriptions/renewals/[id]/page.tsx` (884 lines, 54 strings)

**Interfaces:**
- Consumes: Task 1 keys, plus `subscriptions.status.*` from Plan 2 and `common.intervals.*` from Plan 3.
- Produces, local to this file: the same four key maps as Task 2 (this file has its own copies of all four formatters), plus `SUBSCRIPTION_STATUS_KEYS` and `RENEWAL_INTERVAL_KEYS`.

- [ ] **Step 1: Add imports, hook, and key maps**

```tsx
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
```

This file duplicates the renewals queue's four status formatters at lines 742-793, plus a `formatSubscriptionStatus` and a `formatFrequency`. Add all six key maps at module scope — `RENEWAL_CYCLE_STATUS_KEYS`, `RENEWAL_ATTEMPT_STATUS_KEYS`, `RENEWAL_APPROVAL_STATUS_KEYS` (bodies identical to Task 2 Step 2), plus:

```tsx
const SUBSCRIPTION_STATUS_KEYS: Record<SubscriptionAdminStatus, string> = {
  [SubscriptionAdminStatus.ACTIVE]: "subscriptions.status.active",
  [SubscriptionAdminStatus.PAUSED]: "subscriptions.status.paused",
  [SubscriptionAdminStatus.CANCELLED]: "subscriptions.status.cancelled",
  [SubscriptionAdminStatus.PAST_DUE]: "subscriptions.status.pastDue",
};

const RENEWAL_INTERVAL_KEYS: Record<"week" | "month" | "year", string> = {
  week: "common.intervals.week",
  month: "common.intervals.month",
  year: "common.intervals.year",
};
```

`RENEWAL_INTERVAL_KEYS` is keyed by string literals, not an enum, because `formatFrequency` at line 795 takes `interval: "week" | "month" | "year"` directly — this file does not import the frequency enum.

Add `const { t } = useTranslation("reorder");` as the first line of the component body. `DetailRow` at line 700 also needs its own hook if it renders a `-` fallback; read it and check.

- [ ] **Step 2: Delete five formatters and handle formatFrequency**

Delete `formatCycleStatus` (742), `formatAttemptStatus` (755), `formatApprovalStatus` (765 — convert it as in Task 2 Step 3 rather than deleting, it has the `notRequired` branch), and `formatSubscriptionStatus` (783).

`formatFrequency` at line 795 produces `Every week` / `Every 2 weeks` — the same client-side duplication of a backend label that Plan 2 Task 5 Step 3 dealt with. Apply the same resolution: delete it and render the structured values at the call site:

```tsx
{`${t(RENEWAL_INTERVAL_KEYS[interval])} × ${value}`}
```

Find the call site with `grep -n "formatFrequency" src/admin/routes/subscriptions/renewals/\[id\]/page.tsx` — it is the pending-changes block around line 427.

`formatDateTime` (line 731) gains `emptyValue`. `getAdminErrorMessage` (line 847) and `getNestedErrorMessage` (line 851) walk error objects to find a server message — they take a `fallback` string parameter, so the *callers* pass the translated fallback and the functions themselves need no change.

The four `get*Color` functions stay untouched.

- [ ] **Step 3: Translate the three mutations**

| Line | Change |
|------|--------|
| 80 | `toast.success(t("renewals.toast.forced"))` |
| 83 | `getAdminErrorMessage(mutationError, t("renewals.errors.forceFailed"))` |
| 102 | `toast.success(t("renewals.toast.approved"))` |
| 110 | the fallback argument → `t("renewals.errors.approveFailed")` |
| 133 | `toast.success(t("renewals.toast.rejected"))` |
| 141 | the fallback argument → `t("renewals.errors.rejectFailed")` |

- [ ] **Step 4: Translate the prompts and validation**

| Line | Change |
|------|--------|
| 171 | `title: t("renewals.prompt.forceTitle")` |
| 173 | `description: t("renewals.prompt.forceDescription")` |
| 174 | `confirmText: t("renewals.actions.forceRenewal")` |
| 175 | `cancelText: t("common.actions.cancel")` |
| 198 | `setDecisionError(t("renewals.errors.reasonRequired"))` |
| 199 | `toast.error(t("renewals.errors.reasonRequired"))` |
| 208-209 | `decisionMode === "approve" ? t("renewals.prompt.approveTitle") : t("renewals.prompt.rejectTitle")` |
| 212-213 | `decisionMode === "approve" ? t("renewals.prompt.approveDescription") : t("renewals.prompt.rejectDescription")` |
| 214 | `decisionMode === "approve" ? t("renewals.actions.approve") : t("renewals.actions.reject")` |
| 215 | `cancelText: t("common.actions.cancel")` |

- [ ] **Step 5: Translate the page states and header**

| Line | Change |
|------|--------|
| 238, 254, 271 | `{t("renewals.detail.title")}` |
| 243 | `{t("renewals.detail.loading")}` |
| 260 | fallback → `t("renewals.detail.loadError")` |
| 274 | `<Alert variant="warning">{t("renewals.detail.unavailable")}</Alert>` |
| 286 | `{t("renewals.detail.heading")}` |
| 290-291 | `{t("renewals.detail.description")}` |
| 315 | `{forceMutation.isPending ? t("renewals.actions.forcing") : t("renewals.actions.forceRenewal")}` |
| 326 | `<span>{t("renewals.actions.approveChanges")}</span>` |
| 336 | `<span>{t("renewals.actions.rejectChanges")}</span>` |

- [ ] **Step 6: Translate the seven detail sections**

| Line | Change |
|------|--------|
| 348 | `{t("renewals.detail.sections.cycleOverview")}` |
| 353 | `label={t("common.fields.status")}` — badge renders `{t(RENEWAL_CYCLE_STATUS_KEYS[renewal.status])}` |
| 361 | `label={t("renewals.fields.projectedDelivery")}` |
| 365 | `label={t("renewals.fields.operationalCycle")}` |
| 369 | `label={t("renewals.fields.processedAt")}` |
| 373 | `label={t("renewals.fields.createdAt")}` |
| 377 | `label={t("renewals.fields.lastError")}` |
| 378 | `value={renewal.last_error \|\| t("renewals.fields.noErrorRecorded")}` |
| 386 | `{t("renewals.detail.sections.approvalSummary")}` |
| 391 | `label={t("renewals.columns.approval")}` — value calls `formatApprovalStatus(renewal.approval, t)` |
| 399 | `label={t("renewals.fields.required")}` |
| 400 | `value={renewal.approval.required ? t("common.filters.yes") : t("common.filters.no")}` |
| 403 | `label={t("renewals.fields.decidedAt")}` |
| 407 | `label={t("renewals.fields.decidedBy")}` |
| 410 | `label={t("subscriptions.fields.reason")}`, `value={renewal.approval.reason \|\| t("common.empty.noValue")}` |
| 417 | `{t("renewals.detail.sections.pendingChanges")}` |
| 423 | `label={t("common.fields.variant")}` |
| 427 | `label={t("common.fields.frequency")}` — value uses the `RENEWAL_INTERVAL_KEYS` form from Step 2 |
| 434 | `label={t("subscriptions.fields.effectiveAt")}` |
| 438 | `label={t("subscriptions.fields.variantId")}` |
| 444 | `{t("renewals.detail.noPendingChanges")}` |
| 452 | `{t("renewals.detail.sections.attemptHistory")}` |
| 459-464 | the six table headers → `t("renewals.fields.attempt")`, `t("common.fields.status")`, `t("renewals.fields.started")`, `t("renewals.fields.finished")`, `t("renewals.fields.error")`, `t("common.fields.order")` |
| 492 | `{attempt.error_message \|\| t("renewals.fields.noErrorMessage")}` |
| 503 | `{t("renewals.detail.noAttemptsRecorded")}` |
| 511 | `{t("subscriptions.detail.sections.metadata")}` — reuses Plan 2's key; the English differs (`Technical metadata` vs `Metadata`) so if you want the longer form use `t("renewals.detail.sections.technicalMetadata")` instead. Use the renewals key. |
| 522 | `{t("renewals.detail.noMetadata")}` |
| 532 | `{t("renewals.detail.sections.subscriptionSummary")}` |
| 566 | `label={t("common.fields.status")}` — badge renders `{t(SUBSCRIPTION_STATUS_KEYS[renewal.subscription.status])}` |
| 570 | `label={t("common.fields.customer")}` |
| 573 | `label={t("common.fields.product")}` |
| 574 | `label={t("common.fields.variant")}` |
| 575 | `label={t("subscriptions.fields.sku")}`, `value={renewal.subscription.sku \|\| t("common.empty.noValue")}` |
| 582 | `{t("renewals.detail.sections.generatedOrderSummary")}` |
| 616 | `{t("renewals.detail.noOrderGenerated")}` |
| 620 | `label={t("renewals.fields.orderStatus")}` |
| 624 | `label={t("renewals.fields.orderId")}` |

Every `formatDateTime(...)` in this region needs `, t("common.empty.noValue")`. Every bare `|| "-"` becomes `|| t("common.empty.noValue")`.

- [ ] **Step 7: Translate the decision drawer**

| Line | Change |
|------|--------|
| 637 | `{decisionMode === "approve" ? t("renewals.actions.approveChanges") : t("renewals.actions.rejectChanges")}` |
| 644 | `{decisionMode === "approve" ? t("renewals.prompt.reasonLabelOptional") : t("renewals.prompt.reasonLabelRequired")}` |
| 652-653 | `decisionMode === "approve" ? t("renewals.prompt.reasonPlaceholderApprove") : t("renewals.prompt.reasonPlaceholderReject")` |
| 667 | `{t("common.actions.cancel")}` |
| 683 | `{decisionMode === "approve" ? t("renewals.actions.approve") : t("renewals.actions.reject")}` |

- [ ] **Step 8: Verify, build, test, commit**

```bash
grep -nE '(header|label|title|placeholder|confirmText|cancelText)(:|=) *"[A-Z]' src/admin/routes/subscriptions/renewals/\[id\]/page.tsx
grep -nE '>[A-Z][a-zA-Z ]{3,}<' src/admin/routes/subscriptions/renewals/\[id\]/page.tsx
grep -nE 'return "[A-Z]' src/admin/routes/subscriptions/renewals/\[id\]/page.tsx
grep -nE '\|\| "-"' src/admin/routes/subscriptions/renewals/\[id\]/page.tsx
yarn build && yarn test:i18n
```

Expected: all four return nothing.

Propose to the user and wait for approval:

```
feat(i18n): translate renewal detail page
```

```bash
git add src/admin/routes/subscriptions/renewals/\[id\]/page.tsx
git commit -m "feat(i18n): translate renewal detail page"
```

- [ ] **Step 9: Verify the renewals domain in the browser**

In Chinese, open 续订:

- Column headers 排期时间, 订阅, 状态, 审批, 最近尝试
- Cycle status badges 已排期 / 正在处理 / 已成功 / 已失败
- Approval column shows 无需审批 or 待审批 / 已通过 / 已驳回
- Open the 添加筛选 menu: 状态, 审批状态, 最近尝试结果, and the date inputs 排期时间起 / 排期时间至
- Open a renewal detail: the seven section headings, the 需要审批 row showing 是 / 否, the attempt table's six headers
- Trigger 强制续订 and confirm the dialog and toast are Chinese
- Open 通过变更 with an empty reason on the reject path and confirm 请填写原因
- Note that attempt status badges read 进行中 / 成功 / 失败 while cycle badges read 正在处理 / 已成功 / 已失败 — the distinction is deliberate

---

## Task 4: Add the dunning keys

**Files:**
- Modify: `src/admin/i18n/json/en.json`
- Modify: `src/admin/i18n/json/zhCN.json`

**Interfaces:**
- Consumes: the `dunning` object created by Plan 1 (holds only `breadcrumb`).
- Produces: `dunning.list.*`, `dunning.columns.*`, `dunning.filters.*`, `dunning.caseStatus.*`, `dunning.attemptStatus.*`, `dunning.retryWindow.*`, `dunning.detail.*`, `dunning.fields.*`, `dunning.actions.*`, `dunning.toast.*`, `dunning.errors.*`, `dunning.prompt.*`, `dunning.drawer.*`. Tasks 5-6 consume these.

- [ ] **Step 1: Add to en.json inside the `dunning` object**

```json
    "list": {
      "title": "Dunning",
      "description": "Monitor past-due subscriptions, retry timing, and recovery state.",
      "loadError": "Failed to load dunning cases.",
      "emptyFiltered": "No matching dunning cases",
      "emptyFilteredHint": "Try changing the search term or active filters.",
      "empty": "No dunning cases yet",
      "emptyHint": "Dunning cases will appear here after failed renewal payments enter the recovery flow.",
      "noRetryAttempts": "No retry attempts yet",
      "noPaymentErrorCode": "No payment error code",
      "unknownProvider": "Unknown provider"
    },
    "columns": {
      "nextRetry": "Next retry",
      "attempts": "Attempts"
    },
    "filters": {
      "addFilter": "Add filter",
      "providerId": "Provider id",
      "errorCode": "Error code",
      "attemptRange": "Attempt range",
      "min": "Min",
      "max": "Max",
      "nextRetryFrom": "Next retry from",
      "nextRetryTo": "Next retry to"
    },
    "caseStatus": {
      "open": "Open",
      "retryScheduled": "Retry scheduled",
      "retrying": "Retrying",
      "awaitingManualResolution": "Awaiting manual resolution",
      "recovered": "Recovered",
      "unrecovered": "Unrecovered"
    },
    "attemptStatus": {
      "processing": "Processing",
      "succeeded": "Succeeded",
      "failed": "Failed"
    },
    "retryWindow": {
      "recovered": "Recovered",
      "closedAsUnrecovered": "Closed as unrecovered",
      "waitingForManualResolution": "Waiting for manual resolution",
      "noRetryScheduled": "No retry scheduled",
      "queuedForRetry": "Queued for retry"
    },
    "detail": {
      "title": "Dunning case",
      "heading": "Dunning case",
      "description": "Review recovery state, linked records, retry timing, and attempt history.",
      "loading": "Loading dunning case details...",
      "loadError": "Failed to load dunning case details.",
      "unavailable": "Dunning case details are unavailable.",
      "noAttemptsRecorded": "No attempts have been recorded for this dunning case yet.",
      "noMetadata": "No metadata was stored for this dunning case.",
      "noLinkedRenewal": "No linked renewal",
      "noLinkedOrder": "No linked order",
      "noPaymentErrorMessage": "No payment error message",
      "sections": {
        "caseOverview": "Case overview",
        "paymentSummary": "Payment summary",
        "retrySchedule": "Retry schedule",
        "attemptTimeline": "Attempt timeline",
        "technicalMetadata": "Technical metadata",
        "subscriptionSummary": "Subscription summary",
        "renewalSummary": "Renewal summary",
        "orderPaymentSummary": "Order / payment summary"
      }
    },
    "fields": {
      "attemptCount": "Attempt count",
      "nextRetry": "Next retry",
      "lastAttempt": "Last attempt",
      "recoveredAt": "Recovered at",
      "closedAt": "Closed at",
      "createdAt": "Created at",
      "updatedAt": "Updated at",
      "lastErrorCode": "Last error code",
      "provider": "Provider",
      "lastErrorMessage": "Last error message",
      "latestPaymentReference": "Latest payment reference",
      "recoveryReason": "Recovery reason",
      "strategy": "Strategy",
      "timezone": "Timezone",
      "intervals": "Intervals",
      "source": "Source",
      "attempt": "Attempt",
      "status": "Status",
      "started": "Started",
      "finished": "Finished",
      "error": "Error",
      "paymentReference": "Payment reference",
      "renewalStatus": "Renewal status",
      "scheduledFor": "Scheduled for",
      "generatedOrderId": "Generated order id",
      "orderStatus": "Order status",
      "orderId": "Order ID"
    },
    "actions": {
      "retryNow": "Retry now",
      "retrying": "Retrying...",
      "markRecovered": "Mark recovered",
      "markingRecovered": "Marking recovered...",
      "markUnrecovered": "Mark unrecovered",
      "markingUnrecovered": "Marking unrecovered...",
      "editRetrySchedule": "Edit retry schedule",
      "saveSchedule": "Save schedule",
      "savingSchedule": "Saving schedule...",
      "cancel": "Cancel"
    },
    "toast": {
      "retryStarted": "Retry started",
      "markedRecovered": "Case marked as recovered",
      "markedUnrecovered": "Case marked as unrecovered",
      "retryScheduleUpdated": "Retry schedule updated"
    },
    "errors": {
      "retryNowFailed": "Failed to retry now",
      "markRecoveredFailed": "Failed to mark as recovered",
      "markUnrecoveredFailed": "Failed to mark as unrecovered",
      "updateRetryScheduleFailed": "Failed to update retry schedule",
      "reasonRequired": "Reason is required",
      "atLeastOneInterval": "At least one retry interval is required",
      "maxAttemptsPositive": "Max attempts must be a positive integer",
      "maxAttemptsMatchIntervals": "Max attempts must equal the number of retry intervals"
    },
    "prompt": {
      "retryNowTitle": "Retry payment now?",
      "retryNowDescription": "You are about to trigger an immediate payment retry for this dunning case.",
      "overrideTitle": "Override retry schedule?",
      "overrideDescription": "You are about to replace the current retry schedule for this dunning case.",
      "markRecoveredTitle": "Mark as recovered?",
      "markRecoveredDescription": "You are about to close this case as recovered.",
      "markUnrecoveredTitle": "Mark as unrecovered?",
      "markUnrecoveredDescription": "You are about to close this case as unrecovered.",
      "markRecoveredConfirm": "Mark recovered",
      "markUnrecoveredConfirm": "Mark unrecovered"
    },
    "drawer": {
      "retryScheduleWarning": "Overriding the retry schedule updates future retry timing for this case.",
      "retryIntervalsMinutes": "Retry intervals (minutes)",
      "intervalsPlaceholder": "1440, 4320, 10080",
      "maxAttempts": "Max attempts",
      "reasonRequired": "Reason *",
      "reason": "Reason",
      "overrideNote": "Optional note about this retry policy override",
      "recoveryNote": "Optional recovery note",
      "requiredReason": "Required reason"
    },
    "intervals": {
      "minuteUnit": "{{value}} min"
    }
```

Notes: `dunning.actions.cancel` exists because the dunning detail drawer's Cancel is file-local copy — you may reuse `common.actions.cancel` instead and delete this key; decide once, both are identical. `dunning.intervals.minuteUnit` replaces the `formatIntervals` template `` `${interval} min` `` — Chinese renders it `{{value}} 分钟`, so the unit word must be translatable.

- [ ] **Step 2: Add the same keys to zhCN.json**

```json
    "list": {
      "title": "催款",
      "description": "监控逾期订阅、重试时机和回收状态。",
      "loadError": "加载催款列表失败。",
      "emptyFiltered": "没有匹配的催款案例",
      "emptyFilteredHint": "请尝试修改搜索词或调整筛选条件。",
      "empty": "暂无催款案例",
      "emptyHint": "当续订付款失败进入回收流程后，催款案例将显示在这里。",
      "noRetryAttempts": "暂无重试记录",
      "noPaymentErrorCode": "无付款错误码",
      "unknownProvider": "未知支付服务商"
    },
    "columns": {
      "nextRetry": "下次重试",
      "attempts": "尝试次数"
    },
    "filters": {
      "addFilter": "添加筛选",
      "providerId": "支付服务商 ID",
      "errorCode": "错误码",
      "attemptRange": "尝试次数范围",
      "min": "最小",
      "max": "最大",
      "nextRetryFrom": "下次重试起",
      "nextRetryTo": "下次重试至"
    },
    "caseStatus": {
      "open": "进行中",
      "retryScheduled": "已排期重试",
      "retrying": "重试中",
      "awaitingManualResolution": "等待人工处理",
      "recovered": "已回收",
      "unrecovered": "未回收"
    },
    "attemptStatus": {
      "processing": "进行中",
      "succeeded": "成功",
      "failed": "失败"
    },
    "retryWindow": {
      "recovered": "已回收",
      "closedAsUnrecovered": "已关闭（未回收）",
      "waitingForManualResolution": "等待人工处理",
      "noRetryScheduled": "未排期重试",
      "queuedForRetry": "已进入重试队列"
    },
    "detail": {
      "title": "催款案例",
      "heading": "催款案例",
      "description": "查看回收状态、关联记录、重试时机和尝试历史。",
      "loading": "正在加载催款案例详情……",
      "loadError": "加载催款案例详情失败。",
      "unavailable": "催款案例详情不可用。",
      "noAttemptsRecorded": "此催款案例尚无尝试记录。",
      "noMetadata": "此催款案例未存储元数据。",
      "noLinkedRenewal": "无关联续订",
      "noLinkedOrder": "无关联订单",
      "noPaymentErrorMessage": "无付款错误信息",
      "sections": {
        "caseOverview": "案例概览",
        "paymentSummary": "付款摘要",
        "retrySchedule": "重试排期",
        "attemptTimeline": "尝试时间线",
        "technicalMetadata": "技术元数据",
        "subscriptionSummary": "订阅摘要",
        "renewalSummary": "续订摘要",
        "orderPaymentSummary": "订单 / 付款摘要"
      }
    },
    "fields": {
      "attemptCount": "尝试次数",
      "nextRetry": "下次重试",
      "lastAttempt": "最近尝试",
      "recoveredAt": "回收时间",
      "closedAt": "关闭时间",
      "createdAt": "创建时间",
      "updatedAt": "更新时间",
      "lastErrorCode": "最近错误码",
      "provider": "支付服务商",
      "lastErrorMessage": "最近错误信息",
      "latestPaymentReference": "最近付款参考",
      "recoveryReason": "回收原因",
      "strategy": "策略",
      "timezone": "时区",
      "intervals": "间隔",
      "source": "来源",
      "attempt": "尝试",
      "status": "状态",
      "started": "开始时间",
      "finished": "结束时间",
      "error": "错误",
      "paymentReference": "付款参考",
      "renewalStatus": "续订状态",
      "scheduledFor": "排期时间",
      "generatedOrderId": "生成的订单 ID",
      "orderStatus": "订单状态",
      "orderId": "订单 ID"
    },
    "actions": {
      "retryNow": "立即重试",
      "retrying": "正在重试……",
      "markRecovered": "标记为已回收",
      "markingRecovered": "正在标记已回收……",
      "markUnrecovered": "标记为未回收",
      "markingUnrecovered": "正在标记未回收……",
      "editRetrySchedule": "编辑重试排期",
      "saveSchedule": "保存排期",
      "savingSchedule": "正在保存……",
      "cancel": "取消"
    },
    "toast": {
      "retryStarted": "已开始重试",
      "markedRecovered": "案例已标记为已回收",
      "markedUnrecovered": "案例已标记为未回收",
      "retryScheduleUpdated": "重试排期已更新"
    },
    "errors": {
      "retryNowFailed": "立即重试失败",
      "markRecoveredFailed": "标记已回收失败",
      "markUnrecoveredFailed": "标记未回收失败",
      "updateRetryScheduleFailed": "更新重试排期失败",
      "reasonRequired": "请填写原因",
      "atLeastOneInterval": "至少需要一个重试间隔",
      "maxAttemptsPositive": "最大尝试次数必须为正整数",
      "maxAttemptsMatchIntervals": "最大尝试次数必须与重试间隔数量一致"
    },
    "prompt": {
      "retryNowTitle": "确认立即重试付款？",
      "retryNowDescription": "即将为此催款案例触发一次立即付款重试。",
      "overrideTitle": "确认覆盖重试排期？",
      "overrideDescription": "即将替换此催款案例当前的重试排期。",
      "markRecoveredTitle": "确认标记为已回收？",
      "markRecoveredDescription": "即将将此案例作为已回收关闭。",
      "markUnrecoveredTitle": "确认标记为未回收？",
      "markUnrecoveredDescription": "即将将此案例作为未回收关闭。",
      "markRecoveredConfirm": "标记为已回收",
      "markUnrecoveredConfirm": "标记为未回收"
    },
    "drawer": {
      "retryScheduleWarning": "覆盖重试排期将更新此案例未来的重试时机。",
      "retryIntervalsMinutes": "重试间隔（分钟）",
      "intervalsPlaceholder": "1440, 4320, 10080",
      "maxAttempts": "最大尝试次数",
      "reasonRequired": "原因 *",
      "reason": "原因",
      "overrideNote": "关于此重试策略覆盖的可选备注",
      "recoveryNote": "可选的回收备注",
      "requiredReason": "必填原因"
    },
    "intervals": {
      "minuteUnit": "{{value}} 分钟"
    }
```

- [ ] **Step 3: Verify parity and commit**

```bash
yarn test:i18n
```

Propose to the user and wait for approval:

```
feat(i18n): add dunning translation keys
```

```bash
git add src/admin/i18n/json
git commit -m "feat(i18n): add dunning translation keys"
```

---

## Task 5: Translate the dunning queue page

**Files:**
- Modify: `src/admin/routes/subscriptions/dunning/page.tsx:39-50` (`statusFilterOptions`), `:52-130` (`baseColumns`), `:633-700` (formatters), and the JSX

**Interfaces:**
- Consumes: Task 4 keys.
- Produces, local to this file:
  - `DUNNING_CASE_STATUS_KEYS: Record<DunningCaseAdminStatus, string>`
  - `formatRetryWindow(item: DunningCaseAdminListItem, t: TFunction): string`
  - `formatDateTime(value: string | null, emptyValue: string): string`
  - `formatDateRange(from?: string, to?: string, t: TFunction): string`

- [ ] **Step 1: Move module-scope definitions inside the component**

Keep `PAGE_SIZE` and `columnHelper` at module scope. Move `statusFilterOptions` (39) and `baseColumns` (52) into `DunningPage` as `useMemo` values with zero string changes. Verify `yarn build` passes before continuing.

- [ ] **Step 2: Add imports, hook, key maps**

```tsx
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
```

```tsx
const DUNNING_CASE_STATUS_KEYS: Record<DunningCaseAdminStatus, string> = {
  [DunningCaseAdminStatus.OPEN]: "dunning.caseStatus.open",
  [DunningCaseAdminStatus.RETRY_SCHEDULED]: "dunning.caseStatus.retryScheduled",
  [DunningCaseAdminStatus.RETRYING]: "dunning.caseStatus.retrying",
  [DunningCaseAdminStatus.AWAITING_MANUAL_RESOLUTION]:
    "dunning.caseStatus.awaitingManualResolution",
  [DunningCaseAdminStatus.RECOVERED]: "dunning.caseStatus.recovered",
  [DunningCaseAdminStatus.UNRECOVERED]: "dunning.caseStatus.unrecovered",
};
```

Add `const { t } = useTranslation("reorder");` as the first line of the component body.

- [ ] **Step 3: Delete `formatStatus`, convert `formatRetryWindow`, `formatDateTime`, `formatDateRange`**

Delete `formatStatus` (line 630) — it becomes `t(DUNNING_CASE_STATUS_KEYS[status])` at its two call sites (the column badge at line 100 and the FilterChip value at line 265).

`formatRetryWindow` (line 665) returns five distinct phrases:

```tsx
function formatRetryWindow(item: DunningCaseAdminListItem, t: TFunction) {
  if (item.status === DunningCaseAdminStatus.RECOVERED) {
    return t("dunning.retryWindow.recovered");
  }

  if (item.status === DunningCaseAdminStatus.UNRECOVERED) {
    return t("dunning.retryWindow.closedAsUnrecovered");
  }

  if (item.status === DunningCaseAdminStatus.AWAITING_MANUAL_RESOLUTION) {
    return t("dunning.retryWindow.waitingForManualResolution");
  }

  if (!item.next_retry_at) {
    return t("dunning.retryWindow.noRetryScheduled");
  }

  return t("dunning.retryWindow.queuedForRetry");
}
```

`formatDateTime` gains `emptyValue`. `formatDateRange` (line 709) builds three English sentences. It calls `formatDateTime` internally, so it needs its own `t` parameter to pass `emptyValue` through:

```tsx
function formatDateRange(
  from?: string,
  to?: string,
  t: TFunction = () => "",
) {
  const formattedFrom = formatDateTime(from, t("common.empty.noValue"))
  const formattedTo = formatDateTime(to, t("common.empty.noValue"))

  if (from && to) {
    return t("dunning.dateRange.fromTo", { from: formattedFrom, to: formattedTo })
  }

  if (from) {
    return t("dunning.dateRange.from", { value: formattedFrom })
  }

  if (to) {
    return t("dunning.dateRange.until", { value: formattedTo })
  }

  return t("common.empty.noValue")
}
```

For this to work you must add three keys to both JSON files in Task 4's spirit — do it in this task instead, as a follow-up edit:

```json
    "dateRange": {
      "fromTo": "{{from}} to {{to}}",
      "from": "From {{value}}",
      "until": "Until {{value}}"
    }
```

Chinese: `"{{from}} 至 {{to}}"`, `"自 {{value}} 起"`, `"截至 {{value}}"`.

The default `t: TFunction = () => ""` keeps this callable in the FilterChip path during migration; after migration every caller passes a real `t`. If a default that returns `""` bothers you, make the parameter required and fix both call sites in the same task.

`formatAttemptRange` (line 700) returns `1-9`, `9+`, `Up to 9`, `-`. The first two are numbers and need no translation; `Up to {{max}}` needs a key. Add to `dunning.filters` (both JSON files):

```json
      "upTo": "Up to {{max}}"
```

Chinese: `"最多 {{max}}"`. Then:

```tsx
function formatAttemptRange(t: TFunction, min?: string, max?: string) {
  if (min && max) {
    return `${min}-${max}`
  }

  if (min) {
    return `${min}+`
  }

  if (max) {
    return t("dunning.filters.upTo", { max })
  }

  return t("common.empty.noValue")
}
```

`addDays`, `startOfDay`, and `toLocalDateTimeInputValue` produce no English — leave them.

- [ ] **Step 4: Translate options, columns, and JSX**

| Line | Change |
|------|--------|
| 54, 56 | `t("common.fields.subscription")` |
| 77, 79 | `t("common.fields.status")` |
| 87, 89 | `t("dunning.columns.nextRetry")` |
| 102, 104 | `t("dunning.columns.attempts")` |
| 113 | `{t("dunning.list.noRetryAttempts")}` |
| 119 | `header: t("dunning.fields.lastError")` — actually `Last error` is not in `dunning.fields`; add `"lastError": "Last error"` / `"最近错误"` to `dunning.fields` in both JSON files |
| 123 | `{row.original.last_payment_error_code \|\| t("dunning.list.noPaymentErrorCode")}` |
| 126 | `{row.original.subscription.payment_provider_id \|\| t("dunning.list.unknownProvider")}` |
| 225, 258 | `{t("dunning.list.title")}` |
| 260-261 | `{t("dunning.list.description")}` |
| 238 | fallback → `t("dunning.list.loadError")` |
| 265 | `label={t("common.fields.status")}` — value `formatStatus(status)` → `t(DUNNING_CASE_STATUS_KEYS[status])` |
| 270 | `label={t("dunning.fields.provider")}` |
| 293 | `label={t("dunning.fields.lastErrorCode")}` |
| 304 | `label={t("dunning.fields.attemptCount")}` |
| 322 | `{t("dunning.filters.addFilter")}` |
| 325 | `<DropdownMenu.SubMenuTrigger>{t("common.fields.status")}</DropdownMenu.SubMenuTrigger>` |
| 363 | `{t("common.filters.clearAll")}` |
| 371 | `{t("dunning.filters.providerId")}` |
| 376 | `placeholder={t("dunning.filters.providerId")}` |
| 391 | `{t("dunning.filters.errorCode")}` |
| 396 | `placeholder={t("dunning.filters.errorCode")}` |
| 411 | `{t("dunning.filters.attemptRange")}` |
| 418 | `placeholder={t("dunning.filters.min")}` |
| 434 | `placeholder={t("dunning.filters.max")}` |
| 450 | `{t("dunning.filters.nextRetryFrom")}` |
| 469 | `{t("dunning.filters.nextRetryTo")}` |
| 490 | `placeholder={t("common.actions.search")}` |
| 567-568 | `{hasActiveFilters \|\| search ? t("dunning.list.emptyFiltered") : t("dunning.list.empty")}` |
| 572-573 | `{hasActiveFilters \|\| search ? t("dunning.list.emptyFilteredHint") : t("dunning.list.emptyHint")}` |

`statusFilterOptions` becomes `[t("dunning.caseStatus.open"), ...]` keyed to the enum, inside the component's `useMemo`.

The `FilterChip` at the bottom needs its own hook and `t("common.filters.is")`.

- [ ] **Step 5: Verify, build, test, commit**

```bash
grep -nE '(header|label|title|placeholder|sortLabel)(:|=) *"[A-Z]' src/admin/routes/subscriptions/dunning/page.tsx
grep -nE '>[A-Z][a-zA-Z ]{3,}<' src/admin/routes/subscriptions/dunning/page.tsx
grep -nE 'return "[A-Z]' src/admin/routes/subscriptions/dunning/page.tsx
yarn build && yarn test:i18n
```

Expected: no output except the color functions' lowercase returns.

Propose to the user and wait for approval:

```
feat(i18n): translate dunning queue page
```

```bash
git add src/admin/routes/subscriptions/dunning/page.tsx
git commit -m "feat(i18n): translate dunning queue page"
```

---

## Task 6: Translate the dunning detail page

**Files:**
- Modify: `src/admin/routes/subscriptions/dunning/[id]/page.tsx` (1075 lines, 74 strings)

**Interfaces:**
- Consumes: Task 4 keys, plus `subscriptions.status.*` from Plan 2 and `common.intervals.*` from Plan 3.
- Produces, local to this file: the same `DUNNING_CASE_STATUS_KEYS` map as Task 5, plus `SUBSCRIPTION_STATUS_KEYS`, `DUNNING_ATTEMPT_STATUS_KEYS`, `RENEWAL_STATUS_KEYS`, `getDrawerTitle(mode, t)`, `getDrawerSubmitLabel(mode, pending, t)`, `formatIntervals(intervals, t)`, `formatDateTime(value, emptyValue)`.

- [ ] **Step 1: Add imports, hook, key maps**

```tsx
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
```

Add the key maps at module scope. `DUNNING_CASE_STATUS_KEYS` body identical to Task 5 Step 2. Plus:

```tsx
const DUNNING_ATTEMPT_STATUS_KEYS: Record<DunningAttemptAdminStatus, string> = {
  [DunningAttemptAdminStatus.PROCESSING]: "dunning.attemptStatus.processing",
  [DunningAttemptAdminStatus.SUCCEEDED]: "dunning.attemptStatus.succeeded",
  [DunningAttemptAdminStatus.FAILED]: "dunning.attemptStatus.failed",
};

const SUBSCRIPTION_STATUS_KEYS: Record<SubscriptionAdminStatus, string> = {
  [SubscriptionAdminStatus.ACTIVE]: "subscriptions.status.active",
  [SubscriptionAdminStatus.PAUSED]: "subscriptions.status.paused",
  [SubscriptionAdminStatus.CANCELLED]: "subscriptions.status.cancelled",
  [SubscriptionAdminStatus.PAST_DUE]: "subscriptions.status.pastDue",
};

const RENEWAL_STATUS_KEYS: Record<string, string> = {
  scheduled: "renewals.cycleStatus.scheduled",
  processing: "renewals.cycleStatus.processing",
  succeeded: "renewals.cycleStatus.succeeded",
  failed: "renewals.cycleStatus.failed",
};
```

`RENEWAL_STATUS_KEYS` is `Record<string, string>` because `formatRenewalStatus` takes a string-literal union typed from the DTO, not an enum.

Add `const { t } = useTranslation("reorder");` as the first line of the component body. `DetailRow` (line 906) needs its own hook if it renders `|| "-"`.

- [ ] **Step 2: Delete four formatters, convert three helpers**

Delete `formatCaseStatus` (979) — call sites use `t(DUNNING_CASE_STATUS_KEYS[status])`. Delete `formatAttemptStatus` (1013) and `formatSubscriptionStatus` (1035) similarly.

`formatRenewalStatus` (1050) becomes:

```tsx
function formatRenewalStatus(status: string, t: TFunction) {
  return t(RENEWAL_STATUS_KEYS[status] ?? status)
}
```

Wait — this is a problem. `RENEWAL_STATUS_KEYS[status] ?? status` means an unknown status renders raw, but a known one renders through `t`. But `t` on a missing key returns the key. So `t(RENEWAL_STATUS_KEYS[status])` is enough: known statuses translate, unknown ones pass through as the raw value via i18next's fallback. Use:

```tsx
function formatRenewalStatus(status: string, t: TFunction) {
  return t(RENEWAL_STATUS_KEYS[status] ?? status)
}
```

`getDrawerTitle` (943) and `getDrawerSubmitLabel` (954) get `t` parameters:

```tsx
function getDrawerTitle(mode: ActionDrawerMode, t: TFunction) {
  switch (mode) {
    case "mark_recovered":
      return t("dunning.actions.markRecovered")
    case "mark_unrecovered":
      return t("dunning.actions.markUnrecovered")
    case "retry_schedule":
      return t("dunning.actions.editRetrySchedule")
  }
}

function getDrawerSubmitLabel(
  mode: ActionDrawerMode,
  pending: boolean,
  t: TFunction,
) {
  switch (mode) {
    case "mark_recovered":
      return pending
        ? t("dunning.actions.markingRecovered")
        : t("dunning.actions.markRecovered")
    case "mark_unrecovered":
      return pending
        ? t("dunning.actions.markingUnrecovered")
        : t("dunning.actions.markUnrecovered")
    case "retry_schedule":
      return pending
        ? t("dunning.actions.savingSchedule")
        : t("dunning.actions.saveSchedule")
  }
}
```

`formatIntervals` (1065):

```tsx
function formatIntervals(intervals: number[], t: TFunction) {
  return intervals
    .map((interval) => t("dunning.intervals.minuteUnit", { value: interval }))
    .join(", ")
}
```

`formatDateTime` (968) gains `emptyValue`. `getAdminErrorMessage` takes a fallback parameter — callers translate. `parseIntervals`, `normalizeOptionalString`, and the two `get*Color` functions stay untouched.

- [ ] **Step 3: Translate the five mutations**

| Line | Change |
|------|--------|
| 89 | `toast.success(t("dunning.toast.retryStarted"))` |
| 92 | `getAdminErrorMessage(mutationError, t("dunning.errors.retryNowFailed"))` |
| 111 | `toast.success(t("dunning.toast.markedRecovered"))` |
| 117 | fallback → `t("dunning.errors.markRecoveredFailed")` |
| 139 | `toast.success(t("dunning.toast.markedUnrecovered"))` |
| 145 | fallback → `t("dunning.errors.markUnrecoveredFailed")` |
| 167 | `toast.success(t("dunning.toast.retryScheduleUpdated"))` |
| 173 | fallback → `t("dunning.errors.updateRetryScheduleFailed")` |

- [ ] **Step 4: Translate the prompts and validation**

| Line | Change |
|------|--------|
| 238-242 | the retry-now prompt → `t("dunning.prompt.retryNowTitle")`, `t("dunning.prompt.retryNowDescription")`, `confirmText: t("dunning.actions.retryNow")`, `cancelText: t("common.actions.cancel")` |
| 258-259 | `setFormError(t("dunning.errors.reasonRequired"))` and `toast.error(t("dunning.errors.reasonRequired"))` |
| 268-269 | `setFormError(t("dunning.errors.atLeastOneInterval"))` and toast |
| 274-275 | `setFormError(t("dunning.errors.maxAttemptsPositive"))` and toast |
| 280-281 | `setFormError(t("dunning.errors.maxAttemptsMatchIntervals"))` and toast |
| 286-290 | the override prompt → `t("dunning.prompt.overrideTitle")`, `t("dunning.prompt.overrideDescription")`, `confirmText: t("dunning.actions.saveSchedule")`, `cancelText: t("common.actions.cancel")` |
| 308-318 | the mark prompt ternary → `actionDrawerMode === "mark_recovered" ? t("dunning.prompt.markRecoveredTitle") : t("dunning.prompt.markUnrecoveredTitle")` and the two descriptions and confirms |

- [ ] **Step 5: Translate the page states and header**

| Line | Change |
|------|--------|
| 341, 357, 374 | `{t("dunning.detail.title")}` |
| 346 | `{t("dunning.detail.loading")}` |
| 363 | fallback → `t("dunning.detail.loadError")` |
| 377 | `<Alert variant="warning">{t("dunning.detail.unavailable")}</Alert>` |
| 389 | `{t("dunning.detail.heading")}` |
| 393 | `{t("dunning.detail.description")}` |
| 416 | `{retryNowMutation.isPending ? t("dunning.actions.retrying") : t("dunning.actions.retryNow")}` |
| 426 | `<span>{t("dunning.actions.markRecovered")}</span>` |
| 436 | `<span>{t("dunning.actions.markUnrecovered")}</span>` |
| 446 | `<span>{t("dunning.actions.editRetrySchedule")}</span>` |

- [ ] **Step 6: Translate the sections**

| Line | Change |
|------|--------|
| 458 | `{t("dunning.detail.sections.caseOverview")}` |
| 463 | `label={t("common.fields.status")}` — badge `{t(DUNNING_CASE_STATUS_KEYS[dunningCase.status])}` |
| 471 | `label={t("dunning.fields.attemptCount")}` |
| 475 | `label={t("dunning.fields.nextRetry")}` |
| 479 | `label={t("dunning.fields.lastAttempt")}` |
| 483 | `label={t("dunning.fields.recoveredAt")}` |
| 487 | `label={t("dunning.fields.closedAt")}` |
| 491 | `label={t("dunning.fields.createdAt")}` |
| 495 | `label={t("dunning.fields.updatedAt")}` |
| 504 | `{t("dunning.detail.sections.paymentSummary")}` |
| 509 | `label={t("dunning.fields.lastErrorCode")}` |
| 513 | `label={t("dunning.fields.provider")}` |
| 517 | `label={t("dunning.fields.lastErrorMessage")}` |
| 520 | `{dunningCase.last_payment_error_message \|\| t("dunning.detail.noPaymentErrorMessage")}` — read the actual variable name and keep it |
| 524 | `label={t("dunning.fields.latestPaymentReference")}` |
| 531 | `label={t("dunning.fields.recoveryReason")}` |
| 540 | `{t("dunning.detail.sections.retrySchedule")}` |
| 545 | `label={t("dunning.fields.strategy")}` |
| 549 | `label={t("dunning.fields.timezone")}` |
| 553 | `label={t("dunning.fields.intervals")}` — value `formatIntervals(dunningCase.retry_schedule.intervals, t)` |
| 561 | `label={t("dunning.fields.source")}` |
| 570 | `{t("dunning.detail.sections.attemptTimeline")}` |
| 577-582 | the six table headers → `t("dunning.fields.attempt")`, `t("dunning.fields.status")`, `t("dunning.fields.started")`, `t("dunning.fields.finished")`, `t("dunning.fields.error")`, `t("dunning.fields.paymentReference")` |
| 610 | `{attempt.error_message \|\| t("dunning.fields.lastErrorMessage")}` — read actual variable, use a `noErrorMessage` key if one exists; `dunning.detail.noPaymentErrorMessage` is for the payment block, add `"noErrorMessage": "No error message"` / `"无错误信息"` to `dunning.fields` |
| 621 | `{t("dunning.detail.noAttemptsRecorded")}` |
| 629 | `{t("dunning.detail.sections.technicalMetadata")}` |
| 640 | `{t("dunning.detail.noMetadata")}` |
| 650 | `{t("dunning.detail.sections.subscriptionSummary")}` |
| 684 | `label={t("common.fields.status")}` — badge `{t(SUBSCRIPTION_STATUS_KEYS[dunningCase.subscription.status])}` |
| 688 | `label={t("common.fields.customer")}` |
| 692 | `label={t("common.fields.product")}` |
| 696 | `label={t("common.fields.variant")}` |
| 706 | `{t("dunning.detail.sections.renewalSummary")}` |
| 742 | `{t("dunning.detail.noLinkedRenewal")}` |
| 746 | `label={t("dunning.fields.renewalStatus")}` — value `formatRenewalStatus(dunningCase.renewal.status, t)` |
| 754 | `label={t("dunning.fields.scheduledFor")}` |
| 758 | `label={t("dunning.fields.generatedOrderId")}` |
| 767 | `{t("dunning.detail.sections.orderPaymentSummary")}` |
| 801 | `{t("dunning.detail.noLinkedOrder")}` |
| 804 | `label={t("dunning.fields.orderStatus")}`, `value={dunningCase.order?.status \|\| t("common.empty.noValue")}` |
| 805 | `label={t("dunning.fields.orderId")}`, `value={dunningCase.order?.order_id \|\| t("common.empty.noValue")}` |

Every `formatDateTime(...)` gains `, t("common.empty.noValue")`.

- [ ] **Step 7: Translate the action drawer**

| Line | Change |
|------|--------|
| 821 | `{t("dunning.drawer.retryScheduleWarning")}` |
| 827 | `<Label htmlFor="retry-intervals">{t("dunning.drawer.retryIntervalsMinutes")}</Label>` |
| 830 | `placeholder={t("dunning.drawer.intervalsPlaceholder")}` |
| 836 | `<Label htmlFor="retry-max-attempts">{t("dunning.drawer.maxAttempts")}</Label>` |
| 849 | `{actionDrawerMode === "mark_unrecovered" ? t("dunning.drawer.reasonRequired") : t("dunning.drawer.reason")}` |
| 857-860 | the placeholder ternary → `actionDrawerMode === "retry_schedule" ? t("dunning.drawer.overrideNote") : actionDrawerMode === "mark_recovered" ? t("dunning.drawer.recoveryNote") : t("dunning.drawer.requiredReason")` |
| 874 | `{t("common.actions.cancel")}` |

- [ ] **Step 8: Verify, build, test, commit**

```bash
grep -nE '(header|label|title|placeholder|confirmText|cancelText)(:|=) *"[A-Z]' src/admin/routes/subscriptions/dunning/\[id\]/page.tsx
grep -nE '>[A-Z][a-zA-Z ]{3,}<' src/admin/routes/subscriptions/dunning/\[id\]/page.tsx
grep -nE 'return "[A-Z]' src/admin/routes/subscriptions/dunning/\[id\]/page.tsx
grep -nE '\|\| "-"' src/admin/routes/subscriptions/dunning/\[id\]/page.tsx
yarn build && yarn test:i18n
```

Expected: all four return nothing. One caveat: `return "Mark recovered"` etc. inside `getDrawerTitle`/`getDrawerSubmitLabel` are already converted in Step 2, so the third grep should be empty except color functions.

Propose to the user and wait for approval:

```
feat(i18n): translate dunning detail page
```

```bash
git add src/admin/routes/subscriptions/dunning/\[id\]/page.tsx
git commit -m "feat(i18n): translate dunning detail page"
```

- [ ] **Step 9: Verify the dunning domain in the browser**

In Chinese, open 催款:

- Column headers 订阅, 状态, 下次重试, 尝试次数, 最近错误
- Status badges 进行中 / 已排期重试 / 重试中 / 等待人工处理 / 已回收 / 未回收
- Open 添加筛选: 状态, plus the five filter inputs with Chinese labels and placeholders
- Open a dunning case: section headings 案例概览, 付款摘要, 重试排期, 尝试时间线, 技术元数据, 订阅摘要, 续订摘要, 订单 / 付款摘要
- The 间隔 row shows `1440 分钟, 4320 分钟, 10080 分钟`
- Trigger 立即重试, 标记为已回收, 标记为未回收 and confirm dialogs/toasts are Chinese
- Open 编辑重试排期: warning banner, 重试间隔（分钟）, 最大尝试次数, and the placeholder `1440, 4320, 10080` unchanged (it is a number format, not text)
- Submit the schedule drawer with an empty reason on the mark-unrecovered path and confirm 请填写原因

---

## Verification summary

```bash
yarn build && yarn test:i18n && yarn test:integration:http
```

`renewals-routes.spec.ts`, `dunning-routes.spec.ts`, and their workflow specs must stay green — this plan touches no backend code.

## Known remaining English after this plan

- Frequency labels from the backend (`Every month`)
- Discount labels (`10% off`)
- The `1440, 4320, 10080` interval placeholder — a number format, intentionally untranslated
- zod built-in messages, if any fire

Plans 2-4 leave the analytics metric names (`MRR`, `Churn Rate`, `LTV`) English; Plan 6 covers that page.
