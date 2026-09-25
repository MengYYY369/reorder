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
 */
async function probeDatabase(name: string): Promise<ProbeDatabase> {
  const dbUtils: DbTestUtil = dbTestUtilFactory()
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
        // cleanup drops the suite database but never this one.
        await probeWrapper?.orm?.close()
        await probe?.drop()
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
          await soloWrapper?.orm.close()
          await solo.drop()
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
    })
  },
})

jest.setTimeout(180 * 1000)
