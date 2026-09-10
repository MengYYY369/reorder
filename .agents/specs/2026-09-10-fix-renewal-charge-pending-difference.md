# Spec: Fix Auto-Renewal Charge Blocked by Medusa 2.20 Pending-Difference Validation

## TLDR & Overview

On Medusa 2.20, every off-session renewal charge fails before reaching the payment provider. The core-flow used by the plugin (`createOrUpdateOrderPaymentCollectionWorkflow`) validates the requested charge amount against the order's `summary.raw_pending_difference` **as read through the query layer**. On 2.20 the read path recalculates totals live (`formatOrder → decorateCartTotals`) and zeroes out `pending_difference` whenever `|total − transactions| ≤ currencyEpsilon` (0.01 for two-decimal currencies like CNY/USD). A brand-new renewal order has zero transactions, so any total of 0.01 reads back as a pending difference of 0, the validation `MathBN.gt(total, 0)` fails, and the workflow throws `NOT_ALLOWED: Amount cannot be greater than [object Object]`.

The plugin's auto path (`process-renewal-cycle`, used by both the scheduler and admin force) and the dunning retry path (`run-dunning-retry`) both call this core-flow. The thrown error is not wrapped as a payment-qualified failure, so the cycle fails with `failure_kind=unexpected_error` and **never opens a dunning case** — the subscription silently stops renewing. Orders with a total above the currency epsilon are unaffected, which is why real-priced subscriptions may pass while the ¥0.01 test price (and any sub-cent edge) fails.

The fix moves payment-collection creation out of the shared core-flow and into the plugin: reuse the existing order-linked payment collection when one is present, otherwise create one directly through the Payment Module and link it to the order. This bypasses the summary-based validation entirely and removes the dependency on 2.20's read-time total decoration for the charging decision.

## Problem Statement

A merchant (or the plugin author testing the lifecycle) creates an auto-mode subscription with a minimal price (¥0.01). When the renewal scheduler fires, or when an admin forces the cycle, the cycle fails with `Amount cannot be greater than [object Object]`:

- the renewal order is created, but no payment collection, session, or charge ever happens;
- the failure is recorded as an unexpected error, so no dunning case opens and no retry is scheduled — the customer silently loses their subscription at the next cycle;
- `run-dunning-retry` (re-charging an existing renewal order for an open case) fails with the same error, so past-due recovery is also broken on 2.20;
- the manual (redirect-only) renewal flow is unaffected in production shape, so the bug only surfaces for auto-mode subscriptions and dunning retries.

The user experience is: "automatic renewals worked on the previous Medusa version and do not work on 2.20, and the failure does not even enter dunning."

## Solution

Both charging call sites stop using `createOrUpdateOrderPaymentCollectionWorkflow` and instead manage the renewal order's payment collection explicitly:

1. **Resolve or create.** Before charging, query the payment collection already linked to the renewal order. If none exists, create one via the Payment Module (`createPaymentCollections` with the order's currency and the charge amount) and link it to the order (order ↔ payment collection remote link), mirroring what the core-flow's create branch does.
2. **Reuse safely.** If a linked collection exists in a chargeable state (`not_paid` / `awaiting`), update its amount to the order total to be charged. A linked collection in `authorized` / `partially_authorized` is canceled and replaced by a new collection — the same recreate semantics the core-flow applies, minus its summary-based validation — with the core-flow's guard preserved: only authorized (non-captured) payments are released, and a collection with captured money is never canceled. This keeps a retry after an authorize-succeeded / capture-failed attempt from double-charging and leaves the order with exactly one live collection per charge attempt. A `canceled` collection is treated as missing.
3. **Charge as before.** The rest of the chain is unchanged: create the payment session with the subscription's payment context (`off_session: true`, `confirm: true`, `capture_method: "automatic"`), authorize, capture.
4. **Classify correctly.** The resolve-or-create block is wrapped with the same payment-qualified error classification (`payment_session` source) used for session creation, so a failure here opens a dunning case instead of dying as `unexpected_error`.

Manual renewal (`create-manual-renewal`) is updated to the same resolve-or-create helper so all three call sites share one implementation; its behavior (unconfirmed session + cashier redirect) is unchanged.

A focused regression test reproduces the 2.20 condition (order total equal to the currency epsilon) and proves the charge path completes: payment collection created, session authorized, capture recorded, cycle succeeded, dunning case opened when authorization fails.

## User Stories

### Merchant / operator

1. As a merchant, I want auto-mode subscriptions to be charged automatically at every renewal, so that customers keep their entitlements without manual intervention.
2. As a merchant, I want the renewal engine to work regardless of the order total amount, so that minimal-priced and zero-margin plans renew just like regular ones.
3. As a merchant, I want an admin force-run on a stuck renewal cycle to complete the full charge, so that support can recover a customer immediately.
4. As a merchant, I want a renewal charge failure to open a dunning case, so that the failure is visible in the admin queue and gets retried instead of vanishing.
5. As a merchant, I want dunning retries to re-attempt the charge on the existing renewal order, so that recovery uses the same amount and currency the customer originally agreed to.
6. As a merchant, I want the scheduler logs to show the true failure source (payment session vs provider vs capture), so that I can diagnose gateway problems instead of seeing `unexpected_error`.

### Customer

7. As a customer on an auto-renewing subscription, I want my card to be charged off-session at renewal time, so that my subscription continues without me having to act.
8. As a customer whose card is temporarily declined, I want the dunning flow to retry my card on schedule, so that I can update my payment method and keep my subscription.
9. As a customer whose subscription is paid through a redirect-only provider in manual mode, I want my existing interactive renewal flow to keep working, so that the fix does not change behavior I rely on.

### Admin UI user

10. As an admin, I want the renewal cycle detail to show a succeeded charge with the generated order and payment reference, so that I can confirm the money actually moved.
11. As an admin, I want forced renewals on minimal-priced subscriptions to succeed, so that operational recovery works for every plan tier.
12. As an admin, I want the dunning retry-now action to actually re-charge the renewal order on Medusa 2.20, so that the recovery flow is real rather than a guaranteed error.

### Plugin author / maintainer

13. As a maintainer, I want the charging logic to live in the plugin rather than depend on core-flow validation internals, so that Medusa minor-version changes to total decoration do not break renewals again.
14. As a maintainer, I want an integration test that pins the epsilon-boundary behavior, so that future Medusa upgrades catch regressions at CI time.
15. As a maintainer, I want all three renewal call sites (auto, force, dunning retry) to share one payment-collection resolution helper, so that the semantics cannot drift between paths.
16. As a maintainer, I want the manual renewal path to keep minting unconfirmed sessions for interactive payment, so that the redirect-only provider contract stays intact.

## Implementation Decisions

- **Plugin-owned payment collection resolution.** A new shared helper (in the renewal workflows' step utils) implements "resolve or create":
  - query `order_payment_collection` links for the renewal order;
  - reuse a linked collection whose status is `not_paid` or `awaiting`, updating its amount to the charge total;
  - cancel and replace a linked `authorized` / `partially_authorized` collection before creating the new one (core-flow recreate semantics, without the summary validation; captured payments are never canceled);
  - create a new collection through the Payment Module when no chargeable collection exists, and attach the order ↔ payment collection remote link (same link pair the core-flow creates);
  - never validate the amount against the order summary.
- **Call-site replacement.** `process-renewal-cycle` (serves scheduler and admin force), `run-dunning-retry`, and `create-manual-renewal` replace their `createOrUpdateOrderPaymentCollectionWorkflow` calls with the helper. The session/authorize/capture sequences are unchanged.
- **Error classification.** Helper failures in `process-renewal-cycle` are wrapped as payment-qualified renewal errors with source `payment_session`, so they flow into dunning exactly like session-creation failures. `run-dunning-retry` keeps its existing catch-and-classify block around the whole charge attempt.
- **Amount source unchanged.** The charge amount remains the live order total read through the query (`loadOrderTotal`), which is correct on 2.20; only the summary-based validation is bypassed.
- **No schema changes.** Payment collections, links, and sessions already exist; no migration is required.
- **No changes to payment context semantics.** The subscription's `payment_context` (provider, method reference) remains the source of the charge configuration; the helper only manages the collection container.
- **Medusa version tolerance.** The helper does not depend on `order.summary` shape at all, so it is stable across 2.x read-path changes. If a future Medusa fixes the epsilon zeroing, the helper still behaves correctly (it never reads the summary).
- **Upstream report.** The epsilon-zeroing of `pending_difference` during read (`decorateCartTotals`) contradicting the persisted jsonb value is worth reporting upstream to Medusa; the plugin fix is independent of that outcome.

## Testing Decisions

- **Seam:** the existing HTTP integration test layer (`medusaIntegrationTestRunner`) is the only new test seam needed; no new seams. Prior art: `integration-tests/http/manual-renewal.spec.ts` (subscription seeding with a payment context + real cart via module services, then workflow execution via the workflow engine) and `integration-tests/http/renewals-workflows.spec.ts` (renewal cycle seeding + `processRenewalCycleWorkflow` run + assertions on cycle/subscription/activity log).
- **Tests assert external behavior only:** the charge path completes (collection exists and is linked to the order, session authorized, payment captured), the cycle succeeds with `generated_order_id` set, cadence advances; on authorization failure a dunning case opens with a payment-qualified source; the manual path still yields an unconfirmed session.
- **Epsilon-boundary regression:** the seeded renewal order uses a 0.01 unit price (CNY or USD) so the 2.20 validation would reject it; the test fails on the pre-fix code and passes after the fix. This is the regression pin for the Medusa 2.20 read-path behavior.
- **Provider choice:** `pp_system_default` is used as the payment provider in tests (same as the manual-renewal specs), avoiding external gateway dependencies; authorization/capture assertions use the module-level records rather than provider payloads.
- **Out-of-band verification:** the DTC rig scripts (`verify-renewals`, `verify-epay-notify-renewal`, `verify-dunning-cancellation` in the downstream test repository) re-run against the fixed plugin as end-to-end confirmation on a real backend.

## Out of Scope

- Fixing Medusa 2.20's read-time zeroing of `pending_difference` or its summary-based charge validation upstream (separate upstream issue; the plugin fix works regardless).
- Changing dunning scheduling, retry intervals, or case lifecycle semantics.
- Changing the payment context model, payment method management, or the manual renewal cashier/redirect contract.
- Handling refunds, partial captures, or multi-collection orders — the renewal path only ever creates single full-amount collections.
- Proration or mid-cycle plan changes; the renewal amount remains the full order total.
- Updating the 2.20 upgrade guide beyond a short note in the affected architecture docs (renewals, payments) if behavior documentation mentions the core-flow.

## Further Notes

- Root-cause evidence (Medusa 2.20.0, verified against the installed dist and the live test rig database):
  - `create-or-update-order-payment-collection.js` — `getOrderPendingAmountStep` throws `NOT_ALLOWED, Amount cannot be greater than ${amountPending}` when `MathBN.gt(input.amount, order.summary.raw_pending_difference ?? order.summary.pending_difference)`.
  - On 2.20, order reads that request `total` run `formatOrder → decorateCartTotals`, which recomputes `pending_difference = total − pending_return_total − transaction_total` live and zeroes it whenever `|pending_difference| ≤ currencyEpsilon`; the epsilon is `10^-decimal_digits` of the order currency — 0.01 for CNY/USD, but 1 for zero-decimal currencies (JPY, KRW), so every JPY total ≤ 1 fails, not just sub-cent amounts. A fresh renewal order has `transaction_total = 0`, so a ¥0.01 order reads back as pending `0` — and `{value:"0"}` in the error message matches the raw-BigNumber serialization of that recomputed value.
  - The persisted `order_summary.totals` jsonb for the failing rig order holds `pending_difference = 0.01` (the write-time value was correct); only the read is zeroed. This rules out an order-creation bug.
  - The `succeeded` auto cycle in the rig is a redemption-created free-cycle subscription (no order creation), not a counter-example.
  - The manual-mode rig "success" (order 27) used a test-fixture payment collection inserted directly via SQL, so it never exercised the broken core-flow branch — consistent with "manual mode unaffected" only because the failing branch was bypassed.
- Failure blast radius on 2.20: auto-mode renewals (scheduler and admin force) and dunning retries; manual redirect-only renewals with collections created outside the core-flow are unaffected.
- The fix intentionally keeps the existing charge sequence (session → authorize → capture) so Stripe-style off-session providers and the test rig's simulated provider behave identically before and after.
