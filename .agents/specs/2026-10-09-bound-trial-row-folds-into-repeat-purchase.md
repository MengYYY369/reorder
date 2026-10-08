# Spec: A bound trial row folds into a repeat purchase (checkout-gate exception widened)

## TLDR & Overview

The checkout-completion gate refuses a subscription-track purchase when the
customer already holds a live reorder-rail row for the same product. Ticket 12
(D12) opened exactly one exception: a live row the engine's own stacking fold
would take (`isFoldableReorderRailRow`). That predicate currently accepts a
**card-free** trial row (no stored payment method) and a **paid** row with a
stored provider id, and refuses everything else — including a trial row that
has since **bound a payment method**.

The storefront now routes "renew now" through the ordinary checkout so the
customer picks the payment method there instead of being handed a one-shot
provider link. That makes the refused shape the common one: the production
subscription `01M47SSSRTADRG586CK53AZNWG` is `is_trial = true`,
`payment_mode = auto`, with `payment_method_reference = 1ug584305c078692s` —
the exact shape `checkout-gate.spec.ts` pins as blocked. A customer in that
state can pay, and the completion gate then answers `400 not_allowed`, after
the money moved.

This spec widens the exception to **any** live trial row on the reorder rail.
The refusal's stated rationale ("a bound auto trial row would double-charge
against the method it already holds") does not survive the mechanism it is
about, and the residual risk it gestures at is one the gate already tolerates
on the paid rail it does allow.

## Decisions already taken (user, 2026-10-09)

- **Widen the gate.** Chosen over leaving the backend alone and blocking the
  storefront button: the refused state is the production state, so a
  front-end-only guard would ship a feature nobody can exercise.
- **Keep `POST /store/customers/me/subscriptions/:id/renew-now` as is.** It
  shares its engine with the auto-renewal scheduler and is a public store API;
  the storefront stops calling it for this button, and nothing else changes.

## The mechanism the old rationale assumed

`isFoldableReorderRailRow`'s header says a bound auto trial row "would
double-charge against the method it already holds". That assumes the row keeps
two independent charge dates: the prepaid period it just bought, and the trial
conversion it already holds a method for. It does not:

1. **The prepaid extend moves the anchor, not the row's history.**
   `resolveExtendTarget` (`src/modules/subscription/utils/stacking.ts:154-161`)
   takes any non-native `ACTIVE` row — a bound trial included — and
   `extendSubscriptionRenewalDate` (`:170-180`) anchors on the row's own
   `next_renewal_at`, so the purchase writes `next_renewal_at + 1 cadence`.

2. **The upcoming cycle follows the anchor.**
   `ensureNextRenewalCycleStep` reconciles by role, not by date equality:
   `scheduledFor = subscription.next_renewal_at` then
   `resolveUpcomingCycle(existingCycles, scheduledFor)` →
   `action: "adopt"` → `updateRenewalCycles({ id, scheduled_for })`
   (`src/workflows/steps/ensure-next-renewal-cycle.ts`). `adopt` is defined for
   "an open row sits elsewhere and is free to follow the entitlement date"
   (`src/modules/renewal/utils/upcoming-cycle.ts`).

3. **Trial conversion is triggered by the cycle firing, not by a second job.**
   `process-renewal-cycle.ts` gates on
   `cycle.scheduled_for < subscription.trial_ends_at` and refuses earlier
   ("subscription is still in trial for renewal date …"), and
   `resolveTrialConversionDecision` runs on the cycle that got past that gate.
   With the cycle moved, the conversion charge moves with it.

So the prepay and the conversion are the **same** charge slot, and the row's
`is_trial` / `trial_ends_at` are cleared by the extend itself (pinned by
`integration-tests/http/checkout-subscription-exception.spec.ts`, "converts the
trial row and stacks the new cycle onto it").

## The residual risk, and why it is not new

`resolveUpcomingCycle` has a `defer` branch: when the row it would adopt already
carries an in-flight renewal (`status = processing`, or `generated_order_id`
set), it refuses to move anything and leaves the overlap for an operator. A
prepay landing in that window is a genuine double-charge window.

It is not a property of trial rows. `isFoldableReorderRailRow` already admits
**paid** rows with a stored provider id, and a paid vaulted row can carry an
in-flight renewal order exactly as a bound trial can. The gate therefore
already accepts this class of risk on the rail it allows; the trial arm of the
predicate was never the thing containing it. For the case that motivates this
spec the window is additionally unreachable: a trial whose `trial_ends_at` is
still in the future cannot have a fired cycle, because the eligibility gate
above refuses to process one before that date.

Closing the `defer` window properly is a separate concern (it needs an operator
surface, or a refusal at the prepay boundary rather than at cart completion)
and is out of scope here. It is recorded as a known limitation below rather
than silently left in a comment.

## Proposed Architecture & Data Model

No schema change, no migration, no new endpoint, no new module. One predicate
and its documentation.

`src/modules/subscription/utils/reorder-rail-exclusivity.ts`:

```ts
export function isFoldableReorderRailRow(
  row: ReorderRailRowCandidate
): boolean {
  if (isNativeSubscriptionReference(row.reference)) return false
  if (row.status !== SubscriptionStatus.ACTIVE) return false

  // A trial is the state a repeat purchase converts, whatever it has bound:
  // the extend clears is_trial / trial_ends_at and moves the anchor the
  // upcoming cycle follows.
  if (row.is_trial) return true

  return readPaymentProviderId(row.payment_context) !== null
}
```

The `hasStoredPaymentMethod` import is dropped from this file; the helper keeps
its other callers.

The predicate stays a **strict subset** of `resolveExtendTarget`'s fold set
(non-native + `ACTIVE`), so the subset invariant the spec of ticket 12 relies
on still holds — the new arm is wider, not outside. A redemption-shaped row
(`is_trial: false`, no provider id) and a `PAUSED` row are still refused.

The two readers, the occupying-status set, the fail-open decision and the
refusal message are all untouched.

## Step-by-Step Implementation Plan

### Phase 1: The predicate

- [ ] Step 1: Widen the `is_trial` arm to `return true` and drop the now-unused
      `hasStoredPaymentMethod` import.
- [ ] Step 2: Rewrite the function's doc comment — remove the double-charge
      claim, state what replaces it, and name the `defer` window as the
      residual risk with its owner (this spec / the architecture doc).

### Phase 2: The pins

- [ ] Step 3: `src/modules/subscription/__tests__/checkout-gate.spec.ts` — move
      "a bound auto trial row" out of the `it.each` block table and into the
      allow cases; add a bound **manual** trial row as a second allow case (the
      predicate no longer reads the mode); leave the redemption row, the
      null-context row, the `PAUSED` row and the pure one-time cart in the
      block set.
- [ ] Step 4: `integration-tests/http/checkout-subscription-exception.spec.ts` —
      same move in the `it.each` table, plus one case asserting a
      subscription-track cart onto a **bound auto trial** row reaches the
      extend rather than the refusal.

### Phase 3: The prose

- [ ] Step 5: `docs/architecture/subscriptions.md` — the exception paragraph
      (around line 284) currently lists "a bound (auto) trial" among what still
      blocks. Restate the exception as "a live trial row (bound or card-free) or
      a paid ACTIVE row carrying a provider", and record the `defer` window
      under *Known limitation*.
- [ ] Step 6: `CHANGELOG.md` — one entry under the next unreleased version.
- [ ] Step 7: `.agents/lessons.md` — the lesson: a refusal's stated rationale
      is a claim about a mechanism, and it has to be re-derived when the
      mechanism it names is reconciled by role rather than by the field the
      rationale assumed.

## Verification & Testing

- `corepack yarn test:integration:modules` — the unit gate that owns
  `src/modules/*/__tests__/**`. The two moved/added cases must redden under a
  mutation of the new arm (`return true` → `return false`) and the four
  remaining block cases must stay green.
- `corepack yarn test:integration:http` — the http gate that owns
  `integration-tests/http/**` and is the only one that runs the plugin's
  migrations. Focused run of
  `integration-tests/http/checkout-subscription-exception.spec.ts` first, then
  the whole suite.
- `corepack yarn build` — typecheck (`src/` plus
  `src/modules/*/__tests__/**`; `integration-tests/**` is not in the program, so
  the http spec is typechecked by hand).
- **Mutation check** (repository requirement): flip the new arm to `false` and
  confirm exactly the bound-trial cases redden; assert the replacement string
  exists before writing, because a `str.replace` that silently matches nothing
  reports a green suite that proved nothing.
- End-to-end, on production after the release: a subscription-track purchase
  onto the live bound trial row completes, and `next_renewal_at` moves one
  cadence with `renewal_cycle.scheduled_for` following it.

## Known limitation (recorded, not fixed here)

`resolveUpcomingCycle`'s `defer` branch refuses to move a cycle whose renewal
order is already in flight, so a prepay landing in that window can leave two
chargeable slots for one period. The gate tolerates this on the paid rail
today; this spec extends the same tolerance to bound trial rows rather than
fixing it. Fixing it needs either a refusal at the prepay boundary or an
operator surface for the overlap, and belongs to its own task.
