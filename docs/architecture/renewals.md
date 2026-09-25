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
- a subscription that should have an upcoming renewal has exactly **one** live cycle row standing for it, and the database enforces that, not only the code (see *The one-upcoming-cycle invariant* below)
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
`subscription.next_renewal_at`. Two layers make that true:

**The reconciliation step.** `ensure-next-renewal-cycle` no longer looks for a row
by exact date and creates another one when it finds nothing; it asks
`resolveUpcomingCycle` (`src/modules/renewal/utils/upcoming-cycle.ts`) what to do
with the rows the subscription already carries, and that function answers one of
four actions:

| action | when | what is written |
| --- | --- | --- |
| `match` | a row already sits on `next_renewal_at`, whatever its status | that row's approval state and settings policy — or nothing at all, when the row is `processing`/`succeeded` or its approval state already agrees with what was derived |
| `adopt` | an open row (`scheduled` or `processing`) sits elsewhere and nothing is in flight under it | the same, plus `scheduled_for` moved onto the entitlement date |
| `defer` | the row that would be adopted carries a `generated_order_id` or is `processing` | nothing — and one warning line naming the cycle id and the order id |
| `create` | no open row at all | a fresh `scheduled` cycle |

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

**The constraint.** The index rejects a write that would leave two live `scheduled`
rows for one subscription, so drift cannot be created silently any more. On upgrade
the same migration first normalizes a database that already carries drift: the
duplicates are **soft-deleted** — never flipped to `failed`, which
`listDueRenewalCyclesForProcessing` selects alongside `scheduled` and would therefore
re-arm for a charge — and the row kept is the one already matching
`subscription.next_renewal_at`, falling back to the most recent one. `down()` drops
only the index and does not resurrect the normalized rows, because putting a second
chargeable cycle back on the scheduler's list is worse than the asymmetry.

**Boundary of the repair.** The step only ever deletes rows when the subscription
should have no upcoming cycle at all; it never deletes a row it does not own. A
duplicate that predates the migration is therefore removed by the normalization
above, not by the next purchase, and a live `scheduled` row left behind while the
entitlement-date row is terminal keeps being charged as soon as it is due. Nothing
in the selector can close that: the two orderings of `match` against `adopt` differ
only in which row is written, not in whether the stale row survives.

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

This keeps scheduler discovery lightweight and separate from Admin display concerns.

Because `Cancellation & Retention` can materialize `paused` and `cancelled` states back to `Subscription`, scheduler behavior must treat those lifecycle fields as the operational gate.

Current implications:
- `paused` subscriptions are not normally eligible for renewal execution
- `cancelled` subscriptions are not eligible for renewal execution
- due cycles after effective cancellation should not execute
- cycle records may still exist historically even when they are no longer eligible

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
- `src/modules/renewal/__tests__/upcoming-cycle.spec.ts` — the `match | adopt | defer | create` selector, including the pinned `match`-outranks-`adopt` precedence and the shared write/restore field list
- `integration-tests/http/subscription-from-order.spec.ts` — the stacking purchase end to end: one future `scheduled` row, the `defer` branch through the real workflow, and the index refusing a second live `scheduled` row
- `integration-tests/http/renewals-workflows.spec.ts`
- `integration-tests/http/renewals-routes.spec.ts`
- `integration-tests/http/renewals-admin-flow.spec.ts`
- `integration-tests/http/renewals-smoke.spec.ts`

Related documents:
- [Admin Renewals API](../api/admin-renewals.md)
- [Admin Renewals UI](../admin/renewals.md)
- [Renewals Testing](../testing/renewals.md)
- [Renewals Specs](../specs/renewals/admin-spec.md)
