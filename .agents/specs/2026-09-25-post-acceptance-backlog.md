# Spec: post-acceptance backlog (v1.6.0 follow-up round)

## TLDR & Overview

v1.6.0 shipped the 12-ticket `source-repo-fixes` plan, failed acceptance on
2026-09-24, and was corrected by a seven-commit round on
`fix/1.6.0-acceptance-fixes`, merged to `main` and tagged `v1.6.0` on 2026-09-25
(gates green: build 0; modules 25 suites / 270 tests; http 35 suites / 228 tests,
zero failing assertions). This document is the next round: the findings that
previous round ruled *not fixed now*, plus what the release rehearsal exposed.

Three facts frame it. The artifact a host installs is this repository's compiled
output, not the plugin — `package.json` publishes `files: [".medusa/server"]`, and
root `tsconfig.json` has `include: ["**/*"]` with `outDir: ./.medusa/server`, so 29
compiled Playwright files and `playwright.config.js` ride along (928.5 kB packed,
5.0 MB unpacked). A migration's data-shaping step cannot be verified at all: the
partial unique index is pinned at
`integration-tests/http/subscription-from-order.spec.ts:853`, while the `DO $$`
block that decides *which* duplicate cycle survives has no assertion anywhere and
its scratch-database proof was deleted with the container it ran in. And two money
paths stay open by ruling rather than by evidence.

No production customers exist yet, so class-level fixes stay on the table and
backward-compat shims are out of scope by standing ruling. Every `file:line` below
was read this session; framework claims name the `node_modules` path.

## Decisions (ruled by the user on 2026-09-25)

| # | Question | Ruling |
|---|---|---|
| Q1 | Scope | **All of it** — packaging, migration verifiability, test reachability, money correctness, disclosure, then the deployment. In that order: make it verifiable and shippable before changing behavior, deployment last. |
| Q2 | Packaging | **B3** — leave `tsconfig.json` alone (other tooling may rely on the broad `include`) and narrow what publishes by writing `files` explicitly against the `exports` map. |
| Q3 | Migration verifiability | **H1** — build a real harness that applies the plugin's migration classes to a real database, so both `up()`'s normalization and `down()`'s order are assertable. It pays for every future migration, not just this one. |
| Q4 | Cycle invariant | **D1** — add a `retire` answer, so a stale live `SCHEDULED` row that survives a `match` on a terminal row is soft-deleted instead of left chargeable. Retire never touches a row with money in flight. |
| Q5 | Disclosure layer | **L1 + docs sync** — a shared read wrapper the store routes call, and documentation that names the boundary. Rejected: a global error middleware that rewrites bodies (its blast radius includes legitimate domain messages). |
| Q6 | Deployment target | Both boxes are acceptable **but the two Medusa instances must never run simultaneously**: shut `medusa-dtc` down and validate on `medusa-prod` only. |

## Proposed Architecture & Data Model

### A. Publish surface (Q2 / B3)

`exports` is the contract, and every key in it points inside
`.medusa/server/src/`:

```
"./workflows"                 → ./.medusa/server/src/workflows/index.js
"./modules/*" and "./.medusa/server/src/modules/*" → …/src/modules/*/index.js
"./providers/*"               → …/src/providers/*/index.js
"./*"                         → …/src/*.js
"./admin"                     → …/src/admin/index.{js,mjs}
```

So `files` becomes `[".medusa/server/src"]` (npm adds `package.json`, `README.md`
and `LICENSE` on its own). Nothing else is *referenced*; `.medusa/server/e2e`,
`.medusa/server/scripts` and `.medusa/server/playwright.config.js` are build
byproducts of a repo-wide `include`. No change to `tsconfig.json`, to the build, or
to what a host's own tooling compiles.

Guard against the one real risk — a path some consumer imports that is not in
`exports`: the phase ends by unpacking the produced tarball in a temp directory and
asserting every `exports` target exists, then installing the packed tarball into the
host app the `local-dev` skill describes and booting it.

### B. Migration harness (Q3 / H1)

A new http-suite spec, `integration-tests/http/migrations.spec.ts`, that owns its
own database rather than the per-suite one the runner hands out, because it needs a
schema **before** the migrations exist:

1. Create `<probe-db>` on the same server with the credentials the suite already
   uses (`@medusajs/test-utils` itself issues `create database …` from
   `dist/database.js`, so the role has `CREATEDB`).
2. Build a MikroORM `MikroORMDatabaseDriver` bound to it and run the plugin's real
   migration classes through `Migrator.runMigrationClasses()` — the same entry
   point the `medusa migrate` command uses. `pathToMigrations` is set nowhere in
   this repo, so the class list is imported directly, in module order
   (activity-log → … → renewal → … → subscription), matching what
   `mikro_orm_migrations` records on a real install.
3. Seed the drift state, run `up()`, assert the outcome; run `down()`, assert the
   revert; drop the database in `afterAll`.

The cases it must pin, each chosen because it is the rule a future editor can break
silently:

- `Migration20260924120000.ts` keeps the row whose `scheduled_for` equals
  `subscription.next_renewal_at` when one exists, even when another row is more
  future (the `prefer_entitlement` tier).
- with no entitlement match it keeps the most future row, and never resurrects or
  touches an already soft-deleted or non-`scheduled` row.
- the survivor is soft-deleted-not-`failed`, and carries the
  `normalized: duplicate upcoming cycle removed by the 1.6.0 uniqueness migration`
  note in `last_error`.
- with **no `subscription` table at all** the `DO $$` block still runs (the
  `to_regclass` guard: module migrators run in alphabetical order on a fresh
  database, and renewal precedes subscription).
- a second live `SCHEDULED` insert then fails on
  `renewal_cycle_one_scheduled_per_subscription`, while a soft-deleted or `failed`
  duplicate is accepted (the predicate is partial).
- `down()` drops the index and restores nothing: the normalized rows stay
  soft-deleted, and two live rows become insertable again — the asymmetry the
  release notes already document.
- `Migration20260922120000.ts` (activity-log) `down()` completes on a database that
  holds `subscription.creation_failed` rows — the defect that failed acceptance —
  and leaves the check constraint and the `not null` pair in the pre-migration
  state.

### C. Retire, not just reconcile (Q4 / D1)

`resolveUpcomingCycle` currently answers one of `match | adopt | defer | create`,
and `match` is checked first: an exact-date hit wins whatever its status. When that
hit is terminal (`succeeded`/`failed`) and a *second*, stale live `SCHEDULED` row
exists elsewhere, the step reconciles the terminal row and leaves the stale one
chargeable — the review established that reordering `match`/`adopt` does not fix
this, because the retained row is then due immediately; only a delete closes it.

Shape of the change, in `src/modules/renewal/utils/upcoming-cycle.ts`:

```
type UpcomingCycleResolution =
  | { action: "match";   cycle; retire: UpcomingRenewalCycleRecord[] }
  | { action: "adopt";   cycle; retire: UpcomingRenewalCycleRecord[] }
  | { action: "defer";   cycle }
  | { action: "create";  retire: UpcomingRenewalCycleRecord[] }
```

`retire` is the open rows the chosen action does not adopt: `SCHEDULED`, no
`generated_order_id`, not the matched/adopted row itself. It is deliberately **not**
a sixth action — it is a side effect every action can carry, which keeps the step's
decision readable and keeps `defer`'s rule absolute: a row with money in flight is
never retired, only deferred with the existing warning.

The step then:

- soft-deletes the retired rows through `softDeleteRenewalCycles` — never
  `failed`, which `scheduler-query.ts` selects alongside `scheduled` and would
  re-arm — after the write it came to do, and logs one warning naming each retired
  id and the row it made room for;
- adds `"retired"` to the output union so a host can see it happened;
- compensates with `restoreDeletedUpcomingCycles`, the writer-shaped function the
  last round extracted for exactly this kind of rollback — so the new code reuses a
  path that already has a test, rather than opening a fourth untested branch.

Under the index, `retire` can only ever fire on pre-existing drift or a database
that lost the index, which is why it also gets a warning line: frequency in the
logs is the feedback for whether the index was ever removed.

### D. Store reads that cannot quote internals (Q5 / L1)

A route's own pre-workflow reads (`listSubscriptions`, `retrieveCustomer` for the
tenant check) answer a DAL fault with `db-error-mapper`'s own text, which names a
table or column, because core keeps `invalid_data`/`database_error` bodies
(`error-handler.js` only rewrites `conflict`). Today four routes read this way and
the rest of the plugin does too, so this is a class fix, not a call-site patch.

Design, with the ownership constraint that decides placement: a decision unit under
`src/api/**` is executed by **no** gate (`jest.config.js` `testMatch` covers
`src/modules/*/__tests__/**/*.spec` and `integration-tests/http/*.spec`), and
`medusa plugin:build` typechecks the former but not the latter. So the *decision*
lives in the module and only the *calling* lives in the route:

- `src/modules/subscription/utils/store-read-failure.ts` (new): a pure classifier
  that answers, for a failure raised by a tenant-scoped read, whether the caller may
  be told anything, plus the fixed text selection. Unit-tested in
  `src/modules/subscription/__tests__/`.
- `src/api/store/saas/lib/tenant-ownership.ts` gains
  `readTenantScopedSubscription(reader, id, copy)`: it performs the read, and **any**
  throw becomes the route's own `notFound` text (404) with the raw error logged —
  the same shape as the existing tenant rule, which already answers a mismatch with
  404 so that existence is not leaked. Masking a database outage as a 404 is
  acceptable here and stated so, because this read answers a scoping question and
  carries no domain refusal of its own; genuine refusals come from the workflow,
  which classifies separately.
- The four call sites (`auto-renew`, `renew`, `redeem`, and
  `src/api/store/customers/me/redemptions`'s customer read) switch to it, and
  `docs/api/saas-bridge.md` + `docs/architecture/subscriptions.md` stop claiming a
  boundary the code does not hold.

Rejected, recorded so it is not re-proposed: a global error middleware. It would
also rewrite authored `invalid_data` messages that are customer copy on routes
outside this plugin's control.

### E. Reachability cleanup (Q1 part c)

- The three specs under `src/workflows/__tests__/` run in no gate. Either move each
  to the module that owns the rule it tests, or extend `testMatch`. Chosen: move
  where the rule is module-owned, extend `testMatch` where it genuinely needs the
  engine — decided per file in Phase 3, and each must go red under a mutation probe,
  because "it executes" is not the same as "it can fail".
- `adopted` rollback: same extraction shape as `restoreDeletedUpcomingCycles`
  (writer interface + module-level spec), so the date/approval restore is testable
  without a workflow engine.
- The two casts the last round left: move `asSubscriptionUpdateInput` out of
  `src/workflows/steps/pause-subscription.ts:59` into
  `src/modules/subscription/utils/`, which lets `native-mirror-sync.ts:89,120` drop
  its `as never` pair and serves the consent-flip writer, which must not import from
  `src/workflows/**` at all.
- `redeem`'s `noMatchingSubscription` thrown for a vanished customer row
  (`src/workflows/steps/redeem-redemption-code.ts:169`) gets its own error, and
  `REDEEM_CUSTOMER_REFUSALS` gains the entry — the refusal currently names the wrong
  reason and interpolates a variant id.
- `REDEMPTION_PAYMENT_CONTEXT`
  (`src/workflows/steps/redeem-redemption-code.ts:287-296`) is the one mode writer
  outside `buildPaymentModeFields`; it starts writing the pair through the helper.
- `auto-renew` takes `acquireLockStep` on the subscription id, matching `renew` and
  `redeem`, instead of deciding "overdue" from the guard step's snapshot while the
  write step re-reads for the merge
  (`src/workflows/steps/set-subscription-auto-renew.ts:97,177`).

### F. Deployment (Q6)

Target is `medusa-prod` (`medusa-prod-store-1` on `medusa-saas-backend:0.4.14`,
`medusa-prod-db-1` on `postgres:17-alpine`) with **`medusa-dtc` scaled down first** —
one Medusa instance at a time, per the ruling, which also removes the shared-DB and
shared-port ambiguity from the runbook. Access is key-based SSH as `ubuntu@
170.106.132.210`; that stack's DB password lives only in its own `.env` (root-owned,
sudo) and never leaves the box.

Order, with the reason each step is where it is:

1. Read the host's actual wiring before assuming an install path: which
   `@mengyyy369/reorder` version it resolves, whether that comes from GitHub
   Packages or a `yalc` link (the `local-dev` skill uses yalc), and whether
   `medusa migrate` runs at container start or by hand.
2. `pg_dump` of the prod database, recorded with a filename and checksum in the
   runbook. **This is mandatory, not prudent**: `up()`'s normalization soft-deletes
   rows and `down()` does not bring them back.
3. `docker compose stop` the dtc stack, confirm `docker ps` shows exactly one Medusa
   store.
4. Install 1.6.0, run migrations, and immediately assert the two invariants that
   only a live store shows: every subscription has at most one live `SCHEDULED`
   cycle (`select subscription_id, count(*) … having count(*) > 1` returns nothing),
   and `renewal_cycle_one_scheduled_per_subscription` exists.
5. Smoke the endpoints whose contract this round changed, including the failure
   paths: an unknown redemption code stays 404 on the customer route and 400 on the
   bridge, an auto-renew toggle on a provider mirror refuses with its own sentence,
   and no response body anywhere contains a table or column name.
6. Money-unit switch: **not automatic**. If prod's `medusa-paypal` / host config has
   not moved to the same basis as 1.6.0 expects, the batch either moves together or
   does not move; a half-switched set is the shape of the earlier hundred-fold
   incident. This is a stop point in the runbook, not a step.

## Step-by-Step Implementation Plan

### Phase 0: Restore the verification base
- [ ] 0.1 Recreate a local Postgres for the gates and record the container name in
      `.agents/AGENTS.md`'s *Validation Commands* if it differs from what that
      section already says.
- [ ] 0.2 Confirm all three gates run green on the current `main` before changing
      anything, so the round starts from a measured baseline.

### Phase 1: Publish surface (A)
- [ ] 1.1 `files: [".medusa/server/src"]`; re-run `npm pack --dry-run` and record
      packed/unpacked size plus the file list before and after.
- [ ] 1.2 Unpack the tarball to a temp dir; assert every `exports` target exists.
- [ ] 1.3 Install the packed tarball into the host app per `local-dev` and boot it;
      the plugin's modules and workflows must register.
- [ ] 1.4 `CHANGELOG.md` + `docs/releases/1.6.0-host-upgrade.md`: what ships in the
      package, stated once, correctly.
- [ ] 1.5 Re-release mechanics with the user: whether `v1.6.0` moves to include the
      commits the artifact is built from, or the fixes ride a patch version.

### Phase 2: Migration harness (B)
- [ ] 2.1 `integration-tests/http/migrations.spec.ts`: probe database, driver,
      `runMigrationClasses`, teardown.
- [ ] 2.2 Renewal migration cases: entitlement tier, most-future fallback,
      never-`failed`, note in `last_error`, no-`subscription`-table guard, index
      predicate both ways, `down()` asymmetry.
- [ ] 2.3 Activity-log `down()` completes with `subscription.creation_failed` rows
      present.
- [ ] 2.4 Mutation probes for each tier: break one comparator, show exactly the case
      that owns it reddens.
- [ ] 2.5 `.agents/lessons.md`: hand-run scratch databases are not evidence; the
      harness is.

### Phase 3: Reachability (E)
- [ ] 3.1 Decide per file: move the three `src/workflows/__tests__` specs, or extend
      `testMatch`. Then prove each can fail.
- [ ] 3.2 Extract the `adopted` restore behind a writer interface + module spec.
- [ ] 3.3 Move `asSubscriptionUpdateInput` into the subscription module; drop the
      mirror writer's `as never` pair.
- [ ] 3.4 `redeem`: correct error for the vanished-customer case + whitelist entry;
      `REDEMPTION_PAYMENT_CONTEXT` writes the pair via `buildPaymentModeFields`.
- [ ] 3.5 `auto-renew`: `acquireLockStep` on the subscription id.

### Phase 4: Money correctness (C)
- [ ] 4.1 `resolveUpcomingCycle` gains `retire`; unit cases for every action's
      retire set, and for money-in-flight never being retired.
- [ ] 4.2 Step: soft-delete after the primary write, warning line, `retired` in the
      output union, compensation via `restoreDeletedUpcomingCycles`.
- [ ] 4.3 http cases: drift seeded at module level survives a run by being retired;
      a row carrying `generated_order_id` is deferred and untouched; a rolled-back
      run leaves exactly one live row.
- [ ] 4.4 Docs: `docs/architecture/renewals.md` invariant section states the closed
      form, including what retire does and does not cover.

### Phase 5: Disclosure (D)
- [ ] 5.1 `store-read-failure.ts` + unit spec; `readTenantScopedSubscription` in
      `tenant-ownership.ts`.
- [ ] 5.2 Convert the four routes; keep `assertTenantVisible` semantics.
- [ ] 5.3 http canary cases per route: a DAL fault on the pre-workflow read answers
      404 with fixed text and logs the cause.
- [ ] 5.4 Docs sync: `saas-bridge.md`, `subscriptions.md`, release notes.
- [ ] 5.5 `store-step-failure.ts`: pin or fix the `errors[0]` choice (the engine does
      not order `errors` by causality; a run with both a lock timeout and a refusal
      can answer with the wrong one).

### Phase 6: Deployment (F)
- [ ] 6.1 Read-only survey of `medusa-prod` wiring; write the runbook from facts.
- [ ] 6.2 Backup + checksum, dtc scaled down, one instance confirmed.
- [ ] 6.3 Install, migrate, assert the two invariant queries.
- [ ] 6.4 Endpoint smoke including the failure paths.
- [ ] 6.5 Money-unit decision point with the user; nothing moves half-switched.

## Verification & Testing

Phases 1–5 each end with the three gates from a clean build, plus the mutation
probe named in that phase — a test that cannot go red is not evidence, which this
round has now been burned on twice. Gate expectations and the two-run protocol for
the http suite's OS-killed workers are in `.agents/AGENTS.md` and
`.agents/lessons.md`; the last round's totals are build 0, modules 25/270,
http 35/228, and every new case must be attributable by name.

Phase 6 is verified on the box: the two database invariant queries, the endpoint
smoke list, and a rollback rehearsal from the backup taken in 6.2 before any of it
is called done.

## Risks

- **R1 — masking a database outage as a 404.** Chosen deliberately for
  tenant-scoping reads (Phase 5), because existence is not disclosed anyway and the
  raw error is logged. Not chosen for any other read; if the wrapper spreads, the
  masking becomes the incident.
- **R2 — `retire` soft-deletes a chargeable row.** Mitigated by never retiring a row
  that is `PROCESSING` or carries `generated_order_id`, by the warning line, and by
  reusing a compensation path that has a test.
- **R3 — the migration harness fights the runner.** Nothing in this repo sets
  `pathToMigrations`, so `@medusajs/test-utils` takes `orm.schema.refreshDatabase()`
  for every http suite: the harness must own its database and its migrator, and must
  not assume the per-suite schema is empty.
- **R4 — narrowing `files` breaks a consumer** importing a path outside `exports`
  (e.g. a deep `require` of `.medusa/server/scripts`). Phase 1.3 — booting the host
  app from the installed tarball — is what catches that, not the diff.
- **R5 — prod migration is one-way on data.** `up()` soft-deletes drift rows and
  `down()` will not resurrect them; Phase 6.2's backup is the only undo.

## Deferred (carried, still ruled)

- Admin plan-offer form duplication (`create-plan-offer-modal.tsx` 965 lines vs
  `edit-plan-offer-drawer.tsx` 891, 66 of 75 trimmed-unique drawer lines
  byte-identical, nothing typechecks or tests either) — user deferred, unchanged.
- Anything in the previous round's *Deferred* list not restated above: none left —
  every item there is now a phase here, except the `readStoredPaymentMode` defaults,
  which stay two-on-purpose and documented.

## Revision log

- **v1 (2026-09-25)** — skeleton: backlog grouped as O1…O6, six open questions.
- **v2 (2026-09-25)** — user answered Q1 all, Q2 B3, Q3 H1, Q4 D1, Q5 L1 + docs, Q6
  prod-only with dtc never co-running. Open questions removed; architecture and
  Phases 0–6 written. Two rulings added during drafting: `retire` is a field on every
  action rather than a sixth action, and the disclosure classifier lives under
  `src/modules/**` because `src/api/**` is executed by no gate.
