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
 * The 1.6.x activity-log migration whose `down()` is the acceptance-round defect,
 * and the event type it introduces. Named once here for the same reason as the two
 * renewal constants above: the rollback case addresses the migration by name (never
 * by its row number in `mikro_orm_migrations`, which re-runs of this file shift),
 * and asserts on the event type from both sides — its rows leave with the rollback,
 * its value leaves the check constraint and comes back with the restore.
 */
const CREATION_FAILURE_MIGRATION = "Migration20260922120000"
const CREATION_FAILED_EVENT = "subscription.creation_failed"

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
 * The migrations a probe database has recorded as applied, sorted so it can be
 * compared against a directory listing. The single reader of `mikro_orm_migrations`
 * for the set comparisons: `migrateProbe` applying a directory and the cases
 * claiming a database reached that directory's state must go through the same
 * query, or the two could disagree about what "applied" means.
 */
async function appliedMigrationNames(wrapper: ProbeWrapper): Promise<string[]> {
  return migrationNames(
    await probeQuery(wrapper, `select name from mikro_orm_migrations order by id`)
  )
}

/**
 * A failure a helper has already caught and must keep, boxed so that "there was
 * no error" (`undefined`) and "something threw `undefined`" stay distinguishable
 * in the teardown helpers below.
 */
type Failure = { readonly error: unknown }

/** How an unknown rejection reads when it has to be reported inside another error. */
function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}

/**
 * Attempts every teardown step even when an earlier one throws, and returns what
 * went wrong instead of throwing the first failure. The order matters: a probe's
 * `close()` must never be able to skip its `drop()`, because the next run would
 * then read a database this process never migrated (see `probeDatabase`), and a
 * helper that rethrew immediately is how that leak happens.
 */
async function runTeardown(
  steps: Array<{ label: string; run: () => Promise<void> }>
): Promise<string[]> {
  const notes: string[] = []

  for (const step of steps) {
    try {
      await step.run()
    } catch (error) {
      notes.push(`${step.label}: ${describeError(error)}`)
    }
  }

  return notes
}

/**
 * The error a caller should throw when a teardown step failed. The error the body
 * was already failing with wins — it is the one that explains the red, and a
 * `close()` or `drop()` problem must not be able to replace it — but that error
 * gains the teardown failure on its message, so neither half is swallowed. A body
 * error that is not an `Error` cannot carry a note, so it comes back as one that
 * quotes both rather than dropping the teardown problem.
 */
function combineFailure(primary: Failure | undefined, teardownNote: string): Error {
  if (primary === undefined) {
    return new Error(teardownNote)
  }

  if (primary.error instanceof Error) {
    primary.error.message = `${primary.error.message} [teardown: ${teardownNote}]`
    return primary.error
  }

  return new Error(
    `${describeError(primary.error)} [teardown: ${teardownNote}]`
  )
}

/**
 * Runs `use` against a migrator bound to ONE directory over ONE probe database,
 * built the same way `runMigrationsFromPath` builds its own: `getMikroOrmConfig`
 * plus `MikroORM.init` with `discovery.warnWhenNoEntities` (needed because the
 * migrator is constructed with no entities), and `CustomDBMigrator` comes along
 * because `getMikroOrmConfig` registers it — so this is the same entry point
 * `medusa migrate` uses, not a `migrationsList` shortcut. Closed whatever `use`
 * did, in a way that cannot replace `use`'s error with a close error.
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

  let failure: Failure | undefined

  try {
    return await use(orm.getMigrator())
  } catch (error) {
    failure = { error }
    throw error
  } finally {
    // A plain `finally { await orm.close() }` would replace the migrator failure
    // the case is reporting with whatever `close()` throws — and every case here
    // throws through this helper on purpose (`rerunNormalize` guards, the revert
    // cases will too), so the masking error would be the common path rather than
    // the exotic one. The teardown notes go onto the primary instead.
    const notes = await runTeardown([
      {
        label: `migrator orm for ${dbName}`,
        run: async () => {
          await orm.close()
        },
      },
    ])

    if (notes.length > 0) {
      throw combineFailure(failure, notes.join("; "))
    }
  }
}

/** The one database and one wrapper a solo probe case gets to itself. */
type SoloProbe = {
  readonly name: string
  readonly wrapper: ProbeWrapper
}

/**
 * The lifecycle every single-directory probe case needs: create a fresh database,
 * migrate `migrationPaths` onto it, hand the case the wrapper, then close and
 * drop it whatever the case did. Task 4 and Task 6 each wrote all of that out in
 * full and Task 7 needs it again, so it lives here once.
 *
 * Each case gets its OWN database rather than sharing one built by a
 * `beforeAll`, and that is the same attribution argument as the describe split one
 * level down: a probe created in a shared hook makes the first case to reject
 * poison every sibling's report, and these cases mutate
 * `mikro_orm_migrations` (`openDriftWindow` deletes a row from it), so one shared
 * database would also make the applied-set comparisons depend on case order.
 */
async function withSoloProbe<T>(
  dbName: string,
  migrationPaths: string[],
  use: (probe: SoloProbe) => Promise<T>
): Promise<T> {
  const solo = await probeDatabase(dbName)
  let wrapper: ProbeWrapper | undefined
  let failure: Failure | undefined

  try {
    wrapper = await migrateProbe(solo, migrationPaths)
    return await use({ name: dbName, wrapper })
  } catch (error) {
    failure = { error }
    throw error
  } finally {
    const notes = await runTeardown([
      {
        label: `solo probe orm ${dbName}`,
        run: async () => {
          await wrapper?.orm.close()
        },
      },
      {
        label: `solo probe drop ${dbName}`,
        run: async () => {
          await solo.drop()
        },
      },
    ])

    if (notes.length > 0) {
      throw combineFailure(failure, notes.join("; "))
    }
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

/**
 * The `name` column of the rows, sorted.
 *
 * A row whose name is missing throws with that row quoted instead of becoming
 * `String(undefined)`: the literal `"undefined"` would keep the compared set the
 * right size and shape, so a migration recorded without a name — or a select that
 * stopped projecting one — would pass an equality check against a directory
 * listing rather than be reported as the broken row it is.
 */
function migrationNames(rows: ProbeRow[]): string[] {
  return rows
    .map((row) => {
      if (typeof row.name !== "string") {
        throw new Error(
          `mikro_orm_migrations row carries no name: ${JSON.stringify(row)}`
        )
      }

      return row.name
    })
    .sort()
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
 * One `subscription_log` row. The two display columns are listed only when the
 * caller supplies them, because `Migration20260922120000.up()` is what makes them
 * nullable: a creation-failure row seeded without them is exactly the shape the
 * rollback has to delete before it can put `not null` back.
 *
 * `dedupe_key` is NOT optional the way the plan's four-column insert assumed: the
 * table declares it `text not null` with no default and puts a partial unique index
 * over it (`Migration20260401204521.ts:7-8`), so an insert that does not name it
 * carries a NULL into a required column. It is derived from the id here rather than
 * the insert dropped, which keeps the seed honest about the table.
 */
async function seedLogRow(
  wrapper: ProbeWrapper,
  {
    id,
    eventType,
    actorType = "system",
    subscriptionId = null,
    subscriptionReference = null,
  }: {
    id: string
    eventType: string
    actorType?: string
    subscriptionId?: string | null
    subscriptionReference?: string | null
  }
): Promise<void> {
  await wrapper.manager.execute(
    `insert into subscription_log (id, event_type, actor_type, dedupe_key
        ${subscriptionId ? ", subscription_id" : ""}
        ${subscriptionReference ? ", subscription_reference" : ""},
        created_at, updated_at)
     values ('${id}', '${eventType}', '${actorType}', 'probe-${id}'
        ${subscriptionId ? `, '${subscriptionId}'` : ""}
        ${subscriptionReference ? `, '${subscriptionReference}'` : ""},
        now(), now())`
  )
}

/**
 * What the database currently says about `subscription_log`'s event-type gate, read
 * in one query so a rollback case compares the same snapshot of it rather than five
 * separately-timed ones: whether the check constraint is there, which event types it
 * admits, how many rows of the new type are on disk, which ids survive, and whether
 * the two display columns still accept NULL.
 *
 * Nothing is coerced. A non-textual `definition` means the constraint is gone (the
 * helper says so rather than returning `"undefined"`, which a `toContain` would
 * treat as a pass waiting to happen); a missing count means the select stopped
 * projecting it. The `is_nullable` pair is rendered as one string because the two
 * columns are only ever meaningful together — `down()` restores both, and a rollback
 * that restored one is the bug, not a partial result to compare per column.
 */
type LogGate = {
  readonly constraintCount: number
  readonly definition: string
  readonly creationFailureRows: number
  readonly survivingIds: string
  readonly displayColumnsNullable: string
}

async function logGate(wrapper: ProbeWrapper): Promise<LogGate> {
  const rows = await probeQuery(
    wrapper,
    `select
        (select count(*)::int from pg_constraint
          where conname = 'subscription_log_event_type_check') as constraint_count,
        (select pg_get_constraintdef(oid) from pg_constraint
          where conname = 'subscription_log_event_type_check') as definition,
        (select count(*)::int from subscription_log
          where event_type = '${CREATION_FAILED_EVENT}') as creation_failure_rows,
        coalesce((select string_agg(id, ',' order by id) from subscription_log), '')
          as surviving_ids,
        (select string_agg(column_name || '=' || is_nullable, ',' order by column_name)
           from information_schema.columns
          where table_name = 'subscription_log'
            and table_schema = '${PROBE_SCHEMA}'
            and column_name in ('subscription_id', 'subscription_reference'))
          as display_columns_nullable`
  )

  if (rows.length !== 1) {
    throw new Error(
      `subscription_log gate state came back as ${rows.length} rows, expected 1`
    )
  }

  const row = rows[0]
  const {
    constraint_count: constraintCount,
    definition,
    creation_failure_rows: creationFailureRows,
    surviving_ids: survivingIds,
    display_columns_nullable: displayColumnsNullable,
  } = row

  if (typeof constraintCount !== "number" || typeof creationFailureRows !== "number") {
    throw new Error(
      `subscription_log gate counts did not come back as integers: ${JSON.stringify(row)}`
    )
  }

  if (
    typeof definition !== "string" ||
    typeof survivingIds !== "string" ||
    typeof displayColumnsNullable !== "string"
  ) {
    throw new Error(
      `subscription_log gate state is not the shape this helper reads — most likely the check constraint is gone entirely (compare constraint_count), or the display columns are no longer on the table: ${JSON.stringify(row)}`
    )
  }

  return {
    constraintCount,
    definition,
    creationFailureRows,
    survivingIds,
    displayColumnsNullable,
  }
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
 * Opens the drift window, runs `use` over it, and hands the probe back fully
 * migrated afterwards.
 *
 * Task 7 recorded why the restore cannot simply sit at the end of a case body:
 * `openDriftWindow` drops the index AND deletes the migration's row, so a case
 * that throws between the two leaves the shared probe in the drifted state for
 * every later reader of it. The restore is `restoreAppliedMigration` rather than
 * `rerunNormalize` because `use` usually re-applies the migration itself — with
 * `up()` already done the latter would throw "not pending", and a helper whose
 * teardown reports success as a failure is not a teardown. The recorded-name
 * guard inside it is what makes an unrestored window loud.
 */
async function withDriftWindow(
  dbName: string,
  wrapper: ProbeWrapper,
  use: () => Promise<void>
): Promise<void> {
  await openDriftWindow(wrapper)

  let failure: Failure | undefined

  try {
    await use()
  } catch (error) {
    failure = { error }
    throw error
  } finally {
    const notes = await runTeardown([
      {
        label: `close drift window in ${dbName}`,
        run: async () => {
          await restoreAppliedMigration(
            dbName,
            migrationDirOf("renewal"),
            NORMALIZE_MIGRATION,
            wrapper
          )
        },
      },
    ])

    if (notes.length > 0) {
      throw combineFailure(failure, notes.join("; "))
    }
  }
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

/**
 * The rows `pg_indexes` carries for the 1.6.0 partial unique index: exactly one
 * while `Migration20260924120000` is applied, none once its `down()` has run.
 *
 * Rows rather than a boolean so the expectation says which of the two it checked,
 * and read at BOTH ends of the rollback rather than only after it: `openDriftWindow`
 * leaves this index dropped whenever a later step of a case throws, so an
 * absence-only assertion would be satisfied by a probe another case drifted, and the
 * rollback under test could do nothing at all and still pass.
 */
async function upcomingCycleIndexRows(
  wrapper: ProbeWrapper
): Promise<ProbeRow[]> {
  return probeQuery(
    wrapper,
    `select indexname from pg_indexes where indexname = '${UPCOMING_CYCLE_INDEX}'`
  )
}

/**
 * Puts one reverted migration back and proves the probe is fully migrated again.
 *
 * `up()` is called only when the migration is actually pending, which is the
 * difference from `rerunNormalize`: a rollback case whose `down()` failed part-way
 * must still be able to restore, and MikroORM runs migrations transactionally
 * (`transactional` and `allOrNothing` both default to true,
 * `@mikro-orm/core/utils/Configuration.js:89-91`), so a failed `down()` leaves the
 * row in `mikro_orm_migrations` and there is nothing to re-apply. The recorded-name
 * check is what makes the restore observable rather than assumed: a probe left
 * half-migrated hands every later case in this file a database whose pending set is
 * not what its directory listing says, which is how a rollback leak turns into
 * someone else's false green.
 */
async function restoreAppliedMigration(
  dbName: string,
  migrationDirPath: string,
  migrationName: string,
  wrapper: ProbeWrapper
): Promise<void> {
  await withMigratorFor(dbName, migrationDirPath, async (migrator) => {
    const pending = (await migrator.getPendingMigrations()).map(
      (entry) => entry.name
    )

    if (pending.includes(migrationName)) {
      await migrator.up({ migrations: [migrationName] })
    }
  })

  const recorded = await probeQuery(
    wrapper,
    `select name from mikro_orm_migrations where name = '${migrationName}'`
  )

  if (recorded.length !== 1) {
    throw new Error(
      `${migrationName} is not recorded in ${dbName} after the rollback case: the ` +
        `probe was left half-migrated (${recorded.length} rows for that name) and ` +
        "the next case would read that state as its own"
    )
  }
}

/**
 * Reverts `migrationName` in `dbName`, runs `use` against the reverted database,
 * then re-applies it whatever `use` did.
 *
 * The revert goes through `withMigratorFor` bound to the migration's own directory
 * even when the database is the nine-directory probe: `setupDatabase()` configures
 * the shared wrapper's ORM with `pathToMigrations: migrationPaths[0]`
 * (`@medusajs/test-utils/dist/database.js:100-112`, the activity-log directory), so
 * its own `orm.getMigrator()` cannot see any other module's migration and umzug
 * would answer `Couldn't find migration to apply with name
 * "Migration20260924120000"` (`umzug/lib/umzug.js:317-326`) for a `down()` that
 * asks for it. That is a loud failure rather than a silent one, but it is also the
 * wrong error to meet at a revert case, and the activity-log revert — the one
 * migration `MIGRATION_PATHS[0]` does make reachable that way — is bound here too so
 * that both cases run the same mechanism and whoever reorders `MIGRATION_PATHS` does
 * not turn the other one over.
 *
 * The restore lives in the `finally`, not at the end of the calling case, because a
 * case throwing on its way out is the expected shape of this file (both mutation
 * probes in the plan do it), and a dropped index or a reverted migration must not
 * survive a red run. `runTeardown` + `combineFailure` keep the case's own failure as
 * the reported error, with the restore's problem appended to it rather than replacing
 * it — the same rule `withSoloProbe` follows.
 */
async function withMigrationReverted(
  dbName: string,
  migrationDirPath: string,
  migrationName: string,
  wrapper: ProbeWrapper,
  use: () => Promise<void>
): Promise<void> {
  let failure: Failure | undefined

  try {
    await withMigratorFor(dbName, migrationDirPath, (migrator) =>
      migrator.down({ migrations: [migrationName] })
    )

    await use()
  } catch (error) {
    failure = { error }
    throw error
  } finally {
    const notes = await runTeardown([
      {
        label: `restore ${migrationName} in ${dbName}`,
        run: async () => {
          await restoreAppliedMigration(
            dbName,
            migrationDirPath,
            migrationName,
            wrapper
          )
        },
      },
    ])

    if (notes.length > 0) {
      throw combineFailure(failure, notes.join("; "))
    }
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
    /**
     * Two sibling describes rather than one, and the split is load-bearing: jest
     * inherits a failing `beforeAll` into EVERY case of that describe, so a case
     * that shares the nine-directory probe's hook can never attribute its own red.
     * With `Migration20260924120000`'s `to_regclass` guard neutralized, the probe
     * below rejects while applying `renewal` — the 7th of the 9, before
     * `subscription` creates its table — and all eight cases then report that one
     * inherited error while their own bodies never run. The renewal-only probes
     * therefore live in the describe after this one, which has no hook for them to
     * inherit, and each builds its own single-directory database inside its own
     * body through `withSoloProbe`.
     */
    describe("plugin migrations on the probe over every shipped directory", () => {
      let probe!: ProbeDatabase
      let probeWrapper!: ProbeWrapper

      beforeAll(async () => {
        probe = await probeDatabase(PROBE_DB_NAME)
        probeWrapper = await migrateProbe(probe, MIGRATION_PATHS)
      })

      afterAll(async () => {
        // Either is unset when `beforeAll` itself rejected, and the runner's own
        // cleanup drops the suite database but never this one. Teardown goes
        // through `runTeardown` so a rejected `close()` cannot skip the drop and
        // hand the next run a database this one never migrated — and so neither
        // failure is swallowed.
        const notes = await runTeardown([
          {
            label: "shared probe orm",
            run: async () => {
              await probeWrapper?.orm.close()
            },
          },
          {
            label: "shared probe drop",
            run: async () => {
              await probe?.drop()
            },
          },
        ])

        if (notes.length > 0) {
          throw new Error(`${PROBE_DB_NAME} teardown: ${notes.join("; ")}`)
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

        const appliedByProbe = await appliedMigrationNames(probeWrapper)

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

      /**
       * The two cases below are the reason the probe harness exists at all: nothing
       * else in this repository ever runs a `down()`. The app bootstrap only migrates
       * forwards (`runModulesMigrations` -> `migration-up`), `test:integration:modules`
       * never reaches a migration at all (see the header note), and grepping the suites
       * for `getMigrator` outside this file finds none — so the two rollbacks shipped to
       * the acceptance round with the second one throwing, and nothing noticed. Both
       * cases revert one migration IN THE SHARED PROBE and hand it back fully migrated,
       * through `withMigrationReverted`, because the inventory comparison above and
       * every case a later task adds to this describe read that same database.
       *
       * Each case establishes its own rows rather than reading a sibling's: the renewal
       * one needs a normalized partition and the activity-log one needs creation-failure
       * rows, and an assertion that could be satisfied by whatever a previous case
       * happened to leave behind is not testing the rollback.
       */

      it("drops the constraint and resurrects nothing on down()", async () => {
        // This case's own drifted pair, put through this case's own normalization:
        // the survivor is the entitlement row, the most-future duplicate is the
        // tombstone with the note. Same rule the four cases above follow, and the
        // same reason — the index has to be down before the pair is insertable.
        await openDriftWindow(probeWrapper)
        await seedSubscription(probeWrapper, "sub_t7", "2026-11-24T00:00:00Z")
        await seedCycle(probeWrapper, { id: "cyc_t7_match", subscriptionId: "sub_t7", scheduledFor: "2026-11-24T00:00:00Z" })
        await seedCycle(probeWrapper, { id: "cyc_t7_stale", subscriptionId: "sub_t7", scheduledFor: "2026-12-24T00:00:00Z" })

        await rerunNormalize(PROBE_DB_NAME, probeWrapper)

        // Presence FIRST, and asserted rather than assumed: `rerunNormalize` proves
        // the migration is recorded, not that its index came with it, and without
        // this line the absence below would be equally satisfied by an index
        // `openDriftWindow` dropped and nobody restored.
        expect(await upcomingCycleIndexRows(probeWrapper)).toHaveLength(1)

        await withMigrationReverted(
          PROBE_DB_NAME,
          migrationDirOf("renewal"),
          NORMALIZE_MIGRATION,
          probeWrapper,
          async () => {
            // The whole of what `down()` is: the constraint goes away, and nothing
            // else does.
            expect(await upcomingCycleIndexRows(probeWrapper)).toHaveLength(0)

            // The normalized neighbour is still a tombstone and still carries the
            // note — reviving it would put a second chargeable cycle back on
            // `listDueRenewalCyclesForProcessing`, which is why the migration soft
            // deletes in the first place. Compared as the SET of tombstoned rows for
            // this subscription, so a `down()` that hard-deleted the tombstones comes
            // back `[]` here, and one that cleared their `deleted_at` comes back `[]`
            // here and doubles the live count below: neither mutation can pass by
            // moving the failure somewhere else.
            expect(
              await probeQuery(
                probeWrapper,
                `select id, last_error, deleted_at is not null as tombstoned
                   from renewal_cycle
                  where subscription_id = 'sub_t7' and deleted_at is not null
                  order by id`
              )
            ).toEqual([
              {
                id: "cyc_t7_stale",
                last_error: NORMALIZED_NOTE,
                tombstoned: true,
              },
            ])
            expect(await liveScheduled(probeWrapper, "sub_t7")).toEqual(["cyc_t7_match"])

            // ...and with the index gone a second live `scheduled` row for one
            // subscription is insertable again, which is the money-facing half: the
            // constraint was the only thing between this pair and two charges. The
            // reverse is what `openDriftWindow` documents for the normalize cases —
            // while the index stands this very insert is rejected — so the seed
            // resolving at all is the assertion, and the count below says two rows
            // really are live for one subscription now.
            await seedCycle(probeWrapper, { id: "cyc_t7_again", subscriptionId: "sub_t7", scheduledFor: "2027-01-01T00:00:00Z" })
            expect(await liveScheduled(probeWrapper, "sub_t7")).toEqual([
              "cyc_t7_again",
              "cyc_t7_match",
            ])
          }
        )

        // Restored, and with it the asymmetry the release notes document: `up()`
        // shapes data one way, so the pair the rollback allowed gets normalized again
        // by the re-apply instead of being tolerated under a re-created index. This
        // is also the proof the next case inherits a whole probe — the index, the
        // survivor, and the complete 22-migration inventory rather than the two names
        // this file touches.
        expect(await upcomingCycleIndexRows(probeWrapper)).toHaveLength(1)
        expect(await liveScheduled(probeWrapper, "sub_t7")).toEqual(["cyc_t7_match"])
        expect(await appliedMigrationNames(probeWrapper)).toEqual(
          expectedMigrationNames()
        )
      })

      it("rolls the creation-failure migration back over its own rows", async () => {
        // The acceptance defect: this rollback re-added the event-type check
        // constraint BEFORE deleting the rows the migration had introduced, and `add
        // constraint` validates every row on disk, so a host whose log contained a
        // creation failure could not revert the plugin at all —
        // `check constraint "subscription_log_event_type_check" is violated by some
        // row`. The two rows below are that database: `up()` is the only thing that
        // makes a creation-failure row with no `subscription_id` legal, and a
        // rollback case without such a row cannot see the defect (mutation probe (a)
        // in the plan reddens exactly and only here).
        await seedLogRow(probeWrapper, { id: "slog_t7_bare", eventType: CREATION_FAILED_EVENT })
        await seedLogRow(probeWrapper, { id: "slog_t7_ref", eventType: CREATION_FAILED_EVENT, subscriptionReference: "SUB_PROBE" })
        // A row of a type that existed before 1.6.x, as the neighbour the rollback
        // must leave alone: `down()` deletes its own event type, not the table.
        await seedLogRow(probeWrapper, {
          id: "slog_t7_created",
          eventType: "subscription.created",
          subscriptionId: "sub_t7",
          subscriptionReference: "SUB_PROBE",
        })

        // The starting state, asserted rather than assumed: both new-type rows are on
        // disk (so the zero below measures a delete, not a rejected seed), the
        // constraint admits the event type, and both display columns are nullable.
        expect(await logGate(probeWrapper)).toEqual({
          constraintCount: 1,
          definition: expect.stringContaining(CREATION_FAILED_EVENT),
          creationFailureRows: 2,
          survivingIds: "slog_t7_bare,slog_t7_created,slog_t7_ref",
          displayColumnsNullable: "subscription_id=YES,subscription_reference=YES",
        })

        await withMigrationReverted(
          PROBE_DB_NAME,
          migrationDirOf("activity-log"),
          CREATION_FAILURE_MIGRATION,
          probeWrapper,
          async () => {
            const reverted = await logGate(probeWrapper)

            // Its own rows are gone, and only its own rows.
            expect(reverted.creationFailureRows).toBe(0)
            expect(reverted.survivingIds).toBe("slog_t7_created")
            // The constraint is back as ONE constraint (the migration drops and
            // re-adds it, so two would mean the drop went missing) and it no longer
            // admits the event type this migration introduced. Compared by membership
            // and not against a captured definition string on purpose: `down()`'s list
            // holds the same 25 values `Migration20260909130000.up()` installed
            // (measured: the two sets differ by nothing), but that one appends
            // `subscription.expired` / `redemption.redeemed` while this one places them
            // mid-list, so `pg_get_constraintdef` renders them in a different order and
            // a byte comparison would fail on a rollback that is correct.
            expect(reverted.constraintCount).toBe(1)
            expect(reverted.definition).not.toContain(CREATION_FAILED_EVENT)
            // ...and the display columns are required again, which is the statement
            // the delete exists to make possible.
            expect(reverted.displayColumnsNullable).toBe(
              "subscription_id=NO,subscription_reference=NO"
            )
          }
        )

        // Restored: the constraint admits the event type again and both columns are
        // nullable again, so the probe is back to what `up()` leaves. The deleted
        // creation-failure rows do NOT come back — that is the same one-way property
        // the renewal case above documents.
        expect(await logGate(probeWrapper)).toEqual({
          constraintCount: 1,
          definition: expect.stringContaining(CREATION_FAILED_EVENT),
          creationFailureRows: 0,
          survivingIds: "slog_t7_created",
          displayColumnsNullable: "subscription_id=YES,subscription_reference=YES",
        })
        expect(await appliedMigrationNames(probeWrapper)).toEqual(
          expectedMigrationNames()
        )
      })

      /**
       * Task 17's harness half: which of the two shapes the step's `retire` set
       * can arise from is reachable in a migrated database, and which only in a
       * drifted one.
       *
       * The set is "live `scheduled` rows other than the one the resolution chose",
       * so a run can carry one only when the subscription owns two live `scheduled`
       * rows, or when the row on the entitlement date is terminal and a `scheduled`
       * row sits beside it. The second is index-legal — the partial unique index
       * only covers `status = 'scheduled'` — and the http suite pins what the step
       * does with it. The first is what `Migration20260924120000.up()` normalizes
       * away, and this case is the proof that it does: the pair below is insertable
       * only with the index down, the re-apply leaves exactly one live `scheduled`
       * row behind, and the terminal neighbour keeps its place on the entitlement
       * date because the ranked CTE never sees a terminal row at all.
       */
      it("leaves one live scheduled row per subscription for the step to retire", async () => {
        await withDriftWindow(PROBE_DB_NAME, probeWrapper, async () => {
          await seedSubscription(probeWrapper, "sub_t17", "2026-11-24T00:00:00Z")
          // Terminal and sitting ON the entitlement date. The normalization's CTE
          // filters `rc."status" = 'scheduled'`, so this row is not even a candidate:
          // nothing the migration does can tombstone or move it, which is exactly
          // why the step's `match` can find a live neighbour behind it.
          await seedCycle(probeWrapper, { id: "cyc_t17_terminal", subscriptionId: "sub_t17", scheduledFor: "2026-11-24T00:00:00Z", status: "succeeded" })
          // Two live `scheduled` rows, neither on the entitlement date: the shape
          // the retire consumes and the constraint forbids. With no entitlement hit
          // in the partition the fallback comparator decides who stays.
          await seedCycle(probeWrapper, { id: "cyc_t17_live", subscriptionId: "sub_t17", scheduledFor: "2026-09-24T00:00:00Z" })
          await seedCycle(probeWrapper, { id: "cyc_t17_dupe", subscriptionId: "sub_t17", scheduledFor: "2026-08-24T00:00:00Z" })

          expect(await liveScheduled(probeWrapper, "sub_t17")).toEqual([
            "cyc_t17_dupe",
            "cyc_t17_live",
          ])

          await rerunNormalize(PROBE_DB_NAME, probeWrapper)
        })

        // The window closed on the way out, so the constraint stands again and the
        // state below is the one a migrated host actually holds.
        expect(await upcomingCycleIndexRows(probeWrapper)).toHaveLength(1)

        expect(await liveScheduled(probeWrapper, "sub_t17")).toEqual([
          "cyc_t17_live",
        ])
        expect(
          await probeQuery(
            probeWrapper,
            `select id, status, last_error, deleted_at is not null as tombstoned
               from renewal_cycle where subscription_id = 'sub_t17' order by id`
          )
        ).toEqual([
          {
            id: "cyc_t17_dupe",
            status: "scheduled",
            last_error: NORMALIZED_NOTE,
            tombstoned: true,
          },
          {
            id: "cyc_t17_live",
            status: "scheduled",
            last_error: null,
            tombstoned: false,
          },
          {
            id: "cyc_t17_terminal",
            status: "succeeded",
            last_error: null,
            tombstoned: false,
          },
        ])

        // The negative half, and the reason the http defer / adopt cases need a
        // window of their own: with the constraint up, a second live `scheduled`
        // row for this subscription is uninsertable, so the two-live-rows shape
        // exists only where the index was dropped — and only for as long as the
        // migration stays un-applied, since its `up()` is what clears it.
        const secondLive = await seedCycle(probeWrapper, {
          id: "cyc_t17_again",
          subscriptionId: "sub_t17",
          scheduledFor: "2027-01-24T00:00:00Z",
        }).then(
          () => null,
          (error: Error) => error
        )

        expect(secondLive).toBeInstanceOf(Error)
        expect(String(secondLive?.message)).toMatch(
          /renewal_cycle_one_scheduled_per_subscription|duplicate key value/i
        )
        expect(await liveScheduled(probeWrapper, "sub_t17")).toEqual([
          "cyc_t17_live",
        ])
      })
    })

    /**
     * The two probes that migrate the renewal directory ALONE, which is the state
     * a FIRST INSTALL is in: the plugin's module migrators go in module order, so
     * `renewal` is migrated long before `subscription` creates its table (renewal
     * is the 7th of the 9 directories in `MIGRATION_PATHS`, subscription the 9th,
     * and the app bootstrap's own migration log puts `MODULE: renewal` before
     * `MODULE: subscription` exactly that way round). `Migration20260924120000`'s
     * normalization SQL then joins `subscription` only if `to_regclass` says the
     * relation answers, and that guard is the only thing standing between a first
     * install and a failed boot.
     *
     * No `beforeAll` here, deliberately: these cases build their own database
     * inside their own bodies (`withSoloProbe`), so the error a mutated migration
     * produces names the case that met it instead of being inherited from a hook
     * the whole describe shares. One hook over a single renewal-only probe would
     * reintroduce exactly that, one level down, and these two cases also delete
     * rows from `mikro_orm_migrations` (`openDriftWindow`), which would make one
     * case's applied-set comparison depend on which of them jest ran first.
     */
    describe("plugin migrations on a renewal-only probe", () => {
      it("reaches the migration state of one module directory", async () => {
        // A one-entry list takes the other branch of `setupDatabase()`: the
        // migrations are applied by name, which only holds because this database
        // was created moments ago and so has pending ones — `withSoloProbe` drops
        // before it creates. The applied-set assertion is that fact stated rather
        // than assumed; re-running `setupDatabase()` over an already-migrated
        // database is not allowed here at all, because with nothing pending that
        // branch regenerates the schema from the entities and would wipe seeded
        // rows (see the case below for what that would and would not notice).
        await withSoloProbe(
          `${PROBE_DB_NAME}_renewal_only`,
          [migrationDirOf("renewal")],
          async (solo) => {
            expect(await appliedMigrationNames(solo.wrapper)).toEqual(
              migrationNamesIn(migrationDirOf("renewal")).sort()
            )

            // Bound to one directory AND to this database: a migrator built over a
            // different module sees that module's migrations as still pending, which
            // is what the re-run and revert cases in this phase rely on.
            const pendingForActivityLog = await withMigratorFor(
              solo.name,
              migrationDirOf("activity-log"),
              (migrator) => migrator.getPendingMigrations()
            )

            expect(pendingForActivityLog.map((entry) => entry.name).sort()).toEqual(
              migrationNamesIn(migrationDirOf("activity-log")).sort()
            )
          }
        )
      })

      it("normalizes without a subscription table at all", async () => {
        await withSoloProbe(
          `${PROBE_DB_NAME}_normalize_solo`,
          [migrationDirOf("renewal")],
          async (solo) => {
            // The applied set comes first, because it is what makes the rest of
            // this case mean what it says: THIS directory's migrations ran on
            // THIS database and nothing else did. `migrationNamesIn` is the same
            // listing the harness itself globs, so a mismatch can only mean the
            // probe ended up somewhere other than the renewal directory alone —
            // a widened path list, a database name reused across cases, a
            // wrapper built over another module.
            //
            // It is not, however, a net for `setupDatabase()`'s entity-derived
            // fall-through (with exactly one path and nothing pending it
            // regenerates the schema from entities instead of applying
            // migrations, `database.js:130-140`), and the case comment that
            // claimed it was is wrong on both halves, measured here: such a
            // wrapper loads the one directory's models only
            // (`getProbeWrapperFor`) and every MikroORM instance owns its
            // `MetadataStorage` (`@mikro-orm/core/MikroORM.js:108`), so no
            // `subscription` table can appear for the assertion below to trip
            // on; and calling `setupDatabase()` twice over the same fresh
            // database leaves the first pass' rows in `mikro_orm_migrations`,
            // because `Migrator.getPendingMigrations()` creates that table itself
            // (`@mikro-orm/migrations/Migrator.js:192` ->
            // `MigrationStorage.js:83-102`) and the regenerate does not empty it
            // — so the set comparison still passes, and it passes honestly,
            // because the migrations did run in that database. The reach of this
            // assertion is the migrated-something-else direction, and it is not
            // redundant with the one below: with it removed and the list widened
            // to two directories all eight cases went green; with it restored
            // this is the only one red, on exactly this line.
            expect(await appliedMigrationNames(solo.wrapper)).toEqual(
              migrationNamesIn(migrationDirOf("renewal")).sort()
            )

            // The negative half, asserted rather than assumed: the table really
            // is absent in this database, so the dedup below is not silently
            // normalizing one that has it. A widening that brings the table with
            // it (the subscription directory in the list) reddens here as well as
            // on the set comparison; one that does not (any other module)
            // reddens on the set comparison alone, which is why both are here.
            // Both spellings are read because the migration guards on the
            // unqualified `'"subscription"'` — resolved through `search_path`, see
            // its comment — while a schema-qualified read is the stronger
            // statement about the probe itself; on this public-schema database
            // they must agree on NULL.
            expect(
              await probeQuery(
                solo.wrapper,
                `select to_regclass('public.subscription') as qualified,
                        to_regclass('"subscription"') as searched`
              )
            ).toEqual([{ qualified: null, searched: null }])

            // Same ordering rule Task 5 hit on the shared probe, and for the same
            // reason: the renewal directory has just created
            // `renewal_cycle_one_scheduled_per_subscription`, so a second live
            // `scheduled` row for one subscription is rejected by the very index
            // this migration installs unless the drift window is opened first.
            await openDriftWindow(solo.wrapper)

            // No `seedSubscription` here — there is nothing to insert into. The
            // orphan id is insertable because `renewal_cycle.subscription_id` is a
            // plain `text not null` column with no foreign key
            // (`Migration20260329185930.ts:7`).
            await seedCycle(solo.wrapper, { id: "cyc_solo_a", subscriptionId: "sub_solo", scheduledFor: "2026-08-24T00:00:00Z" })
            await seedCycle(solo.wrapper, { id: "cyc_solo_b", subscriptionId: "sub_solo", scheduledFor: "2026-09-24T00:00:00Z" })

            await rerunNormalize(solo.name, solo.wrapper)

            // The dedup still happened, down to the row the fallback comparator
            // keeps: with no entitlement date to consult, `scheduled_for desc`
            // decides, so the later cycle survives. That is what the migration
            // promises for such a database ("a database with no `subscription`
            // table cannot hold drift against an entitlement date, so the fallback
            // ordering is sufficient there") — and it is the half a guard written
            // the other way round loses. Measured: with `ELSE return;` added to the
            // guard, so a missing `subscription` skips the normalization outright,
            // this is the only one of the eight cases that reddens, and it reddens
            // on the drift the skipped normalization leaves behind
            // (`could not create unique index ... Key (subscription_id)=(sub_solo)
            // is duplicated`) because both seeded rows are still live. Neutralizing
            // the guard the other way instead makes the join unconditional, and this
            // case then fails inside its own `withSoloProbe` with
            // `relation "subscription" does not exist` — the first-install boot
            // failure the guard exists to prevent — rather than inheriting the
            // shared probe's rejection: measured with the guard replaced by a
            // literal that is always non-null, the stack below is this case's own
            // `withSoloProbe` -> `migrateProbe`, and it is the reason these two
            // probes sit in their own describe rather than in the nine-directory one
            // above.
            expect(await liveScheduled(solo.wrapper, "sub_solo")).toEqual(["cyc_solo_b"])
          }
        )
      })
    })
  },
})

jest.setTimeout(180 * 1000)
