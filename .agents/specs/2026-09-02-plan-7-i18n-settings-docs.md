# Plan 7: Settings, Docs, Final Gates

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans`. Checkbox syntax. Browser checks are main-agent-only.

**Goal:** Translate the subscription-settings page **without changing its
behavior**, then finalize documentation and run the repo-wide acceptance gates.

**Architecture:** The one behavioral rule this plan exists to enforce:
`getChangedSections` currently returns English display strings that
`hasWideImpactChanges` compares against (`src/admin/routes/settings/subscription-settings/page.tsx:125-149, 284-288`). Translating those values in place would make
the wide-impact warning language-dependent. This plan first refactors the page to
use **stable section IDs** (`trial` / `dunning` / `renewals` / `cancellation`) for
all logic, and only then translates display labels at render time — as two separate
tasks so the behavior refactor is reviewable on its own.

**Tech Stack:** react-i18next, `ReorderTranslate`.

## Global Constraints

- Prerequisite: Plan 6 accepted.
- **English frozen; byte-for-byte extraction.** Two commits this plan: the settings
  behavior refactor + translation (one commit), then docs (second commit).
- Preflight: `docs/architecture/settings.md`, `docs/admin/subscription-settings.md`,
  `docs/testing/subscription-settings.md`.
- Stable IDs are data, not copy: never pass a translated string where an ID is
  compared.

## Complete string inventory (settings page)

- Title `Subscription Settings` (×4: loading, error, main ×2), description `Manage runtime defaults for trials, dunning, renewals, and cancellation flows.` (×2), `Loading current runtime configuration…`, `Failed to load subscription settings`
- Save block: `Save`, `Saving…` (verify exact pending label), `Changes will apply after this save completes.` / `No unsaved changes.`
- Version/status rows: `Using fallback defaults until the first save`, `No persisted settings record exists yet.`, `Persisted version {{version}}`, `Last updated at {{date}}`, `Updated by {{actor}}`, `Updated by system bootstrap or no actor recorded.` (verify exact set at source 340-368)
- Reset alert: `Reset to defaults is not supported yet in the admin UI.`
- Unsaved-changes alert: `Unsaved changes in: {{sections}}`, narrow-impact and wide-impact variants (verify exact source sentences at 376-390 — the wide-impact sentence mentions persisted process state; do not drop it)
- Intro hint block (source 309-312): both sentences — `Changes apply to future operations and newly created process state.` **and** the existing-cases sentence that Rev 1 dropped
- Sections: `Trial` + `Configure the default trial period applied to future subscription operations.`; `Dunning` + `Define the retry schedule used when a new dunning case is created.`; `Renewals` + `Choose the default behavior used when a new renewal cycle is created.`; `Cancellation Defaults` + `Define how newly created cancellation cases should start.`
- Fields: `Default trial days`, `Retry intervals`, `Values are stored in minutes and must be strictly increasing.`, `Add interval`, `Max dunning attempts`, `Default renewal behavior`, `Default cancellation behavior`
- Behavior options: `Process immediately` + hint, `Review pending changes` + hint, `Recommend retention first` + hint, `Allow direct cancellation` + hint
- Zod messages (3): `Retry interval must be a positive integer`, `Retry intervals must be strictly increasing`, `Max dunning attempts must match the number of retry intervals`
- Toasts: `Subscription settings updated`, `Failed to update subscription settings`, `Settings changed in another session. Refresh the page and try saving again.`

## Task 1: Behavior refactor — stable section IDs (no i18n yet)

**Files:** `src/admin/routes/settings/subscription-settings/page.tsx`

- [ ] Introduce the ID type and switch `getChangedSections` to push IDs:

```ts
type ChangedSection = "trial" | "dunning" | "renewals" | "cancellation"

function getChangedSections(
  dirtyFields: Partial<Record<keyof SubscriptionSettingsFormValues, unknown>>
): ChangedSection[] {
  const sections: ChangedSection[] = []

  if (dirtyFields.default_trial_days) {
    sections.push("trial")
  }
  if (dirtyFields.dunning_retry_intervals || dirtyFields.max_dunning_attempts) {
    sections.push("dunning")
  }
  if (dirtyFields.default_renewal_behavior) {
    sections.push("renewals")
  }
  if (dirtyFields.default_cancellation_behavior) {
    sections.push("cancellation")
  }

  return sections
}
```

- [ ] Update `hasWideImpactChanges` to compare IDs:

```ts
  const hasWideImpactChanges = changedSections.some((section) =>
    ["dunning", "renewals", "cancellation"].includes(section)
  )
```

- [ ] Keep the current UI rendering English temporarily — render labels via a
  module-scope `SECTION_LABELS: Record<ChangedSection, string>` map so the
  `Unsaved changes in: ...` output is **byte-identical** to today's behavior
  (`Trial, Dunning, ...`). Verify with `yarn build` and a browser diff (main agent):
  dirty a dunning field, confirm the wide-impact warning still appears.

This task changes zero user-visible strings and zero behavior — it only replaces
string-typed magic values with typed IDs.

## Task 2: Catalog keys + translation

**Files:** both JSON files, then the settings page.

- [ ] Add `settings.*` per the inventory: `list`, `toast`, `errors`, `sections`
  (labels + the four descriptions), `fields`, `behaviorOptions`
  (4 label+hint pairs), `validation` (3 zod-message keys), `status`
  (version/updated rows incl. interpolated keys), `alerts` (reset, unsaved
  `{{sections}}`, narrow/wide impact, apply/none, fallback/no-record,
  bootstrap/no-actor, saving states), `intro` (both sentences).
- [ ] Schema `message:` values → `settings.validation.*` keys; the page's
  `FieldError` (line 639) resolves keys via `t(message)` (Plan 3 pattern).
- [ ] Move `renewalBehaviorOptions` / `cancellationBehaviorOptions` inside the
  component as `useMemo` with `[t]`, labels+hints via `t`, **`value` strings
  byte-identical** (API values).
- [ ] Render section labels via `t` keyed by the stable IDs from Task 1 —
  logic still compares IDs only.
- [ ] Translate all inventory strings; every interpolated key
  (`{{version}}`/`{{date}}`/`{{actor}}`/`{{sections}}`) keeps its argument.
- [ ] Verify: grep sweeps clean; `yarn build && yarn test:i18n` green.
- [ ] Browser (main agent): switch language to 简体中文; dirty a dunning field →
  the **wide-impact** warning must show (this is the regression test for the
  Rev 1 bug); dirty only the trial field → narrow warning; unsaved-changes list
  shows Chinese section names; save flow toasts Chinese; version/updated rows
  interpolate correctly; switch back to English → identical behavior.

## Task 3: Documentation

**Files:**
- Create: `docs/admin/i18n.md`
- Modify: `docs/README.md` (add `docs/admin/i18n.md` to the admin docs list)

Content: supported languages and per-user selection; the `reorder` namespace;
adding a string (three rules: key convention, update **both** JSON files, run
`yarn test:i18n`); the five contract tests; frozen-English rule; stable-ID rule
(section IDs are logic, labels are copy); deliberate-exceptions list from the plan
index (backend labels, event-type title-casing, `describeOfferPayload`,
USD `en-US`); glossary table (subscription 订阅, renewal 续订, dunning 催收,
retention 挽留, recovered 已回收…). Do not document unimplemented behavior.

## Task 4: Final gates (main agent)

- [ ] Repo-wide sweep:

```bash
grep -rn 'label: "[A-Z]' src/admin --include="*.tsx"
grep -rnE '>\s*[A-Z][a-zA-Z ]{3,}\s*<' src/admin --include="*.tsx"
yarn build && yarn test:i18n && yarn test:integration:modules && yarn test:integration:http
```

Expected: the first grep shows only `menuItems.*` labels; the second returns
nothing; all four commands green (24 HTTP specs, 8 module specs).

- [ ] Full-browser acceptance (main agent): switch the admin to 简体中文 and walk
  every sidebar item — 订阅 / 计划与优惠 / 续订 / 催收 / 取消与挽留 / 数据分析 /
  操作日志 / 订阅设置 — confirming no raw `domain.key` literals render anywhere
  and the documented exceptions are the only English remaining. Switch back to
  English and repeat.
- [ ] Post-push: ask the user whether the public Mintlify docs (`../docs/`) need
  the same update; if yes, run the `sync-docs` skill.

## Completion: two commits

Propose each and wait for approval:

```
feat(i18n): translate subscription settings with stable section identifiers
docs(i18n): document Simplified Chinese admin support
```
