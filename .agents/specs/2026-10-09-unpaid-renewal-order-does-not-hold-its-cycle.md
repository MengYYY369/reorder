# Spec: An unpaid renewal order does not hold its cycle back

## TLDR & Overview

`ensureNextRenewalCycleStep` reconciles the subscription's upcoming cycle
against `subscription.next_renewal_at` (the entitlement date). Its decision
module, `resolveUpcomingCycle`, treats **any** `generated_order_id` on a
`scheduled` row as "money is in motion" (`hasInFlightRenewal`), so the row is
never adopted, never retired, and the whole reconciliation answers `defer` —
the one branch that writes nothing.

That over-approximation is load-bearing only for a row whose order can still
be paid. A row whose order was **positively never charged** — no payment
record at all, or every payment canceled — is not in flight: nothing is
moving, and the code's own analysis says no webhook can start it
(`reconcile-stuck-renewal-cycle.ts`'s `readOrderPaymentVerdict` already draws
exactly that line, and answers `not_captured` for it).

Production hit this on 2026-10-08: a customer prepaid a cycle with the new
"renew now" flow, the entitlement date moved `2026-10-20` → `2026-11-20`, and
the only cycle row — `scheduled_for = 2026-10-13`, carrying an order whose
payment collection has zero `payment` rows — pinned the reconcile into
`defer`. Result: **no cycle on the new entitlement date**, and a row that
becomes chargeable the moment the subscription leaves `manual` mode.

This spec teaches the reconcile to read the order's payment verdict, and to
**retire** a row whose order was never charged instead of deferring on it.

## Decisions already taken (user, 2026-10-09)

- **Fix the cause, not the symptom.** The user asked for "K2 治本": the
  `hasInFlightRenewal` predicate is the cause; the operator SQL that cleaned
  production was the symptom fix.
- **Direction A, not B.** B (a `scheduled_for < next_renewal_at →
  not_chargeable` guard in `resolveCycleDisposition`) would stop the double
  charge but would not restore the missing cycle. Recorded here as a
  deliberate non-goal; see "Known limitations".

## Root cause, with the evidence it was read from

### 1. The predicate never asks the order anything

`src/modules/renewal/utils/upcoming-cycle.ts`:

```ts
function hasInFlightRenewal(cycle: UpcomingRenewalCycleRecord) {
  return (
    cycle.status === RenewalCycleStatus.PROCESSING ||
    cycle.generated_order_id != null
  )
}
```

Its own header explains the case it was written for — `create-manual-renewal`
"reuses a due `scheduled` row without touching its status and only stamps
`generated_order_id`, so an order can sit unpaid on a row that still reads
`scheduled`". The header's conclusion, "moving that row's date would re-arm a
cycle that is already billed", is true for a row the customer is about to pay
and false for a row nobody will ever pay.

### 2. `defer` is the only branch that writes nothing

`resolveUpcomingCycle` has four arms. `match`, `adopt` and `create` all write;
`defer` returns `retire` for its neighbours and does nothing else. So a
deferred candidate leaves the subscription with **no row on the entitlement
date at all**.

### 3. Production state, 2026-10-08 19:23:39

```
subscription 01M47SSSRTADRG586CK53AZNWG
  next_renewal_at = 2026-11-20 05:08:23.447+00   (prepaid +1 cadence)
  is_trial = false, trial_ends_at = NULL, payment_mode = manual

renewal_cycle 01M47SSSV4WSSZE7PBHCXFW4WR
  status = scheduled, scheduled_for = 2026-10-13 05:08:23.447+00
  generated_order_id = order_01M4E4XNPYPEQHGFAG75CNTBKR

order_01M4E4XNPYPEQHGFAG75CNTBKR (display_id 57)
  status = pending
  payment_collection pay_col_01M4E4XP4A5VPZ9XEV5YD4X7J2
    status = not_paid, captured_amount = 0, payment rows = 0
```

and the warning the step emitted:

```
[reorder] left upcoming renewal cycle '01M47SSSV4WSSZE7PBHCXFW4WR' of
subscription '01M47SSSRTADRG586CK53AZNWG' untouched: status 'scheduled'
carries renewal order 'order_01M4E4XNPYPEQHGFAG75CNTBKR' in flight while
the entitlement date is '2026-11-20T05:08:23.447Z'
```

That is the `defer` branch at
`src/workflows/steps/ensure-next-renewal-cycle.ts:775`.

### 4. The two consequences

1. **No cycle on the entitlement date.** `set-subscription-auto-renew.ts` does
   not call `ensureNextRenewalCycleStep` (checked against every call site), so
   flipping auto-renewal on afterwards does not repair it — the scheduler has
   nothing to fire.
2. **The stranded row stays chargeable.** `resolveCycleDisposition`
   (`src/modules/renewal/utils/cycle-disposition.ts:162-175`) answers
   `not_chargeable` for a `manual` row only; every other mode falls through to
   `charge`. Nothing in `process-renewal-cycle.ts` compares `scheduled_for`
   against `next_renewal_at`.

`is_trial` / `trial_ends_at` are no shield: the prepay is what clears them.

## The verdict the codebase already knows how to read

`readOrderPaymentVerdict` (`src/workflows/steps/reconcile-stuck-renewal-cycle.ts:234`)
already answers `captured` / `not_captured` / `ambiguous` for an order, from
`order_payment_collection` → `payment_collection.status` + `payments.status`,
with the deliberate rule that anything it cannot positively read is
`ambiguous` ("we do not know" must never be recorded as "there is no hope").

This spec reuses that primitive rather than inventing a second one. It is
currently module-private; the first phase lifts it into
`src/workflows/utils/order-payment-verdict.ts` and both steps import it.

## Proposed Architecture

### Phase 1 — lift the verdict reader

New `src/workflows/utils/order-payment-verdict.ts`:

```ts
export type OrderPaymentVerdict = "captured" | "not_captured" | "ambiguous"

export async function readOrderPaymentVerdict(
  container: MedusaContainer,
  orderId: string
): Promise<OrderPaymentVerdict>
```

Body moved verbatim from `reconcile-stuck-renewal-cycle.ts` (including its
doc comment, which is the justification for each branch).
`reconcile-stuck-renewal-cycle.ts` imports it and drops its local copy; its
`resolveStuckRenewalOutcomeStep` behaviour is unchanged.

### Phase 2 — the decision module learns about supersession

`upcoming-cycle.ts` gains one concept and one optional parameter:

```ts
export type UpcomingCycleOrderVerdicts = ReadonlyMap<
  string,
  OrderPaymentVerdict
>

/**
 * A `scheduled` row whose `generated_order_id` names an order that was
 * positively never charged.
 */
function isSupersededCycle(
  cycle: UpcomingRenewalCycleRecord,
  verdicts: UpcomingCycleOrderVerdicts
) {
  if (cycle.status !== RenewalCycleStatus.SCHEDULED) return false
  const orderId = cycle.generated_order_id
  if (!orderId) return false
  return verdicts.get(orderId) === "not_captured"
}

export function resolveUpcomingCycle(
  cycles: UpcomingRenewalCycleRecord[],
  scheduledFor: Date,
  verdicts: UpcomingCycleOrderVerdicts = new Map()
): UpcomingCycleResolution
```

Three changes inside:

1. **Candidacy excludes superseded rows.** `candidate` is the latest row
   passing `isOpenUpcomingCycle(cycle) && !isSupersededCycle(cycle, verdicts)`.
   A row whose order was never charged cannot stand for the upcoming renewal:
   adopting it would move a stale order onto the new period, and
   `create-manual-renewal` reuses a due row's `generated_order_id` verbatim.
2. **`collectRetirable` accepts superseded rows.** The qualification widens from
   "`scheduled` and uncharged" to "`scheduled` and (uncharged **or** superseded)".
3. **`create` carries `retire`.** Reaching `create` with superseded rows present
   is now possible, and `renewal_cycle_one_scheduled_per_subscription` (a
   partial unique index on `(subscription_id) WHERE status = 'scheduled' AND
   deleted_at IS NULL`) means the retire **must** happen before the insert.
   `create` is the one arm that previously had no `retire`, because reaching it
   used to imply no open row existed.

A verdict map with no entry for an order leaves the row in flight — the
default (`new Map()`) preserves today's behaviour exactly, so every existing
caller and spec case keeps its meaning.

### Phase 3 — the step reads the verdicts and retires before creating

`ensure-next-renewal-cycle.ts`:

- After loading `existingCycles`, collect the distinct `generated_order_id`s of
  its `scheduled` rows and resolve each with `readOrderPaymentVerdict`, into an
  `UpcomingCycleOrderVerdicts`. Only `scheduled` rows are read: a `processing`
  row defers on its status alone, and terminal rows are never candidates.
- Pass the map to `resolveUpcomingCycle`.
- On `create`: `retireStaleUpcomingCycles(...)` first, then
  `createRenewalCycles(...)`. `madeRoomFor` is the entitlement date, because the
  created row does not exist yet at retire time.
- `EnsureNextRenewalCycleCompensation`'s `created` arm gains
  `retired_ids?: string[]`, and `rollBackUpcomingCycleWrites` restores those ids
  before hard-deleting the created row.

### Phase 4 — the retire re-check learns the second qualification

`retireStaleUpcomingCycles` re-reads its named rows at the write and drops the
ones that stopped qualifying — the guard against a concurrent
`create-manual-renewal` stamping money onto a row between the decision read and
the delete. That re-check is currently the sync `stillRetirable`
(`status === SCHEDULED && generated_order_id == null`), which would **always
withhold** a superseded row, because a superseded row has a
`generated_order_id` by definition.

So the re-check becomes an injected, async qualifier:

```ts
export type UpcomingCycleRetireRecheck = (
  row: UpcomingCycleQualificationRow
) => Promise<boolean>
```

with `stillRetirable` as the default. The step passes one that answers
`stillRetirable(row)` when the row carries no order, and re-reads the verdict —
`status === SCHEDULED && verdict === "not_captured"` — when it does. A row that
got paid in the window keeps its place, exactly as the existing guard intends.

## Verification & Testing

### Module specs (`src/modules/renewal/__tests__/upcoming-cycle.spec.ts`)

- A `scheduled` row with a `generated_order_id` and a `not_captured` verdict is
  **not** the candidate: with no other open row the resolution is `create`.
- The same row appears in that `create`'s `retire`.
- With a second, healthy open row present, the healthy row is adopted and the
  superseded one is still retired.
- A `captured` verdict and an `ambiguous` verdict each leave the row in flight →
  `defer`, unchanged.
- A `generated_order_id` with **no entry** in the map leaves the row in flight →
  `defer` (the backward-compatible default).
- A `processing` row with a `not_captured` verdict still defers (status alone
  is in-flight).
- `create` with no superseded rows carries `retire: []`.

### Retire specs (`src/modules/renewal/__tests__/retire-stale-cycles.spec.ts`)

- The re-check: `retireStaleUpcomingCycles` retires a row whose order the
  injected recheck read as never charged, withholds one it read as paid, asks
  the recheck once per row the write read back, and falls back to the row-local
  qualification when no recheck is injected.
- The `created` compensation deletes its own row first and then restores the
  rows it had to clear — the order is forced by the same partial unique index
  that forced the retire, so swapping the two reddens this case.

### HTTP fixture (`integration-tests/http/subscription-from-order.spec.ts`)

Two defer cases built their "in-flight renewal order" as a bare id string
(`order_outstanding_${Date.now()}`). A row is no longer in flight just because
it names an order, so `seedOutstandingRenewalOrder` now builds a real one:
linked to an `authorized` payment collection with zero `payment` rows, which the
reader cannot settle and therefore parks. Flipping that one status to `not_paid`
is the check that the fixture is not vacuous — it reddens exactly those two
cases.

### Mutation check

Four mutations, each preceded by an `assert count == 1` on the anchor string
(per `.agents/lessons.md`), all four restored and re-verified green:

- `isSupersededCycle`'s verdict comparison `"not_captured"` → `"captured"`: 4
  cases red.
- `create`'s `retire: collectRetirable(cycles, undefined, verdicts)` → `retire: []`:
  1 case red.
- `retireStaleUpcomingCycles`'s default `recheckRetirable` → `async () => true`:
  3 cases red.
- `rollBackUpcomingCycleWrites`'s `created` arm, delete/restore swapped: 1 case
  red.

### Gates

`corepack yarn build` → `test:unit` → `test:integration:modules` →
`test:integration:http` (chunked, `env -u PORT -u NEXT_RUNTIME -u
NEXT_DEPLOYMENT_ID -u NEXT_PRIVATE_START_TIME`) → `test:i18n` →
`verify:package`. Then a patch release and a production deploy.

## Known limitations (deliberate)

- **Direction B is not implemented.** A cycle dated before the entitlement date
  is still `charge`-eligible if it is not superseded. The window that leaves is
  a row with a `captured` or `ambiguous` order — a webhook in flight, or a
  refund — which is the case `defer` is meant to hand to an operator.
- **Retiring a superseded row does not cancel its order.** The stale order stays
  `pending` with a live payment session, so the customer can still pay it. If
  they do, `payment-captured-manual-renewal` fires and `complete-manual-renewal`
  runs against a soft-deleted cycle; the customer gets the period they paid for
  rather than nothing. Cancelling the order is a separate change — the operator
  SQL in `ISSUE.md` does it by hand.
- **A superseded row is only recognised on `scheduled` rows.** A `processing`
  row defers on its status, which is the existing contract.

## Related

- `D:/Projects/medusa-saas/ISSUE.md` → `## K2 · prepay 落在 defer 窗口时…`
- `docs/architecture/subscriptions.md` → `An in-flight renewal cycle is not
  moved by a prepay, but an uncharged one no longer holds its slot.`
- `.agents/lessons.md` → "Bound trial row fold run (2026-10-09)",
  "A Row Held Back For An In-Flight Order Keeps Holding It Back After The Order
  Is Abandoned."
