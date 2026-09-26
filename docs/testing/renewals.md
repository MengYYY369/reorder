# Testing: Renewals

This document describes the current testing strategy for the `Renewals` area in the `Reorder` plugin.

It covers:
- test layers
- test files
- commands
- fixture strategy
- coverage scope
- known non-goals

## Purpose

The testing setup for `Renewals` is designed to protect the plugin at the layers officially supported by Medusa's testing tooling.

The project currently relies on:
- module integration tests
- HTTP integration tests

It does not currently include browser-based UI tests.

## 1. Testing Strategy

The `Renewals` area is tested in two main layers:

1. module/service layer
2. Medusa application integration layer

This gives coverage for:
- data model behavior
- service behavior
- query helpers
- workflows
- custom Admin API routes
- end-to-end backend flow used by the Admin UI
- smoke-level integration with `Subscriptions` and `Plans & Offers`

## 2. Test Tooling

The current setup uses Medusa-supported testing tools:
- `Jest`
- `@medusajs/test-utils`
- `moduleIntegrationTestRunner`
- `medusaIntegrationTestRunner`

Repository files involved in the setup:
- [package.json](../../package.json)
- [jest.config.js](../../jest.config.js)
- [integration-tests/setup.js](../../integration-tests/setup.js)
- [integration-tests/medusa-config.ts](../../integration-tests/medusa-config.ts)

## 3. Test Layers

### 3.1 Module Integration Tests

Purpose:
- verify the `renewal` module service in isolation from full Admin flows

Current files:
- [service.spec.ts](../../src/modules/renewal/__tests__/service.spec.ts)
- [upcoming-cycle.spec.ts](../../src/modules/renewal/__tests__/upcoming-cycle.spec.ts) — the `resolveUpcomingCycle` selector and the `retire` set its first three actions carry
- [retire-stale-cycles.spec.ts](../../src/modules/renewal/__tests__/retire-stale-cycles.spec.ts) — the write half: `retireStaleUpcomingCycles` with its re-read qualification and `withheld` report, the `retireAndDefer` / `retireAndReportUnchanged` / `retireAndReportReconciled` branch wrappers and what each reports, `restoreRetiredUpcomingCycles`, and the `rollBackUpcomingCycleWrites` dispatcher
- [reconcile-restore.spec.ts](../../src/modules/renewal/__tests__/reconcile-restore.spec.ts) — `restoreReconciledCycle`, pinned to every column a reconciliation patch may write

This layer is the right place for:
- renewal cycle creation behavior
- renewal attempt creation behavior
- module-level persistence behavior
- model-adjacent service behavior
- the upcoming-cycle reconciliation decision (`resolveUpcomingCycle`), which is a
  pure selector over rows and is asserted for all four actions and for the `retire`
  set `match`, `adopt` and `defer` each carry — the live `scheduled` rows the decision
  leaves in place, excluding the one it chose, any `processing` row and any row
  carrying a `generated_order_id` — while `create` is asserted to carry no such field;
  for the pinned "`match` outranks `adopt`" precedence, and for the write/rollback
  field list the patch and its restore share
- the step's retire and rollback halves, which are reached through narrowed writer
  types so the effect is assertable here without a workflow engine

Boundary this layer cannot cross: the module runners create their schema from the
entity models and pass no `pathToMigrations`, so **hand-written migrations do not
exist here**. Anything asserting the output of a migration — the partial unique
index `renewal_cycle_one_scheduled_per_subscription`, the normalization that runs
before it — belongs in the HTTP layer below, which does apply plugin migrations.

### 3.2 HTTP Integration Tests

Purpose:
- run a full Medusa application in test mode
- call the real custom Admin routes
- verify workflows, scheduler-facing reads, and API behavior as used by the Admin UI

Current files:
- [renewals-workflows.spec.ts](../../integration-tests/http/renewals-workflows.spec.ts)
- [renewals-routes.spec.ts](../../integration-tests/http/renewals-routes.spec.ts)
- [renewals-admin-flow.spec.ts](../../integration-tests/http/renewals-admin-flow.spec.ts)
- [renewals-smoke.spec.ts](../../integration-tests/http/renewals-smoke.spec.ts)
- [subscription-from-order.spec.ts](../../integration-tests/http/subscription-from-order.spec.ts) — renewal-side cases: a stacked purchase leaves exactly one future `SCHEDULED` cycle, a cycle whose renewal order is already outstanding is deferred rather than rescheduled, a second live `SCHEDULED` row for one subscription is refused by the database, the stale neighbour is retired behind a terminal entitlement-date row (with the index standing) and beside an adopted or deferred row (inside an index window), and an applied adopt is rolled back when the retirement fails mid-run
- [migrations.spec.ts](../../integration-tests/http/migrations.spec.ts) — the migration harness, including which duplicate-cycle shapes survive a re-applied `up()` and which need the index dropped to exist at all

This layer is the main protection for the implemented Admin behavior and the renewal execution boundary.

### 3.3 E2E Browser Tests

Purpose:
- verify the actual Admin UI behavior running in a real browser via Playwright
- exercise critical merchant operational flows, specifically manual revenue recovery (forcing/approving renewals)

Current files:
- [renewal-force.spec.ts](../../e2e/renewal-force.spec.ts) (exercises force-run and approval)
- [RenewalDetailPage.ts](../../e2e/pages/RenewalDetailPage.ts) (Page Object Model)

This layer relies on direct PostgreSQL inserts (`psql`) to isolate complex state without bloating the Admin API.
## 4. Fixture Strategy

Test data helpers are defined in:
- [renewal-fixtures.ts](../../integration-tests/helpers/renewal-fixtures.ts)
- [subscription-fixtures.ts](../../integration-tests/helpers/subscription-fixtures.ts)
- [plan-offer-fixtures.ts](../../integration-tests/helpers/plan-offer-fixtures.ts)

Current helpers include:
- admin auth header creation
- product and variant creation
- subscription seed creation
- renewal cycle seed creation
- renewal attempt seed creation
- plan offer seed creation

These helpers are used to:
- reduce duplication across integration tests
- keep route and workflow tests focused on behavior
- provide realistic seed data for approval, retry, and execution flows
- support smoke-level integration across `Renewals`, `Subscriptions`, `Plans & Offers`, and `Cancellation & Retention`

One property of the seed helper is worth knowing before writing a new spec:
`createRenewalCycleSeed` defaults `status` to `SCHEDULED`
([renewal-fixtures.ts](../../integration-tests/helpers/renewal-fixtures.ts)), which is
exactly the state the partial unique index constrains. Seeding two live
`SCHEDULED` cycles for one subscription is therefore a database error in the HTTP
layer, and a spec that wants that state deliberately has to say so through the
subscription id it reuses — which is what the index self-proof case does.

**Seeding the drift the retire consumes.** A spec that wants two live `SCHEDULED`
rows for one subscription runs inside the window
`withUpcomingCycleIndexDropped` opens in
[subscription-from-order.spec.ts](../../integration-tests/http/subscription-from-order.spec.ts):
`drop index if exists "renewal_cycle_one_scheduled_per_subscription"`, seed the rows,
drive the workflow, then re-create the index with the statement
`Migration20260924120000.up()` ends on. The re-create is half of the assertion, not
teardown hygiene: a step that left a second live `SCHEDULED` row standing makes
PostgreSQL refuse the index with `could not create unique index … is duplicated`, and
the case fails on its way out instead of leaving the suite database drifted for every
later reader. The rollback case is the one that has to differ — leaving both rows live
*is* its assertion, so it deletes its own two rows before the window closes, and the
re-create still runs and still proves the constraint stands afterwards.

The other shape the retire acts on needs no window at all: a terminal
(`succeeded`) row on the entitlement date with one live `SCHEDULED` neighbour is
index-legal, because the partial predicate covers only `status = 'scheduled' and
deleted_at is null`, and that case leaves the index up.

## 5. Current Coverage

### Module Coverage

Covered at the module/service layer:
- renewal cycle creation
- renewal attempt creation
- retrieval and persistence behavior for renewal records

### Query and Workflow Coverage

Covered through integration tests:
- list query behavior
- detail query behavior
- latest attempt summary resolution
- successful renewal execution
- failed renewal execution
- retry path after failure
- duplicate execution blocked
- already processing conflict
- approval required, approved, and rejected transitions
- force execution route and workflow behavior

### Upcoming-Cycle Coverage

Covered through the module and HTTP layers above:
- the `retire` set `resolveUpcomingCycle` names on `match`, `adopt` and `defer`, and
  its absence on `create`
- the soft delete of those rows, including the re-read that withholds a row which took
  on a `generated_order_id` between the selection and the write
- the three log lines a run can write: `retired …` pinned to its whole text in both
  the module and the http case, `restored …` pinned to its whole text in the rollback
  case, and `withheld …` pinned to its count and the row id it names
- the action a run reports: `retired` when the retire was its only write, `deferred`
  when a deferral retired as well, `noop` only when nothing went
- the rolled-back run: an applied adopt whose retirement throws is reported as a
  permanent step failure, the engine compensates it, and both rows are live again

**Manual check on a real database.** After a repeat purchase of a stacked product this
returns nothing:

```sql
select subscription_id, count(*)
  from renewal_cycle
 where status = 'scheduled' and deleted_at is null
 group by subscription_id
having count(*) > 1;
```

A row the step cleared is still on the table, so the same query with the predicate
flipped shows what a run retired:

```sql
select id, subscription_id, scheduled_for, status, deleted_at
  from renewal_cycle
 where deleted_at is not null and status = 'scheduled'
 order by deleted_at desc;
```

A step retirement carries no `last_error` marker — that text is stamped only by the
1.6.0 normalization migration — so the two provenances are told apart by that column,
and the run that did it is the `[reorder] retired …` line in the server log. A
retirement line is not proof that the index is gone: the terminal-row shape above
retires on a database where the constraint stands. A subscription holding two live
`scheduled` rows may indicate a dropped index, since that pair is what the constraint
refuses.

### Admin API Coverage

Covered through HTTP integration tests:
- `GET /admin/renewals`
- `GET /admin/renewals/:id`
- `POST /admin/renewals/:id/force`
- `POST /admin/renewals/:id/approve-changes`
- `POST /admin/renewals/:id/reject-changes`

This includes:
- success paths
- request validation failures
- domain validation failures
- filtered list behavior
- approval decision flows

### Admin Flow Coverage

The file [renewals-admin-flow.spec.ts](../../integration-tests/http/renewals-admin-flow.spec.ts) covers the main scenario-style backend flows used by the Admin UI:
- list renewals
- open renewal detail
- approve changes
- reject changes
- force renewal
- refresh detail and list
- verify final state

This is not a browser test.

It is an integration-level flow test using Medusa-supported tooling and the same custom Admin endpoints used by the UI.

### Cross-Area Smoke Coverage

The file [renewals-smoke.spec.ts](../../integration-tests/http/renewals-smoke.spec.ts) protects the main integration boundary with other plugin areas.

Covered behavior:
- renewal respects subscription operational state
- renewal applies approved pending changes back to the subscription state
- renewal does not bypass active `Plans & Offers` policy
- qualifying renewal payment failure starts `Dunning`
- future renewal execution respects lifecycle effects coming from `Cancellation & Retention`

This is intentionally a smoke-level integration check, not a full browser or system test.

This smoke-check is the main protection for the renewal boundary with:
- subscription eligibility rules
- approved pending change materialization
- current offer-policy revalidation at execution time
- dunning startup after payment-qualified renewal failure
- cancellation-driven pause and cancel eligibility effects

## 6. Commands

Run all HTTP integration tests:

```bash
yarn test:integration:http
```

Run all module integration tests:

```bash
yarn test:integration:modules
```

Run a single HTTP test file:

```bash
TEST_TYPE=integration:http NODE_OPTIONS=--experimental-vm-modules yarn jest --runInBand integration-tests/http/renewals-admin-flow.spec.ts
```

Run the workflow integration file:

```bash
TEST_TYPE=integration:http NODE_OPTIONS=--experimental-vm-modules yarn jest --runInBand integration-tests/http/renewals-workflows.spec.ts
```

Run the smoke-check file:

```bash
TEST_TYPE=integration:http NODE_OPTIONS=--experimental-vm-modules yarn jest --runInBand integration-tests/http/renewals-smoke.spec.ts
```

Run the module test file:

```bash
TEST_TYPE=integration:modules NODE_OPTIONS=--experimental-vm-modules yarn jest --runInBand src/modules/renewal/__tests__/service.spec.ts
```

## 7. What Is Intentionally Not Covered

The current test strategy does not include:
- exhaustive browser-based UI coverage (every validation state, every tooltip)
- visual regression testing

Reason:
- the main backend flows are thoroughly validated through HTTP integration tests, making exhaustive UI tests redundant and brittle
- E2E browser tests are reserved strictly for high-value merchant operational flows (like manual revenue recovery) to ensure the UI boundary is intact

## 8. How to Add New Tests

Use this rule of thumb:

- add a module test when the behavior belongs to the module service itself
- add an HTTP integration test when the behavior depends on real routes, workflows, auth, request validation, or linked Medusa modules
- add a scenario test when you want to protect a full operational Admin flow across multiple endpoints
- extend the smoke-check when changes affect integration with `Subscriptions`, `Plans & Offers`, or `Cancellation & Retention`

For new `Renewals` functionality:
- prefer extending the existing `renewals-*` test files if the change matches their scope
- create a new focused test file only when the flow becomes large enough to deserve its own scenario

## 9. Practical Guidance for Future Contributors

When changing the `Renewals` area:
1. update or add a module test if the service behavior changes
2. update or add an HTTP integration test if route behavior, validators, queries, workflows, or scheduler-facing behavior change
3. update the scenario flow if the main Admin operator flow changes
4. update the smoke-check if renewal semantics change at the boundary with `Subscriptions`, `Plans & Offers`, or `Cancellation & Retention`

If a feature changes the contract of:
- queue filtering
- queue sorting
- approval rules
- force-run rules
- returned detail payload
- renewal execution semantics

then the corresponding integration tests should be updated in the same change set.

## 10. Summary

The `Renewals` area is tested through Medusa-supported integration layers, augmented by targeted E2E browser automation for critical paths.

This provides strong protection for:
- domain behavior
- workflow behavior
- Admin API contract
- the main Admin operational flow
- the integration boundary with `Subscriptions` and `Plans & Offers`
- the merchant's ability to manually force or approve renewals in the Admin UI

It avoids brittle exhaustive UI testing, focusing browser automation only on critical operational recovery.
