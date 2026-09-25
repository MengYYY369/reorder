# Post-Acceptance Backlog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the v1.6.0 plugin shippable as itself (not as this repository), verifiable where it shapes data, and correct on the two money paths that were left open by ruling.

**Architecture:** Three seams carry almost all of it. A publish `files` list derived from the `exports` map decides what a host receives. A probe database driven through `@medusajs/test-utils`' own migration wrapper decides what can be *proved* about migrations. And `resolveUpcomingCycle` — already a pure selector with a partial unique index behind it — gains a `retire` side effect so a stale chargeable cycle stops surviving the reconciliation that was supposed to clean it up.

**Tech Stack:** TypeScript, Medusa v2 (`@medusajs/framework`), MikroORM 6 (`@mikro-orm/migrations`, knex), Jest with `--experimental-vm-modules`, Playwright (already committed, not exercised here), pnpm-based external host app.

**Spec:** `.agents/specs/2026-09-25-post-acceptance-backlog.md` — the plan argues from it; read both. The rulings it inherits are in `.agents/specs/2026-09-24-1.6.0-acceptance-fixes.md`.

## Global Constraints

Every task includes this section. Values are copied verbatim from the spec and `.agents/AGENTS.md`.

- Requires **Medusa 2.20 / mikro-orm 6.6.14** (`CHANGELOG.md:3`).
- All code, comments, specs, docs and commit messages in **English**, whatever language the chat is in (`AGENTS.md:11`).
- **Conventional Commits** `type(scope): description`; explicit paths in `git add`, **never** `git add -A`. The user granted standing approval for commits and pushes on 2026-09-25, which **overrides** the "wait for explicit approval" step in `AGENTS.md:13` — still write the message as if asking, and state what went in.
- Install/test through **`corepack yarn`** (`packageManager` is yarn 4 in `package.json`).
- Both jest gates need **`DB_HOST` / `DB_PORT` / `DB_USERNAME` / `DB_PASSWORD` exported** — `DATABASE_URL` does not feed the per-suite databases (`AGENTS.md:49-61`, `@medusajs/test-utils/dist/database.js:12-20`). No container is running until Task 1 creates one.
- **Never** run `yarn build` while a gate or reviewer holds the tree: `medusa plugin:build` deletes and rewrites `.medusa/server`, which a running http suite loads (`lessons.md`, *Whole-File Restore Is Exclusive Ownership*).
- Gate baseline to reconcile against: build 0; modules **25 suites / 270 tests**; http **35 suites / 228 tests**; an unattended http run loses ~2 suites to `SIGTERM`, so green = union of runs **plus** an isolated `--runInBand --max-old-space-size=4096` re-run of whatever was killed.
- No `any`, **including in specs** — a test double gets a local type or `unknown` plus narrowing. No business rules in route handlers, no documented intended-future behavior (`AGENTS.md` *Never*).
- `.scratch/source-repo-fixes/` is the gitignored ticket archive — never infer from git that a ticket status changed.
- `git remote` has **`upstream → github.com/reorder-js/reorder`** (someone else's repo). Every `gh` call needs `--repo MengYYY369/reorder`.
- The local `~/.npmrc` holds a **`write:packages`-capable** token. It must never be copied to any server. Publish: `@mengyyy369/reorder@1.6.0` already exists on GitHub Packages and **a published version cannot be replaced** — any packaging fix ships as `1.6.1`.
- `medusa plugin:build` typechecks `src/` and `src/modules/*/__tests__/**` but **not** `integration-tests/**`; `jest.config.js:26-33` decides which specs execute at all.

**Per-task verification protocol.** Each task ends with: focused test green → `corepack yarn build` → the mutation probe named in that task actually reddening and then being restored → the commit. A task is not done on "should work".

---

## Phase 1 — Publish surface

### Task 1: Recreate the gate database and record the baseline

**Files:**
- Modify: `.agents/AGENTS.md:49-61` and `.agents/lessons.md:88` together if the container name differs from `medusa-epay-pg` — one commit, both files, or the two contradict each other

The baseline numbers are recorded in the **body of Task 2's commit**, not in a gitignored scratch file (`lessons.md:99`).

**Interfaces:**
- Produces: a reachable Postgres at `127.0.0.1:5432` with the role/password from `.env`'s `DATABASE_URL`, and the measured baseline numbers every later task compares to.

- [ ] **Step 1: Start the container**

```bash
docker run -d --name reorder-acceptance-pg -e POSTGRES_USER=user \
  -e POSTGRES_PASSWORD=$(node -e 'var s=require("fs").readFileSync(".env","utf8");var m=s.match(/DATABASE_URL="?([^"\n]+)/);process.stdout.write(decodeURIComponent(new URL(m[1]).password))') \
  -p 127.0.0.1:5432:5432 postgres:16-alpine
docker exec reorder-acceptance-pg pg_isready -U user
```

Expected: `accepting connections`. If `.env` has no `DATABASE_URL`, stop and ask the user — do not invent credentials.

- [ ] **Step 2: Export the four variables for this shell**

```bash
export DB_HOST=localhost DB_PORT=5432 DB_USERNAME=user
export DB_PASSWORD=$(node -e 'var s=require("fs").readFileSync(".env","utf8");var m=s.match(/DATABASE_URL="?([^"\n]+)/);process.stdout.write(decodeURIComponent(new URL(m[1]).password))')
```

- [ ] **Step 3: Run the modules gate and record the numbers**

```bash
TEST_TYPE=integration:modules NODE_OPTIONS=--experimental-vm-modules corepack yarn jest --forceExit
```

Expected: `Test Suites: 25 passed, 25 total` / `Tests: 270 passed, 270 total`. If six `service.spec.ts` files fail with `ORM not configured`, the env export did not take — fix the shell, not the code.

- [ ] **Step 4: Run the http gate, then re-run killed suites in isolation**

```bash
corepack yarn test:integration:http
grep -E "^FAIL" /tmp/plan-http.log
```

Expected: **0 failing assertions**; `Tests: 228 passed, 228 total` across the union of runs. Collect the killed suite names and re-run them `--runInBand`. Write both runs' totals into `.superpowers/baseline-2026-09-25.md`.

- [ ] **Step 5: Record the numbers where they will be read**

Write the four totals (build exit code, modules suites/tests, http suites/tests, the
killed suites re-run separately) into the commit body of Task 2, which is the first
task that can change a number. If Task 2 is split, they go into the first split's body.

- [ ] **Step 6: No commit of its own** — this task changed no tracked file unless the
container name in Step 1 differed; in that case commit the two doc files now:

```bash
git add .agents/AGENTS.md .agents/lessons.md
git commit -m "docs(agents): name the container the test gates actually need"
```

---

### Task 2: Ship the plugin, not the repository

**Files:**
- Modify: `package.json` (`files` array)
- Create: `scripts/assert-package-surface.mjs`
- Modify: `CHANGELOG.md` (Chores list under `## [1.6.0]`)
- Modify: `docs/releases/1.6.0-host-upgrade.md` (what the package contains)

**Interfaces:**
- Consumes: `exports` in `package.json` (nine keys, all pointing at `.medusa/server/src/...`).
- Produces: `node scripts/assert-package-surface.mjs` exiting 0 on an unpacked tarball; a measured before/after file count for the release decision.

- [ ] **Step 1: Record the "before" numbers**

```bash
npm pack --dry-run 2>&1 | grep -E "package size|total files"
```

Expected today: `925.9 kB`, `400` files. Write both into the commit body.

- [ ] **Step 2: Write the assertion script (fails before the fix)**

```javascript
// scripts/assert-package-surface.mjs
// Every subpath a host can import must resolve inside the packed tree.
import { readFileSync, existsSync } from "node:fs"
import { resolve } from "node:path"

const root = process.argv[2] ?? "package"
const { exports: map } = JSON.parse(
  readFileSync(resolve(root, "package.json"), "utf8")
)

const targets = []
const walk = (value) => {
  if (typeof value === "string") targets.push(value)
  else if (value) Object.values(value).forEach(walk)
}
walk(map)

const missing = targets
  .filter((target) => target.startsWith("./.medusa/server/"))
  .filter((target) => !existsSync(resolve(root, target)))

if (missing.length) {
  console.error("missing packed exports targets:\n" + missing.join("\n"))
  process.exit(1)
}
console.log(`packed exports ok (${targets.length} targets checked)`)
```

- [ ] **Step 3: Pack, unpack, and assert — expecting the e2e payload to show**

```bash
npm pack --quiet && mkdir -p /tmp/pkgcheck && tar xzfg mengyyy369-reorder-1.6.0.tgz -C /tmp/pkgcheck 2>/dev/null || tar xzf mengyyy369-reorder-1.6.0.tgz -C /tmp/pkgcheck
find /tmp/pkgcheck/package/.medusa/server -maxdepth 1 -mindepth 1
node scripts/assert-package-surface.mjs /tmp/pkgcheck/package
```

Expected: the directory list shows `src`, **`e2e`** and `playwright.config.js`; the assertion exits 0 (it checks presence, not absence — that is what the next step's `files` change fixes).

- [ ] **Step 4: Narrow `files`**

In `package.json`, replace

```json
  "files": [
    ".medusa/server"
  ],
```

with

```json
  "files": [
    ".medusa/server/src"
  ],
```

- [ ] **Step 5: Re-pack and assert both directions**

```bash
rm -f mengyyy369-reorder-1.6.0.tgz && npm pack --quiet
rm -rf /tmp/pkgcheck && mkdir -p /tmp/pkgcheck && tar xzf mengyyy369-reorder-1.6.0.tgz -C /tmp/pkgcheck
node scripts/assert-package-surface.mjs /tmp/pkgcheck/package
find /tmp/pkgcheck/package/.medusa/server -maxdepth 1 -mindepth 1
npm pack --dry-run 2>&1 | grep -E "package size|total files"
```

Expected: assertion exits 0; the directory list shows **only `src`**; the count drops from 400. If `src` disappears entirely, `files` was mistyped — fix before continuing.

- [ ] **Step 6: Wire the check into the release path**

In `package.json` `scripts`, after `"build": "medusa plugin:build"`, add:

```json
    "verify:package": "npm pack --silent --quiet > /dev/null && node scripts/assert-package-surface.mjs"
```

and confirm `prepublishOnly` still reads `medusa plugin:build` (it must keep running the build; do not chain the verifier into it — a publish that can fail on a doc-only path is worse than a manual check).

- [ ] **Step 7: Document it**

`CHANGELOG.md` Chores for `[1.6.0]`: one bullet stating the package now ships `.medusa/server/src` only and that `scripts/assert-package-surface.mjs` is what proves every `exports` path survives. `docs/releases/1.6.0-host-upgrade.md`: the same fact where the install instructions are, phrased as installed behavior, not intent.

- [ ] **Step 8: Build, probe, commit**

```bash
corepack yarn build
```

Mutation probe: temporarily change `"./.medusa/server/src"` in one `exports` value to a nonexistent path, run Step 5, confirm the script exits 1 naming it, restore.

```bash
git add package.json scripts/assert-package-surface.mjs CHANGELOG.md docs/releases/1.6.0-host-upgrade.md
git commit -m "fix(package): ship the plugin sources instead of the whole build output"
```

---

### Task 3: Prove the narrowed package installs in a real Medusa app

**Files:**
- Create: `/tmp/consume-check/package.json`, `/tmp/consume-check/medusa-config.ts`

**Interfaces:**
- Consumes: Task 2's tarball.
- Produces: a pass/fail statement about whether any host needs a packed path outside `src` — the answer the spec's R4 risk demanded.

- [ ] **Step 1: If a local host checkout exists, use it**

```bash
ls -d ../medusa-dtc ../medusa-saas 2>/dev/null
```

If one exists, continue at Step 2 with that directory as the host. If none exists locally, **stop and record in the spec** that host verification is deferred to the Phase 6 rehearsal, and skip to Step 4 — do not fabricate a synthetic Medusa app; it would prove nothing about the real one.

- [ ] **Step 2: Install the packed tarball, not the workspace**

```bash
cd <host-checkout> && npm i --no-save /d/Projects/reorder/mengyyy369-reorder-1.6.0.tgz
node -e "console.log(require.resolve('@mengyyy369/reorder/workflows'))"
```

Expected: a path ending `.medusa/server/src/workflows/index.js`. `MODULE_NOT_FOUND` means a needed path was excluded — restore `files`, list the missing file, and go back to Task 2 with the extra entry.

- [ ] **Step 3: Boot the host and confirm the plugin registers**

```bash
npm run dev 2>&1 | grep -iE "reorder|renewal_cycle|error" | head -20
```

Expected: the plugin's modules appear in the loaded list and no `Cannot find module '@mengyyy369/reorder/...'` line exists. Then revert the temporary install: `git checkout package.json node_modules 2>/dev/null; npm i`.

- [ ] **Step 4: Commit the measurement**

```bash
git add .agents/specs/2026-09-25-post-acceptance-backlog.md
git commit -m "docs(spec): record whether the packed plugin resolves in a host app"
```

---

## Phase 2 — Migration harness

### Task 4: A probe database that reaches the real migration state

**Files:**
- Create: `integration-tests/http/migrations.spec.ts`
- Read: `node_modules/@medusajs/test-utils/dist/database.js:3,73,100-128`

**Interfaces:**
- Consumes: `getMikroOrmWrapper({ mikroOrmEntities, pathToMigrations, clientUrl, schema })` — when `pathToMigrations` is an **array with more than one entry**, `setupDatabase()` runs each directory through `runMigrationsFromPath` in the order given and returns without generating an entity-derived schema.
- Produces: `probeDatabase(name)`, `migrateProbe(handle)`, `probeQuery(handle, sql)` and a `beforeAll`-built handle named `probe` that every later task in this phase reuses.

- [ ] **Step 1: Settle the import shape before writing tests**

```bash
node -e "const t=require('@medusajs/test-utils');console.log(Object.keys(t).filter(k=>/mikro|dbTest|loadModels|toMikroOrm/i.test(k)).join('\n'))"
```

Expected: `dbTestUtilFactory` and, ideally, `getMikroOrmWrapper`. If only the factory is exported, import the rest by deep path in the spec: `import { getMikroOrmWrapper } from "@medusajs/test-utils/dist/database"` and `import { loadModels, toMikroOrmEntities } from "@medusajs/test-utils/dist/utils"`. Record which resolved in the commit body — the next session must not re-guess it.

- [ ] **Step 2: Write the failing skeleton**

```typescript
import { medusaIntegrationTestRunner } from "@medusajs/test-utils"
import path from "path"

/** The subset of `getMikroOrmWrapper`'s return these cases use. */
type ProbeWrapper = {
  setupDatabase(): Promise<void>
  manager: {
    execute(sql: string): Promise<unknown>
  }
  orm: {
    getMigrator(): {
      getPendingMigrations(): Promise<Array<{ label?: string; name?: string }>>
      up(options: { migrations: string[] }): Promise<unknown>
      down(options: { migrations: string[] }): Promise<unknown>
    }
    close(): Promise<void>
  }
}

const readRows = (result: unknown): Array<Record<string, unknown>> => {
  const rows = (result as { rows?: Array<Record<string, unknown>> }).rows
  return rows ?? (result as Array<Record<string, unknown>>)
}

const MIGRATION_PATHS = [
  "activity-log", "analytics", "cancellation", "dunning", "plan-offer",
  "redemption", "renewal", "settings", "subscription",
].map((m) => path.resolve(__dirname, `../../src/modules/${m}/migrations`))

medusaIntegrationTestRunner({
  medusaConfigFile: path.resolve(process.cwd(), "integration-tests"),
  env: { JWT_SECRET: "supersecret", COOKIE_SECRET: "supersecret" },
  testSuite: ({ getContainer }) => {
    describe("plugin migrations", () => {
      it("applies every migration the app bootstrap applies", async () => {
        expect(true).toBe(false)
      })
    })
  },
})

jest.setTimeout(180 * 1000)
```

- [ ] **Step 3: Run it to confirm the runner itself works in this file**

```bash
TEST_TYPE=integration:http NODE_OPTIONS="--experimental-vm-modules --max-old-space-size=4096" corepack yarn jest integration-tests/http/migrations.spec.ts --runInBand --forceExit
```

Expected: FAIL on the assertion, not on module loading or the DB. A `Cannot find module '@medusajs/test-utils/dist/utils'` here means Step 1's fallback is wrong — resolve it, do not stub the import.

- [ ] **Step 4: Implement the probe harness and the first real assertion**

Replace the failing skeleton's `it` body:

```typescript
      let probe = dbTestUtilFactory()
      let probeWrapper!: ProbeWrapper
      let appMigrations: string[]

      beforeAll(async () => {
        const container = getContainer()
        await probe.create("reorder_migrations_probe")

        const { getMikroOrmWrapper } = await import(
          "@medusajs/test-utils/dist/database"
        )
        const { loadModels, toMikroOrmEntities } = await import(
          "@medusajs/test-utils/dist/utils"
        )
        const entities = toMikroOrmEntities(
          [
            "activity-log", "analytics", "cancellation", "dunning",
            "plan-offer", "redemption", "renewal", "settings", "subscription",
          ].flatMap((m) =>
            loadModels(
              path.resolve(__dirname, `../../src/modules/${m}/models`)
            )
          )
        )

        // Extracted immediately: Task 6 rebuilds the same wrapper over one
        // migration directory, so the construction lives in one function.
        probeWrapper = getProbeWrapperFor("reorder_migrations_probe", MIGRATION_PATHS)

        // getProbeWrapperFor(name, paths) wraps the toMikroOrmEntities(...) +
        // getMikroOrmWrapper({ ... clientUrl: .../name }) calls above.
        void getMikroOrmWrapper({
          mikroOrmEntities: entities,
          pathToMigrations: MIGRATION_PATHS,
          clientUrl: `postgres://user:${process.env.DB_PASSWORD}@localhost:5432/reorder_migrations_probe`,
          schema: "public",
        })
        await probeWrapper.setupDatabase()

        const executed = await probeWrapper.manager.execute(
          `select name from mikro_orm_migrations order by id`
        )
        appMigrations = (
          await container
            .resolve<any>("models")
            .query?.(`select name from mikro_orm_migrations order by id`)
        ) ?? readRows(executedRaw).map((row) => String(row.name))
      })

      afterAll(async () => {
        await probeWrapper.orm.close()
        await probe.delete("reorder_migrations_probe")
      })

      it("applies every migration the app bootstrap applies", async () => {
        const applied = readRows(
          await probeWrapper.manager.execute(
            `select name from mikro_orm_migrations order by id`
          )
        ).map((row) => String(row.name))

        expect(applied.length).toBeGreaterThan(20)
        expect(applied).toEqual(expect.arrayContaining(appMigrations))
      })
```

`getProbeWrapperFor` is a module-level helper in this spec file, and
`void getMikroOrmWrapper({...})` above is what you delete once the extraction lands —
it is shown only so the argument list is on the page once.

`probe.delete` is the factory's drop method — Step 1 prints the factory's keys, so use
the name it shows. If the app-side list cannot be read from the container, compare
against the module's own migration filenames instead
(`ls src/modules/*/migrations/*.ts`); the requirement is the **comparison**, not the
plumbing. Note in the commit body which comparison you landed on.

- [ ] **Step 5: Run it**

Expected: PASS. Two failures are informative, not fatal, and must be reported rather than patched around: `CREATE DATABASE` refused (role lacks CREATEDB → stop and ask the user for a role change, do not fall back to reusing the suite DB) or the `.ts` migrations not resolving through `pathTs` (then point `MIGRATION_PATHS` at `.medusa/server/src/modules/*/migrations`, rebuild first, and record the tradeoff).

- [ ] **Step 6: Commit**

```bash
git add integration-tests/http/migrations.spec.ts
git commit -m "test(migrations): apply the plugin migrations to a probe database"
```

---

### Task 5: Pin which duplicate cycle survives

**Files:**
- Modify: `integration-tests/http/migrations.spec.ts`
- Read: `src/modules/renewal/migrations/Migration20260924120000.ts:20-95`

**Interfaces:**
- Consumes: Task 4's `probeWrapper`.
- Produces: `seedCycle(handle, { id, scheduledFor, status?, subscriptionId })` and `liveScheduled(handle, subscriptionId)` used by Tasks 6–8.

- [ ] **Step 1: Add the seeding helpers**

```typescript
async function seedSubscription(wrapper: ProbeWrapper, id: string, nextRenewalAt: string) {
  await wrapper.manager.execute(
    `insert into subscription (id, reference, currency_code, customer_id,
        product_id, variant_id, status, interval, interval_count,
        next_renewal_at, created_at, updated_at)
     values ('${id}', 'REF-${id}', 'USD', 'cus_probe', 'prod_probe',
        'variant_probe', 'active', 1, 1, '${nextRenewalAt}', now(), now())`
  )
}

async function seedCycle(
  wrapper: ProbeWrapper,
  {
    id,
    subscriptionId,
    scheduledFor,
    status = "scheduled",
    deletedAt = null,
  }: {
    id: string
    subscriptionId: string
    scheduledFor: string
    status?: string
    deletedAt?: string | null
  }
) {
  await wrapper.manager.execute(
    `insert into renewal_cycle (id, subscription_id, scheduled_for, status,
        approval_required, attempt_count, created_at, updated_at
        ${deletedAt ? ", deleted_at" : ""})
     values ('${id}', '${subscriptionId}', '${scheduledFor}', '${status}',
        false, 0, now(), now()
        ${deletedAt ? `, '${deletedAt}'` : ""})`
  )
}

async function liveScheduled(wrapper: ProbeWrapper, subscriptionId: string) {
  const rows = await wrapper.manager.execute(
    `select id from renewal_cycle
      where subscription_id = '${subscriptionId}'
        and status = 'scheduled' and deleted_at is null
      order by id`
  )
  return readRows(rows).map((row) => String(row.id)).sort()
}
```

- [ ] **Step 2: Write the re-run helper the cases need**

The migration has already run once (Task 4). Each normalization case re-runs `up()` on demand:

```typescript
async function rerunNormalize(wrapper: ProbeWrapper) {
  await wrapper.manager.execute(
    `drop index if exists "renewal_cycle_one_scheduled_per_subscription"`
  )
  await wrapper.manager.execute(`delete from mikro_orm_migrations where name like '%20260924120000%'`)
  const pending = await wrapper.orm.getMigrator().getPendingMigrations()
  await wrapper.orm.getMigrator().up({
    migrations: pending
      .map((m) => m.label ?? m.name ?? "")
      .filter((name) => name.includes("20260924120000")),
  })
}
```

- [ ] **Step 3: Write the four cases**

```typescript
      it("keeps the cycle already sitting on the entitlement date", async () => {
        await seedSubscription(probeWrapper, "sub_t1", "2026-11-24T00:00:00Z")
        await seedCycle(probeWrapper, { id: "cyc_t1_stale", subscriptionId: "sub_t1", scheduledFor: "2026-10-24T00:00:00Z" })
        await seedCycle(probeWrapper, { id: "cyc_t1_match", subscriptionId: "sub_t1", scheduledFor: "2026-11-24T00:00:00Z" })
        await seedCycle(probeWrapper, { id: "cyc_t1_older", subscriptionId: "sub_t1", scheduledFor: "2026-09-24T00:00:00Z" })

        await rerunNormalize(probeWrapper)

        expect(await liveScheduled(probeWrapper, "sub_t1")).toEqual(["cyc_t1_match"])
      })

      it("keeps the most future cycle when none matches the entitlement date", async () => {
        await seedSubscription(probeWrapper, "sub_t2", "2026-12-31T00:00:00Z")
        await seedCycle(probeWrapper, { id: "cyc_t2_newest", subscriptionId: "sub_t2", scheduledFor: "2026-10-24T00:00:00Z" })
        await seedCycle(probeWrapper, { id: "cyc_t2_older", subscriptionId: "sub_t2", scheduledFor: "2026-09-24T00:00:00Z" })

        await rerunNormalize(probeWrapper)

        expect(await liveScheduled(probeWrapper, "sub_t2")).toEqual(["cyc_t2_newest"])
      })

      it("leaves failed and already soft-deleted duplicates alone", async () => {
        await seedSubscription(probeWrapper, "sub_t3", "2026-11-24T00:00:00Z")
        await seedCycle(probeWrapper, { id: "cyc_t3_failed", subscriptionId: "sub_t3", scheduledFor: "2026-08-24T00:00:00Z", status: "failed" })
        await seedCycle(probeWrapper, { id: "cyc_t3_gone", subscriptionId: "sub_t3", scheduledFor: "2026-07-24T00:00:00Z", deletedAt: "2026-07-25T00:00:00Z" })
        await seedCycle(probeWrapper, { id: "cyc_t3_live", subscriptionId: "sub_t3", scheduledFor: "2026-09-24T00:00:00Z" })

        await rerunNormalize(probeWrapper)

        expect(
          readRows(
            await probeWrapper.manager.execute(
              `select last_error, deleted_at from renewal_cycle where id = 'cyc_t3_failed'`
            )
          )[0]
        ).toEqual({ last_error: null, deleted_at: null })
        expect(await liveScheduled(probeWrapper, "sub_t3")).toEqual(["cyc_t3_live"])
      })

      it("notes why the survivors' neighbours vanished", async () => {
        await seedSubscription(probeWrapper, "sub_t4", "2026-11-24T00:00:00Z")
        await seedCycle(probeWrapper, { id: "cyc_t4_keep", subscriptionId: "sub_t4", scheduledFor: "2026-11-24T00:00:00Z" })
        await seedCycle(probeWrapper, { id: "cyc_t4_drop", subscriptionId: "sub_t4", scheduledFor: "2026-10-24T00:00:00Z" })

        await rerunNormalize(probeWrapper)

        const dropped = readRows(
          await probeWrapper.manager.execute(
            `select last_error from renewal_cycle where id = 'cyc_t4_drop'`
          )
        )
        expect(String(dropped[0].last_error)).toContain(
          "normalized: duplicate upcoming cycle removed by the 1.6.0 uniqueness migration"
        )
      })
```

Knex/MikroORM result shape (`rows` vs the array itself) is settled the first time it runs; keep whichever the driver returns and drop the other branch, do not leave both.

- [ ] **Step 4: Run them**

```bash
TEST_TYPE=integration:http NODE_OPTIONS="--experimental-vm-modules --max-old-space-size=4096" corepack yarn jest integration-tests/http/migrations.spec.ts --runInBand --forceExit
```

Expected: PASS on all four.

- [ ] **Step 5: Mutation probe**

In `src/modules/renewal/migrations/Migration20260924120000.ts`, change the ordering key `prefer_entitlement` to the empty string `''`, re-run, and confirm **exactly** case 1 reddens (`cyc_t1_match` loses to `cyc_t1_stale`). Restore. Then flip `rc."scheduled_for" desc` to `asc`, re-run, and confirm **exactly** cases 2 and 4's survivor expectations redden. Restore. Record both probe outputs in the commit body.

- [ ] **Step 6: Commit**

```bash
git add integration-tests/http/migrations.spec.ts
git commit -m "test(renewal): pin which duplicate cycle the uniqueness migration keeps"
```

---

### Task 6: Pin the guard that lets renewal migrate before subscription exists

**Files:**
- Modify: `integration-tests/http/migrations.spec.ts`

**Interfaces:**
- Consumes: Task 4's harness, Task 5's helpers.
- Produces: a case proving the `to_regclass` guard in `Migration20260924120000.ts`.

- [ ] **Step 1: Write the case**

```typescript
      it("normalizes without a subscription table at all", async () => {
        const solo = getProbeWrapperFor("renewal_only")
        await solo.setupDatabase()   // only src/modules/renewal/migrations
        // activity-log..redemption absent → the subscription table does not exist

        const guard = await solo.manager.execute(
          `select to_regclass('public.subscription') as sub`
        )
        expect((guard.rows ?? guard)[0].sub).toBeNull()

        await solo.manager.execute(
          `insert into renewal_cycle (id, subscription_id, scheduled_for,
              status, approval_required, attempt_count, created_at, updated_at)
           values ('cyc_solo_a','sub_solo','2026-08-24','scheduled',false,0,now(),now()),
                  ('cyc_solo_b','sub_solo','2026-09-24','scheduled',false,0,now(),now())`
        )
        await rerunNormalize(solo)

        expect(await liveScheduled(solo, "sub_solo")).toEqual(["cyc_solo_b"])
      })
```

`getProbeWrapperFor(kind)` is a small factory extracted from Task 4's `beforeAll`: it takes the migration-path list as its argument so a second wrapper can be built over `["renewal"]` alone. Extract it first, then make Task 4's `beforeAll` call it — behaviour unchanged.

- [ ] **Step 2: Run, then probe it**

Expected: PASS. Mutation probe: replace `to_regclass('public.subscription')` with a literal `''` (so the join is always emitted), re-run, and expect this case to fail with `relation "subscription" does not exist`. Restore.

- [ ] **Step 3: Commit**

```bash
git add integration-tests/http/migrations.spec.ts
git commit -m "test(renewal): prove the migration runs when its module migrates first"
```

---

### Task 7: Pin both rollbacks

**Files:**
- Modify: `integration-tests/http/migrations.spec.ts`
- Read: `src/modules/activity-log/migrations/Migration20260922120000.ts:20-50`

**Interfaces:**
- Consumes: Task 4's harness.
- Produces: two `down()` cases — the reason the harness exists as much as the normalize cases do.

- [ ] **Step 1: The renewal rollback**

```typescript
      it("drops the constraint and resurrects nothing on down()", async () => {
        await probeWrapper.orm.getMigrator().down({
          migrations: ["Migration20260924120000"],
        })

        const index = await probeWrapper.manager.execute(
          `select indexname from pg_indexes where indexname =
             'renewal_cycle_one_scheduled_per_subscription'`
        )
        expect((index.rows ?? index).length).toBe(0)

        // the normalized neighbours from Task 5 stay soft-deleted
        expect(await liveScheduled(probeWrapper, "sub_t1")).toEqual(["cyc_t1_match"])

        // ...and two live rows are now insertable again
        await seedCycle(probeWrapper, { id: "cyc_t1_again", subscriptionId: "sub_t1", scheduledFor: "2027-01-01T00:00:00Z" })
        expect(await liveScheduled(probeWrapper, "sub_t1")).toEqual(["cyc_t1_again", "cyc_t1_match"])
      })
```

- [ ] **Step 2: The activity-log rollback, which is what failed acceptance**

```typescript
      it("rolls the creation-failure migration back over its own rows", async () => {
        await probeWrapper.manager.execute(
          `insert into subscription_log (id, event_type, actor_type,
               subscription_reference, created_at, updated_at)
           values ('slog_probe_1','subscription.creation_failed','system',
                   'SUB_PROBE', now(), now())`
        )

        await probeWrapper.orm.getMigrator().down({
          migrations: ["Migration20260922120000"],
        })

        const remaining = await probeWrapper.manager.execute(
          `select id from subscription_log where id = 'slog_probe_1'`
        )
        expect((remaining.rows ?? remaining).length).toBe(0)

        const constraint = await probeWrapper.manager.execute(
          `select conname from pg_constraint where conname =
             'subscription_log_event_type_check'`
        )
        expect((constraint.rows ?? constraint).length).toBe(1)
      })
```

Column names come from the model; if the insert is rejected, read `src/modules/activity-log/models/subscription-log.ts` and complete the list — do not drop the insert.

- [ ] **Step 3: Mutation probes**

(a) Swap the `delete` and `add constraint` statements in the activity-log `down()`: the case must fail with `check constraint ... is violated by some row` — the acceptance defect, now gated. (b) Add `delete from renewal_cycle where deleted_at is not null` to the renewal `down()`: the resurrection expectation fails. Restore both.

- [ ] **Step 4: Commit**

```bash
git add integration-tests/http/migrations.spec.ts
git commit -m "test(migrations): gate both rollbacks the acceptance round proved broken"
```

---

### Task 8: Close the phase's documentation debt

**Files:**
- Modify: `.agents/lessons.md`
- Modify: `.agents/specs/2026-09-25-post-acceptance-backlog.md` (check off the §B measures)

- [ ] **Step 1: Write the lesson**

Add a bullet in the style of the existing entries:

```markdown
* **A Migration Is Only Real Where a Runner Applies It**: no runner in this repo
  passes `pathToMigrations`, so `@medusajs/test-utils` reaches
  `orm.schema.refreshDatabase()` for module suites and the migration output simply
  does not exist there — while the http suites *do* run the plugin's migrations
  through `migrateDatabase → runModulesMigrations`
  (`@medusajs/test-utils/dist/medusa-test-runner.js:100`). Rule: assert migration
  behaviour in `integration-tests/http/`, and when a migration *shapes* data rather
  than constraining it, drive it on a probe database built with
  `getMikroOrmWrapper` (`@medusajs/test-utils/dist/database.js:73,100-128`) and prove
  it reaches the same `mikro_orm_migrations` set the app bootstrap writes. Naming a
  framework API without citing the file and line that proves it exists is a plan
  defect: `Migrator.runMigrationClasses()` did not exist here.
```

- [ ] **Step 2: Record the measured answers** in the spec's §B "measure first" list (import shape, `.ts` resolution, CREATEDB verdict) and in the Appendix's gate baseline if Task 1's numbers moved.

- [ ] **Step 3: Full gates, then commit**

```bash
corepack yarn build
TEST_TYPE=integration:modules NODE_OPTIONS=--experimental-vm-modules corepack yarn jest --forceExit
corepack yarn test:integration:http
git add .agents/lessons.md .agents/specs/2026-09-25-post-acceptance-backlog.md
git commit -m "docs(lessons): record what the migration harness proved"
```

Expected: modules now **26 suites / 270+N tests**; http 36 suites total. Update the Appendix baseline in the same commit.

---

## Phase 3 — Reachability

### Task 9: Make the three orphaned workflow specs run

**Files:**
- Move: `src/workflows/__tests__/cancel-subscription.spec.ts` → `src/modules/cancellation/__tests__/cancel-subscription-workflow.spec.ts`
- Move: `src/workflows/__tests__/pause-subscription.spec.ts` → `src/modules/subscription/__tests__/pause-subscription-workflow.spec.ts`
- Move: `src/workflows/__tests__/update-subscription-shipping-address.spec.ts` → `src/modules/subscription/__tests__/shipping-address-update.spec.ts`

**Interfaces:**
- Consumes: `jest.config.js:26-33` `testMatch`, which is what makes these files dead today.
- Produces: three specs that can actually fail a gate.

- [ ] **Step 1: Prove they are currently unexecuted**

```bash
TEST_TYPE=integration:modules NODE_OPTIONS=--experimental-vm-modules corepack yarn jest --listTests | grep -c "src/workflows/__tests__"
```

Expected: `0`. Record it.

- [ ] **Step 2: Move them and fix their import paths**

```bash
git mv src/workflows/__tests__/cancel-subscription.spec.ts src/modules/cancellation/__tests__/cancel-subscription-workflow.spec.ts
git mv src/workflows/__tests__/pause-subscription.spec.ts src/modules/subscription/__tests__/pause-subscription-workflow.spec.ts
git mv src/workflows/__tests__/update-subscription-shipping-address.spec.ts src/modules/subscription/__tests__/shipping-address-update.spec.ts
grep -rn "from \"\.\./\.\./" src/modules/*/__tests__/*workflow*.spec.ts src/modules/__tests__/../*/__tests__/shipping-address-update.spec.ts 2>/dev/null | head
```

Rewrite relative prefixes for the new depth (`../../workflows/...` → `../../../workflows/...`) and run:

```bash
TEST_TYPE=integration:modules NODE_OPTIONS=--experimental-vm-modules corepack yarn jest src/modules --forceExit 2>&1 | tail -20
```

Expected: they execute now. Any assertion that was already wrong (it could not fail before) is a **finding**: fix it in this commit and say so in the body, or if it encodes behavior that no longer exists, delete that case with a note — do not leave a spec red.

- [ ] **Step 3: Probe each file**

For each of the three: break one predicate its workflow depends on, run the file, confirm it reddens, restore. A spec that survives every probe is decoration, and must be rewritten or deleted — record which.

- [ ] **Step 4: Commit**

```bash
git add src/modules src/workflows
git commit -m "test(workflows): move the three specs no gate ever executed"
```

---

### Task 10: Make the `adopted` rollback testable

**Files:**
- Modify: `src/workflows/steps/ensure-next-renewal-cycle.ts`
- Modify: `src/modules/renewal/utils/upcoming-cycle.ts` (types only if needed)
- Create: `src/modules/renewal/__tests__/reconcile-restore.spec.ts`

**Interfaces:**
- Consumes: `UpcomingCycleReconcilePatch` / `restoreForUpcomingCycleReconcile` (`upcoming-cycle.ts:51-59,127`).
- Produces: `restoreReconciledCycle(writer, patch)` with

```typescript
export type ReconcileRestoreWriter = {
  updateRenewalCycles: (data: Record<string, unknown>) => Promise<unknown>
}
```

mirroring the shape the step already calls, and a module spec asserting one update carrying exactly the restored field set.

- [ ] **Step 1: Write the failing spec**

```typescript
import { restoreReconciledCycle } from "../../../workflows/steps/ensure-next-renewal-cycle"

it("restores every column the reconcile write may have changed", async () => {
  const updates: Record<string, unknown>[] = []
  await restoreReconciledCycle(
    { updateRenewalCycles: async (data) => { updates.push(data) } },
    {
      id: "rcy_1",
      scheduled_for: new Date("2026-09-24T00:00:00Z"),
      approval_required: true,
      approval_status: null,
      approval_decided_at: null,
      approval_decided_by: null,
      approval_reason: null,
      metadata: { settings_policy: { settings_version: 3 } },
    }
  )

  expect(updates).toHaveLength(1)
  expect(Object.keys(updates[0]).sort()).toEqual(
    [
      "approval_decided_at", "approval_decided_by", "approval_reason",
      "approval_required", "approval_status", "id", "metadata",
      "scheduled_for",
    ].sort()
  )
})
```

- [ ] **Step 2: Run to confirm it fails on the missing export**

```bash
TEST_TYPE=integration:modules NODE_OPTIONS=--experimental-vm-modules corepack yarn jest src/modules/renewal --forceExit
```

Expected: `restoreReconciledCycle is not a function` (or a typecheck error under `yarn build`).

- [ ] **Step 3: Extract it and delegate from the step**

```typescript
export async function restoreReconciledCycle(
  writer: ReconcileRestoreWriter,
  previous: EnsureNextRenewalCycleReconcileSnapshot
): Promise<void> {
  await writer.updateRenewalCycles(previous)
}
```

and in the compensation, replace the direct `updateRenewalCycles(compensation.previous)` calls for the `updated`/`adopted` branches with `restoreReconciledCycle(renewalModule, compensation.previous)`.

- [ ] **Step 4: Run, then probe**

Expected: PASS. Probe: add `last_error: null` to the writer payload in the implementation only — the field-set expectation reddens while nothing else does. Restore.

- [ ] **Step 5: Commit**

```bash
git add src/workflows/steps/ensure-next-renewal-cycle.ts src/modules/renewal
git commit -m "refactor(renewal): put the reconcile rollback where a gate can reach it"
```

---

### Task 11: One typed subscription-write boundary instead of four cast sites

**Files:**
- Create: `src/modules/subscription/utils/subscription-write-input.ts`
- Modify: `src/workflows/steps/pause-subscription.ts:59` (source of `asSubscriptionUpdateInput`)
- Modify: `src/modules/subscription/utils/native-mirror-sync.ts:89,120`
- Modify: other importers of `asSubscriptionUpdateInput` (`grep -rn asSubscriptionUpdateInput src/`)

**Interfaces:**
- Consumes: the current `asSubscriptionUpdateInput` body (moved verbatim).
- Produces: `asSubscriptionUpdateInput(input: SubscriptionWriteInput): Parameters<SubscriptionModuleService["updateSubscriptions"]>[0]` importable from **both** `src/modules/**` and `src/workflows/**` without a layering violation.

- [ ] **Step 1: Move it, keep the behaviour identical**

```bash
git mv  # not applicable — copy the function into the new module file, then
grep -rn "asSubscriptionUpdateInput" src/ | sed 's/:.*//' | sort -u
```

Update every import to the new module path and delete the copy in `pause-subscription.ts`.

- [ ] **Step 2: Drop the mirror's casts**

In `native-mirror-sync.ts`, remove `} as never)` at `:89` and `(update as never)` at `:120`, passing plain objects instead.

- [ ] **Step 3: Typecheck is the gate**

```bash
corepack yarn build
```

Expected: exit 0. If it errors, the moved signature is too narrow for a caller — widen the input type (a domain type alias), **do not** reintroduce a cast. Record in the commit body which fields forced the widening.

- [ ] **Step 4: Probe**

Rename one property in `SubscriptionWriteInput` so a call site stops matching, confirm `yarn build` exits 1 with that file named, restore. This proves the cast removal bought something.

- [ ] **Step 5: Commit**

```bash
git add src/modules/subscription src/workflows
git commit -m "refactor(subscription): share one typed write boundary and drop the mirror casts"
```

---

### Task 12: Stop telling the wrong reason for a vanished customer

**Files:**
- Modify: `src/modules/redemption/utils/errors.ts`
- Modify: `src/workflows/steps/redeem-redemption-code.ts:169`
- Modify: `src/workflows/redeem-redemption-code.ts` (`REDEEM_CUSTOMER_REFUSALS`)
- Modify: `src/modules/redemption/__tests__/*` (a case for the factory)
- Modify: `CHANGELOG.md`, `docs/api/saas-bridge.md`

**Interfaces:**
- Consumes: `redemptionErrors` factories.
- Produces: `redemptionErrors.customerNotFound(id: string): RedemptionError` → `not_found`, `Redemption customer ${id} not found`; and a matching `{ step: RESOLVE_CODE_STEP, type: NOT_FOUND, copy: /^Redemption customer \S+ not found$/ }` entry.

- [ ] **Step 1: Write the failing factory test**

```typescript
it("names the missing customer, not a variant", () => {
  const error = redemptionErrors.customerNotFound("cus_gone")
  expect(error.type).toBe("not_found")
  expect(error.message).toBe("Redemption customer cus_gone not found")
})
```

- [ ] **Step 2: Run to see it fail** — `corepack yarn jest src/modules/redemption --forceExit`; expect `customerNotFound is not a function`.

- [ ] **Step 3: Implement the factory and switch the throw site**

At `src/workflows/steps/redeem-redemption-code.ts:169` replace
`throw redemptionErrors.noMatchingSubscription(batch.variant_id)` with
`throw redemptionErrors.customerNotFound(input.customer_id)` **only on the branch
where the customer row is absent** — read the surrounding `if` first; the sibling
uses of `noMatchingSubscription` that genuinely mean "no subscription for this
variant" stay as they are. List the branch conditions in the commit body.

- [ ] **Step 4: Declare it and pin the disclosure**

Add the whitelist entry above, then add to `integration-tests/http/saas-bridge.spec.ts` a case: redeeming for a customer id that does not exist answers **404** with `Redemption customer …  not found` and no variant id in the body.

- [ ] **Step 5: Docs, gates, commit**

`CHANGELOG.md` under `[1.6.0]` Fixes: one line, since a bridge-visible message changed.

```bash
corepack yarn build && TEST_TYPE=integration:modules NODE_OPTIONS=--experimental-vm-modules corepack yarn jest --forceExit
git add src/modules/redemption src/workflows integration-tests CHANGELOG.md docs/api/saas-bridge.md
git commit -m "fix(redemption): report a vanished customer as itself"
```

---

### Task 13: The last mode writer joins the pair helper

**Files:**
- Modify: `src/workflows/steps/redeem-redemption-code.ts:287-296`

**Interfaces:**
- Consumes: `buildPaymentModeFields` (`src/workflows/utils/payment-mode-mechanism.ts:44-51`).
- Produces: `REDEMPTION_PAYMENT_CONTEXT` carrying `payment_mode: "auto"` **and** `mechanism: "reorder_auto"`.

- [ ] **Step 1: State the consequence before doing it**

`payment_context.mechanism` is an annotation only — chargeability reads `payment_mode`, native detection reads `reference` (`docs/architecture/payments.md`, *mechanism is not a predicate*). Confirm no query filters on `mechanism` (read `scheduler-query.ts` + `grep -rn "mechanism" src/ --include=*.ts | grep -v "types\|\.md"`); paste the grep result into the commit body.

- [ ] **Step 2: Make the change**

```typescript
const REDEMPTION_PAYMENT_CONTEXT: SubscriptionPaymentContext = {
  ...buildPaymentModeFields("auto"),
  payment_provider_id: null,
  source_payment_collection_id: null,
  source_payment_session_id: null,
  payment_method_reference: null,
  customer_payment_reference: null,
}
```

Keep the explanatory comment about why `auto` is correct for free cycles. If the type has no `mechanism` member, that is Task 11's boundary widening — do it properly, not with a cast.

- [ ] **Step 3: Assert it through the existing redemption create path**

In `integration-tests/http/redemptions-store-flow.spec.ts`, extend the create-path expectation with `mechanism: "reorder_auto"` on the new row's `payment_context`, and confirm the extension path still writes no `payment_context` at all (`:502-513`).

- [ ] **Step 4: Build, focused http run, commit**

```bash
git add src/workflows/steps/redeem-redemption-code.ts integration-tests/http/redemptions-store-flow.spec.ts
git commit -m "fix(redemption): write the redemption mode together with its mechanism"
```

---

### Task 14: Serialize the auto-renew toggle like its siblings

**Files:**
- Modify: `src/workflows/set-subscription-auto-renew.ts`
- Modify: `docs/architecture/subscriptions.md`, `docs/api/saas-bridge.md`

**Interfaces:**
- Consumes: `acquireLockStep` / `releaseLockStep` as used in `create-manual-renewal.ts` and `redeem-redemption-code.ts` (copy their `transform` + `.config` shape).
- Produces: lock key `auto-renew:<subscription_id>` held for the whole run.

- [ ] **Step 1: Match the siblings' arguments exactly**

```bash
grep -n "acquireLockStep" -A 8 src/workflows/create-manual-renewal.ts | head -20
```

then add to the auto-renew workflow, before the native guard:

```typescript
    const lockInput = transform({ input }, ({ input }) => ({
      key: `auto-renew:${input.subscription_id}`,
      timeout: 30,
      ttl: 120,
    }))

    acquireLockStep(lockInput)
```

- [ ] **Step 2: Assert the lock is taken, on the route level**

In `integration-tests/http/native-subscription-mirror.spec.ts`, spy the locking service as that file already does elsewhere, and assert the toggle acquires exactly one lock with the `auto-renew:` prefix and releases it. A duplicate call is a bug the test should catch — assert the count.

- [ ] **Step 3: Gates, docs, commit**

Docs: the auto-renew section gains one sentence — the toggle is serialized against other auto-renew calls on the same subscription; it is **not** serialized against the scheduler, which is still the open item in the spec's §C. Saying that is required; writing "race-free" is the intended-behavior trap.

```bash
git add src/workflows/set-subscription-auto-renew.ts integration-tests/http/native-subscription-mirror.spec.ts docs
git commit -m "fix(subscription): serialize the auto-renew toggle against itself"
```

---

## Phase 4 — The retire answer

### Task 15: Let the selector name the rows it cannot adopt

**Files:**
- Modify: `src/modules/renewal/utils/upcoming-cycle.ts:39-43,223-259`
- Modify: `src/modules/renewal/__tests__/upcoming-cycle.spec.ts`

**Interfaces:**
- Consumes: `isOpenUpcomingCycle`, `hasInFlightRenewal`, `findUpcomingRenewalCycle` (all module-private already).
- Produces:

```typescript
export type UpcomingCycleResolution =
  | { action: "match"; cycle: UpcomingRenewalCycleRecord; retire: UpcomingRenewalCycleRecord[] }
  | { action: "adopt"; cycle: UpcomingRenewalCycleRecord; retire: UpcomingRenewalCycleRecord[] }
  | { action: "defer"; cycle: UpcomingRenewalCycleRecord; retire: UpcomingRenewalCycleRecord[] }
  | { action: "create" }
```

with the rule: `retire` = live `SCHEDULED` rows carrying no `generated_order_id`, excluding the chosen `cycle`. `create` carries no `retire` at all — it is reached only when no open row exists, so its set is provably empty and testing it would pin an impossibility.

- [ ] **Step 1: Write the failing cases**

```typescript
    it("names a stale live row when the entitlement date is held by a settled row", () => {
      const resolution = resolveUpcomingCycle(
        [
          cycle({ id: "rcy_done", status: RenewalCycleStatus.SUCCEEDED, scheduledFor: DATE }),
          cycle({ id: "rcy_stale", scheduledFor: earlier }),
        ],
        DATE
      )

      expect(resolution.action).toBe("match")
      expect(resolution.cycle.id).toBe("rcy_done")
      expect(resolution.retire.map((row) => row.id)).toEqual(["rcy_stale"])
    })

    it("never retires the row it matched or adopted", () => {
      const resolution = resolveUpcomingCycle(
        [cycle({ id: "rcy_a", scheduledFor: later }), cycle({ id: "rcy_b", scheduledFor: earlier })],
        later
      )
      expect(resolution.action).toBe("match")
      expect(resolution.retire).toEqual([])
    })

    it("leaves a row with an order in flight out of the retire set", () => {
      const resolution = resolveUpcomingCycle(
        [
          cycle({ id: "rcy_match", scheduledFor: DATE }),
          cycle({ id: "rcy_billed", scheduledFor: earlier, generatedOrderId: "order_1" }),
        ],
        DATE
      )
      expect(resolution.retire).toEqual([])
    })

    it("reports create without a retire set", () => {
      expect(resolveUpcomingCycle([], DATE)).toEqual({ action: "create" })
    })
```

The existing `defer` and `create` cases need `retire` added to their expectations in the same commit — `defer` now carries one, because the protected row staying put no longer means a *different* stale row is protected too.

- [ ] **Step 2: Run to see them fail** — `corepack yarn jest src/modules/renewal --forceExit`, expect `Cannot read properties of undefined (reading 'map')` on the new cases.

- [ ] **Step 3: Implement**

```typescript
function collectRetirable(cycles, chosen) {
  return cycles.filter(
    (row) =>
      row.id !== chosen?.id &&
      row.status === RenewalCycleStatus.SCHEDULED &&
      row.generated_order_id == null
  )
}
```

return it from the `match`, `adopt` and `defer` branches, update the doc block at `:200-221` (the "Pinned contract" paragraph must now say the stale neighbour is *named*, not that the constraint repairs it), and delete the sentence claiming both halves are restored by the constraint — that is what this task ends.

- [ ] **Step 4: Probe**

Drop the `generated_order_id == null` clause: the in-flight case reddens. Drop the `id !== chosen.id` clause: the "never retires the row it matched" case reddens. Restore both.

- [ ] **Step 5: Commit**

```bash
git add src/modules/renewal
git commit -m "feat(renewal): name the stale upcoming cycles a reconciliation leaves behind"
```

---

### Task 16: Act on the retire set on every path that returns early

**Files:**
- Modify: `src/workflows/steps/ensure-next-renewal-cycle.ts:28,250-360,395-470`

**Interfaces:**
- Consumes: Task 15's `retire`; `softDeleteRenewalCycles` and the generated `restoreRenewalCycles` (`@medusajs/utils/dist/modules-sdk/medusa-service.js:19,333` builds `delete/softDelete/restore` for every model).
- Produces: `retireStaleUpcomingCycles(writer, subscriptionId, retired, logger)`, output union gaining `"retired"`, and a compensation branch `retired` that restores by id.

- [ ] **Step 1: Confirm the generated restore name before writing code**

```bash
grep -rn "softDeleteRenewalCycles\|restoreRenewalCycles" src/ | head
```

Then write a one-line type-level probe in `src/modules/renewal/utils/` scratch, `corepack yarn build`, and read the compiler's suggestion list if the name differs. Use the name the compiler confirms; record it in the commit body. If no restore method exists, stop and report — the plan's assumption would be wrong and the fallback is a compensating `updateRenewalCycles` clearing `deleted_at`, which needs its own probe.

- [ ] **Step 2: Write the module-level spec for the new unit**

```typescript
// src/modules/renewal/__tests__/retire-stale-cycles.spec.ts
import { retireStaleUpcomingCycles } from "../../../workflows/steps/ensure-next-renewal-cycle"
import type { UpcomingRenewalCycleRecord } from "../utils/upcoming-cycle"

function retiredCycle(
  id: string,
  subscriptionId: string,
  scheduledFor: Date
): UpcomingRenewalCycleRecord {
  return {
    id,
    subscription_id: subscriptionId,
    scheduled_for: scheduledFor,
    status: RenewalCycleStatus.SCHEDULED,
    generated_order_id: null,
  } as UpcomingRenewalCycleRecord
}

function writer() {
  const calls: string[] = []
  const live = new Set<string>(["rcy_stale", "rcy_keeper"])
  return {
    calls,
    live: () => [...live].sort(),
    softDeleteRenewalCycles: async (ids: string[]) => {
      const list = Array.isArray(ids) ? ids : [ids]
      for (const id of list) live.delete(id)
      calls.push(`soft:${list.join("+")}`)
    },
  }
}

it("soft-deletes the stale row and warns about the row it made room for", async () => {
  const fake = writer()
  const warnings: string[] = []

  await retireStaleUpcomingCycles(
    fake,
    "sub_1",
    [
      retiredCycle("rcy_stale", "sub_1", new Date("2026-09-24T00:00:00Z")),
    ],
    { warn: (m: string) => warnings.push(m) },
    "rcy_keeper"
  )

  expect(fake.calls).toEqual(["soft:rcy_stale"])
  expect(fake.live()).toEqual(["rcy_keeper"])
  expect(warnings[0]).toContain("rcy_stale")
  expect(warnings[0]).toContain("rcy_keeper")
})

it("writes nothing when there is nothing to retire", async () => {
  const fake = writer()
  await retireStaleUpcomingCycles(fake, "sub_1", [], { warn: () => {} }, "rcy_keeper")
  expect(fake.calls).toEqual([])
})
```

- [ ] **Step 3: Implement the writer + call sites**

```typescript
export type UpcomingCycleRetireWriter = {
  softDeleteRenewalCycles: (ids: string[]) => Promise<unknown>
}

export async function retireStaleUpcomingCycles(
  writer: UpcomingCycleRetireWriter,
  subscriptionId: string,
  retired: UpcomingRenewalCycleRecord[],
  logger: { warn: (message: string) => void },
  madeRoomFor: string
): Promise<void> {
  if (!retired.length) {
    return
  }

  await writer.softDeleteRenewalCycles(retired.map((row) => row.id))

  logger.warn(
    `[reorder] retired ${retired.length} stale upcoming renewal cycle(s) of ` +
      `subscription '${subscriptionId}' (${retired.map((row) => row.id).join(", ")}) ` +
      `behind '${madeRoomFor}'`
  )
}
```

Call it **before each return that can carry a retire set** — the `defer` branch (`:252-271`), the terminal `noop` (`:340-353`), the `updated`/`adopted` write path and the `create` path (empty there, called once for symmetry is *not* required — do not add a no-op call just to look uniform). Add the `retired` compensation branch restoring by id.

- [ ] **Step 4: Add `"retired"` to the union and to every caller's expectations**

```bash
grep -rn "action: \"noop\"\|action: \"created\"" integration-tests/http/*.spec.ts | head
```

The output is additive: existing expectations keep passing. Assert `"retired"` only where a retire happened.

- [ ] **Step 5: Probe**

Remove the `defer`-branch call: the end-to-end case in Task 17 for "in-flight row plus stale neighbour" reddens. Remove the soft-delete inside the helper: the warning-only expectations stay green while the live-row assertion reddens — that pair (log says retired, row still live) is the regression this task exists to prevent. Restore both.

- [ ] **Step 6: Commit**

```bash
git add src/workflows/steps/ensure-next-renewal-cycle.ts src/modules/renewal/__tests__/retire-stale-cycles.spec.ts
git commit -m "feat(renewal): retire the stale upcoming cycle a reconciliation leaves chargeable"
```

---

### Task 17: Prove it end-to-end where the rows can exist

**Files:**
- Modify: `integration-tests/http/subscription-from-order.spec.ts`
- Modify: `integration-tests/http/migrations.spec.ts`

**Interfaces:**
- Consumes: `ensureNextRenewalCycleWorkflow`, `createRenewalCycleSeed`, `createSubscriptionSeed`, `renewalModule.listRenewalCycles`, and Task 5's `seedCycle` / `liveScheduled` / `rerunNormalize` in the harness.
- Produces: two http cases the index permits, one harness case for the drift the index forbids, and an unchanged zero-write pin at `subscription-from-order.spec.ts:810-816`.

- [ ] **Step 1: The adopt-with-nothing-to-retire case (index legal)**

A subscription whose entitlement date moved, carrying exactly one open row: the row is adopted, `retired` is empty.

```typescript
        const cyclesBefore = await captureRenewalCycleRows(container, subscription.id)
        const { value: { result } } = await ensureNextRenewalCycleWorkflow(container).run({
          input: { subscription_id: subscription.id },
        })

        expect(result).toMatchObject({ action: "adopted" })
        const cyclesAfter = await captureRenewalCycleRows(container, subscription.id)
        // one row before, one row after, same id: nothing was retired
        expect(cyclesAfter.map((row) => row.id)).toEqual(cyclesBefore.map((row) => row.id))
        expect(cyclesAfter[0].scheduled_for.toISOString()).toEqual(entitlementAt.toISOString())
```

- [ ] **Step 2: The deferred-row-plus-stale-neighbour case, seeded outside the index**

Two live `SCHEDULED` rows cannot exist while the constraint is up, so the seed drops it and puts it back — and the case asserts the constraint is live again, so a test that forgets to restore cannot pass silently:

```typescript
      it("defers the in-flight row and still retires the unrelated stale one", async () => {
        const indexName = "renewal_cycle_one_scheduled_per_subscription"
        const knex = getContainer().resolve<{ raw(sql: string): Promise<unknown> }>(
          Modules.DATA_SOURCE
        )

        try {
          await knex.raw(`drop index if exists "${indexName}"`)
          await createRenewalCycleSeed(container, {
            subscription_id: subscription.id,
            scheduled_for: staleAt,
          })
          const inFlight = await createRenewalCycleSeed(container, {
            subscription_id: subscription.id,
            scheduled_for: entitlementAt,
            generated_order_id: `order_in_flight_${Date.now()}`,
          })
          await knex.raw(
            `create unique index "${indexName}" on "renewal_cycle" ("subscription_id")
               where "status" = 'scheduled' and "deleted_at" is null`
          )
        } finally {
          // re-created here or the next case in this file passes for the wrong reason
        }

        const { value: { result } } = await ensureNextRenewalCycleWorkflow(container).run({
          input: { subscription_id: subscription.id },
        })

        expect(result).toMatchObject({ action: "deferred" })

        const live = await renewalModule.listRenewalCycles({
          subscription_id: subscription.id,
        } as never)
        // the protected row is untouched; the unrelated stale row is gone
        expect(live.map((row) => row.id).sort()).toEqual([inFlightId].sort())
      })
```

If re-creating the index inside the `finally` throws a unique violation, the step did **not** retire the stale row — that is the bug this case exists to catch, and it must be reported as a failure rather than by dropping the re-creation.

- [ ] **Step 3: The harness half — drift is legal only before the constraint**

Add to `migrations.spec.ts`, reusing Task 5's helpers:

```typescript
      it("leaves exactly one live cycle for a subscription the step then adopts onto", async () => {
        await seedSubscription(probeWrapper, "sub_retire", "2026-11-24T00:00:00Z")
        await seedCycle(probeWrapper, { id: "cyc_old", subscriptionId: "sub_retire", scheduledFor: "2026-09-24T00:00:00Z" })
        await seedCycle(probeWrapper, { id: "cyc_match", subscriptionId: "sub_retire", scheduledFor: "2026-11-24T00:00:00Z", status: "succeeded" })

        await rerunNormalize(probeWrapper)

        expect(await liveScheduled(probeWrapper, "sub_retire")).toEqual([])
      })
```

That pins the shape the step's `retire` consumes: after normalization a terminal row can sit on the entitlement date with its stale neighbour soft-deleted, and the selector reports `match` with an empty retire set — the live-stale case is reachable only where the index was dropped.

- [ ] **Step 4: Run the file and probe**

```bash
TEST_TYPE=integration:http NODE_OPTIONS="--experimental-vm-modules --max-old-space-size=4096" corepack yarn jest integration-tests/http/subscription-from-order.spec.ts integration-tests/http/migrations.spec.ts --runInBand --forceExit
```

Expected: all green, the zero-write pin included. Probe: make `retireStaleUpcomingCycles` log without deleting — Step 2's live-row expectation reddens while its `deferred` assertion stays green. Restore.

- [ ] **Step 5: Commit**

```bash
git add integration-tests
git commit -m "test(renewal): pin the retire path end to end and in the migration harness"
```

### Task 18: Say it in the documentation, in the same commit as nothing else

**Files:**
- Modify: `docs/architecture/renewals.md`, `docs/api/admin-renewals.md`, `docs/testing/renewals.md`, `CHANGELOG.md`, `docs/releases/1.6.0-host-upgrade.md`

- [ ] **Step 1: Write what changed, not what was planned**

`renewals.md`: the invariant section gains the retire paragraph, the `defer` promise narrowed to "writes nothing to the protected row", and a note that a retirement always logs. `admin-renewals.md`: the soft-deleted row's visibility in Admin lists. `testing/renewals.md`: the manual check (`select … having count(*) > 1` returns nothing after a repeat purchase) plus how to seed drift. `CHANGELOG.md` under `[1.6.0]` Fixes. Release notes: an operator-visible line — upgrading can retire a stale cycle, and it will say so in the log.

- [ ] **Step 2: No future tense**

```bash
grep -nE "will be|planned|going forward|intends" docs/architecture/renewals.md | tail
```

Any hit in the new text is a defect (`AGENTS.md`: document implemented behavior only).

- [ ] **Step 3: Commit**

```bash
git add docs CHANGELOG.md
git commit -m "docs(renewal): document the retired cycle the reconciliation now clears"
```

---

## Phase 5 — Disclosure at the read boundary

### Task 19: Enumerate the reads instead of remembering them

**Files:**
- Modify: `.agents/specs/2026-09-25-post-acceptance-backlog.md` (§D site list)

- [ ] **Step 1: Run the sweep and paste the output**

```bash
grep -rnE "await (customerModule|subscriptionModule|query)\.(retrieve|list|graph)" src/api/store/ | tee /tmp/store-reads.txt
```

Expected at minimum: `saas/auto-renew/route.ts` (subscription list + customer), `saas/renew/route.ts` (same two), `saas/redeem/route.ts` (customer), `saas/carts/route.ts:76-78` (customer + a `query.graph` region read), and the shared read in `saas/lib/tenant-ownership.ts:78` reached from `saas/reconcile/route.ts:83,205`. **Not** `src/api/store/customers/me/redemptions/route.ts` — its customer id comes from `auth_context` (`utils.ts:9-22`).

- [ ] **Step 2: Classify each hit**: pre-workflow scoping read (convert) / post-workflow response read (convert only if its failure can reach a body) / validation-only (leave). Write the table into §D.

- [ ] **Step 3: Commit the measurement**

```bash
git add .agents/specs/2026-09-25-post-acceptance-backlog.md
git commit -m "docs(spec): enumerate the store reads that can quote internals"
```

---

### Task 20: The classifier that decides what a read failure may say

**Files:**
- Create: `src/modules/subscription/utils/store-read-failure.ts`
- Create: `src/modules/subscription/__tests__/store-read-failure.spec.ts`

**Interfaces:**
- Produces:

```typescript
export type StoreReadFailureCopy = { notFound: string }
export function classifyStoreReadFailure(
  error: unknown,
  copy: StoreReadFailureCopy
): { type: string; message: string }
```

Always `MedusaError.Types.NOT_FOUND` with `copy.notFound`, whatever arrives; the raw error is the caller's to log.

- [ ] **Step 1: Write the failing spec**

```typescript
import { MedusaError } from "@medusajs/framework/utils"
import { classifyStoreReadFailure } from "../utils/store-read-failure"

const COPY = { notFound: "subscription not found" }

it("answers a driver-shaped fault with the route's own text", () => {
  const fault = new MedusaError(
    MedusaError.Types.INVALID_DATA,
    "column subscription.next_renewal__canary does not exist"
  )
  const result = classifyStoreReadFailure(fault, COPY)
  expect(result).toEqual({ type: "not_found", message: COPY.notFound })
  expect(JSON.stringify(result)).not.toContain("next_renewal__")
})

it("answers a non-MedusaError the same way, without leaking its code", () => {
  const driver = Object.assign(new Error("connection terminated"), {
    code: "57P01",
    table: "subscription_canary",
  })
  expect(classifyStoreReadFailure(driver, COPY)).toEqual({
    type: "not_found",
    message: COPY.notFound,
  })
})

it("answers undefined without inventing anything", () => {
  expect(classifyStoreReadFailure(undefined, COPY)).toEqual({
    type: "not_found",
    message: COPY.notFound,
  })
})
```

- [ ] **Step 2: Implement minimally** — a pure function, no logging, no throw.

- [ ] **Step 3: Probe**: return the incoming `message` when `__isMedusaError` is set; the first case reddens. Restore.

- [ ] **Step 4: Commit**

```bash
git add src/modules/subscription
git commit -m "feat(subscription): decide what a store read failure may disclose"
```

---

### Task 21: One wrapper at the call sites, and no restated readers

**Files:**
- Modify: `src/api/store/saas/lib/tenant-ownership.ts` (add `readTenantScoped`)
- Modify: the sites from Task 19
- Modify: every `type CustomerModule = { … }` under `src/api/store/`

**Interfaces:**
- Produces:

```typescript
export async function readTenantScoped<T>(
  logger: { error: (message: string, error?: unknown) => void },
  context: string,
  copy: { notFound: string },
  read: () => Promise<T>
): Promise<T>
```

returning the read's value, or throwing a freshly built `MedusaError(not_found, copy.notFound)` after logging the raw cause.

- [ ] **Step 1: Implement the wrapper** in `tenant-ownership.ts` delegating the decision to `classifyStoreReadFailure`.

- [ ] **Step 2: Convert the sites**, e.g.

```typescript
  const subscriptions = await readTenantScoped(
    req.scope.resolve<StepFailureLogger>(ContainerRegistrationKeys.LOGGER),
    "renew tenant check",
    RENEW_FAILURE_COPY,
    () => subscriptionModule.listSubscriptions({ id: [subscription_id] })
  )
```

A thrown "not found" from inside the wrapper replaces both the current empty-list 404 and any fault, so delete the now-unreachable `if (!customerId) throw notFound` only if the wrapper covers the same case — otherwise keep it. Prove which by asserting the existing 404 (`saas-bridge.spec.ts:889-912`) still passes.

- [ ] **Step 3: Replace the restated types**

```bash
grep -rn "type CustomerModule = {" src/api/store/ | wc -l
```

For each hit, derive from the real interface:

```typescript
import type { ICustomerModuleService } from "@medusajs/framework/types"

type CustomerModule = Pick<
  ICustomerModuleService,
  "retrieveCustomer" | "listAndCountCustomers"
>
```

(`@medusajs/types/dist/customer/service.d.ts:10` is where that interface lives.) Use whichever members each file actually calls; do not keep a private structural copy.

- [ ] **Step 4: Build and probe**

`corepack yarn build` → 0. Probe: make one wrapper call site bypass the wrapper (`read()` directly) — its canary case in Task 22 reddens. Probe the types: rename `retrieveCustomer` in a `Pick<>` and confirm the build names the file. Restore.

- [ ] **Step 5: Commit**

```bash
git add src/api/store
git commit -m "refactor(store-api): read tenant scoping through one non-disclosing wrapper"
```

---

### Task 22: Canary cases at the route level, and pin the multi-error choice

**Files:**
- Modify: `integration-tests/http/saas-bridge.spec.ts`, `native-subscription-mirror.spec.ts`, `subscriptions-workflows.spec.ts` (or the carts spec matching each route)

- [ ] **Step 1: One case per converted route**

```typescript
      it("keeps a schema fault on the pre-workflow read out of the body", async () => {
        const subscriptionModule =
          container.resolve<SubscriptionModuleService>(SUBSCRIPTION_MODULE)
        const stamp = Date.now()
        const spy = jest
          .spyOn(subscriptionModule, "listSubscriptions")
          .mockRejectedValue(
            new MedusaError(
              MedusaError.Types.INVALID_DATA,
              `column subscription.next_renewal__canary does not exist read-${stamp}`
            )
          )

        const response = await api.post(
          "/store/saas/renew",
          { subscription_id: subscriptionId },
          { headers, validateStatus: () => true }
        )
        spy.mockRestore()

        expect(response.status).toEqual(404)
        expect(String(response.data?.message)).toEqual("subscription not found")
        expect(JSON.stringify(response.data ?? {})).not.toContain(`read-${stamp}`)
      })
```

- [ ] **Step 2: The `query.graph` variant** for `saas/carts` — spy the QUERY service's `graph` with a canary message, same expectations.

- [ ] **Step 3: Pin the `errors[0]` choice** with a case where a run produces a lock fault *and* a refusal, asserting the response is the declared refusal. If reality answers with the lock fault, the spec's §D decision was wrong: report it, do not silently change the assertion.

- [ ] **Step 4: Gates, commit**

```bash
corepack yarn build && corepack yarn test:integration:http
git add integration-tests
git commit -m "test(store-api): pin that read faults never reach the customer"
```

---

### Task 23: Documentation and the public site

**Files:**
- Modify: `docs/api/saas-bridge.md`, `docs/api/store-redemptions.md`, `docs/architecture/subscriptions.md`, `src/api/README.md`, `docs/releases/1.6.0-host-upgrade.md`

- [ ] **Step 1: Narrow the boundary claims to what the code now does** — the previous round's "no internal text from a failed workflow" line must state that scoping reads are covered as of this change and say what is still core's error path (admin routes, non-tenant reads).

- [ ] **Step 2: `src/api/README.md`**: the wrapper is what new store routes should use; one paragraph, implemented behavior.

- [ ] **Step 3: Ask the user about Mintlify** (`AGENTS.md`: after pushing, always ask whether the public docs need syncing; `sync-docs` skill). Record the answer here even if it is "no".

- [ ] **Step 4: Commit**

```bash
git add docs src/api/README.md
git commit -m "docs(store-api): describe the read boundary that now exists"
```

---

## Phase 6 — Deploy it

### Task 24: Find out where the image is built, and write the runbook

**Files:**
- Modify: `docs/releases/1.6.0-host-upgrade.md` (a *Production rehearsal* section — the runbook lives here, tracked; see `lessons.md:99`)

- [ ] **Step 1: Trace the image on the box (read-only)**

```bash
ssh ubuntu@170.106.132.210 'docker history --no-trunc medusa-saas-backend:0.4.14 | head -25; docker inspect medusa-prod-store-1 --format "{{json .Config.Env}}" | tr "," "\n" | grep -iE "reorder|node_env" | head'
```

Expected: `RUN` layers naming a `package.json`/`pnpm install`, which identify the build context. If the layers reference a path that does not exist on this box, the image is built elsewhere — **stop and ask the user where**, since the registry credential belongs in that build, not on the host.

- [ ] **Step 2: Record the three facts** (build host; where `pnpm install` runs; whether `medusa migrate` runs at container start or by hand) and state explicitly: prod currently contains **no `@mengyyy369/*` package** (`ls /app/node_modules/@mengyyy369` → absent), so this is a first install, not an upgrade, and the normalize/retire paths will not execute there.

- [ ] **Step 3: Write the runbook steps in order** with the commands you will actually run, the two invariant queries, and the money-unit stop point. No step may be "then verify it works".

- [ ] **Step 4: Commit**

```bash
git add docs/releases/1.6.0-host-upgrade.md .agents/specs/2026-09-25-post-acceptance-backlog.md
git commit -m "docs(release): record how the production image is built before touching it"
```

---

### Task 25: Rehearse the install on a scratch copy of the live database

**Files:**
- Modify: `docs/releases/1.6.0-host-upgrade.md` (rehearsal results)

- [ ] **Step 1: Dump and validate**

```bash
ssh ubuntu@170.106.132.210 'sudo -n docker exec medusa-prod-db-1 pg_dump -U user -Fc medusa > /tmp/prod-pre-1.6.0.dump && ls -l /tmp/prod-pre-1.6.0.dump'
```

(If sudo needs a password, ask the user to run the command — do not cache credentials.)

- [ ] **Step 2: Restore into a scratch database and boot the plugin against it**

```bash
ssh ubuntu@170.106.132.210 'sudo -n docker exec medusa-prod-db-1 createdb -U user medusa_rehearsal && sudo -n docker exec medusa-prod-db-1 pg_restore -U user -d medusa_rehearsal /tmp/prod-pre-1.6.0.dump'
```

Then run the new backend against `medusa_rehearsal` only. **Never** point it at the live database name.

- [ ] **Step 3: Assert**

```sql
select indexname from pg_indexes where indexname = 'renewal_cycle_one_scheduled_per_subscription';
select subscription_id, count(*) from renewal_cycle
 where status = 'scheduled' and deleted_at is null
 group by subscription_id having count(*) > 1;
```

Expected: one row, zero rows. Record the migration list applied.

- [ ] **Step 4: Write the results into the runbook and commit.**

---

### Task 26: First install on production, with the user watching

**Files:** none (operational)

- [ ] **Step 1: Confirm the preconditions** — one Medusa store running (`docker ps` shows exactly one of `medusa-dtc-store-1` / `medusa-prod-store-1` after scaling dtc down), validated dump, rehearsed restore, and the money-unit answer from Task 27.

- [ ] **Step 2: Install, migrate, restart**, using the commands from Task 24's runbook, and capture output.

- [ ] **Step 3: Assert the two invariant queries** from Task 25 Step 3 plus the endpoint smoke list, including at least one **failure** path per changed contract.

- [ ] **Step 4: Record** what ran and what returned in the runbook; commit. A rehearsal that was not written down did not happen.

---

### Task 27: The money-unit stop point

- [ ] **Step 1: Ask the user, with the evidence**: does `medusa-paypal` and the host's own money basis move in this same window? Half-switching is the shape of the previous hundred-fold incident. Do not proceed with any data migration until this is answered in writing.
- [ ] **Step 2: Record the decision and its date** in the runbook; commit.

---

## Final Checklist

- [ ] `corepack yarn build` → 0
- [ ] modules gate: suite/test totals stated, reconciled against the Appendix baseline, every delta explained by name
- [ ] http gate: union of runs, 0 failing assertions, killed suites re-run in isolation
- [ ] every mutation probe run, its red output captured, and the restoration confirmed (diff-clean)
- [ ] every doc row the router table demands, changed in the same commit as the behavior
- [ ] one commit per task, explicit paths, messages in Conventional Commits
- [ ] `v1.6.x` release decision recorded (published `1.6.0` cannot be replaced)
