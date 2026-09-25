# Spec: post-acceptance backlog (v1.6.0 follow-up round)

## TLDR & Overview

v1.6.0 shipped the 12-ticket `source-repo-fixes` plan, failed acceptance on
2026-09-24, and was corrected by a seven-commit round on
`fix/1.6.0-acceptance-fixes` (merged to `main` and tagged `v1.6.0` on
2026-09-25, gates green: build 0, modules 25 suites / 270 tests, http 35 suites /
228 tests with zero failing assertions). That round ruled a number of findings
*not fixed now* — each with a stated reason and a flip condition, recorded in
`.agents/specs/2026-09-24-1.6.0-acceptance-fixes.md` under *Deferred (ruled, not
forgotten)* and revision logs v4/v5. This document turns that backlog into
work for the next round, and adds what the release rehearsal exposed: the
published artifact is not what a plugin should ship, and nothing in the repo can
verify a migration's data-shaping step.

Two things are deliberately **not** in scope: re-litigating the rulings the user
already made in the previous round (reschedule-in-shared-step + partial unique
index; fold into `[1.6.0]`; defer the admin form duplication; `adopt` no-ops
against an in-flight renewal), and adding back-compat shims — no production
customers exist yet, so class-level fixes stay on the table.

Every `file:line` below was read this session; where a claim depends on framework
internals it names the `node_modules` path instead of trusting memory.

## Objectives

- O1 — the package a host installs contains this plugin, not this repository's
  test suites and browser drivers.
- O2 — migration *behavior* (not only migration *constraints*) is assertable in a
  gate that runs in CI-less reality: today `up()`'s normalization is proven by a
  hand-run scratch database that no longer exists.
- O3 — close the two remaining ways money can be mishandled: a stale live cycle
  surviving beside a terminal one, and the auto-renew toggle deciding on a stale
  snapshot.
- O4 — close the last disclosure path that quotes internals, at the right layer
  (or state, in the docs, exactly which layer does not scrub).
- O5 — make the code the round cannot currently test testable: the three
  `src/workflows/**` specs no gate executes, and the `adopted` rollback with no
  end-to-end case.
- O6 — a rehearsed, reversible path to get 1.6.0 onto the target deployment and
  verify it there, without a second money-unit incident.

## Open Questions (skeleton phase — resolve before any code)

These are the forks where a wrong guess costs a rewrite rather than a diff.

- **Q1 — scope of this round.** Which of O1…O6 do we take, in what order? A
  candidate split that keeps each half independently shippable: **(a)** release
  shape (O1, O2), **(b)** money correctness + disclosure (O3, O4), **(c)** test
  reachability (O5), **(d)** the deployment itself (O6). Say "all, in that order"
  or name a subset.
- **Q2 — packaging direction.** Options, with different blast radius:
  - **B1** keep shipping everything and only fix provenance (what the last round
    chose): cheapest, but a 5.0 MB unpacked tarball keeps carrying 29 compiled
    Playwright files and `playwright.config.js`.
  - **B2** scope the build: give root `tsconfig.json` a real `include` (it
    currently reads `"**/*"`, with `outDir: ./.medusa/server`, which is exactly
    what `package.json`'s `files: [".medusa/server"]` publishes) so only the
    plugin compiles, and add `integration-tests` / `e2e` to the exclude list.
    Requires re-running all three gates (and a Postgres container again) because
    it changes what `yarn build` emits.
  - **B3** leave `tsconfig` alone (other tooling may rely on the broad include) and
    list the published paths explicitly in `files` instead.
  My default is **B3** for surface area, **B2** if you want one source of truth for
  "what compiles". Your call also settles whether `v1.6.0` gets re-tagged.
- **Q3 — do we build a migration harness?** To make `up()`'s normalization
  assertable we need a spec that applies real migration files against a real
  database. **H1**: add that to the http suite (a per-suite database plus
  `Migrator.runMigrationClasses`), which also lets us pin the activity-log
  rollback order this round fixed by hand — a one-time cost that pays for every
  future migration. **H2**: keep migrations hand-proven, and instead make the
  preference rules a pure TypeScript function that emits the SQL, so the *decision*
  is unit-testable while the SQL stays dumb — risk: two representations of one
  rule drifting. **H3**: accept the gap and document it as known.
- **Q4 — how far does the cycle invariant close?** Today `resolveUpcomingCycle`
  answers `match | adopt | defer | create`, and the review established that when a
  terminal (`succeeded`/`failed`) row sits on the entitlement date, `match` wins and
  a stale live `SCHEDULED` stays behind — **both orderings leak money**; only a
  delete path closes it. **D1**: add a `retire` answer that soft-deletes the stale
  row (it deletes a chargeable cycle, so it needs its own approval state and log
  line). **D2**: warn-only first — detect the drift, log it, decide from real
  volume. **D3**: leave it documented. I lean **D2 → D1**: warn now, and let the
  warning's frequency decide whether the delete path is worth its risk.
- **Q5 — at which layer do we stop pre-workflow internals from reaching a body?**
  A DAL fault on a route's own read (`listSubscriptions`, `retrieveCustomer`) still
  answers with `db-error-mapper`'s text naming a table or column, and that is true
  of **every** store route in this plugin, not just the four this round touched.
  **L1**: a shared read wrapper the routes call (fixes the class, touched only
  here). **L2**: a global error middleware that scrubs `invalid_data`/
  `database_error` bodies carrying SQLSTATE-ish text (fixes the class everywhere,
  including code we did not write — but it also risks rewriting legitimate domain
  messages). **L3**: keep the docs honest about the boundary and hang it up.
- **Q6 — deployment target for the "test on the server" step.** The access facts
  are in *Environment and access* below. Which box is in scope — the `medusa-dtc`
  rehearsal host only, or `medusa-prod` too — and does the money-unit switch
  (minor→major, `medusa-paypal` / `medusa-dtc` / `reorder` must move in one batch)
  happen in the same window? A previous incident in this line of work was exactly
  a half-switched money unit, so "which boxes move together" is a hard constraint,
  not a preference.

## Backlog (the previous round's deferrals, restated as work items)

Ordered by what can cost money or data, not by effort.

### 1. Release shape — O1
- [ ] Decide Q2, then implement.
- [ ] Re-measure the tarball (`npm pack --dry-run`) and record packed/unpacked
  size and the file list in the release notes, so the next round can see the
  change instead of trusting the diff.
- [ ] `prepublishOnly` runs `medusa plugin:build` again; confirm the artifact a
  host installs is built from a committed tree (no compiled source that exists
  only in a worktree).

### 2. Migration verifiability — O2
- [ ] Decide Q3.
- [ ] Whatever wins, cover both halves of `Migration20260924120000.ts` (the
      normalize `DO $$` block and the partial unique index — the index is already
      pinned at `integration-tests/http/subscription-from-order.spec.ts:853`) and
      the `down()` order of `Migration20260922120000.ts`, which this round fixed
      by reasoning plus one manual run.
- [ ] Re-seed the equivalent of the deleted scratch database (`renewal_index_scratch`,
      nine cases, gone with the container) or drop the claim that it was proven.

### 3. Money correctness — O3
- [ ] Q4: retire / warn-only / leave, for the stale live `SCHEDULED` row that
      survives a `match` on a terminal row.
- [ ] Q5-adjacent: `set-subscription-auto-renew` decides "overdue" from the guard
      step's snapshot (`src/workflows/steps/set-subscription-auto-renew.ts:97`) and
      the write step re-reads for the merge (`:177`) without re-deciding. Fix by
      either taking `acquireLockStep` on the subscription id like `renew`/`redeem`
      do, or re-deciding in the write step — the second widens the set of steps
      allowed to speak, which is exactly what `store-step-failure.ts` keeps narrow.
- [ ] `redeem-redemption-code.ts:287-296` mints `payment_mode: "auto"` with no
      `mechanism` label; informational today (chargeability reads `payment_mode`,
      native detection reads `reference`), but it is the one mode writer outside
      `buildPaymentModeFields`.
- [ ] `src/workflows/steps/redeem-redemption-code.ts:169` throws
      `noMatchingSubscription` for a vanished *customer* row, so the refusal names
      the wrong reason and interpolates a variant id.

### 4. Disclosure — O4
- [ ] Decide Q5.
- [ ] While there: `store-step-failure.ts:193` quotes `errors[0]` only, and the
      engine does not order `errors` by causality — a run whose lock step timed out
      and whose refusal step also failed can answer with the wrong one. Pin the
      choice or sort it.

### 5. Test reachability — O5
- [ ] `src/workflows/__tests__/` holds three specs that **no gate executes**
      (`jest.config.js` `testMatch` covers `src/modules/*/__tests__/**/*.spec` and
      `integration-tests/http/*.spec` only). Either move each next to the module it
      tests, or extend `testMatch` — the important half is that they run and can go
      red.
- [ ] `adopted` rollback has no end-to-end case; `deleted` got one this round by
      extracting `restoreDeletedUpcomingCycles` behind a two-method writer
      interface. The same extraction shape works for `adopted`.
- [ ] The `match`-outranks-`adopt` contract is pinned at unit level only; no http
      case drives it through a real workflow.
- [ ] Remove the two casts the last round could not: `native-mirror-sync.ts:89,120`
      still pass `as never`, blocked on moving `asSubscriptionUpdateInput` out of
      `src/workflows/steps/pause-subscription.ts:59` into
      `src/modules/subscription/utils/` — which also unblocks the consent-flip
      writer that must not import from `src/workflows/**`.

### 6. Deployment — O6
- [ ] Decide Q6, then write the runbook (order of container switches, the
      money-unit SQL, the smoke list, the rollback point) before touching a box.
- [ ] Acceptance must include the two things only a live store shows: the renewal
      cycle count on a subscription after a repeat purchase, and that
      `/store/saas/*` refusals still read as their own words.

### 7. Previously ruled, still open
- Admin plan-offer form duplication (`create-plan-offer-modal.tsx` 965 lines vs
  `edit-plan-offer-drawer.tsx` 891, 66 of 75 trimmed-unique drawer lines
  byte-identical, no typecheck and no test over either) — user deferred it in the
  previous round; it stays deferred unless this round's Q1 says otherwise.

## Environment and access (verified 2026-09-25, do not re-guess)

- Target host `170.106.132.210`, SSH user `ubuntu`, **key-based — no password is
  needed or held**. Confirmed by a read-only probe.
- `/opt` holds two stacks: `medusa-dtc` (the rehearsal target) and `medusa-prod`
  (`medusa-saas-backend:0.4.14`). Both have their own `postgres:17-alpine`.
- On the dtc stack: the DB password is in `/opt/medusa-dtc/.env` (root-owned,
  needs sudo) — **read it on the box, never into a log or a chat message**.
- Tunnel recipe already used successfully:
  `ssh -L 9001:127.0.0.1:9001 -L 5434:127.0.0.1:5434 ubuntu@170.106.132.210`,
  then `ADMIN_BASE_URL=http://localhost:9001`.
- dtc currently has **no admin user** (its `user` table is empty); create one in
  the container with `npx medusa user -e <email> -p <password>` before any Admin
  or Playwright path is exercised.
- Rollback points that already exist on that box: DB dump
  `~/backups/medusa-dtc-pre-local-plugins-202609221405.sql.gz` and image tag
  `medusa-dtc:rollback-20260922e2e`. They predate this round, so they are a
  fallback for the *stack*, not for 1.6.0's data.
- Local gates need a Postgres the repo does not ship: start one on
  `127.0.0.1:5432` and export `DB_HOST` / `DB_PORT` / `DB_USERNAME` /
  `DB_PASSWORD` (see `.agents/AGENTS.md`, *Validation Commands*). The
  `reorder-acceptance-pg` container used for the 1.6.0 round was removed at
  cleanup, so a fresh round recreates it.

## Verification & Testing

- O1/O2: `npm pack --dry-run` file list and sizes, before and after; the three
  gates re-run from a clean build.
- O3: an http case per money path — repeat purchase leaves one live cycle (exists),
  overdue toggle refused after a concurrent `past_due` (new, needs Q4/Q5 decision),
  and the retired-drift behavior once chosen.
- O4: a case per store route family asserting that no response body carries
  `table`/`column`/SQLSTATE text, using the canary-fault shape the last round
  established in `integration-tests/http/saas-bridge.spec.ts`.
- O5: the moved specs must go red under a mutation probe (invert one predicate,
  confirm the failure, restore) — otherwise "it runs" is not evidence.
- O6: the runbook's smoke list executed against the chosen box, with the cycle
  count and refusal-wording checks above run remotely.
