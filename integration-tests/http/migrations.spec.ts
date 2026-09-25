import { medusaIntegrationTestRunner } from "@medusajs/test-utils"
import {
  dbTestUtilFactory,
  getDatabaseURL,
  getMikroOrmConfig,
  getMikroOrmWrapper,
} from "@medusajs/test-utils/dist/database"
import type { TestDatabase } from "@medusajs/test-utils/dist/database"
import { MikroORM } from "@medusajs/framework/mikro-orm/postgresql"
import {
  ContainerRegistrationKeys,
  loadModels,
  toMikroOrmEntities,
} from "@medusajs/framework/utils"
import fs from "fs"
import path from "path"

/**
 * Migration coverage lives in this suite and not in `test:integration:modules`
 * because that gate passes no `pathToMigrations`, so `@medusajs/test-utils`
 * falls through to `orm.schema.refreshDatabase()` and no migration ever runs
 * there. The http runner does run them
 * (`medusa-test-runner.js` -> `migrateDatabase` -> `runModulesMigrations`), which
 * is what the app-side comparison below reads.
 */

/** One row as it comes back from a raw select. */
type ProbeRow = Record<string, unknown>

/**
 * A probe wrapper whose `setupDatabase()` has resolved. The real `TestDatabase`
 * types `orm` and `manager` as null until then, and every case here needs them,
 * so `migrateProbe` narrows once and the cases read `wrapper.manager.execute`.
 * `mikroOrmEntities` is dropped from the view because the cases never touch it.
 */
type ProbeWrapper = Omit<TestDatabase, "orm" | "manager" | "mikroOrmEntities"> & {
  orm: NonNullable<TestDatabase["orm"]>
  manager: NonNullable<TestDatabase["manager"]>
}

/**
 * The migrator surface the cases use. `getPendingMigrations()` resolves to umzug
 * entries — `{ name, path? }`; MikroORM 6.6 has no `label` on them.
 */
type ProbeMigrator = {
  getPendingMigrations(): Promise<Array<{ name: string; path?: string }>>
  up(options: { migrations: string[] }): Promise<unknown>
  down(options: { migrations: string[] }): Promise<unknown>
}

/** A created probe database plus the only teardown it needs. */
type ProbeDatabase = {
  readonly name: string
  drop(): Promise<void>
}

/**
 * The subset of `dbTestUtilFactory()`'s untyped return the probe lifecycle uses.
 * There is no `delete` and no `execute` on it: the probe database is dropped with
 * `shutdown(name)`, and raw SQL goes through the wrapper's manager.
 */
type DbTestUtil = {
  create(dbName: string): Promise<void>
  shutdown(dbName: string): Promise<void>
}

/**
 * The app's own database handle. Medusa registers the suite connection as a knex
 * instance; only `raw` is used, and knex for postgres resolves a select to an
 * envelope object rather than the bare array the MikroORM manager returns.
 */
type PgConnectionHandle = {
  raw(sql: string): Promise<unknown>
}

const MODULES_ROOT = path.resolve(__dirname, "../..", "src/modules")

/**
 * The module directories the probe migrates, in apply order. All of them share
 * one `mikro_orm_migrations` table, so the order of this list IS the order the
 * migrations run.
 */
const MIGRATION_PATHS: string[] = [
  "activity-log",
  "analytics",
  "cancellation",
  "dunning",
  "plan-offer",
  "redemption",
  "renewal",
  "settings",
  "subscription",
].map((moduleName) => migrationDirOf(moduleName))

const PROBE_DB_NAME = "reorder_migrations_probe"
const PROBE_SCHEMA = "public"

/**
 * The 1.6.0 uniqueness migration whose survivor decision the normalize cases
 * below pin, and the partial unique index it ends by creating. Both are named
 * once here because the helpers have to address each of them separately: the
 * migration is re-applied by name, and the index has to come down before a
 * drifted pair is insertable at all.
 */
const NORMALIZE_MIGRATION = "Migration20260924120000"
const UPCOMING_CYCLE_INDEX = "renewal_cycle_one_scheduled_per_subscription"

/** The note `up()` writes onto every row it soft-deletes. */
const NORMALIZED_NOTE =
  "normalized: duplicate upcoming cycle removed by the 1.6.0 uniqueness migration"

/**
 * The measured migration inventory: 22 migrations across the 9 module
 * directories that ship them (`saas-bridge` ships none). A floor like "more than
 * 20" would still pass if three directories were skipped, so the cases compare
 * against the exact set discovered on disk instead.
 */
const EXPECTED_MIGRATION_COUNT = 22

function migrationDirOf(moduleName: string): string {
  return path.join(MODULES_ROOT, moduleName, "migrations")
}

/** Module directories that actually contain a `migrations` folder, sorted. */
function migrationDirsOnDisk(): string[] {
  return fs
    .readdirSync(MODULES_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => migrationDirOf(entry.name))
    .filter((dir) => fs.existsSync(dir))
    .sort()
}

/**
 * Extensions MikroORM's own migration glob — `!(*.d).{js,ts,cjs}` — treats as a
 * migration, declaration files excluded.
 */
const MIGRATION_FILE_EXTENSIONS = [".ts", ".js", ".cjs"]

/**
 * The migration files one directory ships, picked the way MikroORM picks them.
 * Kept separate from `migrationNamesIn` so the `.ts`-only assumption below has
 * something to assert against.
 */
function migrationFilesIn(migrationDirPath: string): string[] {
  return fs
    .readdirSync(migrationDirPath)
    .filter((file) => !file.endsWith(".d.ts"))
    .filter((file) => MIGRATION_FILE_EXTENSIONS.some((ext) => file.endsWith(ext)))
}

/**
 * The migration names one directory ships. `mikro_orm_migrations` stores them with
 * the extension stripped (`Migration20260924120000`, not `...ts`), so the on-disk
 * names are normalised the same way here before being compared.
 *
 * This strips whichever extension the file carries, which is what MikroORM's
 * storage does for `.ts` and `.js`; a `.cjs` migration would NOT be stripped by
 * the storage, and the first case pins that no such file exists.
 */
function migrationNamesIn(migrationDirPath: string): string[] {
  return migrationFilesIn(migrationDirPath).map((file) =>
    path.basename(file, path.extname(file))
  )
}

/** Every migration name the plugin ships, across every module that has them. */
function expectedMigrationNames(): string[] {
  return migrationDirsOnDisk()
    .flatMap((dir) => migrationNamesIn(dir))
    .sort()
}

/**
 * Fails on a migration directory that is not there. This is not decoration:
 * MikroORM treats a missing migrations directory as "no migrations", applies
 * nothing, AND creates the directory in the source tree on the way. Without this
 * check a mistyped path in a later case surfaces as a data-shaping assertion far
 * from its cause, plus a stray empty module directory left in `src/`.
 */
function assertMigrationDir(migrationDirPath: string): void {
  if (!fs.existsSync(migrationDirPath)) {
    throw new Error(`no migrations directory to migrate from: ${migrationDirPath}`)
  }
}

/**
 * The single place a probe wrapper is constructed. Task 6 rebuilds the same
 * wrapper over one migration directory, so nothing may call `getMikroOrmWrapper`
 * inline.
 *
 * Two facts about `setupDatabase()` shape the contract here, and both come from
 * `@medusajs/test-utils/dist/database`:
 *  - With MORE THAN ONE path it runs each directory through `runMigrationsFromPath`
 *    in list order and returns early, so the entity-derived
 *    `orm.schema.refreshDatabase()` is never reached. That is what makes a probe
 *    database observable at all.
 *  - With EXACTLY ONE path the early return is skipped: pending migrations are
 *    applied when there are any, and when there are NONE the wrapper regenerates
 *    the schema from entities instead. Therefore a single-entry list is only ever
 *    safe over a database created seconds ago; calling `setupDatabase()` again on
 *    an already-migrated database would destroy the rows the cases seeded. Never
 *    do that.
 *
 * The wrapper's own `orm.getMigrator()` only sees `MIGRATION_PATHS[0]`, which is
 * why re-running or reverting one module's migrations goes through
 * `withMigratorFor` rather than the wrapper.
 */
function getProbeWrapperFor(
  dbName: string,
  migrationPaths: string[]
): TestDatabase {
  migrationPaths.forEach(assertMigrationDir)

  const entities = toMikroOrmEntities(
    migrationPaths.flatMap((dir) => {
      const modelsDir = path.join(path.dirname(dir), "models")
      return loadModels(modelsDir)
    })
  )

  return getMikroOrmWrapper({
    mikroOrmEntities: entities,
    pathToMigrations: migrationPaths,
    clientUrl: getDatabaseURL(dbName),
    schema: PROBE_SCHEMA,
  })
}

/**
 * Creates a probe database. The role behind `DB_*` must hold `CREATE DATABASE`;
 * if it does not, this rejects and the suite must report it rather than fall back
 * to the suite's own database.
 *
 * The drop BEFORE the create is not hygiene, it is what the harness proves.
 * `dbTestUtilFactory().create` runs `createDatabase({ errorIfExist: false })`,
 * which swallows the `42P04` duplicate-database error and answers success over a
 * database this process never migrated (`database.js:187` ->
 * `medusa-test-runner-utils/postgres-template.js:158-181`). `afterAll` only runs
 * if the worker survives it, and `.agents/AGENTS.md` records that the http gate
 * loses ~2 suites per run to OS-killed workers, so a leaked
 * `reorder_migrations_probe` is the expected shape of a re-run rather than an
 * exotic one — and the inventory and applied-migration comparisons would then be
 * reading a schema some earlier process built. `shutdown` drops with
 * `errorIfNonExist: false` and terminates stale connections first
 * (`database.js:282-300`, `postgres-template.js:184-201`), so calling it over a
 * name that does not exist is free.
 */
async function probeDatabase(name: string): Promise<ProbeDatabase> {
  const dbUtils: DbTestUtil = dbTestUtilFactory()
  await dbUtils.shutdown(name)
  await dbUtils.create(name)

  return {
    name,
    drop: async () => {
      await dbUtils.shutdown(name)
    },
  }
}

/** Builds the wrapper for `db` and applies `migrationPaths` to it, in list order. */
async function migrateProbe(
  db: ProbeDatabase,
  migrationPaths: string[]
): Promise<ProbeWrapper> {
  const wrapper = getProbeWrapperFor(db.name, migrationPaths)
  await wrapper.setupDatabase()

  const { orm, manager } = wrapper
  if (orm === null || manager === null) {
    throw new Error(
      `setupDatabase() left the probe ${orm === null ? "orm" : "manager"} unconfigured`
    )
  }

  return wrapper as ProbeWrapper
}

/** Raw select over a probe wrapper, narrowed to rows. */
async function probeQuery(
  wrapper: ProbeWrapper,
  sql: string
): Promise<ProbeRow[]> {
  return readRows(await wrapper.manager.execute(sql))
}

/**
 * Runs `use` against a migrator bound to ONE directory over ONE probe database,
 * built the same way `runMigrationsFromPath` builds its own: `getMikroOrmConfig`
 * plus `MikroORM.init` with `discovery.warnWhenNoEntities` (needed because the
 * migrator is constructed with no entities), and `CustomDBMigrator` comes along
 * because `getMikroOrmConfig` registers it — so this is the same entry point
 * `medusa migrate` uses, not a `migrationsList` shortcut. Closed in `finally`.
 */
async function withMigratorFor<T>(
  dbName: string,
  migrationDirPath: string,
  use: (migrator: ProbeMigrator) => Promise<T>
): Promise<T> {
  // `assertMigrationDir` covers the silent no-op here too: this migrator is built
  // over one directory the caller names, so a wrong path must say so rather than
  // report "nothing pending".
  assertMigrationDir(migrationDirPath)

  const orm = await MikroORM.init({
    ...getMikroOrmConfig({
      mikroOrmEntities: [],
      pathToMigrations: migrationDirPath,
      clientUrl: getDatabaseURL(dbName),
      schema: PROBE_SCHEMA,
    }),
    discovery: { warnWhenNoEntities: false },
  })

  try {
    return await use(orm.getMigrator())
  } finally {
    await orm.close()
  }
}

/**
 * Reads a select's rows out of the MikroORM manager.
 *
 * There are two readers because there are two drivers, and each one asserts the
 * SINGLE shape its own driver returns:
 *  - `manager.execute(select)` runs with MikroORM's default `all` method, which
 *    `PostgreSqlConnection.transformRawResult` resolves to the bare row ARRAY.
 *  - `knex.raw(select)` — the app's own connection — resolves to an ENVELOPE
 *    object carrying `rows`.
 * Neither is a fallback for the other: an `A ?? B` union of the two would read
 * `undefined` off the wrong driver and pass a comparison against an empty set. If
 * either driver ever changes shape, its reader throws and names the driver.
 */
function readRows(result: unknown): ProbeRow[] {
  if (!Array.isArray(result)) {
    throw new TypeError(
      "MikroORM manager.execute() did not resolve to a row array; check the query method default"
    )
  }

  return result.filter(
    (row): row is ProbeRow => typeof row === "object" && row !== null
  )
}

/** The knex half of the pair documented above: the envelope around the same select. */
function readRowsFromRaw(result: unknown): ProbeRow[] {
  const rows = (result as { rows?: unknown }).rows

  if (!Array.isArray(rows)) {
    throw new TypeError(
      "knex raw() did not resolve to an object carrying a rows array"
    )
  }

  return rows.filter(
    (row): row is ProbeRow => typeof row === "object" && row !== null
  )
}

function migrationNames(rows: ProbeRow[]): string[] {
  return rows.map((row) => String(row.name)).sort()
}

/**
 * The columns a `subscription` row needs in order to exist at all: the table
 * declares `product_snapshot` and `shipping_address` as `jsonb not null` with no
 * default, and `frequency_interval` / `frequency_value` / `started_at` are what
 * the interval columns are actually called (`interval` / `interval_count` /
 * `currency_code` do not exist on this table). `reference` carries a partial
 * unique index, so it is derived from the id.
 */
async function seedSubscription(
  wrapper: ProbeWrapper,
  id: string,
  nextRenewalAt: string
): Promise<void> {
  await wrapper.manager.execute(
    `insert into subscription (id, reference, customer_id, product_id, variant_id,
        status, frequency_interval, frequency_value, started_at, next_renewal_at,
        product_snapshot, shipping_address, created_at, updated_at)
     values ('${id}', 'REF-${id}', 'cus_probe', 'prod_probe', 'variant_probe',
        'active', 'month', 1, now(), '${nextRenewalAt}',
        '{"id":"${id}"}'::jsonb, '{}'::jsonb, now(), now())`
  )
}

/**
 * One `renewal_cycle` row. `status` is a checked text column
 * (`scheduled|processing|succeeded|failed`), and `deleted_at` is only listed when
 * the caller wants a pre-tombstoned row — listing it with a null binding would
 * make the seed say something the migration does not read.
 */
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
): Promise<void> {
  await wrapper.manager.execute(
    `insert into renewal_cycle (id, subscription_id, scheduled_for, status,
        approval_required, attempt_count, created_at, updated_at
        ${deletedAt ? ", deleted_at" : ""})
     values ('${id}', '${subscriptionId}', '${scheduledFor}', '${status}',
        false, 0, now(), now()
        ${deletedAt ? `, '${deletedAt}'` : ""})`
  )
}

/** The ids of the cycles a subscription can still be charged on. */
async function liveScheduled(
  wrapper: ProbeWrapper,
  subscriptionId: string
): Promise<string[]> {
  const rows = await probeQuery(
    wrapper,
    `select id from renewal_cycle
      where subscription_id = '${subscriptionId}'
        and status = 'scheduled' and deleted_at is null
      order by id`
  )

  return rows.map((row) => String(row.id)).sort()
}

/**
 * Puts the database back into the state a host upgrade arrives in: the 1.6.0
 * constraint not yet there, and the 1.6.0 migration not yet recorded.
 *
 * This runs BEFORE the duplicates are seeded, and that order is the part a later
 * reader is most likely to try to change. `up()` ends by creating
 * `renewal_cycle_one_scheduled_per_subscription`, a partial unique index over
 * `subscription_id` for live `scheduled` rows — so while the probe sits at the
 * post-1.6.0 state the second insert of a duplicate pair is rejected by the very
 * constraint this migration installs, and the case fails on its own seed instead
 * of on the migration's decision.
 */
async function openDriftWindow(wrapper: ProbeWrapper): Promise<void> {
  await wrapper.manager.execute(`drop index if exists "${UPCOMING_CYCLE_INDEX}"`)
  await wrapper.manager.execute(
    `delete from mikro_orm_migrations where name = '${NORMALIZE_MIGRATION}'`
  )
}

/**
 * Re-applies `Migration20260924120000` to `dbName` and proves it ran.
 *
 * The migrator is bound to the renewal directory through `withMigratorFor`,
 * because the shared wrapper's own `orm.getMigrator()` is configured with
 * `pathToMigrations: migrationPaths[0]` — the activity-log directory
 * (`database.js:100-112`) — and cannot see this migration at all. Nothing here
 * calls `setupDatabase()`: with nothing pending that falls through to
 * `orm.schema.refreshDatabase()` and regenerates the schema from the entities,
 * destroying the seeded rows (`database.js:130-140`).
 *
 * Both guards are load-bearing. umzug's `up({ migrations })` selects from the
 * PENDING set only (`umzug/lib/umzug.js:136-160`), so a migration still recorded
 * in `mikro_orm_migrations` is skipped with no error and no output — which would
 * leave every normalize case below asserting against rows the migration never
 * touched. The first guard catches a missing drift window, the second catches the
 * apply itself going silent.
 */
async function rerunNormalize(
  dbName: string,
  wrapper: ProbeWrapper
): Promise<void> {
  await withMigratorFor(dbName, migrationDirOf("renewal"), async (migrator) => {
    const pending = (await migrator.getPendingMigrations()).map(
      (entry) => entry.name
    )

    if (!pending.includes(NORMALIZE_MIGRATION)) {
      throw new Error(
        `${NORMALIZE_MIGRATION} is not pending in ${dbName} (pending: ${
          pending.join(", ") || "none"
        }); open the drift window before re-running it`
      )
    }

    await migrator.up({ migrations: [NORMALIZE_MIGRATION] })
  })

  const recorded = await probeQuery(
    wrapper,
    `select name from mikro_orm_migrations where name = '${NORMALIZE_MIGRATION}'`
  )

  if (recorded.length !== 1) {
    throw new Error(
      `${NORMALIZE_MIGRATION} did not re-apply itself to ${dbName}: ` +
        "mikro_orm_migrations has no row for it, so the normalization below proves nothing"
    )
  }
}

/** The row one of the seeded cycles came back as, by id. */
function rowById(rows: ProbeRow[], id: string): ProbeRow {
  const row = rows.find((candidate) => String(candidate.id) === id)
  if (row === undefined) {
    throw new Error(`no renewal_cycle row came back for ${id}`)
  }

  return row
}

/**
 * What the migration left on one cycle: its note and its tombstone.
 *
 * `deleted_at` is rendered with `to_char` rather than returned raw because a
 * timestamptz comes back as a `Date`, and `toEqual` against the ISO string the
 * seed wrote would then fail on the shape of the driver rather than on the data
 * — which is the wrong thing for a tombstone assertion to report.
 */
async function cycleTombstone(
  wrapper: ProbeWrapper,
  id: string
): Promise<ProbeRow> {
  return rowById(
    await probeQuery(
      wrapper,
      `select id, last_error,
          to_char(deleted_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as deleted_at
         from renewal_cycle where id = '${id}'`
    ),
    id
  )
}

medusaIntegrationTestRunner({
  medusaConfigFile: path.resolve(process.cwd(), "integration-tests"),
  env: { JWT_SECRET: "supersecret", COOKIE_SECRET: "supersecret" },
  testSuite: ({ getContainer }) => {
    describe("plugin migrations", () => {
      let probe!: ProbeDatabase
      let probeWrapper!: ProbeWrapper

      beforeAll(async () => {
        probe = await probeDatabase(PROBE_DB_NAME)
        probeWrapper = await migrateProbe(probe, MIGRATION_PATHS)
      })

      afterAll(async () => {
        // Either is unset when `beforeAll` itself rejected, and the runner's own
        // cleanup drops the suite database but never this one. The `finally` is
        // the point: a rejected `close()` must not be able to skip the drop and
        // hand the next run a database this one never migrated.
        try {
          await probeWrapper?.orm.close()
        } finally {
          await probe?.drop()
        }
      })

      it("migrates every module directory the plugin ships", async () => {
        expect(MIGRATION_PATHS.slice().sort()).toEqual(migrationDirsOnDisk())
        expect(expectedMigrationNames()).toHaveLength(EXPECTED_MIGRATION_COUNT)
        // `migrationNamesIn` derives the expected set by stripping an extension,
        // which is what the migration storage does to a `.ts` or `.js` name. Pinned
        // here because the harness reads `.ts` filenames: a `.cjs` or `.js`
        // migration would otherwise be a naming mismatch it never notices, and a
        // false pass on exactly the inventory this case exists to guard.
        expect(
          migrationDirsOnDisk()
            .flatMap((dir) => migrationFilesIn(dir))
            .filter((file) => !file.endsWith(".ts"))
        ).toEqual([])
      })

      it("reaches the migration state of one module directory", async () => {
        // A one-entry list takes the other branch of `setupDatabase()`: the
        // migrations are applied by name, which only holds because this database
        // was created moments ago and so has pending ones. Re-running
        // `setupDatabase()` over an already-migrated database is not allowed here
        // at all — with nothing pending that branch regenerates the schema from
        // the entities and would wipe the seeded rows.
        const soloName = `${PROBE_DB_NAME}_renewal_only`
        const solo = await probeDatabase(soloName)
        let soloWrapper: ProbeWrapper | undefined

        try {
          soloWrapper = await migrateProbe(solo, [migrationDirOf("renewal")])

          expect(
            migrationNames(
              await probeQuery(
                soloWrapper,
                `select name from mikro_orm_migrations order by id`
              )
            )
          ).toEqual(migrationNamesIn(migrationDirOf("renewal")).sort())

          // Bound to one directory AND to this database: a migrator built over a
          // different module sees that module's migrations as still pending, which
          // is what the re-run and revert cases in this phase rely on.
          const pendingForActivityLog = await withMigratorFor(
            soloName,
            migrationDirOf("activity-log"),
            (migrator) => migrator.getPendingMigrations()
          )

          expect(pendingForActivityLog.map((entry) => entry.name).sort()).toEqual(
            migrationNamesIn(migrationDirOf("activity-log")).sort()
          )
        } finally {
          try {
            await soloWrapper?.orm.close()
          } finally {
            await solo.drop()
          }
        }
      })

      it("applies every migration the app bootstrap applies", async () => {
        const expected = expectedMigrationNames()

        const appRows = readRowsFromRaw(
          await getContainer()
            .resolve<PgConnectionHandle>(ContainerRegistrationKeys.PG_CONNECTION)
            .raw(`select name from mikro_orm_migrations order by id`)
        )
        // The suite database also carries Medusa's own module migrations, so the
        // app-side set is scoped to the names this plugin owns before comparing.
        const appliedByApp = migrationNames(appRows).filter((name) =>
          expected.includes(name)
        )

        const appliedByProbe = migrationNames(
          await probeQuery(
            probeWrapper,
            `select name from mikro_orm_migrations order by id`
          )
        )

        // The two sets come from two different databases: the suite one the
        // bootstrap migrated and this probe one. Their equality is the comparison
        // that says the probe reaches the state the app reaches.
        expect(appliedByProbe).toEqual(appliedByApp)
        // ...and that set is the complete on-disk inventory rather than a subset
        // of it, which is what stops a silently skipped directory passing.
        expect(appliedByApp).toEqual(expected)
      })

      /**
       * The four cases below pin the survivor decision of
       * `Migration20260924120000`, which until now had only ever been proven by
       * hand on a scratch database that no longer exists. They run against the
       * shared probe database, whose rows the runner's snapshot/restore does NOT
       * reset between cases, so every case seeds its own subscription and its own
       * `sub_t*` / `cyc_t*_<n>` ids and none of them depends on another case's
       * cleanup.
       */

      it("keeps the cycle already sitting on the entitlement date", async () => {
        await openDriftWindow(probeWrapper)
        await seedSubscription(probeWrapper, "sub_t1", "2026-11-24T00:00:00Z")
        // Deliberately the row furthest into the FUTURE and the one that is NOT
        // the entitlement date. The plan seeded this at 2026-10-24, which made it
        // the middle of the three, so both comparators in the `ORDER BY` named
        // `cyc_t1_match` and the case passed even with the entitlement tier
        // deleted out of the migration. Measured, not assumed: that version is
        // the first probe record in the commit body, and it reddens nothing.
        await seedCycle(probeWrapper, { id: "cyc_t1_stale", subscriptionId: "sub_t1", scheduledFor: "2026-12-24T00:00:00Z" })
        await seedCycle(probeWrapper, { id: "cyc_t1_match", subscriptionId: "sub_t1", scheduledFor: "2026-11-24T00:00:00Z" })
        await seedCycle(probeWrapper, { id: "cyc_t1_older", subscriptionId: "sub_t1", scheduledFor: "2026-09-24T00:00:00Z" })

        await rerunNormalize(PROBE_DB_NAME, probeWrapper)

        // The survivor is the row equal to `subscription.next_renewal_at`, which
        // is the FIRST `ORDER BY` key (`(coalesce(rc.scheduled_for =
        // sub.next_renewal_at, false)) desc`). It is not the most-future row, so
        // this is the case that dies when that tier is removed: the fallback
        // comparator alone would keep `cyc_t1_stale` and tombstone the entitlement
        // date instead, which is the money-facing half of the decision.
        expect(await liveScheduled(probeWrapper, "sub_t1")).toEqual(["cyc_t1_match"])
        // ...and both losers carry the tombstone and the note, while the survivor
        // carries neither.
        expect(
          await probeQuery(
            probeWrapper,
            `select id, last_error is not null as noted, deleted_at is not null as tombstoned
               from renewal_cycle where subscription_id = 'sub_t1' order by id`
          )
        ).toEqual([
          { id: "cyc_t1_match", noted: false, tombstoned: false },
          { id: "cyc_t1_older", noted: true, tombstoned: true },
          { id: "cyc_t1_stale", noted: true, tombstoned: true },
        ])
      })

      it("keeps the most future cycle when none matches the entitlement date", async () => {
        await openDriftWindow(probeWrapper)
        await seedSubscription(probeWrapper, "sub_t2", "2026-12-31T00:00:00Z")
        await seedCycle(probeWrapper, { id: "cyc_t2_newest", subscriptionId: "sub_t2", scheduledFor: "2026-10-24T00:00:00Z" })
        await seedCycle(probeWrapper, { id: "cyc_t2_older", subscriptionId: "sub_t2", scheduledFor: "2026-09-24T00:00:00Z" })

        await rerunNormalize(PROBE_DB_NAME, probeWrapper)

        // `sub_t2.next_renewal_at` matches neither row, so the first key is false
        // for both and the fallback comparator — `rc."scheduled_for" desc` — is
        // what decides. This and the note case at the end are the only two that
        // react to that `desc` being flipped: case 1's answer is already fixed by
        // the entitlement tier before the fallback is consulted.
        expect(await liveScheduled(probeWrapper, "sub_t2")).toEqual(["cyc_t2_newest"])
      })

      it("leaves failed and already soft-deleted duplicates alone", async () => {
        await openDriftWindow(probeWrapper)
        await seedSubscription(probeWrapper, "sub_t3", "2026-11-24T00:00:00Z")
        await seedCycle(probeWrapper, { id: "cyc_t3_failed", subscriptionId: "sub_t3", scheduledFor: "2026-08-24T00:00:00Z", status: "failed" })
        await seedCycle(probeWrapper, { id: "cyc_t3_gone", subscriptionId: "sub_t3", scheduledFor: "2026-07-24T00:00:00Z", deletedAt: "2026-07-25T00:00:00Z" })
        await seedCycle(probeWrapper, { id: "cyc_t3_live", subscriptionId: "sub_t3", scheduledFor: "2026-09-24T00:00:00Z" })

        await rerunNormalize(PROBE_DB_NAME, probeWrapper)

        // The CTE ranks only `status = 'scheduled' and deleted_at is null`, so
        // neither of these is even a candidate: `failed` is not re-touched (and
        // above all not re-armed for a charge, which is why the migration soft
        // deletes instead of marking failed), and a row tombstoned before the
        // migration keeps the tombstone it already had rather than being stamped
        // with `now()` and this migration's note.
        expect(await cycleTombstone(probeWrapper, "cyc_t3_failed")).toEqual({
          id: "cyc_t3_failed",
          last_error: null,
          deleted_at: null,
        })
        expect(await cycleTombstone(probeWrapper, "cyc_t3_gone")).toEqual({
          id: "cyc_t3_gone",
          last_error: null,
          deleted_at: "2026-07-25T00:00:00Z",
        })
        expect(await liveScheduled(probeWrapper, "sub_t3")).toEqual(["cyc_t3_live"])
      })

      it("notes why the survivors' neighbours vanished", async () => {
        await openDriftWindow(probeWrapper)
        // `2026-12-24` matches NEITHER row below. The plan used 2026-11-24 here,
        // which is exactly `cyc_t4_keep`, and then the entitlement tier — not the
        // fallback — chose the survivor, so this case could not see a change to
        // `scheduled_for desc` at all (measured: the second probe output in the
        // commit body reddens only case 2 against the plan's dates). With no
        // entitlement match in the partition, the survivor is the most-future row
        // and the note travels with whoever that comparator picks.
        await seedSubscription(probeWrapper, "sub_t4", "2026-12-24T00:00:00Z")
        await seedCycle(probeWrapper, { id: "cyc_t4_keep", subscriptionId: "sub_t4", scheduledFor: "2026-11-24T00:00:00Z" })
        await seedCycle(probeWrapper, { id: "cyc_t4_drop", subscriptionId: "sub_t4", scheduledFor: "2026-10-24T00:00:00Z" })

        await rerunNormalize(PROBE_DB_NAME, probeWrapper)

        const rows = await probeQuery(
          probeWrapper,
          `select id, last_error from renewal_cycle
            where subscription_id = 'sub_t4' order by id`
        )

        // The row the fallback removed carries the reason the merchant sees, the
        // survivor carries nothing: the note is stamped on the duplicate, not
        // written across the partition.
        expect(String(rowById(rows, "cyc_t4_drop").last_error)).toContain(
          NORMALIZED_NOTE
        )
        expect(rowById(rows, "cyc_t4_keep").last_error).toBeNull()
        // ...and it is the same row the fallback keeps, so a note that followed a
        // different survivor cannot pass either.
        expect(await liveScheduled(probeWrapper, "sub_t4")).toEqual(["cyc_t4_keep"])
      })
    })
  },
})

jest.setTimeout(180 * 1000)
