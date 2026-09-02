# Simplified Chinese (zhCN) Support — Plan Index (Rev 2)

This is the execution order for adding Simplified Chinese to the Reorder Admin UI,
preceded by the Medusa 2.19 upgrade.

This revision replaces the 2026-09-02 Rev 1 plan set (archived in `v1/`). It resolves
the review findings recorded in the Rev 1 self-review and independent audits:
Plan 0 scope violation, a locale-dependent behavior regression in Settings, analytics
child-component scoping, contract-test blind spots, a Windows-unusable browser gate,
33 approval checkpoints, wrong skill names, and ~40 missing strings.

Each plan below is independently reviewable but sequentially dependent. Do not start a
plan before the previous one is accepted.

## Execution rules for every plan

- **Branch first.** Never work on `main`. Create `feat/simplified-chinese` (or a
  worktree via `using-git-worktrees`) before Plan 0 and keep it for Plans 0-7.
- **One commit per plan.** After the plan's tasks are complete and verified, the
  implementer presents a summary plus one Conventional Commits message and waits for
  explicit user approval before committing. No commit commands appear inside tasks.
- **Main-agent browser checks.** Subagents may edit code and run tests, but every
  browser verification in these plans is performed by the main agent — never by a
  subagent (Browser Use is main-agent-only in this environment).
- **Skills.** Plans reference the exact installed skill names:
  `subagent-driven-development`, `executing-plans`, `run-tests`, `local-dev`,
  `using-git-worktrees`, `verification-before-completion`.
- **English baseline is frozen.** Every `en.json` value must match the existing
  rendered English copy byte-for-byte at extraction time. Copywriting changes require
  a separate, explicit task. The only permitted English-edit is the order-widget
  `"subscription_discount"` fallback fix (Plan 2, disclosed).
- **Backend labels stay English** (explicit decision): frequency labels
  (`Every month`), discount labels (`10% off`), and analytics metric labels from
  `METRIC_LABELS`. Frontend-authored strings are translated — the metric-tab labels
  `Churn` / `Created` in `metricTabs` are frontend strings and ARE in scope.
- **Preflight docs.** Before a domain plan's tasks start, read the matching
  `docs/architecture/*.md`, `docs/admin/*.md`, and `docs/testing/*.md` files, and
  invoke the `run-tests` skill for the verification step.

## Plan sequence

| Order | Plan | Scope | Commit |
|-------|------|-------|--------|
| 0 | [Medusa 2.19 version bump](2026-09-02-plan-0-medusa-2.19-upgrade.md) | Package versions + lockfile only; verify; report failures | `chore(deps): ...` |
| 1 | [i18n foundation](2026-09-02-plan-1-i18n-foundation.md) | Namespace, catalogs, full key-literal contract test, shared translate type, sidebar labels, breadcrumbs, 2 pilot files, platform-safe browser gate | `feat(i18n): ...` |
| 2 | [Subscriptions domain](2026-09-02-plan-2-i18n-subscriptions.md) | List + detail pages, order widget, address lines, all empty/loading states | `feat(i18n): ...` |
| 3 | [Plans & Offers domain](2026-09-02-plan-3-i18n-plans-offers.md) | List + create modal + edit drawer + discount range filter | `feat(i18n): ...` |
| 4 | [Renewals & Dunning domains](2026-09-02-plan-4-i18n-renewals-dunning.md) | 4 files; no silent default translator | `feat(i18n): ...` |
| 5 | [Cancellation & Retention domain](2026-09-02-plan-5-i18n-cancellations.md) | List + detail; three distinct offer prompts; full empty/loading/linked-section coverage | `feat(i18n): ...` |
| 6 | [Activity Log & Analytics](2026-09-02-plan-6-i18n-activity-log-analytics.md) | Both pages; child-component hooks; export block; aria labels | `feat(i18n): ...` |
| 7 | [Settings, docs, final gates](2026-09-02-plan-7-i18n-settings-docs.md) | Stable section IDs, dynamic status copy, docs, repo-wide sweep | `feat(i18n): ...` + docs commit |

## Shared type — defined once in Plan 1

`src/admin/i18n/translate.ts` exports:

```ts
export type ReorderTranslate = ReturnType<typeof useTranslation>["t"]
```

All helper signatures across Plans 2-6 use `ReorderTranslate` — never
`import type { TFunction } from "i18next"` (i18next is an undeclared transitive
dependency here). Helper functions that need `t` take it as their **first** parameter
when trailing parameters are optional (`formatDiscountRange(t, min?, max?)`), and as a
**required** parameter otherwise — no default empty-translator implementations.

## Key ownership (canonical, resolves Rev 1 conflicts)

- `common.fields.*`: `id`, `product`, `variant`, `status`, `frequency`, `discount`,
  `nextRenewal`, `subscription`, `reference`, `customer`, `order`, `sku`, `reason`,
  `email`, `createdAt`
- Domain status enums stay domain-scoped (`subscriptions.status.*`,
  `renewals.cycleStatus.*`, `dunning.caseStatus.*`, `analytics.status.*`,
  `cancellations.caseStatus.*`). `analytics.status.*` is a distinct key set, not a
  duplicate: its values feed the analytics filter only.
- `actions.cancel` exists only as `common.actions.cancel`. No domain redefines it.
- Domain-specific strings stay in their domain even when the English text coincides
  with another domain's (e.g. renewals' `Processing` ≠ attempts' `Processing` in zh).

## Verification per plan

1. `yarn build` — green.
2. `yarn test:i18n` — the contract test: catalog parity, no empty values, and every
   translation-key-shaped string literal in `src/admin/**` (any of the ten namespace
   prefixes, single- or double-quoted, including key maps, zod `message:` values, and
   route labels) exists in `en.json`. Route configs must carry
   `translationNs: "reorder"`.
3. `yarn test:integration:http` + `yarn test:integration:modules` — green
   (via the `run-tests` skill).
4. Main-agent browser check per the plan's verification task.

## Deliberate exceptions (documented, not gaps)

- Backend `formatFrequencyLabel`, discount labels, `METRIC_LABELS` — English.
- Activity-log event-type badges (`formatActivityEventType` / `formatEventType`) —
  frontend title-casing of open-ended backend event strings; no fixed vocabulary.
- Analytics USD formatting keeps its `"en-US"` hardcode.
- Cancellation `describeOfferPayload` summary fragments (`3 cycles`, `resume <date>`,
  `10 %`) — known gap, tracked for a future plan; everything around it IS translated.
