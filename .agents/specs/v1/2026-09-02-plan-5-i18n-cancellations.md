# Plan 5: Cancellation & Retention Domain

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Translate the Cancellation & Retention list page and the large detail page — 130 unique strings across two files, the most densely packed domain in the plugin.

**Architecture:** Two files: the list page is a straightforward DataTable with filters (same pattern as Plans 2-4), and the detail page is a 1753-line behemoth with 11 status formatters, 3 action drawers (apply offer, finalize, update reason), and an offer-history timeline. Many formatters duplicate those from Plans 2-4 (`formatSubscriptionStatus`, `formatDunningStatus`, `formatRenewalStatus`, `formatApprovalStatus`) — this plan maps them to the same keys established there.

**Tech Stack:** react-i18next 13.5.0, `@medusajs/ui`.

## Global Constraints

- **Prerequisite: Plans 1-4 are complete.** `yarn test:i18n` green.
- All code, comments, JSON keys, and commit messages in English. Chinese only as JSON values.
- Conventional Commits `type(scope): description`; propose and wait for explicit user approval before committing.
- Key convention `<domain>.<area>.<key>`. Domain here is `cancellations`.
- Reuse `common.*`, `subscriptions.status.*`, `dunning.caseStatus.*`, `renewals.cycleStatus.*`, `renewals.approvalStatus.*` where the meaning matches exactly.
- Do not refactor unrelated files.

## Reused keys

From Plans 1-4: `common.actions.cancel`, `common.actions.save`, `common.actions.search`, `common.fields.status`, `common.fields.product`, `common.fields.variant`, `common.fields.customer`, `common.fields.subscription`, `common.fields.reference`, `common.fields.frequency`, `common.fields.nextRenewal`, `common.fields.sku`, `common.fields.reason`, `common.empty.noValue`, `common.filters.yes`, `common.filters.no`, `common.filters.is`, `common.filters.clearAll`, `common.filters.clearAllFilters`, `subscriptions.status.active`, `.paused`, `.cancelled`, `.pastDue`, `dunning.caseStatus.*`, `renewals.cycleStatus.*`, `renewals.approvalStatus.*`, `subscriptions.fields.effectiveAt`, `subscriptions.detail.sections.metadata`.

## File Structure

| File | Unique strings | Task |
|------|----------------|------|
| `src/admin/i18n/json/en.json` + `zhCN.json` | — | 1 |
| `src/admin/routes/subscriptions/cancellations/page.tsx` (630 lines) | 25 | 2 |
| `src/admin/routes/subscriptions/cancellations/[id]/page.tsx` (1753 lines) | 105 | 3 |

## Key naming

The status keys diverge slightly from earlier plans because the cancellations status enum uses string literals (`"requested"`, `"evaluating_retention"`, `"retention_offered"`, `"retained"`, `"paused"`, `"canceled"`) rather than an enum object. The key map is `Record<string, string>` keyed by the string value.

---

## Task 1: Add the cancellations keys

**Files:**
- Modify: `src/admin/i18n/json/en.json`
- Modify: `src/admin/i18n/json/zhCN.json`

**Interfaces:**
- Consumes: the `cancellations` object created by Plan 1 (holds only `breadcrumb`).
- Produces: `cancellations.list.*`, `cancellations.columns.*`, `cancellations.filters.*`, `cancellations.caseStatus.*`, `cancellations.outcome.*`, `cancellations.offerType.*`, `cancellations.reasonCategory.*`, `cancellations.detail.*`, `cancellations.fields.*`, `cancellations.actions.*`, `cancellations.toast.*`, `cancellations.errors.*`, `cancellations.prompt.*`, `cancellations.drawer.*`. Tasks 2-3 consume these.

- [ ] **Step 1: Add to en.json inside the `cancellations` object**

```json
    "list": {
      "title": "Cancellation & Retention",
      "description": "Manage cancellation requests, retention offers, and churn tracking.",
      "loadError": "Failed to load cancellation cases.",
      "emptyFiltered": "No matching cancellation cases",
      "emptyFilteredHint": "Try changing the search term or active filters.",
      "empty": "No cancellation cases yet",
      "emptyHint": "Cancellation cases will appear here once customers initiate cancel requests."
    },
    "columns": {
      "subscription": "Subscription",
      "reasonCategory": "Reason category",
      "outcome": "Outcome",
      "offerType": "Offer type"
    },
    "filters": {
      "addFilter": "Add filter",
      "reasonCategory": "Reason category",
      "finalOutcome": "Final outcome",
      "offerType": "Offer type",
      "createdFrom": "Created from",
      "createdTo": "Created to"
    },
    "caseStatus": {
      "requested": "Requested",
      "evaluatingRetention": "Evaluating retention",
      "retentionOffered": "Retention offered",
      "retained": "Retained",
      "paused": "Paused",
      "canceled": "Canceled"
    },
    "outcome": {
      "retained": "Retained",
      "paused": "Paused",
      "canceled": "Canceled"
    },
    "offerType": {
      "pauseOffer": "Pause offer",
      "discountOffer": "Discount offer",
      "bonusOffer": "Bonus offer"
    },
    "reasonCategory": {
      "price": "Price",
      "productFit": "Product fit",
      "delivery": "Delivery",
      "billing": "Billing",
      "temporaryPause": "Temporary pause",
      "switchedCompetitor": "Switched competitor",
      "other": "Other",
      "unclassified": "Unclassified"
    },
    "detail": {
      "title": "Cancellation",
      "heading": "Cancellation case",
      "description": "Review cancellation reason, evaluate retention options, and finalize the outcome.",
      "loading": "Loading cancellation case details...",
      "loadError": "Failed to load cancellation case details.",
      "unavailable": "Cancellation case details are unavailable.",
      "noLinkedRenewal": "No linked renewal",
      "noLinkedOrder": "No linked order",
      "noOfferHistory": "No offer history entries for this case.",
      "sections": {
        "caseOverview": "Case overview",
        "offerHistory": "Offer history",
        "subscriptionSummary": "Subscription summary",
        "renewalSummary": "Renewal summary",
        "dunningSummary": "Dunning summary",
        "technicalMetadata": "Technical metadata"
      }
    },
    "fields": {
      "requestedAt": "Requested at",
      "decidedAt": "Decided at",
      "finalizedAt": "Finalized at",
      "finalizedBy": "Finalized by",
      "finalOutcome": "Final outcome",
      "reasonCategory": "Reason category",
      "reason": "Reason",
      "decisionReason": "Decision reason",
      "decisionTimeline": "Decision timeline",
      "offerHistory": "Offer history",
      "offerNote": "Offer note",
      "offer": "Offer",
      "offerType": "Offer type",
      "decisionStatus": "Decision status",
      "decisionStatusProposed": "Proposed",
      "decisionStatusAccepted": "Accepted",
      "decisionStatusRejected": "Rejected",
      "decisionStatusApplied": "Applied",
      "decisionStatusExpired": "Expired",
      "dunningStatus": "Dunning status",
      "renewalStatus": "Renewal status",
      "approvalStatus": "Approval status",
      "subscriptionStatus": "Subscription status",
      "pauseCycles": "Pause cycles",
      "resumeAt": "Resume at",
      "discountType": "Discount type",
      "discountValue": "Discount value",
      "durationCycles": "Duration cycles",
      "bonusType": "Bonus type",
      "bonusValue": "Bonus value",
      "label": "Label",
      "note": "Note",
      "captureChurnReason": "Capture the churn reason"
    },
    "actions": {
      "applyOffer": "Apply retention offer",
      "applyPauseOffer": "Apply pause offer",
      "applyDiscountOffer": "Apply discount offer",
      "applyBonusOffer": "Apply bonus offer",
      "finalizeCancellation": "Finalize cancellation",
      "updateReason": "Update reason",
      "changeReason": "Change reason",
      "editReason": "Edit reason",
      "save": "Save",
      "cancel": "Cancel"
    },
    "toast": {
      "offerApplied": "Retention offer applied",
      "cancellationFinalized": "Cancellation finalized",
      "reasonUpdated": "Reason updated"
    },
    "errors": {
      "applyOfferFailed": "Failed to apply retention offer",
      "finalizeFailed": "Failed to finalize cancellation",
      "reasonUpdateFailed": "Failed to update reason",
      "reasonRequired": "Reason is required",
      "reasonRequiredBeforeFinalize": "Reason is required before final cancel",
      "bonusValueRequired": "Bonus value is required for free cycle or credit",
      "discountValuePositive": "Discount value must be greater than 0",
      "pauseCyclesOrResumeDate": "Pause offer requires pause cycles or resume date"
    },
    "prompt": {
      "applyOfferTitle": "Apply retention offer?",
      "applyOfferDescription": "You are about to apply this retention offer to the cancellation case.",
      "finalizeTitle": "Finalize cancellation?",
      "finalizeDescription": "You are about to finalize this cancellation. This action sets the final outcome."
    },
    "drawer": {
      "applyOfferTitle": "Apply retention offer",
      "finalizeTitle": "Finalize cancellation",
      "reasonTitle": "Update reason",
      "selectOfferType": "Select offer type",
      "selectCategory": "Select a category",
      "effectiveAt": "Effective at",
      "immediately": "Immediately",
      "endOfCycle": "End of cycle",
      "discountPercentage": "Percentage",
      "discountFixed": "Fixed",
      "freeCycle": "Free cycle",
      "gift": "Gift",
      "credit": "Credit",
      "optionalLabel": "Optional label",
      "optionalNote": "Optional note attached to the offer payload",
      "optionalOperatorNotes": "Optional operator notes",
      "optionalExplanation": "Optional explanation for the update",
      "optionalFinalCancellationNotes": "Optional final cancellation notes",
      "optionalReasonOrCustomerResponse": "Optional reason or customer response",
      "selectedOfferNotAllowed": "Selected retention offer is not allowed for this case"
    }
```

The `cancellations.actions.cancel` entry duplicates `common.actions.cancel`. Decide once: either use the common key and delete this one, or keep both. The plan uses the common key for literal Cancel buttons and the domain key for the `cancel` action label in the drawer context.

- [ ] **Step 2: Add the same keys to zhCN.json**

```json
    "list": {
      "title": "取消与挽留",
      "description": "管理取消请求、挽留方案和流失追踪。",
      "loadError": "加载取消案例列表失败。",
      "emptyFiltered": "没有匹配的取消案例",
      "emptyFilteredHint": "请尝试修改搜索词或调整筛选条件。",
      "empty": "暂无取消案例",
      "emptyHint": "当客户发起取消请求后，取消案例将显示在这里。"
    },
    "columns": {
      "subscription": "订阅",
      "reasonCategory": "原因分类",
      "outcome": "最终结果",
      "offerType": "方案类型"
    },
    "filters": {
      "addFilter": "添加筛选",
      "reasonCategory": "原因分类",
      "finalOutcome": "最终结果",
      "offerType": "方案类型",
      "createdFrom": "创建时间起",
      "createdTo": "创建时间至"
    },
    "caseStatus": {
      "requested": "已请求",
      "evaluatingRetention": "评估挽留中",
      "retentionOffered": "已提供挽留方案",
      "retained": "已挽留",
      "paused": "已暂停",
      "canceled": "已取消"
    },
    "outcome": {
      "retained": "已挽留",
      "paused": "已暂停",
      "canceled": "已取消"
    },
    "offerType": {
      "pauseOffer": "暂停方案",
      "discountOffer": "折扣方案",
      "bonusOffer": "赠品方案"
    },
    "reasonCategory": {
      "price": "价格",
      "productFit": "产品匹配度",
      "delivery": "配送",
      "billing": "账单",
      "temporaryPause": "暂时停用",
      "switchedCompetitor": "转向竞品",
      "other": "其他",
      "unclassified": "未分类"
    },
    "detail": {
      "title": "取消",
      "heading": "取消案例",
      "description": "查看取消原因、评估挽留方案并确定最终结果。",
      "loading": "正在加载取消案例详情……",
      "loadError": "加载取消案例详情失败。",
      "unavailable": "取消案例详情不可用。",
      "noLinkedRenewal": "无关联续订",
      "noLinkedOrder": "无关联订单",
      "noOfferHistory": "此案例尚无方案历史记录。",
      "sections": {
        "caseOverview": "案例概览",
        "offerHistory": "方案历史",
        "subscriptionSummary": "订阅摘要",
        "renewalSummary": "续订摘要",
        "dunningSummary": "催款摘要",
        "technicalMetadata": "技术元数据"
      }
    },
    "fields": {
      "requestedAt": "请求时间",
      "decidedAt": "决定时间",
      "finalizedAt": "最终确定时间",
      "finalizedBy": "最终确定人",
      "finalOutcome": "最终结果",
      "reasonCategory": "原因分类",
      "reason": "原因",
      "decisionReason": "决定原因",
      "decisionTimeline": "决定时间线",
      "offerHistory": "方案历史",
      "offerNote": "方案备注",
      "offer": "方案",
      "offerType": "方案类型",
      "decisionStatus": "决定状态",
      "decisionStatusProposed": "已提议",
      "decisionStatusAccepted": "已接受",
      "decisionStatusRejected": "已拒绝",
      "decisionStatusApplied": "已应用",
      "decisionStatusExpired": "已过期",
      "dunningStatus": "催款状态",
      "renewalStatus": "续订状态",
      "approvalStatus": "审批状态",
      "subscriptionStatus": "订阅状态",
      "pauseCycles": "暂停周期数",
      "resumeAt": "恢复时间",
      "discountType": "折扣类型",
      "discountValue": "折扣数值",
      "durationCycles": "持续周期数",
      "bonusType": "赠品类型",
      "bonusValue": "赠品价值",
      "label": "标签",
      "note": "备注",
      "captureChurnReason": "记录流失原因"
    },
    "actions": {
      "applyOffer": "应用挽留方案",
      "applyPauseOffer": "应用暂停方案",
      "applyDiscountOffer": "应用折扣方案",
      "applyBonusOffer": "应用赠品方案",
      "finalizeCancellation": "确认取消",
      "updateReason": "更新原因",
      "changeReason": "更换原因",
      "editReason": "编辑原因",
      "save": "保存",
      "cancel": "取消"
    },
    "toast": {
      "offerApplied": "挽留方案已应用",
      "cancellationFinalized": "取消已确认",
      "reasonUpdated": "原因已更新"
    },
    "errors": {
      "applyOfferFailed": "应用挽留方案失败",
      "finalizeFailed": "确认取消失败",
      "reasonUpdateFailed": "更新原因失败",
      "reasonRequired": "请填写原因",
      "reasonRequiredBeforeFinalize": "最终取消前必须填写原因",
      "bonusValueRequired": "免费周期或信用赠品需要填写赠品价值",
      "discountValuePositive": "折扣数值必须大于 0",
      "pauseCyclesOrResumeDate": "暂停方案需要填写暂停周期数或恢复时间"
    },
    "prompt": {
      "applyOfferTitle": "确认应用挽留方案？",
      "applyOfferDescription": "即将将此挽留方案应用于取消案例。",
      "finalizeTitle": "确认最终取消？",
      "finalizeDescription": "即将确认此取消，此操作将设定最终结果。"
    },
    "drawer": {
      "applyOfferTitle": "应用挽留方案",
      "finalizeTitle": "确认取消",
      "reasonTitle": "更新原因",
      "selectOfferType": "选择方案类型",
      "selectCategory": "选择分类",
      "effectiveAt": "生效时间",
      "immediately": "立即",
      "endOfCycle": "周期结束时",
      "discountPercentage": "按百分比",
      "discountFixed": "固定金额",
      "freeCycle": "免费周期",
      "gift": "礼品",
      "credit": "信用额度",
      "optionalLabel": "可选标签",
      "optionalNote": "附加到方案负载的可选备注",
      "optionalOperatorNotes": "可选的运营人员备注",
      "optionalExplanation": "可选的更新说明",
      "optionalFinalCancellationNotes": "可选的最终取消备注",
      "optionalReasonOrCustomerResponse": "可选的原因或客户反馈",
      "selectedOfferNotAllowed": "所选挽留方案不适用于此案例"
    }
```

- [ ] **Step 3: Verify parity and commit**

```bash
yarn test:i18n
```

Propose to the user and wait for approval:

```
feat(i18n): add cancellations translation keys
```

```bash
git add src/admin/i18n/json
git commit -m "feat(i18n): add cancellations translation keys"
```

---

## Task 2: Translate the cancellations list page

**Files:**
- Modify: `src/admin/routes/subscriptions/cancellations/page.tsx:37-65` (module-scope options), `:62-130` (`baseColumns`), `:595-640` (formatters), and JSX

**Interfaces:**
- Consumes: Task 1 keys.
- Produces, local to this file:
  - `CANCELLATION_REASON_KEYS: Record<string, string>`
  - `CANCELLATION_OUTCOME_KEYS: Record<CancellationFinalOutcomeAdmin, string>`
  - `CANCELLATION_OFFER_TYPE_KEYS: Record<string, string>`
  - `formatReasonCategory(value: string | null, t: TFunction): string`
  - `formatDateTime(value: string | null, emptyValue: string): string`

- [ ] **Step 1: Move module-scope definitions inside the component**

Keep `columnHelper` (line 37) at module scope. Move `reasonCategoryFilterOptions` (40), `finalOutcomeFilterOptions` (49), `offerTypeFilterOptions` (56), and `baseColumns` (62) into `CancellationsPage` as `useMemo` with zero string changes. Verify `yarn build`.

- [ ] **Step 2: Add imports, hook, and key maps**

```tsx
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
```

```tsx
const CANCELLATION_REASON_KEYS: Record<string, string> = {
  price: "cancellations.reasonCategory.price",
  product_fit: "cancellations.reasonCategory.productFit",
  delivery: "cancellations.reasonCategory.delivery",
  billing: "cancellations.reasonCategory.billing",
  temporary_pause: "cancellations.reasonCategory.temporaryPause",
  switched_competitor: "cancellations.reasonCategory.switchedCompetitor",
  other: "cancellations.reasonCategory.other",
};

const CANCELLATION_OUTCOME_KEYS: Record<CancellationFinalOutcomeAdmin, string> = {
  [CancellationFinalOutcomeAdmin.RETAINED]: "cancellations.outcome.retained",
  [CancellationFinalOutcomeAdmin.PAUSED]: "cancellations.outcome.paused",
  [CancellationFinalOutcomeAdmin.CANCELED]: "cancellations.outcome.canceled",
};

const CANCELLATION_OFFER_TYPE_KEYS: Record<string, string> = {
  pause_offer: "cancellations.offerType.pauseOffer",
  discount_offer: "cancellations.offerType.discountOffer",
  bonus_offer: "cancellations.offerType.bonusOffer",
};
```

Add `const { t } = useTranslation("reorder");` as the first line of the component body.

- [ ] **Step 3: Delete three formatters, convert one**

Delete `formatFinalOutcomeFilter` (line 620) — call sites use `t(CANCELLATION_OUTCOME_KEYS[value])`. Delete `formatOfferTypeFilter` (line 640) — call sites use `t(CANCELLATION_OFFER_TYPE_KEYS[value])`.

`formatReasonCategory` (line 608) has a `null` → `"Unclassified"` branch and a default that title-cases unknown values. Keep the default branch, replace the known branches:

```tsx
function formatReasonCategory(value: string | null, t: TFunction) {
  if (!value) {
    return t("cancellations.reasonCategory.unclassified");
  }

  const key = CANCELLATION_REASON_KEYS[value];

  if (key) {
    return t(key);
  }

  return value
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}
```

`formatDateTime` (line 561) gains `emptyValue`.

- [ ] **Step 4: Translate options, columns, and JSX**

`reasonCategoryFilterOptions` → `t("cancellations.reasonCategory.price")` etc. `finalOutcomeFilterOptions` → `t(CANCELLATION_OUTCOME_KEYS[...])`. `offerTypeFilterOptions` → `t(CANCELLATION_OFFER_TYPE_KEYS[...])`.

Columns:

| Line | Change |
|------|--------|
| 70, 72 | `t("cancellations.columns.subscription")` |
| 85, 87 | `t("common.fields.status")` |
| 96, 98 | `t("cancellations.columns.reasonCategory")` |
| 107, 109 | `t("cancellations.columns.outcome")` |
| 118, 120 | `t("cancellations.columns.offerType")` |

JSX:

| Line | Change |
|------|--------|
| 210, 235 | `{t("cancellations.list.title")}` |
| 217, 242 | `{t("cancellations.list.description")}` |
| 225 | fallback → `t("cancellations.list.loadError")` |
| 270 | `label={t("common.fields.status")}` |
| 282 | `label={t("cancellations.filters.reasonCategory")}` |
| 304 | `label={t("cancellations.filters.finalOutcome")}` |
| 325 | `label={t("cancellations.filters.offerType")}` — read the actual line; the filter section may have a different structure. |
| 340 | `{t("cancellations.filters.addFilter")}` |
| 366 | `{t("common.filters.clearAll")}` |
| 374 | `{t("cancellations.filters.createdFrom")}` |
| 392 | `{t("cancellations.filters.createdTo")}` |
| 410 | `placeholder={t("common.actions.search")}` |
| 480 | `{hasActiveFilters \|\| search ? t("cancellations.list.emptyFiltered") : t("cancellations.list.empty")}` |
| 484 | `{hasActiveFilters \|\| search ? t("cancellations.list.emptyFilteredHint") : t("cancellations.list.emptyHint")}` |

The `FilterChip` at the bottom needs its own hook and `t("common.filters.is")`.

- [ ] **Step 5: Verify, build, test, commit**

```bash
grep -nE '(header|label|title|placeholder|sortLabel)(:|=) *"[A-Z]' src/admin/routes/subscriptions/cancellations/page.tsx
grep -nE '>[A-Z][a-zA-Z ]{3,}<' src/admin/routes/subscriptions/cancellations/page.tsx
grep -nE 'return "[A-Z]' src/admin/routes/subscriptions/cancellations/page.tsx
yarn build && yarn test:i18n
```

Propose to the user and wait for approval:

```
feat(i18n): translate cancellations list page
```

```bash
git add src/admin/routes/subscriptions/cancellations/page.tsx
git commit -m "feat(i18n): translate cancellations list page"
```

---

## Task 3: Translate the cancellations detail page

**Files:**
- Modify: `src/admin/routes/subscriptions/cancellations/[id]/page.tsx` (1753 lines, 105 strings)

**Interfaces:**
- Consumes: Task 1 keys, plus `subscriptions.status.*`, `dunning.caseStatus.*`, `renewals.cycleStatus.*`, `renewals.approvalStatus.*` from earlier plans.
- Produces, local to this file: 11 key maps and 11 formatter conversions. The full list of key maps is in Step 2.

- [ ] **Step 1: Add imports, hook, and key maps**

```tsx
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
```

Add these at module scope:

```tsx
const CANCELLATION_STATUS_KEYS: Record<string, string> = {
  requested: "cancellations.caseStatus.requested",
  evaluating_retention: "cancellations.caseStatus.evaluatingRetention",
  retention_offered: "cancellations.caseStatus.retentionOffered",
  retained: "cancellations.caseStatus.retained",
  paused: "cancellations.caseStatus.paused",
  canceled: "cancellations.caseStatus.canceled",
};

const CANCELLATION_OUTCOME_KEYS: Record<string, string> = {
  retained: "cancellations.outcome.retained",
  paused: "cancellations.outcome.paused",
  canceled: "cancellations.outcome.canceled",
};

const CANCELLATION_REASON_KEYS: Record<string, string> = {
  // body identical to Task 2 Step 2
};

const CANCELLATION_OFFER_TYPE_KEYS: Record<string, string> = {
  pause_offer: "cancellations.offerType.pauseOffer",
  discount_offer: "cancellations.offerType.discountOffer",
  bonus_offer: "cancellations.offerType.bonusOffer",
};

const OFFER_DECISION_STATUS_KEYS: Record<string, string> = {
  proposed: "cancellations.fields.decisionStatusProposed",
  accepted: "cancellations.fields.decisionStatusAccepted",
  rejected: "cancellations.fields.decisionStatusRejected",
  applied: "cancellations.fields.decisionStatusApplied",
  expired: "cancellations.fields.decisionStatusExpired",
};

const SUBSCRIPTION_STATUS_KEYS: Record<string, string> = {
  active: "subscriptions.status.active",
  paused: "subscriptions.status.paused",
  cancelled: "subscriptions.status.cancelled",
  past_due: "subscriptions.status.pastDue",
};

const DUNNING_STATUS_KEYS: Record<string, string> = {
  open: "dunning.caseStatus.open",
  retry_scheduled: "dunning.caseStatus.retryScheduled",
  retrying: "dunning.caseStatus.retrying",
  awaiting_manual_resolution: "dunning.caseStatus.awaitingManualResolution",
  recovered: "dunning.caseStatus.recovered",
  unrecovered: "dunning.caseStatus.unrecovered",
};

const RENEWAL_STATUS_KEYS: Record<string, string> = {
  scheduled: "renewals.cycleStatus.scheduled",
  processing: "renewals.cycleStatus.processing",
  succeeded: "renewals.cycleStatus.succeeded",
  failed: "renewals.cycleStatus.failed",
};

const RENEWAL_APPROVAL_KEYS: Record<string, string> = {
  pending: "renewals.approvalStatus.pending",
  approved: "renewals.approvalStatus.approved",
  rejected: "renewals.approvalStatus.rejected",
};
```

Add `const { t } = useTranslation("reorder");` as the first line of the component body. `DetailBlock` components (if any) need their own hooks.

- [ ] **Step 2: Convert the 11 formatters**

Delete `formatCaseStatus` (1499), `formatFinalOutcome` (1533), `formatReasonCategory` (1555), `formatSubscriptionStatus` (1575), `formatDunningStatus` (1590), `formatRenewalStatus` (1609), `formatApprovalStatus` (1624), `formatOfferType` (1637), `formatOfferDecisionStatus` (1648). Each call site becomes `t(KEY_MAP[value])`.

`formatReasonCategory` in this file has the same `null` → `"Unclassified"` branch and default title-case as the list page. Convert identically.

`formatDateTime` (1488) gains `emptyValue`. `getDrawerTitle` (1419) gets `t`:

```tsx
function getDrawerTitle(mode: ActionDrawerMode, t: TFunction) {
  switch (mode) {
    case "apply_offer":
      return t("cancellations.drawer.applyOfferTitle");
    case "finalize":
      return t("cancellations.drawer.finalizeTitle");
    case "reason":
      return t("cancellations.drawer.reasonTitle");
  }
}
```

`describeOfferPayload` (1682) builds English descriptions of offer payloads (e.g. `3 cycles`, `resume Jan 15, 2026`, `10 %`). Translating these requires eight new keys and a significant restructuring of the function. This is the most complex single function in the i18n work. The plan's recommendation: **leave `describeOfferPayload` in English for now**, add a note to the plan index as a known gap, and create a separate follow-up plan if needed. The function is internal to the offer-history timeline and affects only a small part of the detail page.

If you do want to translate it, the pattern is: replace every template literal string with `t("cancellations.offerPayload.", {...})` plus interpolation. The eight keys and their Chinese values would be:

- `"cycles": "{{count}} 个周期"` (handles both `3 cycles` and `3 cycles` with singular/plural via `count`)
- `"resumeAt": "{{date}} 恢复"`  
- `"discountValue": "{{value}} %"`  
- `"discountValueFixed": "{{value}} 固定"`  
- `"durationCycles": "持续 {{count}} 个周期"`  
- `"bonusValue": "{{value}}"`  
- `"bonusLabel": "{{label}}"`  
- `"offerPayloadDivider": " · "` (the joiner)

But this task is already large; skip it and document the gap.

- [ ] **Step 3: Translate the three mutations**

| Line | Change |
|------|--------|
| 48-55 | Find the apply-offer, finalize, and reason-update mutations. Translate success toasts to `t("cancellations.toast.offerApplied")`, `t("cancellations.toast.cancellationFinalized")`, `t("cancellations.toast.reasonUpdated")`. Translate error fallbacks to `t("cancellations.errors.applyOfferFailed")`, `t("cancellations.errors.finalizeFailed")`, `t("cancellations.errors.reasonUpdateFailed")`. |

Use `grep -n "toast.success\|toast.error"` to find the exact lines.

- [ ] **Step 4: Translate the prompts**

| Line | Change |
|------|--------|
| Find the apply-offer and finalize prompts. Translate: `title` → `t("cancellations.prompt.applyOfferTitle")` / `t("cancellations.prompt.finalizeTitle")`; `description` → corresponding description keys; `confirmText` → `t("cancellations.actions.applyOffer")` / `t("cancellations.actions.finalizeCancellation")`; `cancelText` → `t("common.actions.cancel")`. |

- [ ] **Step 5: Translate the page states and header**

| Line | Change |
|------|--------|
| Find the three early returns (loading, error, unavailable). Translate: `t("cancellations.detail.title")` for headings, `t("cancellations.detail.loading")`, `t("cancellations.detail.loadError")`, `t("cancellations.detail.unavailable")`. |
| Find the main header: `t("cancellations.detail.heading")` and `t("cancellations.detail.description")`. |
| Find the three action buttons (apply offer, finalize, update reason). Translate to `t("cancellations.actions.applyOffer")`, `t("cancellations.actions.finalizeCancellation")`, `t("cancellations.actions.updateReason")` / `t("cancellations.actions.editReason")`. |

- [ ] **Step 6: Translate the sections**

| Line | Change |
|------|--------|
| Case overview heading | `t("cancellations.detail.sections.caseOverview")` |
| Status badge | `{t(CANCELLATION_STATUS_KEYS[dunningCase.status])}` — use the correct variable name for the cancellation case |
| `Requested at` | `label={t("cancellations.fields.requestedAt")}` |
| `Reason category` | `label={t("cancellations.fields.reasonCategory")}` |
| `Reason` | `label={t("cancellations.fields.reason")}` |
| `Final outcome` | `label={t("cancellations.fields.finalOutcome")}` |
| `Finalized at` | `label={t("cancellations.fields.finalizedAt")}` |
| `Finalized by` | `label={t("cancellations.fields.finalizedBy")}` |
| `Decided at` | `label={t("cancellations.fields.decidedAt")}` |
| `Decision reason` | `label={t("cancellations.fields.decisionReason")}` |
| `Decision timeline` | `label={t("cancellations.fields.decisionTimeline")}` |
| `Offer history` heading | `t("cancellations.detail.sections.offerHistory")` |
| `No offer history` | `t("cancellations.detail.noOfferHistory")` |
| Subscription summary heading | `t("cancellations.detail.sections.subscriptionSummary")` |
| `Subscription status` | `label={t("cancellations.fields.subscriptionStatus")}` — badge `{t(SUBSCRIPTION_STATUS_KEYS[...])}` |
| Renewal summary heading | `t("cancellations.detail.sections.renewalSummary")` |
| `Renewal status` | `label={t("cancellations.fields.renewalStatus")}` |
| `Approval status` | `label={t("cancellations.fields.approvalStatus")}` |
| Dunning summary heading | `t("cancellations.detail.sections.dunningSummary")` |
| `Dunning status` | `label={t("cancellations.fields.dunningStatus")}` |
| Technical metadata heading | `t("cancellations.detail.sections.technicalMetadata")` |

Every `formatDateTime(...)` gains `, t("common.empty.noValue")`.

- [ ] **Step 7: Translate the three action drawers**

The apply-offer drawer has:
- `Drawer.Title` → `t("cancellations.drawer.applyOfferTitle")`
- Offer type select label → `t("cancellations.drawer.selectOfferType")`
- Each offer type option → `t("cancellations.offerType.pauseOffer")` etc.
- `Effective at` → `t("cancellations.drawer.effectiveAt")`
- `Immediately` / `End of cycle` → `t("cancellations.drawer.immediately")` / `t("cancellations.drawer.endOfCycle")`
- `Discount type` → `t("cancellations.fields.discountType")`
- `Percentage` / `Fixed` → `t("cancellations.drawer.discountPercentage")` / `t("cancellations.drawer.discountFixed")`
- `Discount value` → `t("cancellations.fields.discountValue")`
- `Free cycle` / `Gift` / `Credit` → `t("cancellations.drawer.freeCycle")` / `t("cancellations.drawer.gift")` / `t("cancellations.drawer.credit")`
- `Bonus value` → `t("cancellations.fields.bonusValue")`
- `Duration cycles` → `t("cancellations.fields.durationCycles")`
- `Optional label` → `t("cancellations.drawer.optionalLabel")`
- `Optional note` → `t("cancellations.drawer.optionalNote")`
- `Optional operator notes` → `t("cancellations.drawer.optionalOperatorNotes")`
- `Cancel` → `t("common.actions.cancel")`
- `Save` → `t("cancellations.actions.save")`

The finalize drawer:
- `Drawer.Title` → `t("cancellations.drawer.finalizeTitle")`
- `Select a category` → `t("cancellations.drawer.selectCategory")`
- Reason category options → `t("cancellations.reasonCategory.*")` keys
- `Capture the churn reason` → `t("cancellations.fields.captureChurnReason")`
- `Optional final cancellation notes` → `t("cancellations.drawer.optionalFinalCancellationNotes")`
- `Optional reason or customer response` → `t("cancellations.drawer.optionalReasonOrCustomerResponse")`
- `Cancel` → `t("common.actions.cancel")`
- `Finalize cancellation` → `t("cancellations.actions.finalizeCancellation")`

The reason-update drawer:
- `Drawer.Title` → `t("cancellations.drawer.reasonTitle")`
- `Select a category` → `t("cancellations.drawer.selectCategory")`
- `Optional explanation for the update` → `t("cancellations.drawer.optionalExplanation")`
- `Cancel` → `t("common.actions.cancel")`
- `Save` → `t("cancellations.actions.save")`

- [ ] **Step 8: Verify, build, test, commit**

```bash
grep -nE '(header|label|title|placeholder|confirmText|cancelText)(:|=) *"[A-Z]' src/admin/routes/subscriptions/cancellations/\[id\]/page.tsx
grep -nE '>[A-Z][a-zA-Z ]{3,}<' src/admin/routes/subscriptions/cancellations/\[id\]/page.tsx
grep -nE 'return "[A-Z]' src/admin/routes/subscriptions/cancellations/\[id\]/page.tsx
grep -nE '\|\| "-"' src/admin/routes/subscriptions/cancellations/\[id\]/page.tsx
yarn build && yarn test:i18n
```

Propose to the user and wait for approval:

```
feat(i18n): translate cancellations detail page
```

```bash
git add src/admin/routes/subscriptions/cancellations/\[id\]/page.tsx
git commit -m "feat(i18n): translate cancellations detail page"
```

---

## Verification summary

```bash
yarn build && yarn test:i18n && yarn test:integration:http
```

## Known remaining English after this plan

- `describeOfferPayload` in `cancellations/[id]/page.tsx` — the offer-history timeline descriptions (`3 cycles`, `resume Jan 15`, `10 %`) stay English. This is a deliberate scope decision documented in Task 3 Step 2 with the full key set if tackled later.
- Backend frequency and discount labels, as before.
- Analytics metric names (`MRR`, `Churn Rate`, `LTV`) — Plan 6 covers that page.