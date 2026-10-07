# Renewals Architecture

This document describes the current architecture of the `Renewals` area in the `Reorder` plugin.

It focuses on the implemented system, not on the initial design assumptions.

## Goal

The `Renewals` area provides the execution and operational review layer for recurring subscription billing.

The current implementation supports:
- tracking renewal cycles and renewal attempts
- scheduled processing through a Medusa job
- manual force execution from Admin
- approval and rejection of pending subscription changes before renewal
- Admin queue and detail views for renewal operations
- integration with `Subscriptions` and `Plans & Offers`
- integration with `Dunning` for payment-qualified renewal failures
- retry ownership split by failure kind: payment-qualified failures hand off to an open dunning case, structural failures retry a bounded number of times and then abandon the cycle
- reconciliation of stuck `processing` cycles, with an Admin override for parked cycles
- operational hardening through workflow locking, correlation IDs, structured logs, and scheduler summary metrics

## Architectural Overview

The implementation is split into four main layers:

1. domain module
2. workflows and scheduled job
3. admin API
4. admin UI

Each layer has a clear responsibility:

- the domain module owns `renewal_cycle` and `renewal_attempt`
- workflows own execution, approval, rejection, and force-run mutations
- the scheduled job discovers due cycles and triggers the shared execution workflow
- the admin API exposes read and mutation routes for operational users
- the admin UI renders the queue and detail views and calls the Admin endpoints

## 1. Domain Module

The `renewal` custom module is the owner of the renewal execution domain.

It contains:
- domain types
- the `renewal_cycle` data model
- the `renewal_attempt` data model
- the module service
- read-model utilities for Admin queue, detail, and scheduler reads

Key design choices:
- one renewal cycle represents one concrete due renewal unit for one subscription
- a subscription that should have an upcoming renewal has exactly **one** live `scheduled` cycle row standing for it. The database refuses a second one on new writes, and the reconciliation step soft-deletes the extra live `scheduled` rows it finds (see *The one-upcoming-cycle invariant* below)
- attempt history is stored separately from the cycle aggregate
- the cycle stores operational state and selected execution summary fields directly
- the subscription remains the source of active subscribed state, while the cycle remains the source of execution history

## 2. Data Model

The `renewal_cycle` model stores:
- identity and scheduling fields
- execution status
- approval state
- generated order reference
- last error summary
- applied pending change snapshot
- attempt counter and metadata

Core `renewal_cycle` fields include:
- `id`
- `subscription_id`
- `scheduled_for`
- `processed_at`
- `status`
- `approval_required`
- `approval_status`
- `approval_decided_at`
- `approval_decided_by`
- `approval_reason`
- `generated_order_id`
- `applied_pending_update_data`
- `last_error`
- `attempt_count`
- `last_failure_kind`
- `structural_attempt_count`
- `metadata`

The `renewal_attempt` model stores:
- `id`
- `renewal_cycle_id`
- `attempt_no`
- `started_at`
- `finished_at`
- `status`
- `error_code`
- `error_message`
- `payment_reference`
- `order_id`
- `metadata`

### Cycle status and failure bookkeeping

`renewal_cycle.status` carries six values:

| status | meaning |
| --- | --- |
| `scheduled` | live upcoming cycle; the only status a new cycle is created in |
| `processing` | a run holds it (workflow lock); transient |
| `succeeded` | the period was paid and finalized (possibly with no order — the trial-end branch) |
| `failed` | the last attempt failed; a bounded scheduler retry still applies |
| `abandoned` | **terminal.** The period was written off: consecutive structural failures reached `renewal_max_attempts`, or dunning exhausted. Never retried, never selected by the due query. The subscription is left `past_due` and `renewal.abandoned` is emitted; the host decides what happens next — this plugin never cancels a subscription as a side effect |
| `awaiting_manual_resolution` | **parked, non-terminal.** A stuck `processing` cycle whose payment state could not be decided. The period is neither paid nor written off; a human resolves it through the Admin resolve-stuck route |

Two fields back the failure bookkeeping:

- `last_failure_kind` records `classifyRenewalFailure`'s verdict for the last
  failed attempt (`order_creation_failed`, `unexpected_error`, payment kinds,
  …), so retry ownership is decided from the recorded verdict instead of being
  re-derived.
- `structural_attempt_count` counts **consecutive structural** (non-payment)
  failures and is compared against the `renewal_max_attempts` setting. It is
  deliberately a separate counter from `attempt_count`: `attempt_count` also
  counts payment attempts owned by dunning, so capping on it would abandon
  cycles whose payment retries are still legitimately in flight. It resets to
  `0` on success.

### Indexing Strategy

The current migrations and model setup optimize the renewal queue for:
- lookup by `subscription_id`
- filtering by `status`
- filtering and ordering by `scheduled_for`
- Admin filtering and sorting by operational fields
- attempt history lookup by `renewal_cycle_id`

plus one constraint rather than one lookup:

- `renewal_cycle_one_scheduled_per_subscription`, a partial unique index on
  `subscription_id` restricted to `status = 'scheduled' and deleted_at is null`
  (`src/modules/renewal/migrations/Migration20260924120000.ts`). It is
  hand-authored because the model generator cannot express the extra `status`
  predicate, and a later `medusa plugin:db:generate` may propose dropping it — that
  drop would be a regression, not cleanup.

### The one-upcoming-cycle invariant

For a subscription that should have an upcoming renewal, exactly one live
`renewal_cycle` row stands for it, and it carries `scheduled_for` equal to
`subscription.next_renewal_at`. The count is the enforced half, and two layers do
different jobs in it: the partial unique index below refuses a **new** live
`scheduled` row for a subscription that already holds one, and the reconciliation
step soft-deletes the live `scheduled` row it finds beside the row it keeps. Neither
one is the whole invariant on its own — the index predicate is
`status = 'scheduled' and deleted_at is null`, so a `succeeded` or `failed` row on
the entitlement date with one live `scheduled` neighbour is a shape the constraint
permits and only the step clears, while the step only runs when something re-runs
its workflow. The date holds whenever the step can write, with one deliberate
exception — `defer` leaves a row on its own date rather than move money that is
already in flight, and says so in the log.

**The reconciliation step.** `ensure-next-renewal-cycle` no longer looks for a row
by exact date and creates another one when it finds nothing; it asks
`resolveUpcomingCycle` (`src/modules/renewal/utils/upcoming-cycle.ts`) what to do
with the rows the subscription already carries, and that function answers one of
four actions:

| action | when | what is written |
| --- | --- | --- |
| `match` | a row already sits on `next_renewal_at`, whatever its status | that row's approval state and settings policy — or nothing to that row at all, when it is `processing`/`succeeded` or its approval state already agrees with what was derived. Either way the run's `retire` set is still acted on (see *The retire* below) |
| `adopt` | an open row (`scheduled` or `processing`) sits elsewhere and nothing is in flight under it | the same, plus `scheduled_for` moved onto the entitlement date, and the same `retire` set |
| `defer` | the row that would be adopted carries a `generated_order_id` or is `processing` | nothing to the protected row, plus the `retire` set — and one warning line naming the cycle id and the order id |
| `create` | no open row at all | a fresh `scheduled` cycle, and no `retire` set: reaching this action means there was no open row to leave behind |

`match` outranks `adopt` for every status; that precedence is a pinned contract, not
an accident of the code's order. Adopting a row that sits behind a settled
(`succeeded`/`failed`) row on the entitlement date would put a second chargeable
cycle onto a period that already ended, which is the failure the invariant exists to
remove. A past-dated `scheduled` row with no order is adopted rather than left
behind, because `process-renewal-cycle` moves anything it works on to `processing`,
so an untouched `scheduled` row is unclaimed.

`adopt` is a reschedule, not a replacement: the row keeps its id, its
`renewal_attempt` children and its `generated_order_id` history. The step compensates
a reconciliation write from one field list shared with the write itself
(`UpcomingCycleReconcilePatch` and the restore type derived from it), so adding a
column to the write without adding it to the rollback is a type error rather than a
half-repaired row. The `deleted` compensation (taken when a subscription should no
longer have an upcoming cycle) restores at most one row live and recreates any
extras soft-deleted, because restoring two would violate the index in the middle of
a rollback.

**The retire.** `match`, `adopt` and `defer` each answer with a second field
alongside the row they chose: `retire`, the subscription's other live `scheduled`
rows that carry no `generated_order_id` (`collectRetirable`,
`src/modules/renewal/utils/upcoming-cycle.ts:229-239`) — exactly the rows the
decision neither moves nor deletes. `ensure-next-renewal-cycle` acts on that set on
every path that can carry it: the two that return early for their own reason
(`retireAndDefer`, `retireAndReportUnchanged`) and the one that reports a completed
reconciliation write (`retireAndReportReconciled`),
`src/workflows/steps/ensure-next-renewal-cycle.ts:160-413`. Acting on it is a write
with a re-read in front of it: the step lists the named ids again, keeps only the
rows that still read `scheduled` with no order, and soft-deletes those. A row that
took on money between the selector's read and this write — `create-manual-renewal`
stamps `generated_order_id` on a due `scheduled` row and leaves its status alone, and
no lock on either side is subscription-scoped — is left live and said out loud as
`withheld … from retirement: no longer an uncharged scheduled cycle`, so the log
records which half of the decision the write actually took rather than leaving an
unexplained survivor.

- The delete is soft. The row keeps its id, its `renewal_attempt` children (the
  model declares no soft-remove cascade, so a retire cannot orphan them), its
  `scheduled_for` and its status; what changes is visibility — the scheduler's due
  read no longer selects it, and neither do the Admin renewal reads.
- A retirement always logs. There is no silent path: the line is
  `[reorder] retired N stale upcoming renewal cycle(s) of subscription '<id>' (<row ids>) behind '<kept or moved row id>'`,
  and it is written after the delete lands, so a line never claims a row that is
  still live. The soft delete is the step's only write on that row, so `status`,
  `scheduled_for` and `last_error` keep their values — the
  `last_error` normalization marker is stamped only by this release's migration,
  which is how a table read tells the two provenances apart.
- The run's reported action follows the write. A `match` that wrote nothing to its
  own row but cleared a neighbour reports `retired` instead of `noop`, while a
  `defer` keeps reporting `deferred` — the promise that branch makes is about the row
  it refuses to move, and the retirement it does make is on the log.
- A rollback undoes it and says so: `restoreRetiredUpcomingCycles` clears
  `deleted_at` on the ids the run named and logs
  `restored N retired upcoming renewal cycle(s) … the retirement was rolled back and
  these rows are chargeable again`
  (`src/workflows/steps/ensure-next-renewal-cycle.ts:231-248`). On the `updated` /
  `adopted` paths the retire rides inside the same compensation as the row snapshot,
  and a retire that throws is reported as a permanent step failure carrying that
  compensation (`StepResponse.permanentFailure`,
  `src/workflows/steps/ensure-next-renewal-cycle.ts:396-402`) instead of propagating
  out of `invoke` — a step that throws without a response is a step the engine never
  compensates, and the reconciliation write above it would have stayed applied.
- One retirement line is not evidence that a host lost the index. The
  `succeeded`/`failed`-on-the-entitlement-date shape above retires on a database
  where the constraint stands. A subscription holding two live `scheduled` rows may
  indicate a dropped index, because that pair is precisely what the constraint
  refuses.

**The constraint.** The index rejects a write that would leave two live `scheduled`
rows for one subscription, so drift cannot be created silently any more. On upgrade
the same migration first normalizes a database that already carries drift: the
duplicates are **soft-deleted** — never flipped to `failed`, which
`listDueRenewalCyclesForProcessing` selects alongside `scheduled` and would therefore
re-arm for a charge — and the row kept is the one already matching
`subscription.next_renewal_at`, falling back to the most recent one. `down()` drops
only the index and does not resurrect the normalized rows, because putting a second
chargeable cycle back on the scheduler's list is worse than the asymmetry.

**Boundary of the repair.** The step writes a delete in two situations: when the
subscription should have no upcoming cycle at all (the `deleted` branch, which
hard-deletes and is compensated by re-inserting the snapshot), and when a
reconciliation leaves a live `scheduled` row standing beside the row it keeps or
moves (the retire, which soft-deletes). It never deletes a row it does not own: the
`defer` row, any `processing` row and any row already carrying a
`generated_order_id` are outside the retire set by construction, and a row that
stopped qualifying between the two reads drops out of the write. A duplicate that
predates the migration is removed by the normalization above at upgrade time; a
duplicate that appears afterwards exists only where the index no longer stands, and
the next run of this workflow retires one half of it rather than leaving both
chargeable. The selector itself still decides nothing about a stale row's fate — it
names the rows, and the write half above is what clears them.

## 3. Execution Semantics

`Renewals` use the subscription as the source of current operational state and optionally apply approved `pending_update_data` during execution.

The current implementation follows these rules:
- only eligible subscriptions may renew
- pending changes are only considered when they are effective for the cycle date
- approval is enforced when the cycle requires it
- `Plans & Offers` are re-resolved at execution time before pending changes are applied
- successful execution updates the subscription’s active cadence and clears applied `pending_update_data`
- the cycle records whether pending changes were actually applied

This means:
- `Subscriptions` own active subscription state
- `Plans & Offers` own current policy validation
- `Renewals` own execution state and outcome history

The implemented `Cancellation & Retention` area does not change `Renewals` ownership.

Current boundary with `Cancellation & Retention`:
- `Renewals` do not own cancellation process state
- `Cancellation & Retention` do not own renewal-cycle execution history
- future cycle eligibility is derived from `Subscription` lifecycle state rather than by moving cycle ownership into the cancellation module

In runtime terms:
- future cycles must respect `Subscription.status`
- future cycles must respect `cancel_effective_at`
- future cycles must respect `next_renewal_at`
- `pause` and `cancel` affect eligibility, not ownership of `renewal_cycle` records

### Retry ownership — one predicate, two consumers

Who may move a renewal cycle next is decided by one disposition predicate,
`resolveCycleDisposition` (`src/modules/renewal/utils/cycle-disposition.ts`),
consumed both by the scheduler's due query and by the `process-renewal-cycle`
step, so ownership cannot drift between the two. Evaluated top to bottom:

| disposition | when | consequence |
| --- | --- | --- |
| `settled` | cycle status is `succeeded`, `abandoned`, or `awaiting_manual_resolution` | terminal or parked — neither the scheduler nor the step may reopen it (`processing` is deliberately not adjudicated here; it is in-flight state owned by the workflow lock) |
| `not_chargeable` | subscription status is not `active`/`past_due` (paused, cancelled), or `cancel_effective_at` is at or before the cycle's `scheduled_for`, or the row is a native mirror (the provider charges it), or it is manual-mode outside the trial carve-out | dropped from the due set; the scheduler never charges or fails it |
| `dunning_owns` | an **open** dunning case exists for the cycle (`open`, `retry_scheduled`, `retrying`, `awaiting_manual_resolution`) | the case owns the retry timing; the scheduler must not touch the cycle |
| `trial_end` | a manual-mode trial whose cycle is at or after `trial_ends_at` | the one manual cycle the scheduler picks up, so the deterministic trial-end branch can run on time; that branch never charges |
| `charge` | everything else | the normal off-session charge path |

The due query (`listDueRenewalCyclesForProcessing`) still selects only
`[scheduled, failed]` rows with `scheduled_for <= now`, then drops everything
the predicate excludes. What the exclusions fix, concretely: a paused or
cancelled subscription's leftover cycle used to be selected, rejected by the
step, re-marked `failed`, and selected again five minutes later — an infinite
loop that also minted a fresh `renewal.failed` each pass. Cycles excluded by
the predicate keep their status and are simply not selected.

Step-level rules in `process-renewal-cycle`:

- `abandoned` and `awaiting_manual_resolution` are rejected defensively even
  though the due query excludes them, because manual force runs bypass the
  query.
- On failure the verdict is written to `last_failure_kind`. **Blocked
  outcomes** (`already_processing`, `duplicate_execution`) are not failures:
  they increment neither counter.
- A **payment-qualified** failure hands its retries to dunning — the new open
  case then holds the `dunning_owns` disposition. If `startDunningWorkflow`
  itself throws, the failure is treated as **structural** (alertable event,
  counted toward the cap): a payment failure whose recovery machinery could
  not start must never be silently retried forever.
- A **structural** failure increments `structural_attempt_count`. At or above
  `renewal_max_attempts` the cycle becomes `abandoned` and `renewal.abandoned`
  is persisted and emitted; below the cap it stays `failed` for a bounded
  retry. Structural failures reproduce deterministically (missing cart,
  missing payment context), which is why they cap out instead of looping. The
  payment-context guard sits **ahead of order creation**: a subscription that
  cannot be charged fails without minting an order (the check used to sit
  after the order workflow, and every retry minted one orphan order per
  attempt up to the cap).
- On success `structural_attempt_count` resets to `0`.

### The catch-up charge after a late recovery (do not "fix" this)

Period finalization — the shared step consumed by the automatic success path,
dunning recovery, and stuck-cycle reconciliation — advances the subscription
cadence **anchored on the cycle's own `scheduled_for`, never on `now`**. This
is deliberate: it keeps the billing anchor from drifting by the recovery
delay.

The documented consequence: **a period recovered days late leaves the next
period immediately due.** A cycle scheduled on the 1st that is recovered on
the 8th produces the next `scheduled_for` on the following period's 1st — in
the past — so the scheduler bills it on the next pass: a catch-up charge for
the following period, exactly as if the late period had been paid on time.
`complete-manual-renewal` uses `max(now, scheduled_for)` for a different
reason (a manual payment can arrive arbitrarily late); mixing the two rules
would make the anchor depend on which rail paid. A future reader who sees the
past-dated next cycle and "fixes" the anchor to `now` reintroduces date
drift — the original anchor is the contract.

## 4. Read Path

The read path is optimized for the Admin renewal queue and cycle detail.

Main components:
- admin route handlers under `src/api/admin/renewals`
- normalization helpers in `src/api/admin/renewals/utils.ts`
- query helpers in `src/modules/renewal/utils/admin-query.ts`
- scheduler-specific query helper in `src/modules/renewal/utils/scheduler-query.ts`

### Queue Flow

For the queue view:
1. the Admin UI sends query params to `GET /admin/renewals`
2. the route validates and normalizes query input
3. `listAdminRenewals(...)` applies filters, sorting, pagination, and linked summary resolution
4. the query layer reads renewal cycles and latest attempts
5. the response is mapped to Admin DTOs used by the queue DataTable

The Admin read model distinguishes between:
- `scheduled_for` as the operational cycle date owned by `renewal_cycle`
- `effective_scheduled_for` as the projected delivery date shown when the linked subscription has `skip_next_cycle = true`

Supported queue capabilities include:
- pagination
- search
- filtering
- sorting
- latest-attempt summary resolution

### Detail Flow

For the detail view:
1. the Admin UI requests `GET /admin/renewals/:id`
2. the route resolves the cycle through the detail query helper
3. linked subscription and generated-order summaries are resolved
4. attempt history and pending-change summary are mapped into the detail DTO

The detail payload represents:
- the cycle aggregate
- approval summary
- linked subscription summary
- linked order summary
- pending changes
- attempt history
- metadata

This keeps the operational cycle source of truth intact while allowing the Admin UI to show the projected post-skip delivery date.

### Scheduler Read Flow

The scheduled job uses a dedicated scheduler query rather than the Admin read model.

It selects due cycles by:
- `status in [scheduled, failed]`
- `scheduled_for <= now`
- approval-eligible state when approval is required

and then drops every cycle the disposition predicate excludes (see *Retry
ownership*): subscriptions not `active`/`past_due`, cancellations already
effective for the cycle date, native mirror rows, manual-mode rows outside the
trial-end carve-out, and cycles whose recovery an open dunning case owns. The
exclusion filter runs after pagination, so a page consisting solely of
excluded cycles returns an empty batch until the next offset pass.

This keeps scheduler discovery lightweight and separate from Admin display concerns.

Lifecycle fields are the operational gate, now enforced by the query itself
rather than only by step-level checks:
- `paused` subscriptions are not selected for renewal execution
- `cancelled` subscriptions are not selected for renewal execution
- due cycles after effective cancellation are not selected
- cycle records may still exist historically even when they are no longer selected

A second read serves the stuck-cycle reconciliation job
(`listStuckProcessingRenewalCycles`): cycles still `processing` whose
`updated_at` is older than 30 minutes — far beyond any legitimate provider
call — are presumed crashed runs. `awaiting_manual_resolution` is deliberately
not returned here: a parked cycle waits for a human, and re-processing it
would undo the park.

## 5. Write Path

All state-changing renewal operations are routed through workflows.

Implemented mutations:
- process renewal cycle
- force renewal cycle
- approve renewal changes
- reject renewal changes

Write path pattern:
1. the scheduler or Admin route submits a workflow input
2. the workflow validates the current cycle and subscription state
3. the workflow applies execution or decision logic
4. the route returns the refreshed renewal detail payload for Admin mutations

This keeps business logic out of routes and centralizes mutation rules in workflows.

## 6. Workflows

The current renewal mutation layer is built around:
- `process-renewal-cycle`
- `force-renewal-cycle`
- `approve-renewal-changes`
- `reject-renewal-changes`
- `reconcile-stuck-renewal-cycle`

### Core Execution Workflow

`process-renewal-cycle` is the shared execution workflow used by:
- the scheduler job
- manual `force renewal`

It is responsible for:
- validating concurrency and state
- validating subscription eligibility
- validating approval requirements
- re-validating `Plans & Offers` policy for pending changes
- creating the renewal attempt
- updating cycle status
- creating the renewal order when applicable
- starting `Dunning` when payment-qualified renewal failures happen after order creation
- updating subscription cadence and snapshots
- recording success or failure

Current implementation detail:
- the workflow acquires a Medusa workflow lock with key `renewal:${renewal_cycle_id}`
- the current lock settings are `timeout = 10` seconds and `ttl = 120` seconds
- this shared lock protects both scheduler execution and manual force execution

Period finalization is extracted into one shared step,
`finalize-renewal-period` (`src/workflows/steps/finalize-renewal-period.ts`):
mark the cycle `succeeded`, advance the cadence anchored on `scheduled_for`,
set `last_renewal_at`, clear applied pending changes, reset
`structural_attempt_count`, ensure the next cycle, and persist + emit
`renewal.succeeded`. The automatic path, dunning recovery, and stuck-cycle
reconciliation all settle a paid period through the same semantics (see *The
catch-up charge after a late recovery* above for the anchor rule).

### Stuck-`processing` reconciliation

A hard process death between the capture and the `SUCCEEDED` write can strand
a cycle in `processing` with money taken. The hourly
`recover-stuck-renewal-cycles` job finds cycles that are still `processing`
after 30 minutes, discovers the order the crashed attempt created through the
`renewal_cycle` ↔ `order` link (not `generated_order_id`, which is only
written by the successful end of a run), and applies a three-row decision
table:

| Observed state | Action |
| --- | --- |
| Linked order's payment confirmed captured | Finalize the period `succeeded` via the shared finalization step |
| No linked order, or payment confirmed not captured | Return the cycle to `failed` with an explanatory `last_error`; normal retry ownership applies |
| Anything else (authorized not captured, unreadable, ambiguous provider state) | **Park** the cycle as `awaiting_manual_resolution`; the subscription is left untouched |

The third row is deliberate: "we do not know" must not be recorded as "there
is no hope", so an ambiguous outcome is parked — never collapsed into
`abandoned` — and `renewal.awaiting_manual_resolution` is emitted.

### Resolve-stuck route

`POST /admin/renewals/:id/resolve-stuck` with `{ outcome: "succeeded" | "failed" | "abandoned", reason }`
is the operator entry point. It accepts a cycle in `processing` or in
`awaiting_manual_resolution` (so a parked cycle has a way out), applies the
operator's override, and records the actor and reason in the activity log.

### Approval Workflows

`approve-renewal-changes` and `reject-renewal-changes` are the mutation boundary for approval decisions.

They are responsible for:
- validating that approval is required
- blocking duplicate decisions
- storing who decided, when, and why
- updating the cycle approval state

### Force Workflow

`force-renewal-cycle` is the Admin-facing operational mutation.

It is responsible for:
- validating that the cycle can be manually forced
- enforcing approval requirements before force-run
- delegating actual execution to the shared core renewal workflow
- attaching a manual-operation correlation ID used by structured operational logging

## 7. Scheduled Processing

`Renewals` are processed by the scheduled job:

- `src/jobs/process-renewal-cycles.ts`

The job:
- runs every five minutes
- discovers due cycles in batches
- executes the shared renewal workflow for each cycle
- logs per-cycle outcomes
- emits a structured run summary with counters and duration

The scheduler does not implement a separate business flow. It reuses the same core execution logic as manual force.

## 8. Concurrency and Operational Hardening

The renewal execution workflow already uses Medusa workflow locking around the critical execution path.

Current hardening includes:
- lock key based on `renewal_cycle_id`
- anti-duplication through state validation
- structured operational logging
- generated correlation IDs for scheduler and manual force flows
- per-cycle and per-job outcome logging
- summary counters for:
  - success count
  - failure count
  - blocked count
  - processing duration

Alert-oriented log classification currently distinguishes between:
- already processing
- duplicate execution
- subscription not eligible
- approval blocked
- offer policy blocked
- order creation failure
- unexpected runtime failure

Operational implementation note:
- structured renewal observability lives in `src/modules/renewal/utils/observability.ts`
- the scheduler job logs per-run and per-cycle summaries
- the core execution step and manual force flow emit correlation-aware operational events

## 8.1 Boundary with Cancellation & Retention

`Cancellation & Retention` now participates in the recurring-commerce runtime boundary, but it does so through subscription lifecycle effects rather than by taking over renewal ownership.

Current runtime split:
- `RenewalCycle` remains the source of truth for renewal scheduling and execution history
- `CancellationCase` remains the source of truth for churn handling decisions
- subscription lifecycle fields are the integration point between those domains

## 9. Admin API Architecture

The Admin API exposes custom routes dedicated to renewal monitoring and operational actions.

Implemented read routes:
- `GET /admin/renewals`
- `GET /admin/renewals/:id`

Implemented mutation routes:
- `POST /admin/renewals/:id/force`
- `POST /admin/renewals/:id/approve-changes`
- `POST /admin/renewals/:id/reject-changes`
- `POST /admin/renewals/:id/resolve-stuck`

The API layer uses:
- Zod validators
- authenticated admin requests
- query helpers for reads
- workflows for mutations

## 10. Admin UI Architecture

The Admin UI is implemented as custom Medusa Admin routes nested under `Subscriptions`.

Current screens:
- renewals queue page
- renewal cycle detail page

### Queue Page

The queue page is built with Medusa `DataTable`.

It supports:
- pagination
- search
- filters
- sorting
- row navigation to detail
- default scheduled date range on mount

Implemented route file:
- `src/admin/routes/subscriptions/renewals/page.tsx`

### Detail Page

The detail page contains:
- cycle overview
- approval summary
- subscription summary
- generated order summary
- pending changes
- attempt history
- technical metadata
- action menu with `force`, `approve`, and `reject`

Decision flows use Drawers and confirm prompts in the standard Medusa style.

Implemented route file:
- `src/admin/routes/subscriptions/renewals/[id]/page.tsx`

## 11. Query Invalidation Strategy

The Admin UI uses explicit invalidation for renewal list and detail queries.

After a successful mutation:
- the renewals list query is invalidated
- the renewal detail query is invalidated

This keeps queue state and detail state synchronized after operator actions.

Implementation detail:
- list and detail display queries are centralized in `src/admin/routes/subscriptions/renewals/data-loading.ts`
- invalidation is shared through `invalidateAdminRenewalsQueries(...)`
- approval drawers use local form state and already-loaded detail data rather than a separate remote display query

## 12. Error and Loading Handling

The `Renewals` UI follows Medusa-style state handling:
- the queue uses DataTable loading and empty states
- the detail page shows explicit loading and error states
- decision drawers show local loading and inline error states
- risky actions require operator confirmation

This keeps display data separate from drawer-only form state and matches the existing Admin UX patterns used elsewhere in the plugin.

## 13. Testing Strategy

`Renewals` are protected through:
- module integration tests
- HTTP integration tests for query helpers, workflows, and routes
- an Admin flow integration test
- a smoke-level integration test against `Subscriptions` and `Plans & Offers`

Implemented test files:
- `src/modules/renewal/__tests__/service.spec.ts`
- `src/modules/renewal/__tests__/upcoming-cycle.spec.ts` — the `match | adopt | defer | create` selector, including the pinned `match`-outranks-`adopt` precedence, the `retire` set the first three carry and the absence of one on `create`, and the shared write/restore field list
- `src/modules/renewal/__tests__/retire-stale-cycles.spec.ts` — the write half: `retireStaleUpcomingCycles` with its re-read qualification and `withheld` report, the `defer` / unchanged / reconciled wrappers and what each reports, and the rollback dispatcher with the retired-row restore
- `src/modules/renewal/__tests__/reconcile-restore.spec.ts` — `restoreReconciledCycle`, pinned to every column a reconciliation patch may write
- `integration-tests/http/subscription-from-order.spec.ts` — the stacking purchase end to end: one future `scheduled` row, the `defer` branch through the real workflow, the index refusing a second live `scheduled` row, the retire behind a terminal entitlement-date row with the index up, the retire beside an adopted or deferred row inside an index window, and the applied adopt rolled back when the retirement fails
- `integration-tests/http/renewal-retry-ownership.spec.ts` — the disposition exclusions end to end: paused and cancelled subscriptions drop out of the due set, an open dunning case takes ownership, a closed case releases it, and a manual trial's trial-end cycle stays processable while a manual non-trial cycle does not
- `integration-tests/http/renewal-failure-cap.spec.ts` — the structural cap: structural failures abandon at `renewal_max_attempts`, payment failures do not increment the structural counter, a payment failure whose dunning start fails still terminates at the cap, and blocked outcomes increment nothing
- `integration-tests/http/reconcile-stuck-renewal-cycle.spec.ts` — the three-row decision table (captured → finalized, not captured → retryable, ambiguous → parked), job idempotency, and the parked cycle staying out of the stuck scan
- `integration-tests/http/resolve-stuck-route.spec.ts` — the operator override from `processing` and from `awaiting_manual_resolution`, with the reason recorded
- `integration-tests/http/renewal-reminders.spec.ts` — the lookahead job emitting `renewal.upcoming` / `subscription.trial_ending` exactly once, including manual subscriptions, excluding paused/cancelled
- `integration-tests/http/trial-conversion.spec.ts` — the trial-end three-way decision (convert on auto with a usable method, deterministic end on manual, end with an alertable reason without one) and the native row never charged
- `integration-tests/http/migrations.spec.ts` — the migration harness, including which duplicate shapes a migrated database can actually hold
- `integration-tests/http/renewals-workflows.spec.ts`
- `integration-tests/http/renewals-routes.spec.ts`
- `integration-tests/http/renewals-admin-flow.spec.ts`
- `integration-tests/http/renewals-smoke.spec.ts`

Related documents:
- [Admin Renewals API](../api/admin-renewals.md)
- [Admin Renewals UI](../admin/renewals.md)
- [Renewals Testing](../testing/renewals.md)
- [Renewals Specs](../specs/renewals/admin-spec.md)
