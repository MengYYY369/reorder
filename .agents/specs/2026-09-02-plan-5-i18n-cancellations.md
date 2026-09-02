# Plan 5: Cancellation & Retention Domain

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans`. Checkbox syntax. Browser checks main-agent-only.

**Goal:** Translate the cancellation list page and the largest detail page, with the
**three distinct retention-offer prompts** preserved and the ~20 surrounding strings
Rev 1 missed.

**Architecture:** Plan 1/2 patterns. Key structural fix from review: the detail page
has three separate apply-offer confirmation flows (pause / discount / bonus) whose
descriptions communicate different consequences — they get three key triples, not a
generic one. `describeOfferPayload` summary fragments remain a documented exception;
everything around it is translated.

**Tech Stack:** react-i18next, `ReorderTranslate`.

## Global Constraints

- Prerequisite: Plan 4 accepted.
- **English frozen**; byte-for-byte extraction.
- Key ownership: `common.fields.sku` / `common.fields.reason` / `common.fields.reference`
  / `common.fields.customer` / `common.fields.order` come from Plan 1's `common`
  block (they exist there — do **not** expect them under `subscriptions.fields.*`;
  Plan 2's domain fields are additive). `cancellations.fields.*` holds only
  cancellation-specific fields.
- `actions.cancel` = `common.actions.cancel` only.
- Status keys: this domain's enum values are string literals — maps are
  `Record<string, string>`.
- Preflight: `docs/architecture/cancellation.md`, `docs/admin/cancellations.md`,
  `docs/testing/cancellations.md`.
- One commit at plan end.

## Complete string inventory

### List page (`cancellations/page.tsx`)

Title `Cancellation & Retention` (×2), description `Review cancellation cases, churn reasons, and retention outcomes.` (×2 — exact text), `Failed to load cancellation cases.`, columns Subscription / Status / Reason category / Final outcome / Offer type (verify against source; keep exact order), filters (reason-category 7 options, final-outcome 3, offer-type 3, `Add filter`, `Created from`, `Created to`), `Clear all`, `Search`, empty pairs, `FilterChip` `is`, `Unclassified`, `Retained`/`Paused`/`Canceled` outcome, offer-type labels.

### Detail page (`cancellations/[id]/page.tsx`)

- Headings `Cancellation case` (×3 early returns) + `Loading cancellation case details...` / `Failed to load cancellation case details.` / `Cancellation case details are unavailable.`
- Header block `Cancellation case` + description `Review cancellation context, retention actions, linked module summaries, and final outcome.` (exact)
- Action buttons: `Apply retention offer`, `Finalize cancellation`, `Change reason` (verify exact label), loading `Loading latest case data for this action...` ← missed in Rev 1
- **Three offer prompts** (source 424-430, 463-469, 503-509):
  - `Apply pause offer?` + pause description
  - `Apply discount offer?` + discount description
  - `Apply bonus offer?` + bonus description
  - finalize prompt `Finalize cancellation?` + description
- Toasts: offer applied / finalized / reason updated + 3 error fallbacks
- Validation: `Reason is required`, `Reason is required before final cancel`, `Bonus value is required for free cycle or credit`, `Discount value must be greater than 0`, `Pause offer requires pause cycles or resume date`, `Selected retention offer is not allowed for this case`
- Case overview: Status / `Requested at` / `Cancellation effective at` / `Cancelled at` / `Decided at` / `Finalized at` / `Finalized by` / Reason category / Reason / `No final outcome yet` / `No reason recorded` ← missed set
- Offer history: heading, `No retention offers have been recorded for this case yet.`, `No retention offers or final outcome entries have been recorded yet.`, `No payload summary`, timeline entry labels (`Retention offer event recorded`, `Final outcome`, `Case reached a terminal outcome`, `Effective at {{date}}` — verify exact forms at source 291-315) ← missed set
- Linked summaries: `Linked renewal summary` (heading), `No linked renewal cycle`, `Renewal status`, `Approval status`, `Linked dunning summary` (heading), `No active dunning case linked`, `Dunning status`, `Attempt count`, `Last error` ← missed set
- Offer drawer: `Apply retention offer` title, `Select offer type`, three offer-type options, `Effective at`, `Immediately`, `End of cycle`, `Pause cycles`, `Resume at`, `Discount type`, `Percentage`, `Fixed`, `Discount value`, `Duration cycles`, `Bonus type`, `Free cycle`, `Gift`, `Credit`, `Bonus value`, `Label`, `Optional label`, `Optional note attached to the offer payload`, `Optional operator notes`, footer `Apply offer` / `Continue` ← missed
- Finalize drawer: `Finalize cancellation` title, `Select a category`, 7 reason options, `Capture the churn reason`, `Optional final cancellation notes`, footer
- Reason drawer: `Update reason`/`Edit reason` (verify exact), `Optional explanation for the update`, footer `Save`
- Formatters: case status (6 string-literal cases), final outcome, reason category (`Unclassified` + default title-case), subscription status (reuse `subscriptions.status.*`), dunning status (reuse `dunning.caseStatus.*`), renewal status (reuse `renewals.cycleStatus.*`), approval (reuse `renewals.approvalStatus.*`), offer type, offer decision (Proposed/Accepted/Rejected/Applied/Expired)

## Task 1: Catalog keys

**Files:** both JSON files.

Add `cancellations.*` per inventory: `list`, `columns`, `filters`, `caseStatus`,
`outcome`, `offerType`, `reasonCategory` (7 + `unclassified`), `detail` (incl.
`sections.linkedRenewal`, `sections.linkedDunning`, empty/loading strings),
`fields`, `actions`, `toast`, `errors`, `prompt` — with
**`prompt.applyPauseTitle/applyPauseDescription`,
`prompt.applyDiscountTitle/applyDiscountDescription`,
`prompt.applyBonusTitle/applyBonusDescription`** as three distinct pairs (plus
`finalizeTitle/Description`), and `drawer.*` incl. `applyOfferFooter` (`Apply offer`)
and `continueFooter` (`Continue`).

Rules: byte-for-byte English; zhCN per Plan 1 terminology; three prompt descriptions
must be translated with their distinct consequences intact (暂停恢复语义 / 折扣语义 /
赠品语义), not merged into one generic sentence. Run `yarn test:i18n`.

## Task 2: List page

- [ ] Restructure module-scope options/columns into the component (zero string
  changes).
- [ ] Hook + key maps (`CANCELLATION_REASON_KEYS`, `CANCELLATION_OUTCOME_KEYS`,
  `CANCELLATION_OFFER_TYPE_KEYS`); `formatReasonCategory(value, t)` keeps the
  `Unclassified` branch and title-case default; `formatDateTime` gains
  `emptyValue`.
- [ ] JSX per inventory; `FilterChip` own hook.
- [ ] Verify: greps clean; build + `yarn test:i18n`; browser (main agent): filters,
  outcome badges, empty states.

## Task 3: Detail page

- [ ] Hook (page) + hooks in `DetailRow`/`JsonBlock`-style children and the drawer
  bodies as separate components.
- [ ] Key maps for the 9 status/decision formatters; `getDrawerTitle(mode, t)`;
  `formatDateTime`/`formatUnknown` gain `emptyValue`; `describeOfferPayload` left
  English (documented exception) — **but its `formatDateTime` calls inside still get
  the `emptyValue` argument** so signatures stay consistent.
- [ ] JSX per inventory **including every previously missed string**: the three
  prompt triples mapped to their own drawers (`Apply pause offer?` →
  `applyPauseTitle` etc.), timeline empty states, linked summary sections, drawer
  footers `Apply offer`/`Continue`, loading-latest-case copy.
- [ ] Verify: four grep sweeps clean; build + `yarn test:i18n`; browser (main
  agent): all three offer flows (each dialog shows its own distinct Chinese
  description), finalize flow with reason-required validation, reason-update flow,
  linked summaries showing `无关联续订` / `无活跃催收案例`, offer history with the
  English payload fragments (expected).

## Completion: single commit

```
feat(i18n): translate cancellation and retention screens
```
