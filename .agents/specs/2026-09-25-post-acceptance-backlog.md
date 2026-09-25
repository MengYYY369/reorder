# Spec: post-acceptance backlog (v1.6.0 follow-up round)

## TLDR & Overview

v1.6.0 shipped the 12-ticket `source-repo-fixes` plan, failed acceptance on
2026-09-24, and was corrected by a seven-commit round on
`fix/1.6.0-acceptance-fixes`, merged to `main`, tagged `v1.6.0` and published as a
GitHub release on 2026-09-25 (gates green: build 0; modules 25 suites / 270 tests;
http 35 suites / 228 tests, zero failing assertions). This document is the next
round: the findings that round ruled *not fixed now*, plus what the release
rehearsal exposed.

Three facts frame it. The artifact a host installs is this repository's compiled
output, not the plugin — `package.json` publishes `files: [".medusa/server"]` and
root `tsconfig.json` has `include: ["**/*"]` with `outDir: ./.medusa/server`, so 29
compiled Playwright files and `playwright.config.js` ride along (928.5 kB packed,
5.0 MB unpacked). A migration's *data-shaping* step has no assertion anywhere: the
partial unique index is pinned at
`integration-tests/http/subscription-from-order.spec.ts:853`, while the `DO $$`
block that decides which duplicate cycle survives was proven by hand on a scratch
database that has since been deleted. And the two money paths that were left open
were left open by ruling, not by evidence.

No production customers exist yet, so class-level fixes stay on the table and
backward-compat shims are out of scope by standing ruling. Every `file:line` here
was read this session; framework claims name the `node_modules` path. Claims that a
reviewer or I could not verify are labelled **measure first**.

### What v2 of this document got wrong, and what it cost

The first version of this plan was reviewed adversarially and against repo
conventions, and four of its designs were wrong in ways that would have been found
during implementation, not before:

- It built the migration harness on `Migrator.runMigrationClasses()`, **which does
  not exist** (zero hits across `@mikro-orm/**` and `@medusajs/**`), and implied the
  http suite's schema is entity-derived. Both false — see §B.
- It placed `retire` after the step's write, but the two paths that need it most
  (`defer`, and `match` on a terminal row) **return before any write**
  (`src/workflows/steps/ensure-next-renewal-cycle.ts:252-271,340-353` vs the write at
  `:407`), so the flagship case would still have leaked.
- It reused `restoreDeletedUpcomingCycles` as retire's compensation. That function
  re-inserts rows **by id**, which is correct only because the delete path is a hard
  SQL `DELETE` (`@medusajs/utils/dist/dal/mikro-orm/mikro-orm-repository.js:235-262`);
  after a soft delete the row is still there and the rollback would throw a
  `renewal_cycle_pkey` violation.
- It listed the disclosure sites from memory, naming a route with no DAL read
  (`src/api/store/customers/me/redemptions/route.ts`, whose
  `requireStoreCustomer` throws 401 out of `auth_context`:
  `src/api/store/customers/me/redemptions/utils.ts:9-22`) while omitting two that do
  read. It also missed that the class includes `query.graph` faults.

The lesson goes into `.agents/lessons.md` (Phase 5): a plan naming a framework API
must cite the file and line that proves the API exists. Recorded here so the next
reader knows why §B and §C read differently than the first draft.

## Decisions (ruled by the user on 2026-09-25)

| # | Question | Ruling |
|---|---|---|
| Q1 | Scope | **All of it** — packaging, migration verifiability, test reachability, money correctness, disclosure, then the deployment. Verifiability first, behavior change second, deployment last. |
| Q2 | Packaging | **B3** — leave `tsconfig.json` alone and narrow what publishes by writing `files` against the `exports` map. |
| Q3 | Migration verifiability | **H1** — a harness that applies the real migration files to a real database. |
| Q4 | Cycle invariant | **D1** — retire a stale live `SCHEDULED` row instead of leaving it chargeable. Retire never touches a row with money in flight. |
| Q5 | Disclosure layer | **L1 + docs sync** — one shared read wrapper, and documentation that names the boundary. Rejected: a global error middleware (its blast radius includes legitimate domain messages). |
| Q6 | Deployment | Both boxes are acceptable **but the two Medusa instances must never run at once**: scale `medusa-dtc` down and validate on `medusa-prod`. |

Standing commit policy carried forward from the previous round's Q7 (it was missing
from v2): one commit per phase, explicit paths only (never `git add -A`), each
Conventional Commits message shown to the user for approval before committing, all
artifacts in English.

## Proposed Architecture & Data Model

### A. Publish surface (Q2 / B3)

`exports` is the contract and every functional key points inside
`.medusa/server/src/` — workflows, `modules/*`, `providers/*`, `./*` → `src/*.js`,
and `./admin`. Verified against the loader: a plugin's root resolves to
`.medusa/server/src` (`@medusajs/medusa/dist/loaders/api.js:40-41` serves routes
from there; `get-resolved-plugins.js:13,69-73`), and the admin bundler writes into
`src/admin` (`@medusajs/admin-bundler/dist/index.js:1565`).
`.medusa/server/medusa-plugin-options.json` is produced only by `plugin:develop`
(`@medusajs/framework/dist/build-tools/compiler.js:238-240`), so its absence in a
published tarball is correct and keeps the host's admin `type: "package"`.

So `files` becomes `[".medusa/server/src"]`. (`exports["./package.json"]` points
outside it; npm packs `package.json` regardless, so that key still resolves.)
Nothing in this repo consumes a packed path outside `src` — the scripts and docs
refer to `./scripts/*.ts` in the checkout, not in the package. **measure first**:
Phase 1 proves it by installing the produced tarball into the host app and booting,
which is the only check that catches a deep import the `exports` map does not show.

### B. Migration harness (Q3 / H1)

Two corrections to the premise, both verified:

- The http suites **already apply the plugin's real migrations**:
  `medusaIntegrationTestRunner` is `MedusaTestRunner`, which calls
  `migrateDatabase(appLoader)` (`@medusajs/test-utils/dist/medusa-test-runner.js:100`)
  → `runModulesMigrations`. The `orm.schema.refreshDatabase()` branch
  (`@medusajs/test-utils/dist/database.js:139`) belongs to the *module* runner, which
  is what `lessons.md:107` says. That is why the index self-proof at `:853` sees a
  constraint the entity model cannot produce.
- The seam to reuse already exists: `getMikroOrmWrapper({ mikroOrmEntities,
  pathToMigrations, clientUrl, schema })` accepts an **array** of migration dirs and,
  when there is more than one, runs each through `runMigrationsFromPath` in order
  (`@medusajs/test-utils/dist/database.js:73,100-128,56`), with `path` and `pathTs`
  both set to that dir (`:41-42`). Database creation comes from the same module
  (`dbTestUtilFactory`, `@medusajs/test-utils/dist/database.js:3`; the `create
  database` statement itself lives in
  `@medusajs/test-utils/dist/medusa-test-runner-utils/postgres-template.js:165`).
  Do **not** build a class-list runner: `MikroORM.init({ migrations: {
  migrationsList } })` (`@mikro-orm/core/utils/Configuration.d.ts:276`) bypasses
  `CustomDBMigrator.resolve`
  (`@medusajs/utils/dist/dal/mikro-orm/custom-db-migrator.js:12-46`), which is where
  the disabled-file check and the `SET LOCAL search_path` wrapper live, so it would
  not be the same entry point `medusa migrate` uses.

Design: `integration-tests/http/migrations.spec.ts` owns a **separate** database
(`dbTestUtilFactory().create(<probe-name>)`, dropped in `afterAll`) so it can observe
the pre-migration state, and points `pathToMigrations` at the plugin's migration
directories in the order the real migrator applies them — alphabetical by module,
recorded last round from `mikro_orm_migrations` on a fresh install: activity-log,
analytics, cancellation, dunning, plan-offer, redemption, renewal, settings,
subscription. **Measure first**, before committing to the shape: (a) that the
migration `.ts` files resolve under jest's transform through `pathTs`; (b) that the
test role can `CREATE DATABASE` (inferred from the runner doing it, not measured
here); (c) that a partially-migrated probe database can be reused across cases or
must be recreated per case.

Cases it must pin — each one is a rule a future editor can break silently:

- `Migration20260924120000.ts` keeps the row whose `scheduled_for` equals
  `subscription.next_renewal_at` even when another row is more future (the
  `prefer_entitlement` tier), and falls back to the most future row when none
  matches.
- it never touches a non-`scheduled` row or an already soft-deleted one;
- the dropped rows are soft-deleted, never `failed`, and carry the
  `normalized: duplicate upcoming cycle removed by the 1.6.0 uniqueness migration`
  note in `last_error` (`scheduler-query.ts:64` selects `failed` alongside
  `scheduled`, so a `failed` duplicate would be re-armed for a charge);
- it runs clean with **no `subscription` table at all** (the `to_regclass` guard:
  renewal precedes subscription in module order on a fresh install);
- after indexing, a second live `SCHEDULED` insert fails on
  `renewal_cycle_one_scheduled_per_subscription` while a soft-deleted or `failed`
  duplicate is accepted (the predicate is partial);
- `down()` drops the index and resurrects nothing: the normalized rows stay
  soft-deleted and two live rows become insertable again — the asymmetry the release
  notes document;
- `Migration20260922120000.ts` (activity-log) `down()` completes on a database
  holding `subscription.creation_failed` rows — the defect that failed acceptance —
  and leaves the check constraint and both `not null`s in their pre-migration state.

Drift-seeding cases for §C also live here rather than in the http suite, because
this is the only place a database can exist **before** the constraint does.

### C. Retire, not just reconcile (Q4 / D1)

`resolveUpcomingCycle` answers `match | adopt | defer | create`, and `match` is
checked first (`src/modules/renewal/utils/upcoming-cycle.ts:240-257`): an exact-date
hit wins whatever its status. When that hit is terminal (`succeeded`/`failed`) and a
*second*, stale live `SCHEDULED` row exists elsewhere, the step returns a `noop` at
`src/workflows/steps/ensure-next-renewal-cycle.ts:340-353` and the stale row stays
chargeable. Reordering `match`/`adopt` does not help: the retained row is then
immediately due, so both orderings leak money, and only a delete closes it.

What v2 got wrong and the corrected shape:

- **`retire` is not a field on every action.** `create` is reached only when no open
  row exists (`!candidate` after `isOpenUpcomingCycle` filtering), so its retire set
  is provably empty; testing it would pin an impossibility. `retire` is therefore
  carried by `match` and `adopt` only, and there is a case asserting `create`
  retires nothing *because nothing open exists to retire* — a real statement about
  `succeeded`/`failed` rows never being retired.
- **It must run on the paths that return early.** The step gains a single
  `retireStaleRows(container, logger, retired, subscription)` helper invoked before
  **every** return that can carry a retire set — including the `defer` return
  (`:252-271`) and the terminal-`match` `noop` (`:340-353`) — not after "the write it
  came to do", which on those paths never happens.
- **Retire never includes the protected row.** Candidates are live `SCHEDULED` rows
  with no `generated_order_id` that are not the matched/adopted row. A `PROCESSING`
  or order-carrying row is deferred, exactly as today, and stays untouched.
- **`defer`'s documented promise narrows honestly.** Today `defer` means "writes
  nothing at all", pinned by a zero-write comparison at
  `integration-tests/http/subscription-from-order.spec.ts:810-816`. That case seeds
  one row, so it stays green. The promise becomes "writes nothing to the protected
  row", and a **new** case with a protected in-flight row *plus* one stale open row
  pins the difference. `docs/architecture/renewals.md` must be changed in the same
  commit, or it becomes the next ticket-10 defect.
- **Compensation is `restore`, not re-insert.** MedusaService generates a `restore`
  family beside `softDelete`
  (`@medusajs/utils/dist/modules-sdk/medusa-service.js:19,169-174,333`), so
  `restoreDeletedUpcomingCycles` is left alone (its re-insert-by-id is right for the
  hard-delete path) and a separate retire compensation un-soft-deletes by id.
  `RenewalCycleRestoreWriter` gains a `restoreRenewalCycles` member instead of being
  reused. **Measure first**: confirm the generated method name against
  `RenewalModuleService` with a typecheck before writing the call.
- Rollback-safety note carried from the previous round: retiring must not orphan
  `renewal_attempt` children — verified safe, the model declares no
  `cascade: ["soft-remove"]` (`src/modules/renewal/models/renewal-cycle.ts:24-26`,
  and `@medusajs/utils/dist/dal/mikro-orm/utils.js:52` requires it).
- Seeding two live `SCHEDULED` rows in any http case requires dropping the index
  first, because the constraint is live in test databases. That belongs in the §B
  harness, not in a case that has to remember to re-create it.

Output union gains `"retired"` alongside the existing `noop | created | updated |
adopted | deferred | deleted`, and each retirement logs one warning naming the row
and the row it made room for — which is also the field signal that a host dropped the
index.

### D. Store reads that cannot quote internals (Q5 / L1)

A pre-workflow read answers a DAL fault with `db-error-mapper`'s own text naming a
table or column (`@medusajs/utils/dist/dal/mikro-orm/db-error-mapper.js:31-38`), and
core keeps `invalid_data` / `database_error` bodies (`error-handler.js` rewrites only
`conflict`). Phase 5.0 **enumerates** the sites instead of listing them from memory,
covering both seams — module-service reads *and* `query.graph` reads — because the
class includes both. Known from this session's inspection, to be regenerated by the
sweep: `saas/auto-renew/route.ts` (subscription list + customer), `saas/renew/route.ts`
(same two), `saas/redeem/route.ts` (customer), `saas/carts/route.ts:76-78` (customer +
a `query.graph` region read), and the shared read in `saas/lib/tenant-ownership.ts:78`
that `saas/reconcile/route.ts:83,205` goes through. Explicitly **not**
`src/api/store/customers/me/redemptions`: its customer id comes from
`auth_context` (`utils.ts:9-22`), and wrapping `listAndCountRedemptionRecords` would
turn a list fault into a 404, which is a worse lie than the current one.

Design, with the placement rule that decides it: a decision unit under `src/api/**`
is executed by no gate (`jest.config.js:26-33` covers
`src/modules/*/__tests__/**/*.spec` and `integration-tests/http/*.spec`), and
`medusa plugin:build` typechecks the former but not the latter. So the *decision*
lives in the owning module and only the *calling* lives in the route:

- `src/modules/subscription/utils/store-read-failure.ts` — a pure classifier: given
  a failure from a tenant-scoping read, what status and which fixed text may the
  caller use, and what must never leave the process. Unit-tested under
  `src/modules/subscription/__tests__/`.
- `src/api/store/saas/lib/tenant-ownership.ts` — a thunk wrapper
  `readTenantScoped(logger, what, copy, read)` used by the enumerated sites. Any
  throw becomes the route's own 404 text with the raw cause logged. That deliberately
  masks a database outage as a 404: this read answers a scoping question only, the
  existence signal is already absent by design, and refusals with real customer copy
  come from the workflow, which classifies separately. Statuses already pinned stay
  pinned (`saas-bridge.spec.ts:889-912` asserts 404 + `subscription not found`).
- Same commit replaces the **five** drifted hand-restated `type CustomerModule = {…}`
  shapes under `src/api/store/` with `Pick<ICustomerModuleService, "retrieveCustomer"
  | "listAndCountCustomers">`-style derivations
  (`@medusajs/types/dist/customer/service.d.ts:10`), which is the rule
  `lessons.md:104` states and the wrapper would otherwise re-violate.
- `store-step-failure.ts` keeps quoting `errors[0]`. v2 asked to "pin or fix" it;
  fixed as a decision: each of these workflows has one user-facing step, so the
  choice is right today — and it gets one http case that pins what a multi-error run
  answers with, so the day it stops being right something goes red.

### E. Reachability cleanup

- The three specs under `src/workflows/__tests__/` run in no gate. Per file: move it
  next to the module that owns the rule, or extend `testMatch` — and if `testMatch`
  widens, the same commit must update `AGENTS.md:61-62` and `lessons.md:107`, both of
  which state the current pattern as fact. Each relocated or newly-gated spec must go
  red under a named mutation probe.
- `adopted` rollback gets the same writer-interface extraction as `deleted` did, so
  the date/approval restore is assertable without a workflow engine.
- `asSubscriptionUpdateInput` moves from
  `src/workflows/steps/pause-subscription.ts:59` into
  `src/modules/subscription/utils/`, letting `native-mirror-sync.ts:89,120` drop its
  `as never` pair and serving the consent-flip writer, which may not import from
  `src/workflows/**`. Verification for this item is `yarn build` — a gate that fails
  on type errors in `src/` and `src/modules/*/__tests__`, which is stated so nobody
  looks for a jest case.
- `src/workflows/steps/redeem-redemption-code.ts:169` stops throwing
  `noMatchingSubscription` for a vanished customer row: new error, new
  `REDEEM_CUSTOMER_REFUSALS` entry, refusal no longer names the wrong reason or
  interpolates a variant id.
- `REDEMPTION_PAYMENT_CONTEXT`
  (`src/workflows/steps/redeem-redemption-code.ts:287-296`) becomes the last mode
  writer using `buildPaymentModeFields`.
- `set-subscription-auto-renew` takes `acquireLockStep` on the subscription id, as
  `renew` and `redeem` do, instead of deciding "overdue" from the guard step's
  snapshot (`src/workflows/steps/set-subscription-auto-renew.ts:97`) while the write
  step re-reads for the merge (`:177`).

### F. Deployment (Q6)

`medusa-prod` (`medusa-prod-store-1` on `medusa-saas-backend:0.4.14`,
`medusa-prod-db-1` on `postgres:17-alpine`) with `medusa-dtc` scaled down **first**:
one Medusa instance at a time, per the ruling, which also removes the shared-port and
shared-DB ambiguity. Key-based SSH as `ubuntu@170.106.132.210` (verified by probe; no
password involved). The stack's DB password exists only in its own root-owned `.env`
on the box and never leaves it.

Facts that change the runbook, both verified: `up()` is **transactional and
all-or-nothing** by MikroORM default (`@mikro-orm/core/utils/Configuration.js:89-91`,
not overridden by Medusa at `mikro-orm-create-connection.js:89-92`), so a failed
migration cannot half-apply its own soft-deletes; but migrations run **per module in a
loop with no cross-module transaction**
(`@medusajs/modules-sdk/dist/loaders/utils/load-internal.js:309-317`), so "the store
came up on a partially migrated schema" is reachable and needs an explicit failure
branch. The dump must therefore be **validated and its restore rehearsed before** the
upgrade, not after — v2 checked it only in step 6.5.

Order:

1. Read the host's actual wiring: which `@mengyyy369/reorder` it resolves, from
   GitHub Packages or a `yalc` link (the `local-dev` skill uses yalc), and whether
   `medusa migrate` runs at container start or by hand. Record in the runbook.
2. `pg_dump` the prod database, **restore it into a scratch database on the same box
   and boot the new version against that**, then throw the scratch away. The runbook
   is `docs/releases/1.6.0-host-upgrade.md` (tracked) — an untracked file is an
   unrecorded residual, `lessons.md:99`.
3. Scale dtc down; confirm exactly one Medusa store in `docker ps`.
4. Install 1.6.0, migrate, and assert the two invariants only a live store shows: no
   subscription holds more than one live `SCHEDULED` cycle
   (`group by subscription_id having count(*) > 1` returns nothing), and
   `renewal_cycle_one_scheduled_per_subscription` exists.
5. Smoke the changed contracts, failures included: unknown redemption code stays 404
   on the customer route and 400 on the bridge, an auto-renew toggle on a provider
   mirror refuses with its own sentence, a retired-drift case logs its warning, and no
   response body anywhere contains a table or column name.
6. Money-unit switch (minor→major) is a **stop point, not a step**: it moves with
   `medusa-paypal` and the host config in one batch or not at all. A half-switched set
   is the shape of the earlier hundred-fold incident.

## Step-by-Step Implementation Plan

### Phase 0: Verification base
- [ ] 0.1 Start a Postgres for the gates and reconcile `AGENTS.md:49-61` with
      `lessons.md:88`, which names a container (`medusa-epay-pg`) that does not exist
      on this machine — one commit, both files, or the two contradict each other.
- [ ] 0.2 Re-run all three gates on unmodified `main` for a measured baseline, and
      record the probe database's `CREATE DATABASE` capability (§B measure first).

### Phase 1: Publish surface (A)
- [ ] 1.1 `files: [".medusa/server/src"]`; `npm pack --dry-run` before/after with
      sizes and the file list.
- [ ] 1.2 Unpack to a temp dir; assert every `exports` target resolves.
- [ ] 1.3 Install the tarball into the host app per `local-dev` and boot it: modules,
      workflows, routes and the admin bundle must all register.
- [ ] 1.4 `CHANGELOG.md` + `docs/releases/1.6.0-host-upgrade.md`: what the package
      contains, stated once.
- [ ] 1.5 With the user: does `v1.6.0` move again or does this ride a patch version.

### Phase 2: Migration harness (B)
- [ ] 2.1 `integration-tests/http/migrations.spec.ts`: probe database,
      `getMikroOrmWrapper` with the ordered `pathToMigrations` array, teardown;
      settle the three measure-first items before writing cases.
- [ ] 2.2 Renewal cases: entitlement tier, most-future fallback, never `failed`,
      `last_error` note, no-`subscription`-table guard, index predicate both ways,
      `down()` asymmetry.
- [ ] 2.3 Activity-log `down()` completes with `creation_failed` rows present.
- [ ] 2.4 Mutation probes, one per tier: break one comparator, show exactly the case
      owning it reddens.
- [ ] 2.5 `lessons.md`: a plan that names a framework API without citing the file and
      line proving it exists; hand-run scratch databases are not evidence.

### Phase 3: Reachability (E)
- [ ] 3.1 Per-file decision for `src/workflows/__tests__`; each must go red under a
      named probe; `AGENTS.md:61-62` + `lessons.md:107` in the same commit if
      `testMatch` widens.
- [ ] 3.2 `adopted` restore behind a writer interface + module spec, with a probe
      (drop one field from the restore list).
- [ ] 3.3 Move `asSubscriptionUpdateInput` into the subscription module, drop the
      mirror `as never` pair; verification is `yarn build`.
- [ ] 3.4 `redeem`: correct error + whitelist entry, and its refusal-wording case.
- [ ] 3.5 `redeem` create constant writes the pair via `buildPaymentModeFields`.
- [ ] 3.6 `auto-renew` lock step; docs: `docs/architecture/subscriptions.md`,
      `docs/api/saas-bridge.md`, `CHANGELOG.md` in this phase's commit.

### Phase 4: Money correctness (C)
- [ ] 4.1 Selector: `retire` carried by `match` and `adopt`; unit cases for the
      candidate rule (never the protected row, never `PROCESSING`, never an
      order-carrying row, never a terminal row).
- [ ] 4.2 Step: `retireStaleRows` invoked on **every** return path that can carry a
      retire set; warning line; `"retired"` in the output union.
- [ ] 4.3 Retire compensation via the generated `restore` family (confirm the name by
      typecheck); a probe that un-soft-deletes nothing when the restore is removed.
- [ ] 4.4 Cases: terminal-`match` + stale live row → one live row remains and it is
      the entitlement one; `defer` + stale row → protected row untouched, stale row
      retired; a rolled-back retire leaves exactly one live row.
- [ ] 4.5 Docs, same commit: `docs/architecture/renewals.md` (invariant + the narrowed
      `defer` promise), `docs/api/admin-renewals.md`, `docs/testing/renewals.md`,
      `CHANGELOG.md` under `[1.6.0]`, `docs/releases/1.6.0-host-upgrade.md`.

### Phase 5: Disclosure (D)
- [ ] 5.0 Enumerate every pre-workflow read in `src/api/store/**` (service reads and
      `query.graph`) and paste the list into this spec before coding.
- [ ] 5.1 `store-read-failure.ts` + its unit spec.
- [ ] 5.2 `readTenantScoped` in `tenant-ownership.ts`; convert the enumerated sites;
      replace the five `type CustomerModule` restatements with derived types.
- [ ] 5.3 Canary cases per route: a DAL/graph fault on the pre-workflow read answers
      404 with fixed text and logs the cause; the existing 404 pin stays green.
- [ ] 5.4 Multi-error run pin for the `errors[0]` choice.
- [ ] 5.5 Docs, same commit: `docs/api/saas-bridge.md`,
      `docs/api/store-redemptions.md`, `docs/architecture/subscriptions.md`,
      `src/api/README.md`, `docs/releases/1.6.0-host-upgrade.md`; plus the
      `sync-docs` question for the public Mintlify site.

### Phase 6: Deployment (F)
- [ ] 6.1 Host wiring survey; write the runbook into
      `docs/releases/1.6.0-host-upgrade.md`.
- [ ] 6.2 Dump, restore-to-scratch, boot-the-new-version rehearsal; only then
      scale dtc down and confirm one instance.
- [ ] 6.3 Install, migrate, assert the two invariant queries; failure branch for the
      per-module migration loop.
- [ ] 6.4 Endpoint smoke including the failure paths.
- [ ] 6.5 Money-unit decision point with the user. Nothing moves half-switched.

## Verification & Testing

Phases 1–5 each end with the three gates from a clean build **plus** the mutation
probe named for that phase — no phase may claim verification without one, which is
what v2 did three times. Totals must be attributable by name: the last round's
baseline is build 0, modules 25 suites / 270 tests, http 35 suites / 228 tests, and
the http gate's union-of-runs protocol (including OS-killed suites) is in
`AGENTS.md:49-61` and `lessons.md:107`.

Phase 6 is verified on the box: the two invariant queries, the endpoint smoke list,
and a rollback that was rehearsed on a scratch database before the upgrade ran.

## Risks

- **R1 — masking a database outage as a 404.** Chosen deliberately for
  tenant-scoping reads only, with the cause logged. If the wrapper spreads to reads
  that carry domain meaning, the masking becomes the incident.
- **R2 — `retire` soft-deletes a row someone meant to keep.** Bounded by the
  candidate rule (never the protected row, never terminal, never order-carrying), by
  the warning line, and by a `restore`-based compensation that is itself probed.
- **R3 — the harness fights the runner.** `getMikroOrmWrapper` is built for one
  entity set and one migration path per suite; a probe database that applies
  module-ordered dirs itself is close to but not exactly the production path
  (`runModulesMigrations`). Phase 2.1 must show the probe reaches the same
  `mikro_orm_migrations` rows the real bootstrap writes, or the harness proves the
  wrong thing.
- **R4 — narrowing `files` breaks a consumer** importing something outside `exports`.
  Phase 1.3 (boot the host app from the installed tarball) is the check, not the diff.
- **R5 — one-way data on prod.** `up()` soft-deletes drift rows, `down()` does not
  resurrect them, and per-module migration means a partial schema is reachable even
  though each migration is atomic. The rehearsed dump is the only undo.

## Deferred (carried, still ruled)

- Admin plan-offer form duplication (`create-plan-offer-modal.tsx` 965 lines vs
  `edit-plan-offer-drawer.tsx` 891; 66 of 75 trimmed-unique drawer lines
  byte-identical; nothing typechecks or tests either) — user deferred; unchanged.
- The previous round's *no additional harness is planned* ruling on the checkout
  middleware ordering (already proven by `native-checkout-gate.spec.ts`) is a
  no-action ruling, so it correctly has no phase here. v2's "none left" sentence was
  wrong as written.
- Two `readStoredPaymentMode` defaults (`manual` at the toggle, `auto` at the payment
  method update) stay two-on-purpose, documented as such.

## Revision log

- **v1 (2026-09-25)** — skeleton: backlog as O1…O6 with six open questions.
- **v2 (2026-09-25)** — user answered Q1 all, Q2 B3, Q3 H1, Q4 D1, Q5 L1+docs, Q6
  prod-only with dtc never co-running. Architecture and Phases 0–6 written.
- **v3 (2026-09-25)** — after two independent reviews of v2, both verified by the
  controller. §B rebuilt on the seam that actually exists (`getMikroOrmWrapper` with
  an ordered `pathToMigrations` array; `runMigrationClasses` does not exist; http
  suites already migrate). §C rebuilt three times over: `retire` narrowed to
  `match`/`adopt`, moved onto the early-return paths, and compensated by `restore`
  instead of a re-insert that would violate the primary key. §D's site list corrected
  and made to be enumerated rather than remembered, `query.graph` included, the
  non-reading route removed, and the five restated customer types folded in. §F fixed
  on two framework facts (each migration is atomic; the module loop is not) with the
  backup rehearsal moved before the upgrade. Doc-sync obligations added to Phases 3,
  4, 5; the runbook given a tracked path; the commit policy carried forward from the
  previous round's Q7; probes named per phase; v2's "none left" claim corrected; and
  `errors[0]` turned from an open question into a decision with a pin.
