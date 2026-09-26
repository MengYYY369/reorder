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

The array that ships is `files: [".medusa/server/src", "!**/__tests__/**"]`.
(`exports["./package.json"]` points outside the first entry; npm packs
`package.json` regardless, so that key still resolves.) The two entries drop
disjoint sets, and the 35 removals measured in the packed-surface bullet below split
along exactly that line: the first entry drops everything under `.medusa/server` that
is not `src`, and the negation drops the compiled specs. Measured on this build with
`npm pack --dry-run`: `[".medusa/server/src"]` alone packs 366 files, 28 of them
`.medusa/server/src/**/__tests__/*.spec.js`; appending the negation packs 338 and
none. Nothing in this repo consumes a packed path outside `src` — the scripts and
docs refer to `./scripts/*.ts` in the checkout, not in the package. That is a
repo-internal statement; the claim about consumers outside this repository is a
separate measurement, and it holds too: **measured on 2026-09-25 against the two
real hosts, no host needs a packed path outside `.medusa/server/src`.**

The host boot this paragraph asked for was **not** performed, and that is a
deviation from 1.3 below, so it is recorded here rather than in a gitignored note.
Booting a host on the packed tree first requires making the host consume it:
`medusa-dtc` pins a `file:` tarball at `apps/backend/package.json:51`, and
`medusa-saas` declares `workspace:*` at `apps/backend/package.json:25` resolved by
`pnpm-lock.yaml:67` to `link:vendor/@mengyyy369/reorder`, a vendored checkout of the
plugin. Either way the install rewrites a tracked `package.json`, that repository's
lockfile and its `node_modules`, and the boot then runs this plugin's subscribers and
scheduled jobs against the database in that host's own `.env`
(`medusa-dtc/apps/backend/medusa-config.ts:106`,
`medusa-saas/apps/backend/medusa-config.ts:34`) — not this plan's probe database. It does
**not** migrate on its own, which is worth stating because the assumption is easy to
make: `@medusajs/medusa/dist/commands/develop.js` and `start.js` contain zero occurrences
of `migrat`, app migration runs only through `MedusaAppMigrateUp`
(`@medusajs/framework/dist/medusa-app-loader.js:119`) reached from `medusa db:migrate`,
and `medusa-dtc/docs/dtc-acceptance-runbook.md:23` documents that step as deliberately
outside the container. Both repositories are developed outside this worktree, so the
check was run read-only instead: both working trees were fingerprinted
(`git status --porcelain | sha1sum`) before and after and are byte-identical, and neither
host's `.env` was opened.

What the read-only measurement established:

- **Consumed surface, defined by the consumers.** `git grep` over tracked source in
  both hosts returns 7 specifier lines in `medusa-dtc` (excluding `pnpm-lock.yaml`)
  and 7 in `medusa-saas` (excluding `pnpm-lock.yaml` and that host's vendored copy
  of the plugin). The saas count is 7 where the first pass recorded 8: the third
  `/workflows` site it named, `apps/backend/src/scripts/seed-logto-e2e.ts`, no longer
  exists — saas commit `cd7d3c9` deleted it — and the two sites listed below are all
  that remain. There are only two distinct specifiers a host writes: the bare
  `@mengyyy369/reorder` as `plugins[].resolve` (`medusa-dtc/apps/backend/medusa-config.ts:170`,
  `medusa-saas/apps/backend/medusa-config.ts:111`) and `@mengyyy369/reorder/workflows`
  (`medusa-dtc/apps/backend/src/scripts/seed-dtc-plan-offers.ts:3`,
  `medusa-saas/apps/backend/src/scripts/seed-mypbo-test.js:18`). Zero specifiers name
  `e2e`, `playwright.config`, `scripts/`, `docs/`, `assets/` or any `__tests__` path,
  and neither storefront depends on the package.
- **The old packed surface is known exactly, because a host still holds it.**
  `medusa-dtc/apps/backend/local-packages/mengyyy369-reorder-1.5.0.tgz` is the tarball
  that host installs, packed under the previous `files: [".medusa/server"]`: 349 files,
  22 of them outside `.medusa/server/src`, of which 19 are repository payload
  (14 `.medusa/server/e2e/**`, 4 `.medusa/server/scripts/*.js`,
  `.medusa/server/playwright.config.js`) and 3 (`package.json`, `README.md`, `LICENSE`)
  are what npm ships regardless. Against the new 338-file tree the removal set is 35:
  those 19, dropped by the `.medusa/server/src` entry, plus 16 compiled
  `**/__tests__/*.spec.js` that lived inside `src`, dropped by `"!**/__tests__/**"` —
  all 16 are in the 28 a `files: [".medusa/server/src"]`-only pack still carries, so
  the negation is the entry that removes them. No non-test `src` path was lost — the
  narrowed build is a superset there (24 paths added, per-module migrations 20 → 22).
- **The vendored copy agrees.** `medusa-saas/apps/backend/vendor/@mengyyy369/reorder/`
  (844 files, the same `exports` map, `files` unset) differs from the new tree by 530
  paths, classifying as: (i) `exports` targets missing — **0**; (ii) `.medusa/server/src`
  paths missing — **16**, every one a `**/__tests__/*.spec.js`; (iii) repository
  payload — **514** (387 `src/*.ts`, 90 `docs/`, 14 `.medusa/server/e2e/`, 8 `assets/`,
  4 `.medusa/server/scripts/`, 4 `scripts/`, and one each of `playwright.config.js`,
  `tsconfig.json`, `AGENTS.md`, `CLAUDE.md`, `CHANGELOG.md`, `.gitignore`, `.zcode/`).
  Its `src/` and `docs/` bulk is an artifact of it being a checkout: no tarball ever
  shipped those.
- **Resolution, probed rather than asserted.** From a scratch consumer directory under
  the OS temp dir whose `node_modules` holds only the unpacked tarball — no install, no
  lockfile, so nothing can resolve by hoisting — 33 specifiers were resolved under both
  the `require` and the `import` condition: the two the hosts write, the twelve the plugin
  loader builds for itself (`<name>/package.json`, `<name>/admin`, and the ten
  `<name>/.medusa/server/src/modules/<dir>` read off the `modules` listing by
  `@medusajs/utils/dist/common/get-resolved-plugins.js:71,92`), their `./modules/*`
  aliases, and nine deep `./*` imports. In that sample the new tree resolves 29/33 and
  the published 1.5.0 tarball 30/33, under both conditions, and the single differing
  case — `@mengyyy369/reorder/workflows/__tests__/pause-subscription.spec` — is one of
  three, not the whole delta; the sample simply happened to name one of them. Probing
  every removed spec in every specifier form that can name it (29 cases: the three
  `workflows/__tests__/*.spec` files, and each of the thirteen
  `modules/*/__tests__/*.spec` files through both `./modules/*` and the loader's
  `./.medusa/server/src/modules/*`) gives 3/29 in the 1.5.0 tree and 0/29 in the new
  one. So the old-versus-new delta is **three specifier-reachable removals**: the `./*`
  key that carries `api/middlewares` and `workflows/index` also named all three
  `src/workflows/__tests__/*.spec.js` files — `cancel-subscription`,
  `pause-subscription`, `update-subscription-shipping-address` — each of which resolves
  in 1.5.0 and fails `MODULE_NOT_FOUND` in the new tree under `require`, mapping to an
  absent file under `import`. The thirteen inside `modules/` were never
  specifier-reachable in either packaging: the two patterns that outrank `./*` for
  them, `./modules/*` and `./.medusa/server/src/modules/*`, both append `/index.js`,
  so all 26 of their cases fail against the published 1.5.0 tree exactly as
  against the new one. The three sample failures that are common to both trees are the
  bare root (`ERR_PACKAGE_PATH_NOT_EXPORTED` — `exports` has no `"."` key, and the
  loader resolves `<name>/package.json` instead, which the probe confirms), plus
  `modules/renewal/index` and `modules/renewal/__tests__/service.spec`, the two
  module-pattern-shadowed cases. No host writes any of the three removed specifiers,
  and no gate here could run them: `jest.config.js:22` sets
  `modulePathIgnorePatterns: ["dist/", ".medusa/"]`, which hides every packed copy in
  both packagings, and the three `testMatch` values (`:27,29,31`) name
  `integration-tests/http`, `src/modules/*/__tests__` and `src/admin/i18n/__tests__`,
  never `src/workflows/__tests__` — the directory the three checkout
  `src/workflows/__tests__/*.spec.ts` files sit in. The `import` condition was
  re-checked against `fs.existsSync` because `import.meta.resolve` maps through
  `exports` without stat'ing and answers a URL for a removed file; it is also
  the only condition that proves `./admin` → `admin/index.mjs` survives (`require`
  selects `admin/index.js`).
- **Nothing reaches for a path it does not own.** The installed `@medusajs` 2.20.0
  sources join nine directory names inside a plugin's resolved dir: `links/`,
  `workflows/`, `policies/` and `search/`
  (`@medusajs/medusa/dist/loaders/index.js:116,127,124`, and `:121` →
  `@medusajs/medusa/dist/loaders/search.js:32`), `subscribers/` and `jobs/` (`:38`,
  `:48`), `api/` (`@medusajs/medusa/dist/loaders/api.js:41`), and `modules/` and
  `admin/` (`@medusajs/utils/dist/common/get-resolved-plugins.js:71`, `:75-82`). Seven
  of the nine exist in the new tree: `modules/` with its 10 dirs, each carrying an
  `index.js`, `api/` 106 files, `workflows/` 84, `admin/` 9, `links/` 8, `jobs/` 7,
  `subscribers/` 5. The two that do not, `search/` and `policies/`, are absent from this
  plugin in every form: `find src -type d -name search -o -name policies` returns
  nothing here, and neither the new tree nor the published 1.5.0 one holds a directory
  of either name, so there was nothing for the narrowing to lose. Each of the two also
  no-ops on an empty set before it reads anything: `loaders/search.js:29-31` returns
  unless the Search Module is registered, and the walk behind
  `loaders/index.js:124` (`framework/dist/policies/policy-loader.js:10-15` →
  `utils/dist/policies/discover-policies.js:25-30`) keeps only entries literally named
  `policies` and returns on an empty list.
  `.medusa/server/medusa-plugin-options.json` stays absent, which
  `get-resolved-plugins.js:45-56` tolerates and which keeps the host's admin
  `type: "package"`. The packed code performs no `__dirname`-relative read and no
  `readFileSync`/`readdirSync` at all, and a scan of all 690 relative `require()`
  targets across its 335 `.js`/`.mjs` files finds 0 missing and 0 escaping the package
  root; the admin bundle is self-contained (0 relative imports, 0 self-references).
  Both hosts' `plugins`/`modules` entries name only the bare package — the relative
  resolves in those files (`./src/modules/desktop-seat`, `./src/modules/smtp-notification`,
  `./src/lib/auth-email-templates.ts`) are host-owned. And the five reorder sites the
  saas host documents patching by hand
  (`medusa-saas/docs/plugins/2026-09-21-plugin-issues-for-source-repos.md`) all sit
  under `.medusa/server/src/` and are present in both trees.

What the boot still owns is registration **of the packed tree**, not resolution, and
that qualifier is the whole of it. A host boot is not the only thing that exercises
Awilix wiring and route mounting for this plugin in a real app: `test:integration:http`
boots one with the plugin registered as `resolve: projectRoot`
(`integration-tests/medusa-config.ts:19-31`), which `get-resolved-plugins.js:13,69`
resolves to the same `.medusa/server/src` a host's copy lives in, on a listening port
(`@medusajs/test-utils/dist/medusa-test-runner.js:131-132` builds `api` as an axios
client with `baseURL: http://localhost:<port>`;
`integration-tests/http/cancellations-admin-flow.spec.ts:39` is one of its call sites),
and §B below records that `medusaIntegrationTestRunner` is
`MedusaTestRunner`. What that gate cannot reach is the artifact: it registers this
checkout's build output, not the `files`-narrowed copy that lands in a host's
`node_modules/@mengyyy369/reorder`, and the cron registrations and the admin build of
*that* tree are what only a host boot shows working in a real app. That is 6.2's
boot-the-new-version rehearsal, where booting is the point and the database is this
plan's own, and not a check to run inside a host repository this plan does not own.

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
subscription.

**Measured 2026-09-26, when Phase 2 closed. The three "measure first" items are
answered, all three in the direction the design assumed:**

- **(a) the `.ts` files do resolve through `pathTs`.** `getMikroOrmConfig` sets `path`
  and `pathTs` to the same directory (`@medusajs/test-utils/dist/database.js:41-42`) and
  jest's `@swc/jest` transform loads them, so `MIGRATION_PATHS` points at
  `src/modules/*/migrations` and the probe applies **22 migrations across 9 module
  directories** (`saas-bridge` ships none) with no compiled fallback used or needed. The
  inventory case pins the `.ts`-only layout deliberately: a compiled-migration tree
  reddens it rather than passing on stripped names.
- **(b) the test role can `CREATE DATABASE`.** Role `user` in `reorder-acceptance-pg` is
  `rolsuper = t`, `rolcreatedb = t`, and `CREATE DATABASE` / `DROP DATABASE` were run on a
  throwaway name before the harness existed, so the plan's BLOCKED path never triggered.
- **(c) a partially-migrated probe database can be reused across cases** — the shared
  nine-directory probe is migrated once in `beforeAll` and every case that mutates it
  (`openDriftWindow`, the two reverts) hands it back on the path that passes, because the
  runner's snapshot/restore covers only the *suite* database, never a probe this file
  created. Each case owns its id range (`sub_t1..sub_t4`, `sub_t7`) so no case depends on a
  sibling's cleanup, and the one known leak window is listed in the residuals below. A
  **fresh** database is required for a one-directory wrapper, and
  the reason is the framework, not taste: with nothing pending, `setupDatabase()` falls through
  to `orm.schema.refreshDatabase()` (`database.js:130-140`) and regenerates the schema from
  the entity models over a database you believed you had migrated.

Harness facts later phases build on (the mechanics and their citations are the
`A Migration Is Only Real Where a Runner Applies It` bullet in `.agents/lessons.md`):
`getMikroOrmWrapper`'s own migrator is bound to `pathToMigrations[0]`
(`database.js:107`), so a revert of any other module's migration goes through
`withMigratorFor(dbName, migrationDirOf(<module>), …)`; `getPendingMigrations()` entries
are `{ name, path? }` with no `label` (MikroORM 6.6.14); `dbTestUtilFactory()` has no
`delete`/`execute` and its `create` swallows an existing database, so `probeDatabase()`
drops before it creates and every teardown is `try { close } finally { drop }`;
`withSoloProbe(dbName, dirs, fn)` and `withMigrationReverted(dbName, dir, name, wrapper,
use)` are the two lifecycles cases should call instead of re-writing them; and the probe
reads `src/` while the app bootstrap reads the built `.medusa/server/` copy, so an
app-side probe rebuilds after mutating **and** after restoring.

Shipped case set (10, all green in the re-baselined http gate): the six on the
nine-directory probe — inventory, app-bootstrap equivalence, and the four normalize cases
— plus `drops the constraint and resurrects nothing on down()` and
`rolls the creation-failure migration back over its own rows` on the same probe, and the
two renewal-only cases (`reaches the migration state of one module directory`,
`normalizes without a subscription table at all`) in a describe with no hook, so their
red is attributable.

**Not settled here, and deliberately not ticked:** the "index predicate both ways" item
below is only half built. A second live `SCHEDULED` insert is rejected while the index is
up — but that is proven operationally (a seed violates it and the case fails loudly), not
by an assertion, and nothing yet shows a `failed` or soft-deleted duplicate being
*accepted* under the live index, which is the "partial" half of the partial index.
Residuals the next reader of this harness owns, with their rulings:

- **Task 17** — the activity-log `down()` case's `definition` check is one-sided
  (`not.toContain('subscription.creation_failed')` proves the new value left, nothing
  proves the other 25 stayed). Fix: seed one `dunning.started` row and let `add
  constraint`'s own validation assert, or parse the quoted values and compare as a sorted
  set against `Migration20260909130000.ts:3-4`.
- **Task 17** — `survivingIds` aggregates the WHOLE `subscription_log` table, so any case
  added before that one which seeds it must update three expectations (it fails loudly and
  informatively, not silently).
- **Task 10** — reuse `withMigrationReverted` rather than writing a fourth revert
  skeleton.
- **Task 5's helper, unowned** — `openDriftWindow` runs outside any teardown, so a throw
  between it and `rerunNormalize` leaks a dropped index *and* an unrecorded migration into
  the shared probe. Today no case can read that as a false green (the next inventory
  comparison goes red), and the clean fix is a `withDriftWindow(dbName, wrapper, use)`
  that re-applies in its own `finally`.
- **Task 4's still-open minors** — `readRowsFromRaw` dereferences `.rows` on a possibly
  null envelope instead of throwing its named `TypeError` (`migrations.spec.ts:510`), and
  `MIGRATION_FILE_EXTENSIONS.some((ext) => file.endsWith(ext))` (`:160`) would accept
  `.mts` as `.ts`. `EXPECTED_MIGRATION_COUNT = 22` is a deliberate tripwire: raising it is
  correct only for a migration that has been given cases in this file.

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
class includes both.

#### The sweep, run on this branch at `8ceb608`

The brief's pattern is anchored on a directly-awaited call, so it under-counts:
`saas/reconcile/route.ts:62,67` are awaited together as a `Promise.all` opened at `:61`,
never individually. The enumeration therefore drops the `await` anchor and strips
comment lines (exactly one matches — `reconcile/route.ts:59`, prose that mentions
`query.graph`). Output verbatim, 29 hits:

```bash
grep -rnE "(customerModule|subscriptionModule|query)\.(retrieve[A-Za-z]*|list[A-Za-z]*|graph)" \
  src/api/store/ | grep -vE ":[0-9]+: *//"
```

```
src/api/store/customers/me/subscriptions/utils.ts:135:  const { data } = await query.graph({
src/api/store/customers/me/subscriptions/utils.ts:168:  const { data: cancellationData } = await query.graph({
src/api/store/customers/me/subscriptions/utils.ts:201:  const { data } = await query.graph(
src/api/store/customers/me/subscriptions/utils.ts:289:  const { data } = await query.graph({
src/api/store/customers/me/subscriptions/utils.ts:317:  const { data } = await query.graph({
src/api/store/customers/me/subscriptions/utils.ts:349:  const { data } = await query.graph({
src/api/store/customers/me/subscriptions/utils.ts:420:  const { data } = await query.graph(
src/api/store/customers/me/subscriptions/utils.ts:477:  const { data } = await query.graph(
src/api/store/customers/me/subscriptions/utils.ts:609:  const { data } = await query.graph(
src/api/store/customers/me/subscriptions/utils.ts:680:  const { data } = await query.graph({
src/api/store/saas/auto-renew/route.ts:101:  const subscriptions = await subscriptionModule.listSubscriptions({
src/api/store/saas/auto-renew/route.ts:113:  const customer = await customerModule.retrieveCustomer(subscription.customer_id)
src/api/store/saas/carts/route.ts:77:  const customer = await customerModule.retrieveCustomer(customerId)
src/api/store/saas/carts/route.ts:82:  const { data: regions } = await query.graph({
src/api/store/saas/ensure-customer/route.ts:74:    const candidates = await customerModule.listCustomers(
src/api/store/saas/ensure-customer/route.ts:95:    const candidates = await customerModule.listCustomers(
src/api/store/saas/lib/tenant-ownership.ts:78:  const customer = await customerModule.retrieveCustomer(customerId)
src/api/store/saas/reconcile/route.ts:62:      query.graph({
src/api/store/saas/reconcile/route.ts:67:      query.graph({
src/api/store/saas/reconcile/route.ts:90:      const { data: collections } = await query.graph({
src/api/store/saas/reconcile/route.ts:120:    const cartLink = await query.graph({
src/api/store/saas/reconcile/route.ts:125:    const subLink = await query.graph({
src/api/store/saas/reconcile/route.ts:138:      const { data: carts } = await query.graph({
src/api/store/saas/reconcile/route.ts:179:    const { data } = await query.graph({
src/api/store/saas/reconcile/route.ts:216:  const { data: customerData } = await query.graph({
src/api/store/saas/reconcile/route.ts:235:  const { data } = await query.graph({
src/api/store/saas/redeem/route.ts:101:  const customer = await customerModule.retrieveCustomer(customer_id)
src/api/store/saas/renew/route.ts:99:  const subscriptions = await subscriptionModule.listSubscriptions({
src/api/store/saas/renew/route.ts:111:  const customer = await customerModule.retrieveCustomer(customerId)
```

19 hits under `saas/**`, 10 under `customers/me/**`. The brief's own command returns 27
— this list minus `reconcile/route.ts:62,67`.

Against the plan's predicted list: every predicted site is confirmed, with two
corrections. `saas/carts/route.ts` is `:77` (customer) plus the `query.graph` region
read at `:82`, not `:76-78`. And three groups were not predicted at all:
`saas/ensure-customer/route.ts:74,95` (two `listCustomers` scoping reads),
seven more `query.graph` reads in `saas/reconcile/route.ts` (`:90,120,125,138,179,216,235`,
plus the two `Promise.all` reads above), and the ten reads in
`customers/me/subscriptions/utils.ts`. No other read seam hides in the subtree:
widening the receiver set to any `.retrieve*/.list*/.graph` call adds exactly
one site outside the 29 — `customers/me/redemptions/utils.ts:52`
(`listAndCountRedemptionRecords`), the read this section already excludes below — and
`saas/**` has no `middlewares.ts` that could swallow a throw before it reaches the error
handler.

#### Every hit, classified

Class is one of: pre-workflow scoping read (convert) / post-workflow response read
(convert only if its failure can reach a body) / validation-only (leave).

| Site | Read | What it answers | Class | Decision |
|---|---|---|---|---|
| `saas/auto-renew/route.ts:101` | `subscriptionModule.listSubscriptions` | subscription exists, and its `customer_id` (`:104`) | pre-workflow scoping | convert |
| `saas/auto-renew/route.ts:113` | `customerModule.retrieveCustomer` | `metadata` for `assertTenantVisible` (`:115`) | pre-workflow scoping | convert |
| `saas/renew/route.ts:99` | `subscriptionModule.listSubscriptions` | subscription exists → `customerId` (`:102`) | pre-workflow scoping | convert |
| `saas/renew/route.ts:111` | `customerModule.retrieveCustomer` | `metadata` for `assertTenantVisible` (`:113`) | pre-workflow scoping | convert |
| `saas/redeem/route.ts:101` | `customerModule.retrieveCustomer` | `metadata` for `assertTenantVisible` (`:103`) | pre-workflow scoping | convert |
| `saas/carts/route.ts:77` | `customerModule.retrieveCustomer` | `metadata` for `assertTenantVisible` (`:79`) | pre-workflow scoping | convert |
| `saas/carts/route.ts:82` | `query.graph` `region` | `region_id` for `createCartWorkflow` (`:95-97`); the `!region` 400 at `:88-93` is a precondition, but the value is consumed, so this is not validation-only | pre-workflow lookup — **not** tenant-scoping; a DAL fault reaches the body identically | convert (the plan's own list counted it) |
| `saas/ensure-customer/route.ts:74` | `customerModule.listCustomers` | external_id candidates, kept only through `isOwnedByRequestTenant` (`:80`) | pre-workflow scoping | convert |
| `saas/ensure-customer/route.ts:95` | `customerModule.listCustomers` | email candidates, same filter (`:100`) and the adoption decision (`:109`) | pre-workflow scoping | convert |
| `saas/lib/tenant-ownership.ts:78` | `customerModule.retrieveCustomer` | shared helper; reached only from `reconcile:83,205` (confirmed — no other caller under `src/api/`) | pre-workflow scoping | convert, once, in the helper |
| `saas/reconcile/route.ts:62` | `query.graph` `order` | `order.customer_id` (`:74`) → `assertCustomerTenantVisible` (`:83`) | pre-workflow scoping | convert |
| `saas/reconcile/route.ts:67` | `query.graph` `order_payment_collection` | link id consumed at `:85-90` | post-scoping response read; uncaught, reaches the body | convert |
| `saas/reconcile/route.ts:90` | `query.graph` `payment_collection` | `paymentStatus` in the response (`:101-116`) | post-scoping response read | convert |
| `saas/reconcile/route.ts:120` | `query.graph` `order_cart` | `cartId` in the response (`:130`) | post-scoping response read | convert |
| `saas/reconcile/route.ts:125` | `query.graph` `subscription_order` | `subscriptionId` in the response (`:169-171`) | post-scoping response read | convert |
| `saas/reconcile/route.ts:138` | `query.graph` `cart` | cart snapshot in the response (`:149-156`) | post-scoping response read | convert |
| `saas/reconcile/route.ts:179` | `query.graph` `subscription` | exists (`:198`) + `customer_id` → `assertCustomerTenantVisible` (`:205`) | pre-workflow scoping | convert |
| `saas/reconcile/route.ts:216` | `query.graph` `customer` | `metadata` → `assertTenantVisible` (`:233`) | pre-workflow scoping | convert |
| `saas/reconcile/route.ts:235` | `query.graph` `subscription` by customer | the list the route returns (`:254`) | post-scoping response read | convert |
| `customers/me/subscriptions/utils.ts:135` | `subscription` by `customer_id` (`listStoreCustomerSubscriptions`, `:129`) | the caller's own list | post-auth read of a caller-owned resource | leave |
| `customers/me/subscriptions/utils.ts:168` | `cancellation_case` (same fn, `:129`) | enrichment of that list | post-auth read, caller-owned | leave |
| `customers/me/subscriptions/utils.ts:201` | `subscription` `id`+`customer_id` (`retrieveOwnedSubscription`, `:195`) | ownership, against the `auth_context` id | ownership read, caller-proven | leave |
| `customers/me/subscriptions/utils.ts:289` | `cancellation_case` (`getActiveCancellationCase`, `:285`) | detail enrichment | post-auth read, caller-owned | leave |
| `customers/me/subscriptions/utils.ts:317` | `dunning_case` (`getSubscriptionDunningCase`, `:313`) | detail enrichment | post-auth read, caller-owned | leave |
| `customers/me/subscriptions/utils.ts:349` | `dunning_attempt` (`getLatestDunningAttempt`, `:345`) | detail enrichment | post-auth read, caller-owned | leave |
| `customers/me/subscriptions/utils.ts:420` | `subscription` `id`+`customer_id` (`getStoreSubscriptionPaymentMethodsResponse`, `:412`) | payment-method view of the caller's subscription | post-auth read, caller-owned | leave |
| `customers/me/subscriptions/utils.ts:477` | `subscription` (`getStoreSubscriptionDetailResponse`, `:469`) | the detail body | post-auth read, caller-owned | leave |
| `customers/me/subscriptions/utils.ts:609` | `subscription` `id`+`customer_id` (`getOwnedSubscriptionForAction`, `:603`) | ownership before a mutation | ownership read, caller-proven | leave |
| `customers/me/subscriptions/utils.ts:680` | `product` by `req.params.id` (`getStoreProductSubscriptionOfferResponse`, `:673`) | catalog offer lookup — answers no tenant-scoping question | outside §D's class | leave (see ruling) |

No hit landed in `validation-only`: every read here either decides tenant visibility or
supplies a value something consumes. The column is kept because the taxonomy needs it,
not because anything filled it.

#### Scope ruling

**Convert** the 19 `saas/**` reads — all of them, including `ensure-customer`, which the
plan never predicted, and including `reconcile`'s six post-scoping response reads,
because that route has no workflow to classify separately and every one of its reads is
uncaught, so each fault reaches a body.

**Do not convert** `src/api/store/customers/me/**` (the 10 rows above). In that subtree
the customer id is not caller-supplied: `requireStoreCustomer` takes it from
`req.auth_context.actor_id` (`src/api/store/customers/me/subscriptions/utils.ts:114-127`,
the same shape as `redemptions/utils.ts:9-22`). Wrapping those reads would answer a DAL
fault with a 404 telling an authenticated customer that *their own* subscription does not
exist — a worse answer than the current one, because it denies a resource the caller
legitimately owns rather than merely quoting internals at it. That is §D's standing
argument for excluding `customers/me/redemptions` ("wrapping
`listAndCountRedemptionRecords` would turn a list fault into a 404, which is a worse lie
than the current one"), and it generalizes to the whole subtree, so it is recorded as the
subtree's rule and not as one route's exception. The only read a widened receiver set
surfaces outside this list is `customers/me/redemptions/utils.ts:52`
(`listAndCountRedemptionRecords`, `customer_id` from the same `auth_context` helper),
which is the site this section has always excluded — so the exclusion is now justified by
the rule above rather than by name. `subscriptions/utils.ts:680` is left for a distinct
reason — a `product` read answers no tenant-scoping question, so it is outside this
class entirely, and masking it as 404 would misreport catalog the caller can see. They
are listed above so the enumeration is complete rather than convenient.

#### What "convert" can promise about status (measured in Task 12)

`src/workflows/utils/store-step-failure.ts:206-218` rewrites a *declared* refusal to
`invalid_data` unless the caller opts out:

```typescript
if (declared) {
  return {
    type:
      preserveQuotedStatus === true ? type : MedusaError.Types.INVALID_DATA,
    message,
```

Only `src/api/store/customers/me/redemptions/route.ts:76` passes `preserveQuotedStatus`.
So a refusal that a step throws as `not_found` answers **400** on `/store/saas/redeem`
and **404** on the customer route (core's `error-handler` maps `invalid_data`→400,
`not_found`→404). A canary case that assumes 404 at the bridge therefore tests behavior
the classifier does not implement; the wrapper's cases must be pinned per route, against
the status each one actually produces.

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

### Measured on 2026-09-25, which rewrites what "deploy" means

- The running production image has **no `@mengyyy369/*` package at all**
  (`ls /app/node_modules/@mengyyy369` → absent), and the backend workspace's
  manifests declare no such dependency. So 1.6.0 onto `medusa-prod` is a **first
  install, not an upgrade**: the plugin's tables are created from scratch, which
  means the acceptance round's normalize step, the drift path and the index's
  dedup behaviour will **not** be exercised there at all — they can only be
  exercised by the §B harness. Anything that claims production "verified the
  invariant" after a first install is claiming the wrong thing.
- The backend is a **pnpm workspace**, not an npm app:
  `/home/ubuntu/medusa-saas/src` holds `pnpm-workspace.yaml`, `pnpm-lock.yaml`,
  `turbo.json` and `apps/`. Registry credentials therefore belong to pnpm's
  config at the place `pnpm install` actually runs — and that is a build-time
  concern, not a runtime one.
- **No Dockerfile was found anywhere under `/home/ubuntu/medusa-saas`** (maxdepth 2),
  yet `medusa-saas-backend:0.4.14` exists locally with `labels=null` and a
  2026-09-21 build date. Open question Phase 6.1 must answer before anything
  installs: **where is that image built?** If it is built off-box, the registry
  credential belongs in that build environment and must never be copied onto the
  production host.
- Network path is fine: `npm.pkg.github.com` answers from the box (a clean 401
  with no token supplied). `ubuntu/.npmrc` today holds a mirror `registry=` line
  and **no token**, and `/root/.npmrc` exists separately. The local
  developer-machine `.npmrc` now contains a `write:packages` credential, which is
  publish-capable: copying it to a production host would trade a private-repository
  read need for a write-capable secret sitting on a box that does not consume the
  package. What this host needs, when the dependency is actually added, is a
  separate token scoped to `read:packages` only.

Order:

1. Answer the open question above — where `medusa-saas-backend` is built and where
   `pnpm install` runs — then decide where a **read-only** registry credential
   belongs. Record in the runbook.
2. `pg_dump` the prod database, **restore it into a scratch database on the same box
   and boot the new version against that**, then throw the scratch away. The runbook
   is `docs/releases/1.6.0-host-upgrade.md` (tracked) — an untracked file is an
   unrecorded residual, `lessons.md:99`.
3. Scale dtc down; confirm exactly one Medusa store in `docker ps`.
4. Add the dependency through the pnpm workspace and migrate. Because this is a
   first install, the expected `mikro_orm_migrations` result is *every* plugin
   migration applied fresh, and the drift assertions below are vacuous unless rows
   are seeded deliberately — say which of them are asserted against seeded data and
   which against the empty schema. Then assert the two invariants a live store
   shows: no subscription holds more than one live `SCHEDULED` cycle
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
- [ ] 1.1 `files: [".medusa/server/src", "!**/__tests__/**"]` — the array that ships
      (`package.json` at HEAD of this branch; §A states which removals each entry is
      responsible for); `npm pack --dry-run` before/after with
      sizes and the file list.
- [ ] 1.2 Unpack to a temp dir; assert every `exports` target resolves.
- [ ] 1.3 Prove the packed tree against a host app. Its install-plus-boot form was **not
      run** — the install rewrites a tracked `package.json` and lockfile in a host
      repository outside this worktree, and the boot drives that host's own database;
      §A records what replaced it and why. The read-only half is done: every specifier
      either host writes, and every specifier the plugin loader builds, resolves inside
      the narrowed tree. Unchecked here is the half only a boot settles — modules,
      workflows, routes and the admin bundle *register* — which 6.2 rehearses.
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
baseline was build 0, modules 25 suites / 270 tests, http 35 suites / 228 tests, and
Phase 2's close re-baselined it to **modules 25 / 270 (unchanged — Phase 2 added no
module spec) and http 36 suites / 238 tests**, the delta being
`integration-tests/http/migrations.spec.ts` and its 10 cases. The http gate's
union-of-runs protocol (including OS-killed suites) is in `AGENTS.md:49-61` and
`lessons.md:107`; the numbers and their per-suite reconciliation are in the Appendix.

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
  Settled without the boot §A originally called for: the two real hosts write two
  distinct specifiers between them and both resolve, the tarball a host still holds from
  before the narrowing differs from the new one by 19 repository-payload paths and 16
  compiled `__tests__` specs and nothing else, and all 690 relative `require()` targets
  inside the packed tree resolve within it. What stays open is registration, which moves
  to 6.2. See §A for the measurements.
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

## Appendix: constraints for the session that executes this plan

Written by the session that produced the plan, because every line below was paid
for in a wrong commit, a voided test run, or a rejected review.

**Read first, in this order**: this file; `.agents/AGENTS.md`; `.agents/lessons.md`
(each bullet is a rule someone was bitten by, and several describe the exact code
this plan changes); `.agents/specs/2026-09-24-1.6.0-acceptance-fixes.md` for the
rulings this one inherits. Do not re-derive any of it from the code.

**Repo and release state as of 2026-09-25**: `main` is at `1d38d84`, equal to
`origin/main`. Tag `v1.6.0` points at the same commit; the GitHub release exists.
`@mengyyy369/reorder@1.6.0` is published to GitHub Packages
(`npm view … → 1.6.0`, tarball shasum `f79d309a…`) with the 400-file surface this
plan's Phase 1 shrinks. The e2e workstream is committed (`35499e8`), so the
previous ruling to leave that work alone in the tree no longer applies to it.

**Environment, measured on this machine**: `node_modules` exists (install with
`corepack yarn install`; a plain `npm`/`yarn` without corepack picks the wrong
toolchain). No Postgres container was running when this was written — `reorder-acceptance-pg`
was deleted at cleanup, so Phase 0.1 recreates one before any gate means anything; it has
existed since (Task 1) and `docker start reorder-acceptance-pg` is the branch that applies
now. Gates need `DB_HOST`/`DB_PORT`/`DB_USERNAME`/`DB_PASSWORD` exported (not
`DATABASE_URL`; see `AGENTS.md`), **`DB_HOST` must be `localhost` on this machine, never
`127.0.0.1`** — the loopback address wedges Medusa's `PgConnection` (pool timeouts at
60/120/180 s, zero server-side backends, reproduced against an untouched spec) while the
container's publish address legitimately is `127.0.0.1:5432`. `TEST_TYPE` is set by the yarn
scripts, not by hand.

**Traps that produced bad evidence in the last round**

- Never run `yarn build` while a gate or a reviewer holds the tree:
  `medusa plugin:build` deletes and rewrites `.medusa/server`, which a running http
  suite loads its plugin from. It produced four `FAIL`s from nothing but a rebuild.
- The unattended http run loses ~2 suites to OS-killed workers (`SIGTERM`), a
  different pair each time. "Green" is the union of runs plus an isolated
  `--runInBand --max-old-space-size=4096` re-run of whatever was killed, and totals
  must be reconciled by name. Baseline as of Phase 2's close (2026-09-26):
  **build 0; modules 25 suites / 270 tests; http 36 suites / 238 tests, 0 failing
  assertions** — modules unchanged, because Phase 2 added no module spec, and the
  `+1 suite / +10 tests` on the http side is `integration-tests/http/migrations.spec.ts`
  (§B's harness). The pre-Phase-2 numbers were 35 / 228.
- Capture `$?` immediately after a command. A chained command's exit code is not
  the gate's exit code; that is how a red build once got reported green.
- Check the mtime of any log you are about to cite. `.scratch/*.log` files from the
  original 12-ticket round nearly became this round's evidence.
- A `cp` restore, or a full-file write, is a claim on the whole file. No second
  agent may touch a file while a mutation probe is live in it.
- Framework APIs named in a plan or a comment must carry the `node_modules` file and
  line that proves they exist. This plan's first version cited
  `Migrator.runMigrationClasses()`, which does not exist.
- `medusa plugin:build` typechecks `src/` and `src/modules/*/__tests__/**` but not
  `integration-tests/**`; `jest.config.js:26-33` decides which specs execute. A
  decision unit placed under `src/api/**` or `src/workflows/__tests__/` can fail
  nothing. Measured again at Phase 2's close: on a fully green tree
  `npx tsc --noEmit -p tsconfig.json` still exits 2 with **90 `error TS` spread over 18
  files under `integration-tests/`**, none of them in `migrations.spec.ts`. So a spec
  added there is typechecked by hand, and "clean" means `… | grep -c <spec>` returns 0 —
  the exit code says nothing while that pre-existing debt stands.
- Engine-reported failures are serialized plain objects, never `Error` instances,
  and a workflow run that leaves `throwOnError` at its default rethrows that object
  verbatim. Any route that runs a workflow must classify.
- Single-entity jsonb writes merge; batch/upsert paths overwrite; writing `null`
  clears the column. Never describe an incomplete jsonb payload as data loss without
  naming the DAL method that ran.

**Working protocol**: one phase at a time; each phase ends with the three gates from
a clean build **plus** its named mutation probe actually reddening; documentation
owed by that phase changes in the same commit; every phase is its own commit with
explicit paths (never `git add -A`) and its Conventional Commits message shown to
the user **before** committing or pushing. `.scratch/source-repo-fixes/` is the
ticket archive and is gitignored — never conclude from `git` that a ticket's status
was updated.

**Periphery**: `git remote` has an `upstream` pointing at `reorder-js/reorder`
(the official project). `gh` resolves to it by default, so every `gh` call needs
`--repo MengYYY369/reorder`; never push a tag or release there. The publish token in
this machine's `~/.npmrc` is `write:packages`-capable — do not copy it to the
production host; when the dependency is actually added, that environment needs a
separate `read:packages` token, and Phase 6.1 must first answer where the backend
image is built.
