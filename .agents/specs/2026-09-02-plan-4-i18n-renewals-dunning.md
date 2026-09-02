# Plan 4: Renewals & Dunning Domains

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans`. Checkbox syntax. Browser checks main-agent-only.

**Goal:** Translate the renewals queue + detail and dunning queue + detail pages.

**Architecture:** Plan 1/2 patterns, with two Rev 1 fixes baked in: **no default
empty-translator parameters** (a missed `t` must be a compile error, not blank UI),
and `formatDateRange`'s English connectors become interpolated keys. Status
vocabularies stay domain-scoped — cycle `Processing` (正在处理) and attempt
`Processing` (进行中) are deliberately different keys.

**Tech Stack:** react-i18next, `ReorderTranslate`.

## Global Constraints

- Prerequisite: Plan 3 accepted.
- **English frozen**; byte-for-byte extraction.
- `actions.cancel` = `common.actions.cancel` only (no domain copies).
- Backend labels English; the `1440, 4320, 10080` placeholder is a number format —
  untranslated.
- Preflight: `docs/architecture/renewals.md` + `dunning.md`, matching
  `docs/admin/*.md` and `docs/testing/*.md`.
- One commit at plan end.

## Complete string inventory

### Renewals list (`renewals/page.tsx`)

Title `Renewals` (×2), description `Monitor scheduled subscription renewal cycles and their latest execution state.` (×2 — **use this exact text**; Rev 1 paraphrased it),
`Failed to load renewals.`, columns Scheduled / Subscription / Status / Approval /
Last attempt, cell `No attempts yet`, filters (Status / Approval / Last attempt
option sets, `Add filter`, `Approval status`, `Last attempt result`,
`Scheduled from`, `Scheduled to`), `Clear all`, `Search`, empty-state pairs,
`FilterChip` `is`.

Formatter families: cycle status (Scheduled/Processing/Succeeded/Failed), attempt
status (Processing/Succeeded/Failed), approval (Pending/Approved/Rejected),
approval-summary (`Not required`, `Pending approval`), relative status
(Awaiting processing / Currently processing / Processed / Needs review).

### Renewals detail (`renewals/[id]/page.tsx`)

Headings `Renewal` (×3 early returns) + loading/error/unavailable copy,
`Renewal cycle` header + description, actions (`Force renewal`, `Forcing...`,
`Approve changes`, `Reject changes`), force/approve/reject prompts (titles,
descriptions, confirm/cancel), toasts (`Renewal forced`, `Pending changes approved`,
`Pending changes rejected`) + 3 error fallbacks + `Reason is required`,
sections (`Cycle overview`, `Approval summary`, `Pending changes`,
`Attempt history`, `Technical metadata`, `Subscription summary`,
`Generated order summary`), rows (Status / Projected delivery / Operational cycle /
Processed at / Created at / Last error / `No error recorded` / Approval / Required +
Yes/No / Decided at / Decided by / Reason / Variant / Frequency / Effective at /
Variant ID / `No pending changes are attached to this renewal cycle.` /
attempt-table headers Attempt/Status/Started/Finished/Error/Order /
`No error message` / `No attempts have been recorded for this renewal cycle yet.` /
`No metadata was stored for this renewal cycle.` / customer-product rows /
`No order generated` / Order status / Order ID), decision drawer
(`Approve changes`/`Reject changes` title, `Reason` / `Reason *`,
`Optional review note` / `Required rejection reason`, Cancel, Approve/Reject),
`formatFrequency` deleted → interval-key form.

### Dunning list (`dunning/page.tsx`)

Title `Dunning` (×2), description `Monitor past-due subscriptions, retry timing, and recovery state.` (×2), `Failed to load dunning cases.`, columns Subscription / Status / Next retry / Attempts / Last error, cells (`No retry attempts yet`, `No payment error code`, `Unknown provider`), filters (6 status options, `Add filter`, `Provider id` label+placeholder, `Error code` label+placeholder, `Attempt range`, `Min`, `Max`, `Next retry from`, `Next retry to`), `Clear all`, `Search`, empty pairs, `FilterChip` `is`, status map (Open / Retry scheduled / Retrying / Awaiting manual resolution / Recovered / Unrecovered), retry-window phrases (Recovered / Closed as unrecovered / Waiting for manual resolution / No retry scheduled / Queued for retry), `formatAttemptRange` (`Up to {{max}}` branch), `formatDateRange` (three connector keys).

### Dunning detail (`dunning/[id]/page.tsx`)

Headings `Dunning case` (×3) + loading/error/unavailable, header + description,
actions (`Retry now`/`Retrying...`, `Mark recovered`, `Mark unrecovered`,
`Marking recovered...`/`Marking unrecovered...`, `Edit retry schedule`,
`Save schedule`/`Saving schedule...`), five prompts (retry-now, override, mark
recovered/unrecovered pairs), toasts (retry started, marked recovered/unrecovered,
retry schedule updated) + 4 error fallbacks + 4 validation messages (`Reason is
required`, `At least one retry interval is required`, `Max attempts must be a
positive integer`, `Max attempts must equal the number of retry intervals`),
sections (Case overview / Payment summary / Retry schedule / Attempt timeline /
Technical metadata / Subscription summary / Renewal summary /
Order / payment summary), rows (Status / Attempt count / Next retry / Last attempt /
Recovered at / Closed at / Created at / Updated at / Last error code / Provider /
Last error message + `No payment error message` / Latest payment reference /
Recovery reason / Strategy / Timezone / Intervals / Source / attempt-table headers +
`Payment reference` / `No error message` / `No attempts have been recorded for this
dunning case yet.` / `No metadata was stored for this dunning case.` /
subscription rows / `No linked renewal` / Renewal status / Scheduled for /
Generated order id / `No linked order` / Order status / Order ID), action drawer
(warning banner, `Retry intervals (minutes)`, placeholder, `Max attempts`,
`Reason *`/`Reason`, three placeholder variants), `formatIntervals`
(`{{value}} min`), `formatRenewalStatus` via renewals cycle keys.

## Task 1: Catalog keys

**Files:** both JSON files.

Add `renewals.*` and `dunning.*` areas covering the inventories above — `list`,
`columns`, `filters`, status families, `detail`, `fields`, `actions`, `toast`,
`errors`, `prompt`, `drawer` (dunning), `dateRange` (`fromTo` `{{from}} 至 {{to}}`,
`from` `自 {{value}} 起`, `until` `截至 {{value}}`), `intervals.minuteUnit`
(`{{value}} 分钟`), `filters.upTo` (`Up to {{max}}` / `最多 {{max}}`).

Rules: byte-for-byte English (source wins on conflict); no `actions.cancel` copies;
zhCN per Plan 1 terminology with 催收 for dunning and 已回收/未回收 retained for
recovered/unrecovered (glossary note: if the team prefers 追回, change once in
`zhCN.json` — all pages follow automatically). Run `yarn test:i18n`.

## Task 2: Renewals list

- [ ] Restructure module-scope options/columns into the component (zero string
  changes; build green).
- [ ] Hook + four key maps (cycle, attempt, approval, relative status).
- [ ] Delete the four plain formatters; `formatApprovalStatus(approval, t)` keeps
  the `notRequired` branch; `formatDateTime` gains required `emptyValue`.
- [ ] JSX per inventory; `FilterChip` own hook.
- [ ] Verify: greps clean; `yarn build && yarn test:i18n`; browser (main agent):
  queue columns/badges/filters incl. 排期时间起/至, `无需审批`.

## Task 3: Renewals detail

- [ ] Hook (page) + key maps (incl. `RENEWAL_INTERVAL_KEYS` keyed by the string
  union); convert/delete formatters per inventory; **every helper takes required
  `t`** — no defaults.
- [ ] `getAdminErrorMessage(error, fallback)` unchanged — callers pass
  `t("renewals.errors.*")` as fallback.
- [ ] JSX per inventory incl. decision drawer and attempt table.
- [ ] Verify: greps clean; build + `yarn test:i18n`; browser (main agent): all seven
  sections, force/approve/reject flows, 请填写原因 validation, cycle vs attempt
  status wording difference visible.

## Task 4: Dunning list

- [ ] Restructure; hook + `DUNNING_CASE_STATUS_KEYS`.
- [ ] Delete `formatStatus`; `formatRetryWindow(item, t)`;
  `formatAttemptRange(t, min?, max?)`; **`formatDateRange(from, to, t)` with
  required `t` and the two call sites updated in the same task** (Rev 1's default
  `() => ""` is forbidden — a missed argument must fail compilation, not render
  blank labels).
- [ ] JSX per inventory; `FilterChip` own hook.
- [ ] Verify: greps clean; build + `yarn test:i18n`; browser (main agent): status
  badges, five filter inputs, `1440 分钟` not required here (detail-only).

## Task 5: Dunning detail

- [ ] Hook + key maps (case, attempt, subscription, renewal-status map over the
  string union with `t(MAP[status] ?? status)` passthrough for unknown values).
- [ ] `getDrawerTitle(mode, t)` / `getDrawerSubmitLabel(mode, pending, t)` —
  required `t`; `formatIntervals(intervals, t)`; `formatRenewalStatus(status, t)`.
- [ ] JSX per inventory incl. action drawer and validation toasts.
- [ ] Verify: greps clean; build + `yarn test:i18n`; browser (main agent): all
  eight sections, retry-now/mark flows, schedule drawer with Chinese labels and the
  numeric placeholder unchanged, `1440 分钟` intervals row.

## Completion: single commit

```
feat(i18n): translate renewals and dunning screens
```
