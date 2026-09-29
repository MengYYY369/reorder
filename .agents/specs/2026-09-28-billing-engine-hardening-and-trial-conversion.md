# Spec: Billing Engine Hardening, Event Completion, and Trial Conversion

**Status:** FINAL (revision 3) — trial-claim round applied 2026-09-28.
**Date:** 2026-09-28
**Scope owner:** repository owner (single-operator production deployment)
**Release shape:** one release, all phases, with a hard cut line after Phase 6 (decision Q10a + R4).

## TLDR & Overview

A static audit of the billing engine, followed by an adversarial falsification pass, confirmed four defects in the renewal/dunning interaction and three gaps in the outward event surface. Trials end by cancelling the subscription unconditionally — even when the subscription is in auto mode with a usable vaulted payment method — and three plan-offer rules are exposed in the Admin UI while no code enforces them.

The owner review round added five findings, two of which were holes in the first draft of this spec (a dunning-start failure that would restore the infinite retry loop, and a crash window inside the recovery path that would re-charge a period), and one of which reframed the store-route authorization question entirely.

**Two of the event gaps are live customer-facing defects, not latent ones.** The host application already carries Medusa subscribers on the event bus that send customer emails: `saas-email-renewal-failed.ts` listens on `renewal.failed`, and `saas-email-expired.ts` listens on `subscription.expired`. Because this plugin persists both events without emitting them, **the "renewal payment failed" email and the trial "subscription expired" email have never been delivered.** Combined with H1 (a failed renewal is silently re-charged every five minutes), **the first customer to hit a failed renewal would be charged repeatedly with no notification of any kind** — there are no customers today, so the defect has no victim yet and would acquire one on the first day of trading. Phase 6 is therefore ranked equal to the engine fixes, not below them.

Revision 3 adds a second body of work: **a customer-claimable free trial** — no card required, with more days granted when the customer binds a payment method that will be charged when the trial ends. The engine support for trials already exists (offer rules, `is_trial`, `trial_ends_at`, a cycle scheduled at trial end); what is missing is a claim entry point, a record of who has already claimed, a way to bind a method **without charging anything now**, and a customer exit path that actually works. Three findings make the last two concrete: self-service cancellation on the vault rail does not cancel anything today (T1), unbinding a payment method does not exist (T2), and the code comment claiming PayPal rejected the standalone vault API is contradicted by the pinned SDK (T4).

## Production Baseline (read-only, verified 2026-09-28)

Queried against `medusa_store` on the production host.

**There are no customers yet.** The rows below are the operator's own test traffic and the plugin's own rehearsals, not a customer base. This changes how the numbers should be read: they describe *money in flight*, which is still real and still at risk, but nothing here has a customer attached, and there is no historical data to migrate, backfill or reconcile.

| Fact | Value |
|------|-------|
| Subscriptions (live) | 16 — 7 auto, 9 manual; 11 active, 5 cancelled |
| Subscriptions exposed to the scheduler (active/past_due, non-trial, non-`NATIVE-`, non-manual) | **4** |
| Renewal cycles | 13 scheduled, 5 succeeded |
| Due now | 0 |
| **Earliest due cycle** | **2026-10-18 08:28:48+00** |
| Trial subscriptions | 1 — a redemption-created `SUB-RDM-…`, auto mode, `trial_ends_at` 2026-09-17, now `cancelled` |

Consequences:

1. The first real scheduler charge is 2026-10-18 08:28 UTC and the scheduler runs every five minutes. The engine defects become live on the first renewal that fails after that date. Every phase is scheduled against it.
2. The blast radius of H1/H2/H3 is the **4 scheduler-exposed subscriptions**; the 9 manual subscriptions renew through the manual flow (they are exposed to C2, the 90-day hygiene cancellation, instead).
3. The one trial row is `cancelled` at its `trial_ends_at`, consistent with the trial clean-end branch having executed correctly. The branch works; conversion is what is missing.
4. The host's checkout completes carts through **core** `/store/carts/:id/complete` (`apps/storefront/src/lib/data/cart.ts:505`), after which this plugin's `order.placed` subscriber creates the subscription. **Nothing in the host calls this plugin's `/store/carts/:id/subscribe` route.**
5. **The absence of customers is a reason to fix the engine before launch, not a reason to relax.** H1 re-charges the same person every five minutes; T5 mails a false "renewal failed" to the same person every five minutes once Phase 6 lands. Neither has a victim today and both would have one on the first day of trading. It also removes the whole class of data-migration concerns from the trial work: no backfill into `trial_claim`, no constraint that can fail to build, no historical duplicates to reconcile.

## Confirmed Findings (evidence, not opinion)

Each finding survived an adversarial pass whose explicit goal was to falsify it — no guard, cap, status transition, config default, DB constraint, or subscriber was found that prevents it.

| ID | Finding | Decisive evidence |
|----|---------|-------------------|
| H1 | A failed renewal cycle keeps `status = failed` and its original `scheduled_for`, so the `*/5 * * * *` scheduler re-arms it and attempts a new charge — minting a new order each time — with no attempt cap, ignoring the configured dunning schedule. | `src/modules/renewal/utils/scheduler-query.ts:64` selects `[scheduled, failed]`; `src/workflows/steps/process-renewal-cycle.ts:993-999` writes `failed` without touching `scheduled_for`; `:694` increments `attempt_count` with no comparison anywhere; `:827-844` calls `createRenewalOrder` unconditionally (contrast `create-manual-renewal.ts:146-182`, which reuses an outstanding order). Code comments acknowledge the re-arm: `src/modules/renewal/utils/upcoming-cycle.ts:172-174`. |
| H2 | Dunning recovery leaves the cycle `failed`, so the scheduler charges the same period again; conversely a scheduler success never closes an open dunning case, so the dunning job later retries the original order. | `src/workflows/steps/run-dunning-retry.ts:649-714` never touches the renewal module; the behaviour is pinned by the repo's own test `integration-tests/http/dunning-workflows.spec.ts:315`; no `updateDunningCases` call site is on a renewal-success path; `src/workflows/utils/resolve-order-payment-collection.ts` treats a `completed` collection as absent and creates a new one, so even a paid order does not stop the retry. |
| H3 | A hard process death between capture and the `SUCCEEDED` write strands the cycle in `processing` forever with money taken. | `src/workflows/steps/process-renewal-cycle.ts:622-624` passes no compensating function to `createStep`; the capture at `:544` and the `SUCCEEDED` write at `:885` are not in one transaction (the engine strips the transaction manager); no job, subscriber, or admin route repairs a `processing` cycle; `force-renewal-cycle.ts:88-90` rejects it. |
| M7 | The dunning job can hot-loop forever on one wedged case, starving every other case. | `src/jobs/process-dunning-retries.ts:152-218` breaks only on an empty batch and always queries with `skip: 0`; `src/workflows/steps/run-dunning-retry.ts:592-608` throws before the state transition, leaving `next_retry_at` in the past; the job lock is held for the whole run so it cannot self-interrupt. |
| B1 | `renewal.failed` is persisted to the activity log but never emitted on the event bus. **The host's `saas-email-renewal-failed.ts` subscriber listens on exactly that event name, so the customer-facing "renewal failed" email has never been delivered.** | `src/workflows/steps/process-renewal-cycle.ts:1001` persists without emitting; `emitSubscriptionBusEvent` is called from only three places; `apps/backend/src/subscribers/saas-email-renewal-failed.ts:8` declares `{ event: "renewal.failed" }`. The `saas-bridge` whitelist entry registered at `src/subscribers/forward-saas-events.ts:55` is consequently dead as well. |
| B2 | No `dunning.*` event is emitted or persisted anywhere; dunning writes only domain tables and structured logs. | No `persistSubscriptionLogEvent` / `emitSubscriptionBusEvent` call in `src/modules/dunning`, any dunning step, or the dunning admin routes. |
| B3 | There is no upcoming-renewal lookahead: the scheduler selects only cycles already due. | `src/modules/renewal/utils/scheduler-query.ts:65-66` filters `scheduled_for <= now`; no reminder/notify code exists in `src/`. |
| C1 | Trials end by cancelling the subscription unconditionally — no order, no charge, no bus event — even when the subscription is in auto mode with a usable vaulted payment method. | `src/workflows/steps/process-renewal-cycle.ts:739-821` cancels and returns before the order/charge block. |
| C2 | A manual-mode trial never reaches that branch and is silently cancelled about 90 days after trial end. | `src/api/store/saas/carts/route.ts:141-146` forces `payment_mode: manual`; `scheduler-query.ts:107-145` excludes manual rows; `src/jobs/manual-renewal-hygiene.ts:35-62` cancels manual rows 90 days past `next_renewal_at`. Admin force-renewal is the one manual escape hatch (`force-renewal-cycle.ts:68-75` has no manual filter). |
| C3 | The trial-end branch persists `subscription.expired` without emitting it, so **the host's `saas-email-expired.ts` subscriber never fires for a trial that ends normally**; only the redemption-expiry job emits that event. | `src/workflows/steps/process-renewal-cycle.ts:768-813` calls `persistSubscriptionLogEvent` directly; the emitting path is `src/jobs/redemption-expiry.ts:105`; `apps/backend/src/subscribers/saas-email-expired.ts:8`. |
| D1 | `rules.trial_requires_payment_method`, `rules.minimum_cycles`, and `rules.stacking_policy` are stored, validated, and displayed but never enforced. | The only runtime read of `trial_requires_payment_method` dead-ends into an unread DTO field (`redeem-redemption-code.ts:159-160`); no cancellation or billing code reads `minimum_cycles` or `stacking_policy`; the similarly named `row_stacking_policy` / `max_stacking_cycles` are a different, enforced pair (`validate-subscription-cart.ts:229-243`). |
| R1 | **Dunning-start failure restores the infinite retry loop.** When `startDunningWorkflow` throws, the error is swallowed (`process-renewal-cycle.ts:1069-1085`, logged alertable), the cycle stays `failed`, and no dunning case exists — so the "an open case owns the retry" exclusion does not apply and the five-minute loop continues. | `src/workflows/steps/process-renewal-cycle.ts:1048-1086`. |
| R2 | **The recovery path has a re-charge window.** Closing the dunning case before finalizing the cycle leaves a crash window in which the case is closed and the cycle is still `failed` — the scheduler then charges the period again. The mirror window exists because `run-dunning-retry` never checks the cycle's status. | `src/workflows/steps/run-dunning-retry.ts:649-714`; no cycle-status guard anywhere in that step. |

### Trial-claim round findings (revision 3)

| ID | Finding | Decisive evidence |
|----|---------|-------------------|
| T1 | **Customer self-service cancellation does not cancel anything on the vault rail.** The store route only opens a cancellation *case*; finalizing it is admin-only, and the host storefront renders no cancel action for vaulted subscriptions at all. A customer who clicks "cancel" today still holds an `active` subscription with a future renewal date. | `src/workflows/steps/start-cancellation-case.ts:238-249` creates the case with `status: REQUESTED` and never calls `updateSubscriptions`; `finalizeCancellationWorkflow` has exactly one caller, `src/api/admin/cancellations/[id]/finalize/route.ts`; `apps/storefront/src/modules/saas/subscription-panel/index.tsx:145-156` renders the cancel button only when `row.rail === "native"`. |
| T2 | **There is no way to unbind a payment method.** No `DELETE` route exists under any `payment-method*` path in either the store or the admin API, no workflow branch writes `payment_method_reference: null`, and the storefront has no removal UI. | `src/workflows/steps/update-subscription-payment-method.ts:64-66` rejects an empty `payment_method_id` and always writes a resolved method; `src/api/store/customers/me/subscriptions/validators.ts:84` requires a non-empty string. The only effective lever is the auto-renew toggle, which sets `payment_mode: manual` — enough to stop charges (`src/modules/renewal/utils/scheduler-query.ts:127-138`) but it leaves the card reference on file. |
| T3 | **No dedicated record answers "has this customer already claimed a trial for this plan".** The subscription row carries `is_trial`, so the question is *inferable* — but only for this plugin's own rows. | No `trial_started_at` column, no claim table, and no per-customer trial filter on the **store** list route. The admin list *does* filter (`src/api/admin/subscriptions/validators.ts:47` → `src/modules/subscription/utils/admin-query.ts:488-489`), so an operator can answer it by hand. The gap is that nothing enforces it, nothing makes it race-safe, and `is_trial` is genuinely ambiguous as a proxy: native mirror rows are written `is_trial: false` (`src/modules/subscription/utils/native-mirror-sync.ts:70`) while cancelled trials keep `is_trial: true`. The only trial-adjacent eligibility rule in the repo is the redemption path's new-user check (`src/workflows/steps/redeem-redemption-code.ts:200-224`), which is per-variant and reads live subscriptions and orders, not trial claims. |
| T4 | **The comment claiming PayPal rejected the standalone vault API is unsubstantiated, and the primitives it names are present and callable in the pinned SDK.** The comment asserts an *account-level* rejection; a client SDK shipping method stubs cannot settle that either way, and no re-test or API error log survives. | `src/modules/plan-offer/types/index.ts:56-58`. `@paypal/paypal-server-sdk` 1.0.0 (pinned) exposes `createSetupToken` (`POST /v3/vault/setup-tokens`) and `createPaymentToken` (`POST /v3/vault/payment-tokens`); `SetupTokenRequest` and `PaymentTokenRequest` each carry only `customer?` and `paymentSource` — **no order id and no amount**; and `VaultInstructionAction.OnPayerApproval` exists (`vaultInstructionAction.d.ts:12`), consumed by the standalone vault flow's `VaultExperienceContext`. `medusa-paypal` calls none of them (`paypal-core.ts:348-356` uses `VaultController` only to list tokens). **What this does not establish:** that the account may use them. The four gates in `medusa-paypal/README.md:184-196` (reference transactions, eligibility review, the app's "Save payment methods" toggle, RDA) are documented without distinguishing the two vault flows, and `ON_SUCCESS` vaulting working is **not** evidence that the standalone flow is approved — **verified in sandbox on 2026-09-28: a second sandbox app that returned a vaulted payment token from a captured `ON_SUCCESS` order answers `403 NOT_AUTHORIZED` on the direct `/v3/vault/*` calls probed (`POST /v3/vault/setup-tokens`, `GET /v3/vault/payment-tokens`), while the plugin's own app — "Save payment methods" on — runs the whole setup-token flow and charges the result.** So the two vault paths are gated separately, and the account permission is a real gate with a bare-403 failure signature. Task P4 is settled for sandbox; the **production** app's toggle stays a pre-launch checklist item, because the owner cannot test production. Separately, the comment's `ON_APPROVE` half maps to the wrong flow: `ON_APPROVE` is not a member of `StoreInVaultInstruction` at all (that enum has `OnSuccess` alone); `OnPayerApproval` belongs to `VaultInstructionAction`, which the checkout-order path never uses. |
| T5 | **The due query does not filter on subscription status, so a cycle left behind by a cancelled subscription is selected and then rejected — marking the cycle `failed` and logging `renewal.failed`.** This is producible **today**, without any trial work, and it becomes a false customer email the moment Phase 6 starts emitting. | `src/modules/renewal/utils/scheduler-query.ts:63-68` filters on cycle fields only, and `:107-145` excludes native mirror rows and manual mode only; `src/workflows/steps/process-renewal-cycle.ts:273-282` then rejects any status outside `active`/`past_due`. The error classifies as `subscription_not_eligible` (`src/modules/renewal/utils/observability.ts:62-64`), which `isAlertableRenewalFailure` does **not** exclude (`:90-92`), so the catch at `:993-999` re-marks the cycle `failed` and persists a fresh `renewal.failed` **every five minutes** — the dedupe key includes the run's `finishedAt`, so nothing collapses them. **The path exists now:** any failed cycle (H1) survives an admin cancellation, because `ensureNextRenewalCycleStep` deletes only `SCHEDULED` cycles (`ensure-next-renewal-cycle.ts:717-725`) — so cancelling a subscription with a leftover failed cycle is enough. The host's `saas-email-renewal-failed` subscriber applies no filtering, so the false email starts with **Phase 6's emit, not Phase 15's cancellation**. Phase 2's exclusion 2 closes the loop by removing cancelled subscriptions from the due set; Phase 15's cycle deletion is defence in depth for the pre-due-date case, not the thing preventing the email. |
| T6 | **A subscription created without a cart cannot be charged, so "claim free, bind, charge at trial end" does not work as designed.** Every charge path requires `subscription.cart_id` and rebuilds the renewal order out of that cart. A claim endpoint modeled on the redemption path creates `cart_id: null` — which is exactly why the one production trial (a redemption row) never had to convert. | `src/workflows/steps/process-renewal-cycle.ts:827-841` throws `renewalErrors.invalidData("…missing 'cart_id' required for renewal order creation")` before any order is built, and `createRenewalOrder` reads `cart.region_id`, `cart.sales_channel_id`, `cart.currency_code`, `cart.items` and shipping methods (`:435-457`, `:378-386`). The manual path has the identical guard (`src/workflows/steps/create-manual-renewal.ts:140-144`) and `force-renewal-cycle` runs the same workflow, so there is no operator escape hatch. The failure classifies as `order_creation_failed` (`observability.ts:80-85`), i.e. **structural**, so after Phase 2 the cycle retries and is abandoned rather than charging. **This is a pre-existing latent defect, not one this feature introduces:** any redemption-created subscription whose free cycles are exhausted reaches the same guard. It is listed here because the trial-claim work is what makes it reachable in normal operation, and because §8 row 1 and Phase 14's acceptance test both depend on it being fixed. |
| T7 | **A template cart is necessary but not sufficient: the charge path also requires a payment context.** Immediately after the order is built, the step refuses to charge a subscription whose `payment_context` has no provider or no stored method reference — and the redemption path writes both as `null`. | `src/workflows/steps/process-renewal-cycle.ts:472-483` throws `renewalOrderCreationFailed("…is missing renewal payment context")` when `payment_provider_id` or `payment_method_reference` is absent. `redeem-redemption-code.ts:292-301` sets both to `null` (and reuses the same context for trials at `:303-310`). Both this guard and T6's cart guard are alertable, but only the cart guard lands in `order_creation_failed`: this one passes a custom message that matches neither branch of `classifyRenewalFailure` (`observability.ts:80-85` looks for `"renewal order creation failed"` or `"missing 'cart_id'"`), so it classifies as `unexpected_error` — still alertable (`:90-92`), so the failure is a `failed` cycle retried every five minutes rather than a silent no-op. **Consequence for the design:** the card-free trial is unaffected (it ends, it never charges), and the bound trial is fine *because binding is what writes the payment context*. The path that was broken was the ineligible-degrades-to-paid one — and **Q19 removes it rather than repairing it**, so this finding's fix is a deletion. **The guard also fires too late, which matters independently of trials.** It sits *after* `createOrderWorkflow` (`:447-464`), inside a step with **no compensating function** (`createStep("process-renewal-cycle", handler)`, `:622`), and the order came from an already-committed sub-workflow. So any structurally unchargeable subscription does not produce one failed cycle — it produces **one orphan order per attempt**, up to `renewal_max_attempts`, each carrying only the order metadata `subscription_id` / `renewal_cycle_id` (`:458-462`): the `link.create` calls sit at `:558-576`, after the guard throws, so no link row is ever written for an orphan. **Fix:** move the payment-context check ahead of order creation, so a subscription that cannot be charged fails without creating anything. This applies to every rail, not just claimed trials. **Owned: the plan's Task 4 Step 5** — pre-deadline work (Tasks 1–12), not trial work: the orphan-order loop is reachable today on any rail. |
| T8 | **The rail-exclusivity gate is one-directional, so a customer can hold a vault trial and a native subscription at once — and be charged twice.** The claim endpoint is what makes a reorder row reachable without any checkout, turning a latent gap into a reachable one. | `src/modules/subscription/utils/checkout-gate.ts:140` → `findBlockingNativeRow` requires `isNativeSubscriptionReference(row.reference)` and a live status (`native-subscription.ts:70-73`), and the gate is registered on core `/store/carts/:id/complete` (`src/api/middlewares.ts:32-40`). So **native → reorder is blocked; reorder → native is not.** A customer on a vault trial can buy the native plan from the pricing card and keep the vault trial running — self-service cancellation on the vault rail does not work (T1) and the storefront renders no cancel button for it. At `trial_ends_at` this plugin charges the bound vault trial while PayPal charges its own plan: two live subscriptions, two charges, one product. §12's "a subscription never migrates between the two rails" answers a question nobody asked; the reachable failure is **holding both**. **Fix:** add the missing direction to the checkout gate — a live reorder-rail row for the product blocks a native purchase. **Owned: the plan's Task 4 Step 6** (pre-deadline). The second half is already owned — Task 20 Step 3's `assertEligible` refuses when any subscription exists for the customer and product, `NATIVE-` mirrors included, and its Step 6 tests it. The reorder→native direction does not exist in the gate today. |
| T9 | **The eligibility rule's native half is up to an hour late, so the guarantee the design leans on does not hold as stated.** | medusa-paypal 0.6.1's `SubscriptionEventPayload` carries no `product_id` (`src/subscription/types.ts:48-60`), and every emit site constructs exactly those fields, so the mirror subscriber drops every event (`paypal-subscription-mirror.ts:39-49`). **NATIVE- rows are therefore created only by the hourly backfill** (`native-subscription-backfill.ts:43-46`, `schedule: "17 * * * *"`), not by the event path. The mirror writer does require a resolved `product_id` (`native-mirror.ts:123-167`), so a row that exists is correct — but for up to an hour after a native subscription is created, there is no row, and the eligibility rule cannot see it. **Worse, the test that pins this cannot catch it:** `integration-tests/http/native-subscription-mirror.spec.ts` emits a payload *with* `product_id`, which the real emitter never sends. **Fix:** pin the mirror's actual payload shape in a test, and treat the backfill interval as the real eligibility window rather than pretending it is an edge case. |

**PayPal rail context (verified in `D:\Projects\medusa-paypal` 0.6.1).** Two billing rails coexist. The **vault rail** stores the wallet and writes the token into the payment session's `data.payment_method` / `vault_id` (`src/providers/paypal/service.ts:1189-1202`), which a host can reuse off-session (`initiatePayment` short-circuit at `service.ts:661-669`). The **native rail** uses PayPal's own subscriptions, where PayPal performs the recurring charge, and a billing plan can already carry one trial cycle followed by a regular cycle (`src/subscription/engine.ts:413-465`). Native subscriptions must never be charged by this plugin (they are already excluded as `NATIVE-` mirror rows); vault-rail trials are the ones C1 applies to. Note: `paypal.subscription.revised` is still unimplemented in 0.6.1 (`CHANGELOG.md:78-115`), so the code comment in this repo calling it "blocked until 0.5.0" is stale.

**Auto-renew opt-in already exists end to end.** The storefront's checkout checkbox produces a vault intent on the payment session (`hasVaultIntent`, `apps/storefront/src/lib/data/cart.ts:501-503`), and the host then flips the subscription to auto explicitly through `finalizeVaultedAutoRenew` (`apps/storefront/src/lib/data/subscriptions.ts:229-249` → `POST /store/saas/auto-renew`); this plugin's `payment-captured-save-payment-method` subscriber does the same flip only when the offer's `consent_from_session` rule is configured, which it is not by default. Phase 8 therefore does not need a new opt-in mechanism for trials that arrive through checkout. **Revision 3 adds a second, independent way to reach `payment_mode: auto`** — binding a payment method on a claimed trial (Task 22) — so "`payment_mode === 'auto'`" no longer implies "ticked auto-renew at checkout". Any logic that assumed the two were the same population must say which one it means.

## Decisions

| # | Question | Decision |
|---|----------|----------|
| Q1 | Who owns payment retries after a failure? | **(c) Split by failure kind.** Payment-qualified failures hand off to dunning, which exclusively owns their retry timing. Structural failures get a bounded scheduler retry. |
| Q2 | How does an exhausted cycle leave the due set? | **(a) A new terminal status** `abandoned` on `renewal_cycle`. |
| Q3 | What happens to the cycle and cadence when dunning recovers? | Cycle becomes `succeeded` and the cadence advances from `scheduled_for`, in the same workflow. The repo's own pinned test is deliberately changed. |
| Q4 | What closes a dunning case when the period is paid another way? | Close it as `recovered` with an explicit `recovery_reason`. |
| Q5 | Stale-`processing` reconciliation? | Both: an automatic job with a conservative rule, plus an Admin action with an operator override. |
| Q6 | Caller authorization on `/store/carts/:id/subscribe`? | **(a) Do not add a guard.** Nothing in the host calls that route, and the path the host does use — core `/store/carts/:id/complete` — carries the identical cart-id-as-capability property, so a guard on the plugin route would create a false sense of safety. Documented as an inherited risk instead. |
| Q7 | How does a non-converting trial end? | **(a) Cancel cleanly at `trial_ends_at`, made deterministic on both rails.** No payment-link flow. |
| Q8 | How is `trial_requires_payment_method` enforced? | A per-offer **toggle, default OFF**. When ON: enforce auto mode at checkout **and** apply a trial-end safety net. |
| Q9 | What replaces the two decorative rules? | Remove `minimum_cycles` and `stacking_policy` from the Admin UI forms; mark them deprecated in docs; keep the persisted columns and DTO fields. |
| Q10 | Release shape | **(a) One release, all phases.** |

### Review round (revision 2)

| # | Question | Decision |
|---|----------|----------|
| R1 | Dunning-start failure | Count it as a **structural** failure so the attempt cap eventually abandons the cycle, and emit an alertable event. Never treat it as "handed to dunning". |
| R2 | Recovery write ordering | Add a hard guard: `run-dunning-retry` must refuse to execute when the cycle is already `succeeded` or `abandoned`, closing the case instead. This closes both crash windows regardless of write order. |
| R3 | Subscription state after a cycle is abandoned | **(c)** Leave the subscription in `past_due` and emit the alertable `renewal.abandoned` event; the external application decides whether to cancel. The plugin never auto-cancels a subscription as a side effect of a failed period. |
| R4 | Cut line | **Phases 1–6 are mandatory and must land before 2026-10-18.** Phases 7–11 may slip to the next version without reopening this spec. |
| R5 | Ambiguous stuck-`processing` outcome | **(b) Park, do not abandon.** A new non-terminal cycle status `awaiting_manual_resolution` (same vocabulary as the dunning case status) holds the cycle until an operator resolves it. "We do not know" is not "there is no hope". |
| R6 | Billing anchor after a late recovery | **(a) Keep the original anchor** (`scheduled_for`), consistent with the automatic path. Documented consequence: a late recovery produces a catch-up charge for the following period. |

### Trial-claim round (revision 3)

| # | Question | Decision |
|---|----------|----------|
| Q11 | What shape does "bind a payment method" take? | **(c) Two buttons on every product, and no new setting to choose between them.** The card-free claim always creates a reorder trial. The "bind and get more days" button always binds through the **vault** rail — the provider stores the method, this plugin owns the recurrence, so this plugin also owns the trial length. The **provider rail is not a binding method for a claimed trial at all**: a variant that carries `paypal_subscription` metadata *is* a provider-managed subscription, the storefront already routes to it (`isNativeVariant`, `apps/storefront/src/lib/util/plan.ts`), and its trial is configured in the PayPal billing plan, not in an offer rule. **`trial_binding_method` is therefore not added to the offer rules** — the rail is a property of the product, expressed in the catalogue, and it already exists. |
| Q12 | May a customer escape the charge by unbinding or cancelling? | **Yes — explicitly permitted.** A customer who bound a method may cancel the subscription or disable auto-renew before `trial_ends_at` to prevent the charge, and keeps whatever bonus days were granted. **No anti-abuse machinery is built for this.** |
| Q13 | What happens to `trial_requires_payment_method`? | **Keep it as a real hard gate, orthogonal to the bonus.** When ON, the flag means all three of: the card-free **claim** is refused, the checkout gate from Q8 still applies, and the Q8 trial-end safety net still applies. OFF (default) = both buttons available and no gate. Q8 is not superseded, it is extended — the same flag, one more enforcement point, because claiming no longer passes through a cart. |
| Q14 | Where is the trial length configured? | **Each rail keeps its own, because they are not the same concept.** On the **vault** rail this plugin owns the recurrence, so the trial length is a rule about when this plugin charges — it lives in `plan_offer.rules` (`trial_days`, `trial_bonus_days`). On the **provider** rail PayPal owns the recurrence, so the trial length is part of the **PayPal billing plan's identity** — it stays in `variant.metadata.paypal_subscription.trial_periods`, where it already is. **The attempt to unify them was structurally wrong, not merely expensive:** the plan cache hash includes `trial_periods` (`medusa-paypal/src/subscription/metadata.ts:102-113`) and a PayPal plan is immutable, so making the offer the source would mean **every edit to the offer mints a new plan and strands existing subscribers on the old one** — an "edit the trial length" button that silently forks the product. The two channels previously proposed for it were also both dead: the engine is in another repository and cannot read `plan_offer`, and the cart line item's metadata is never read (`detectSubscriptionSession` reads only `variant_id` and `quantity`) and is client-settable anyway. **Consequence:** the Admin offer form, when the product has a variant carrying `paypal_subscription`, displays that variant's `trial_periods` **and its `setup_fee`** read-only beside the offer's own values, so the operator sees both numbers and cannot edit the wrong one by accident. **And a correction to "where it already is":** neither host script actually configures `trial_periods` today (`seed-saas.ts` and `upsert-prod-variants.ts` both write only `interval_unit`, `interval_count`, `product_type`, `product_name`), and the live native variant carries `setup_fee: 2`. So the native rail currently has **no trial at all** — which is fine, and is a configuration task rather than a code task, but the spec must not imply the trial already exists. **`setup_fee` is the field that actually charges at approval, which is why the display must show it:** a native trial configured with a zero trial price but a live `setup_fee` is not free. |
| Q15 | How is "already claimed" recorded? | **An explicit `trial_claim` ledger**, unique on `(customer_id, product_id)`. Eligibility = a ledger hit **or** any existing subscription for the product (any rail, any status). Gives race safety, auditability, and an Admin view; avoids inferring the answer from `subscription.is_trial`, which native mirror rows and cancelled trials would make ambiguous. |
| Q16 | Where does this work sit in the release? | **Append as Phases 12–16, after the cut line.** Phase 8's three-way branch is a hard prerequisite: without it, every claimed trial ends by cancelling the subscription. |
| Q17 | How does a trial end when the customer wants out? | **Every binding method must have a working cancellation path.** Self-service cancellation must actually take effect on the vault rail (it does not today — T1), and the pending renewal cycle must be removed with it (T5). A customer must never be unable to stop a future charge. |
| Q18 | A claim-created subscription has no cart, and every charge path requires one (T6). | **(a) The claim creates a template cart** — a cart with an explicit region and one line item for the variant, created through core `createCartWorkflow`, existing only so the renewal-order builder has a source. **Three properties are mandatory, not incidental.** **(i) Strip `renewal_source_cart_id` from the renewal order's line-item metadata — this is the actual fix, and it is a two-line change.** That field is written in exactly two places (`process-renewal-cycle.ts:409-411`, `create-manual-renewal.ts:273`) and **read nowhere** in this repository or the host; it is what hands the customer the cart id, and the host storefront requests it as `*items.metadata`. Traceability survives without it — the order metadata carries `subscription_id` and `renewal_cycle_id`, and the subscription carries `cart_id`. **Remove the leak rather than guarding it.** **(ii) As defence in depth, `completed_at` is set on the template cart — after creation, not during it.** `createCartWorkflow` cannot create a completed cart: it runs `updateCartPromotionsWorkflow`, whose `cartFieldsForRefreshSteps` include `completed_at` and whose `validateCartStep` throws "Cart … is already completed" — inside the workflow that created it, which then compensates the cart away. Create the cart normally, then set the column with `updateCartsStep` in the same workflow. What this buys: `addToCart`, `addShippingMethodToCart`, `refreshCartItems`, `sync-subscription-cart-pricing` and `createPaymentCollectionForCart` all refuse a completed cart, and a payment collection is what `completeCartWorkflow` needs — so no completion is possible. **It is not a `completed_at` check in `completeCartWorkflow` itself** (that workflow is idempotent via the order-cart link, and has no such guard) and **`updateCart` / `updateLineItemInCart` are blind to it** because their queries omit the column, so a holder of the id can still mutate email, addresses and quantities. Accept that residual exposure, or add the column to the plugin-side checks. **(iii) The region is an explicit, validated input.** With no `region_id` core throws `No regions found`; with one that does not price the variant it throws `Variants with IDs … do not have a price`. Since the cart's currency is what every future renewal order is priced in, an implicit region freezes the wrong currency for the life of the subscription. Take the region from the claim request, validate the variant has a price there, and fail with a clear message. The region is customer-supplied and is not a security boundary — the same is true of checkout — but say so rather than implying otherwise. **(b)** (a cart-less order path) is cleaner conceptually and far more invasive — `createRenewalOrder` is precisely what Phases 3–6 rewrite. **(c)** contradicts Q5. **The cart is necessary but not sufficient — see T7.** |
| Q19 | What does an ineligible customer get when they claim? | **A typed, actionable error — not a subscription.** The earlier answer ("silently degrade to a normal paid subscription, never block the sale") is withdrawn, because it asks an endpoint that collects no payment to produce a row that must later be charged, and T7 shows exactly how that fails. **The degradation branch is deleted from the design.** Three things this decision needs that it does not yet have: **(a) The refusal must use the repo's existing vocabulary, not a new one.** "Typed" means a `MedusaError` raised from a named step, declared in a `CustomerRefusal` list with fixed copy, and classified by `classifyStepFailure` — exactly what `src/api/store/customers/me/redemptions/route.ts:71-88` does, with a typed subclass as in `src/modules/redemption/utils/errors.ts:3-9`. Name it in the step; do not leave "typed" undefined. **(b) The sale is not blocked, but not for the reason an earlier revision gave.** That revision said the DTO "already returns `eligible: false`" — it does not; the DTO returns `is_enabled`, `days` and `requires_payment_method` and has no eligibility field at all, and the host does not call that endpoint. What is true: the host's pricing card always renders a working subscribe button beside the trial one, so no purchase path depends on the trial. **(c) The host must be wired, and that is an unrecorded external dependency** — the trial CTA is an unconditional inert placeholder (`cards.tsx:252-264`) and the host's only eligibility consumer hardcodes `eligible: true`. Until someone wires the claim call and consumes the eligibility fields, this endpoint has no caller. Record it beside T1's cancel button. |

## Proposed Architecture & Data Model

### 1. `renewal_cycle` — two new states and failure bookkeeping

| Change | Detail |
|--------|--------|
| `status` enum | add **`abandoned`** (terminal) and **`awaiting_manual_resolution`** (non-terminal, parked pending a human). The column carries a CHECK constraint, so the migration drops and recreates it; the model enum, every status switch, the Admin badge/filter, DTOs, and i18n must handle both values. |
| `last_failure_kind` | `text null`. Records `classifyRenewalFailure`'s verdict for the last failed attempt, so retry ownership can be decided without re-deriving it from the error. |
| `structural_attempt_count` | `integer not null default 0`. Counts consecutive structural (non-payment) failures; reset on success. Compared against `renewal_max_attempts`. A dedicated counter is used rather than the shared `attempt_count`, because `attempt_count` also counts payment attempts owned by dunning and would mis-trigger the cap. |

Both parked and abandoned cycles are naturally outside the due set, which selects `[scheduled, failed]` only.

### 2. Settings — two new fields

| Field | Default | Purpose |
|-------|---------|---------|
| `renewal_max_attempts` | `3` | Cap on consecutive structural failures before the cycle is abandoned. |
| `renewal_reminder_lead_days` | `3` | Lookahead window for the upcoming-renewal reminder job. `0` disables the job. |

Both flow through the existing settings module, validator, Admin page, version check, and i18n (en + zhCN).

### 3. Retry ownership — one decision point

A single predicate is used by the due query and by the process step, so ownership cannot drift between them:

```
resolveCycleDisposition(cycle, subscription, openDunningCase) →
  | "not_chargeable"       // excluded before the step ever runs
  | "dunning_owns"         // an open case owns the retry timing
  | "trial_end"            // the trial-end branch handles this cycle
  | "charge"               // normal charge path
  | "settled"              // abandoned / awaiting_manual_resolution; never retried
```

**Due-query exclusions** (extend `excludeNonChargeableCycles` in `src/modules/renewal/utils/scheduler-query.ts`, which already loads the subscription):

1. existing: `NATIVE-` mirror rows and `payment_mode === "manual"`;
2. new: subscription status not in (`active`, `past_due`) — stops the silent five-minute loop for paused and cancelled subscriptions;
3. new: `cancel_effective_at` at or before the cycle's `scheduled_for`;
4. new: an **open** dunning case exists for the cycle (`open`, `retry_scheduled`, `retrying`, `awaiting_manual_resolution`) — this is what makes dunning the exclusive owner of payment retries;
5. carve-out: a **manual-mode trial** whose cycle is at or after `trial_ends_at` stays processable, because the trial-end branch must run to end it deterministically (Q7a). The branch itself never charges a manual subscription.

**Step-level rules** in `process-renewal-cycle`:

- `abandoned` and `awaiting_manual_resolution` are never selected by the due query; the step rejects both defensively.
- On failure, record `last_failure_kind`. If the failure is **payment-qualified** (existing discriminator: `getPaymentQualifiedFailureContext(error)` returns non-null) **and dunning started successfully**, dunning owns the retry and exclusion 4 prevents the scheduler from touching the cycle.
- **R1: if `startDunningWorkflow` throws**, the failure is treated as **structural** — it increments `structural_attempt_count` and is subject to the cap — and an alertable event is emitted. A payment failure whose recovery machinery could not start must not be silently retried by the scheduler forever.
- If the failure is **structural**, increment `structural_attempt_count`. At or above `renewal_max_attempts`, set the cycle `abandoned` and emit an alertable `renewal.abandoned`. Otherwise leave it `failed` for a bounded retry.
- `already_processing` and `duplicate_execution` are "blocked", not failures: they must not increment either counter.

### 4. Double-charge elimination

**Dunning recovery finalizes the period** (Q3, R6). `run-dunning-retry`'s recovery path must, in the same workflow: mark the cycle `succeeded` with `processed_at` and `generated_order_id` set to the order that was actually paid, advance the subscription cadence **anchored on `scheduled_for`** (never `now`, so the anchor does not drift), set `last_renewal_at`, clear applied pending changes, ensure the next cycle, and persist + emit `renewal.succeeded`. This is the same finalization the automatic path performs, so it is extracted into one shared step consumed by the automatic path, `complete-manual-renewal`, and this recovery path; if extraction proves too invasive, the dunning path implements identical semantics and a test asserts parity across all three.

**R2 — the ordering guard.** Independently of write order, `run-dunning-retry` must refuse to run when its cycle is already `succeeded` or `abandoned`: it closes the case (as recovered if the cycle is `succeeded`, as a no-op closure otherwise) and stops. Without this guard, a crash between "close the case" and "finalize the cycle" leaves a closed case and a `failed` cycle, which the scheduler then charges again — and the reverse order leaves an open case whose retry step would charge an already-settled period. The guard makes both orders safe, so the write order stops being load-bearing.

**Renewal success closes an open case** (Q4). On the automatic success path, if an open dunning case exists for the cycle, close it as `recovered` with a `recovery_reason` distinguishing the path. The abandoned earlier renewal order is left in place and is **not** cancelled automatically — cancelling an order whose payment state may be partially settled is a money-risking action that belongs to an operator. Documented as a known consequence.

**Dunning exhaustion abandons the cycle** (R3). When a case closes as `unrecovered` (automatic exhaustion in `run-dunning-retry` or the admin route), the originating cycle becomes `abandoned` and the subscription is left in `past_due`. The plugin emits the alertable `renewal.abandoned` event carrying the reason; **it does not cancel the subscription**. The host application owns that decision. This is a deliberate boundary: cancelling a customer relationship is not a side effect a background job should perform.

### 5. Stuck-`processing` reconciliation (Q5, R5)

A new job scans cycles in `processing` whose `updated_at` is older than a threshold (30 minutes; well beyond any legitimate provider call) and reconciles each conservatively. The order created by the crashed attempt is discoverable through the existing `renewal_cycle` ↔ `order` link.

| Observed state | Action |
|----------------|--------|
| A linked order whose payment is **confirmed captured** | Finalize as `succeeded` via the shared finalization step; close the attempt as `succeeded`; emit `renewal.succeeded`. |
| No linked order, or a linked order whose payment is **confirmed not captured** (no session, or session failed/cancelled) | Return the cycle to `failed` with an explanatory `last_error`; normal retry ownership then applies. |
| Anything else — session authorized but not captured, unreadable provider state, ambiguous collection | **Park** the cycle as `awaiting_manual_resolution` (R5) with a reason and emit an alertable event. The subscription is left untouched. Money may be in flight, and "we do not know" must not be recorded as "there is no hope". |

The same logic is exposed as an Admin action (`POST /admin/renewals/:id/resolve-stuck`) taking an explicit operator override (`succeeded` | `failed` | `abandoned`), so a human can resolve a parked cycle.

### 6. Dunning loop hardening (M7)

1. **Pre-transition failures must leave the due set.** When the subscription is not chargeable, or `max_attempts` is already reached, or the case is missing its order/schedule, the case is parked as `awaiting_manual_resolution` with a reason (or closed as `unrecovered` for exhaustion) instead of throwing and leaving `next_retry_at` in the past. Parking is chosen over throwing because the case must stop being due while remaining resolvable — `retry-now` already accepts `awaiting_manual_resolution`.
2. **A loop iteration cap** as a safety net, so no future wedge can hold the job lock indefinitely.
3. **Correct pagination** in the job loop: the current `skip: 0` re-query is only safe once (1) guarantees progress. Keep the fixed-page re-query (it is what makes concurrent resolution safe) and add the cap.

### 7. Event surface completion

| Event | Change |
|-------|--------|
| `renewal.failed` | Emit on the bus at the existing persist site (`process-renewal-cycle.ts:1001`). **This is what makes the host's `saas-email-renewal-failed` subscriber fire for the first time**, and it fixes the dead `saas-bridge` whitelist entry. |
| `subscription.expired` (trial path) | Add the emit at `process-renewal-cycle.ts:768` so the host's `saas-email-expired` subscriber fires for a trial that ends normally. |
| `dunning.started`, `dunning.retry_executed`, `dunning.recovered`, `dunning.unrecovered`, `dunning.retry_schedule_updated` | The enum members already exist and are unused. Persist them to the activity log **and** emit them, so dunning becomes visible in the Admin timeline as well as in the event stream. |
| `renewal.abandoned` (new) | Emitted whenever a cycle is abandoned (structural exhaustion, dunning exhaustion). Alertable. Carries the reason so the host can decide whether to cancel the subscription (R3). |
| `renewal.awaiting_manual_resolution` (new) | Emitted when the stuck-cycle reconciliation parks a cycle. Alertable. |
| `renewal.upcoming` (new) | Emitted by the new lookahead job. |
| `subscription.trial_ending` (new) | Emitted by the lookahead job for trial subscriptions. |
| `saas-bridge` forwarding | Register the new event names in `src/subscribers/forward-saas-events.ts` and document them in `docs/api/saas-bridge.md`. |

**Lookahead job.** A new job scans, once per hour, for cycles whose `scheduled_for` falls within `renewal_reminder_lead_days`, plus trial subscriptions whose `trial_ends_at` falls within the same window, and emits `renewal.upcoming` / `subscription.trial_ending`. Idempotency comes free from the activity log's unique `dedupe_key`, so a cycle is announced exactly once. Unlike the charge scheduler, this job deliberately **includes manual-mode subscriptions** — for a manual subscription the reminder is the moment the customer must act. It excludes paused and cancelled subscriptions, and cycles that are not `scheduled`.

*Alternative considered:* emitting without persisting. Rejected — persisting costs one row per cycle, makes the reminder auditable in the Admin timeline, and provides the dedupe guarantee without new machinery.

### 8. Trial conversion and deterministic trial end (Q7a, Q8)

The trial-end branch is rewritten from "always cancel" to a three-way decision:

| Condition | Behaviour |
|-----------|-----------|
| `payment_mode === "auto"` **and** a usable payment method reference exists **and** the subscription has a cart | **Convert.** Fall through to the normal order/charge path for the period starting at `trial_ends_at`. Success follows the normal success path (cycle `succeeded`, cadence advances from `trial_ends_at`). A payment-qualified failure starts dunning, exactly as for a normal renewal, so the customer can repair their card. **The cart is a hard prerequisite (T6)**, supplied for claimed trials by Q18a's template cart; without it this row throws before charging. |
| `payment_mode === "manual"` | **End.** Cancel with `cancel_effective_at = trial_ends_at`, cycle `succeeded` with no order, attempt `succeeded`, persist **and emit** `subscription.expired` with a reason distinguishing "trial ended, manual rail". |
| `auto` but no usable payment method | **End**, with an alertable reason. When `trial_requires_payment_method` is ON this is an expected-but-reportable outcome; when OFF it is a configuration gap worth surfacing. |

Determinism on the manual rail is achieved by the due-query carve-out in §3 item 5 — the scheduler processes a manual trial's trial-end cycle so the branch runs at `trial_ends_at` instead of the subscription lingering until the 90-day hygiene cancellation. `manual-renewal-hygiene` keeps its role as a backstop for abandoned manual subscriptions generally, but trials no longer depend on it.

**`trial_requires_payment_method`** becomes a real, per-offer toggle with a **default of OFF**:

- *Checkout enforcement:* when ON, a trial checkout that is not in auto mode is rejected with a clear message, because only an auto-mode checkout will vault a usable method. Enforced where the trial rules are already resolved (`validate-subscription-cart.ts:311-314`) and mirrored in the redemption path, which already computes the value (`redeem-redemption-code.ts:159-160`) and currently discards it.
- *Trial-end safety net:* when ON and no usable method exists at trial end, the trial ends per the third row above and the emitted event carries the rule so the operator can distinguish "expected" from "misconfigured".

The opt-in population needs no new mechanism: the storefront checkbox already produces the vault intent that flips `payment_mode` to `auto` (see the PayPal rail context above).

### 9. Rule retirement (Q9)

- Admin UI: remove the `minimum_cycles` and `stacking_policy` inputs from `create-plan-offer-modal.tsx` and `edit-plan-offer-drawer.tsx`. `trial_requires_payment_method` stays, defaulting to OFF.
- Docs: mark both removed rules as deprecated and explicitly **not enforced**; document `row_stacking_policy` / `max_stacking_cycles` as the enforced pair to avoid the existing name confusion.
- Persisted columns, API validators, and DTO fields stay for compatibility. No migration, no breaking change.

### 10. Docs

- **New:** `docs/api/store-customer-self-service-tutorial.md` — the internal tutorial. Audience: the owner's frontend developers, building the portal UI inside the SaaS app. Contents: how an external application obtains and forwards a Medusa customer identity for `/store/customers/me/*` (session vs bearer, and the consequence of each); the nine actions (list, detail, pause, resume, skip, change frequency, swap variant, change payment method, request cancellation) with request/response shapes and error cases; how to build a "payment failed" banner and retry affordance from `payment_status` + `payment_recovery` **without** any new event; and an explicit *not supported* section (customer cannot accept a retention offer — application is admin-only; no un-skip; no undo of a scheduled change; no reactivate; no past-charges view; no billing address; swap is same-product variant only and a price change is not surfaced or confirmed; guest redemption is unsupported; the list route is unpaginated). Phase 15 adds a tenth action — finalizing a cancellation — which Task 25 must fold in.
- **Updated:** `docs/architecture/renewals.md` (retry ownership, both new statuses, stuck reconciliation, the catch-up charge consequence of R6), `docs/architecture/dunning.md` (parking, recovery finalizes the period, exhaustion abandons the cycle, the R2 guard), `docs/architecture/subscriptions.md` (trial end and conversion, subscription left `past_due` on abandonment), `docs/admin/plan-offers.md` (deprecations, the enforced stacking pair), `docs/architecture/activity-log.md` (new event types), `docs/architecture/settings.md` (two new settings), `docs/api/saas-bridge.md` (new whitelist entries), the matching `docs/testing/*.md` files, and `AGENTS.md`'s task router for the new tutorial.

### 11. Known consequences and inherited risks

Recorded here so they are not rediscovered as surprises.

1. **Cart-id-as-capability is inherited from Medusa core.** Both core `/store/carts/:id/complete` and this plugin's `/store/carts/:id/subscribe` treat the cart id as the credential, and the host uses the core route. Adding a guard to the plugin route would not close the path the host actually uses. Documented, not fixed (Q6).
2. **A late dunning recovery produces a catch-up charge.** Anchoring on `scheduled_for` (R6) means a period recovered seven days late leaves the next period immediately due. Deliberate: it is the same rule the automatic path uses, and it keeps the billing anchor from drifting.
3. **An abandoned period leaves orphan unpaid orders — one per attempt, not one.** The renewal order created by a failed attempt is not cancelled, because cancelling an order whose payment state may be partially settled is an operator action. The step has no compensating function and the order comes from an already-committed sub-workflow, so a failure that occurs *after* order creation repeats on every retry up to the cap. **This is why T7 requires the payment-context check to move ahead of order creation:** a structurally unchargeable subscription must fail without minting anything, or the cap becomes a multiplier rather than a limit.
4. **An abandoned cycle leaves the subscription in `past_due`.** No job cancels it; the host application receives `renewal.abandoned` and decides (R3).
5. **A bound trial can be exited before the charge.** Deliberate (Q12): the customer may cancel or disable auto-renew before `trial_ends_at` and keep the bonus days they were granted. There is no anti-abuse machinery, by decision.
6. **The two rails have different operational profiles.** A provider-managed subscription is invisible to this plugin's engine — no renewal events, no dunning, no reminder job, no conversion decision — because PayPal owns the recurrence; a vault-rail trial gets all of them. The same product can therefore behave two different ways in the Admin timeline **depending on which variant the customer chose**, which is the intended shape (Q11) and is exactly why the two rails must not be conflated into one offer setting. **The "no reminder" half is not yet pinned by anything:** §7's lookahead job scans trial subscriptions by `trial_ends_at` with no `NATIVE-` exclusion, and it skips provider trials today only because the mirror writer sets `is_trial: false` and no `trial_ends_at` (`native-mirror-sync.ts:70-77`). Add an explicit exclusion (or a test pinning the mirror's null `trial_ends_at`) so a future mirror change cannot start mailing provider-trial customers a reminder this plugin has no business sending.

### 12. Trial claiming — two shapes, one product

The trial a customer can claim has two shapes, and the difference is decided per offer:

| | Card-free claim | Bound claim |
|---|---|---|
| Trial length | `rules.trial_days` (N) | `rules.trial_days + rules.trial_bonus_days` (N+M) |
| Payment method at claim | none | bound **without charging anything** |
| At `trial_ends_at` | **ends** (§8 rows 2–3) | **charges** (§8 row 1) |
| Who performs the charge | nobody | this plugin, over the vault rail |

New offer rules, all inside the existing `rules` JSONB — **no migration**:

| Field | Type | Meaning |
|-------|------|---------|
| `trial_bonus_days` | `number \| null` | Extra days granted once a payment method is bound. `null`/`0` disables the bonus button. |

**`trial_binding_method` is deliberately not added (Q11, Q14).** The rail is a property of the product, not of the offer: a variant carrying `paypal_subscription` metadata is a provider-managed subscription and the storefront already routes to it. Adding an offer rule for it would create a second, conflicting place to express the same fact.

**Binding always means the vault rail, and that is the whole mechanism.**

- **`vault`** — the provider only stores the method. On PayPal this is the **setup-token flow** (`createSetupToken` → the payer approves on a PayPal page → `createPaymentToken`), which involves no order, no amount, and no charge (T4). This plugin then owns the recurrence exactly as it does for any auto subscription today — **including the trial length**, which is why `trial_days` and `trial_bonus_days` both live in the offer.

**The provider rail is not a second binding method — it is a different product.** A variant carrying `paypal_subscription` metadata *is* a provider-managed subscription: PayPal owns the recurrence, the trial is a cycle in the billing plan (`medusa-paypal/src/subscription/engine.ts:407-468`), the resulting row is a `NATIVE-` mirror this plugin never charges, and the storefront already routes to it by checking that metadata (`isNativeVariant`). Nothing about claiming a reorder trial applies to it, and no offer rule configures it. **Its trial length stays in the variant metadata (Q14), because it is part of the plan's identity — and a plan is immutable and cached by a hash that includes `trial_periods`.**

Two things about that rail are worth stating because they are easy to get wrong. (i) The trial price is `config.trial_periods[0].price`, not a hard-coded zero (`engine.ts:427`); "free trial" is `price: 0` by configuration, not by construction. (ii) When a trial exists the engine attaches `setup_fee` to the **TRIAL** cycle (`engine.ts:431-438`) and it is charged at approval (`medusa-paypal/README.md:225`) — so a plan built from the README's own example charges the customer at signup. A native-rail trial that must be free has to omit `setup_fee`. (The `2026-09-19 sandbox verification` an earlier revision cited is **not recoverable**: no dated record survives, and the harness verifies a trial at price `1.00` plus a `2.00` setup fee, i.e. not the no-charge case.)

**A subscription never migrates between the two rails** (Q11). The card-free claim always produces a reorder trial; a provider-managed subscription is created by the storefront's existing native path and is only ever mirrored.

**Sequence (Q8).** The card-free claim is created first and is never blocked by the binding step; binding, when it happens, **extends** `trial_ends_at` to `started_at + (N + M) days` — anchored on the original start, so "bind on day 5" and "bind on day 1" produce the same end date. If the customer never binds, the trial simply ends at N. A binding attempt that fails or is abandoned costs the customer nothing.

**The extension has two writes, not one.** `next_renewal_at` must move with `trial_ends_at`, and the pending `SCHEDULED` cycle must be re-pointed to the new date — through `ensureNextRenewalCycleStep`, which already adopts and moves the open row, rather than a direct write. Extending `trial_ends_at` alone leaves the cycle at day N, where the trial-eligibility gate rejects it as "still in trial" every five minutes for M days, marking it `failed` and (once Phase 6 is live) emitting `renewal.failed` each time. There is at most one `SCHEDULED` cycle per subscription — a partial unique index enforces it (`src/modules/renewal/migrations/Migration20260924120000.ts:85`) — so re-pointing cannot silently create a second one; the risk is leaving it stale, not duplicating it.

**The conversion needs a cart (T6), and Q18a supplies it.** A subscription created without one cannot build a renewal order, so the bound conversion at `trial_ends_at` would throw before charging. The template cart closes that. The payment-context half of T7 is not a problem here — **binding is what writes the payment context**, and Q19 removes the only path that had none.

**PayPal only, for now.** Creem, Stripe, and Dodo Payments are future providers; the owner holds no accounts with them. The design keeps the binding capability as a **provider property** so those rails can be added later, but **nothing is abstracted ahead of the second implementation** — the shape is a duck-typed method on the resolved provider module, not an interface layer.

### 13. The trial-claim ledger and eligibility

A new `trial_claim` record, written inside the same workflow that creates the trial:

| Column | Notes |
|--------|-------|
| `id`, `customer_id`, `product_id`, `variant_id` | `product_id` is the eligibility scope. |
| `claimed_at`, `trial_ends_at` | Snapshots taken at claim time. |
| `source` | `self_service` \| `redemption` \| `admin`. |
| `subscription_id` | The trial it produced. |
| `binding_method` | `none` \| `vault`, updated when binding lands. There is no `provider_subscription` value: a provider-managed subscription never passes through the claim endpoint (Q11), so nothing could write one. |

**Unique on `(customer_id, product_id)`.** This is the race-safe anchor: two concurrent claims cannot both win, and the constraint lives on a table this feature owns, so no webhook-driven mirror write can break it.

**Eligibility = ledger hit OR any existing subscription for the product**, any rail, any status (Q15). Query the `subscription` table's own `customer_id` and `product_id` columns — both are NOT NULL and indexed (`src/modules/subscription/models/subscription.ts:13-14`), and native mirror rows always carry a resolved `product_id` (the mirror writer refuses to build a row without one, `native-mirror.ts:163-167`). **Do not query the `subscription_product` link table:** those links are created only by the redemption path (`redeem-redemption-code.ts:657-668`); the checkout path links customer, cart and order only (`link-subscription-commerce-entities.ts:41-75`), so a link-based query would silently pass every customer who bought the plan — the exact case this half of the rule exists to catch.

**This half is weaker than it looks, and T9 says why:** medusa-paypal 0.6.1 emits no `product_id`, so the mirror subscriber drops every event and `NATIVE-` rows are created only by the **hourly** backfill. For up to an hour after a native subscription exists, there is no row and this rule cannot see it. The storefront's gated button is the practical defence — a customer cannot reach the provider's approval flow without going through this plugin's checkout — but the window is real and must not be described as an edge case. T8 adds the mirror-image gap: a customer who holds a vault trial can still buy the native plan, because the checkout gate only fires in the other direction.

An ineligible customer is **never blocked from buying, and never handed a subscription either** (Q19): the claim is refused with a typed, actionable error, the storefront never shows them the trial button in the first place because the DTO said `eligible: false`, and the ordinary subscribe button is beside it. **There is no degradation branch** — an endpoint that collects no payment must not fabricate a row that will later have to be charged.

**The ledger is written at each creation door, not at one shared step.** The tempting single point does not exist: `createSubscriptionRecordStep` is called only by the cart and order flows (`create-subscription-from-cart.ts:174`, `create-subscription-from-order.ts:208`) and its input *requires* `cart_id` and `order_id` (`create-subscription-record.ts:20-24`), so the redemption path bypasses it entirely (`redeem-redemption-code.ts:360`) and a no-cart claim workflow could not call it even if it wanted to. Extract a small ledger step and invoke it from every door that can create a trial — self-service claim, redemption, and an admin action — with a compensating delete on rollback, exactly as the existing log-event step is used. Two doors are named in the spec's decisions and only two exist today; the admin door is a **new** route this work adds, not an existing one, so if it is not built the spec's "three doors" should read two.

### 14. Claim entry point and storefront contract

A new authenticated route, modeled on the redemption path — which already creates a payment-free subscription with `cart_id: null` and no order (`redeem-redemption-code.ts:360-405`; the payment context it installs is at `:292-310`):

```
POST /store/customers/me/trials
  { variant_id, region_id, binding?: "none" | "vault" }
```

It creates the trial subscription directly — **no order and no payment** — and returns the subscription plus, for a bound claim, the provider approval link. The eligibility decision and the ledger write happen in the same workflow.

**The request names only whether to bind, not which rail.** `"vault"` is the only binding mechanism (Q11); the provider rail is a different product reached through the storefront's existing native path, not through this endpoint. `region_id` is required because the template cart's region determines every future renewal order's currency (Q18a).

**An ineligible claim is refused, not degraded (Q19).** Return a typed error the storefront can act on. Do not create a subscription — the endpoint collects no payment, so it cannot produce one that will ever charge.

**Authentication is not inherited.** There is no wildcard `/store/customers/me/*` guard — each group registers its own matcher, and `src/api/middlewares.ts` is the registration list. The route needs its own `middlewares.ts` with `authenticate("customer", ["session", "bearer"])`, registered there, or it will run with no `auth_context` and no customer.

The storefront learns what to render from the existing public offer endpoint (`GET /store/products/:id/subscription-offer`), extended with:

```
trial: {
  is_enabled, days, bonus_days,
  eligible, reason,
  binding: { method, supported }
}
```

`binding.method` is `"vault"` when `trial_bonus_days` is set; `supported` is false until Task 22 lands, and the storefront hides the bound button while it is false. There is no `provider_subscription` value — see Q11.

**That endpoint is currently anonymous.** It carries no auth middleware, so today it cannot see a customer at all; it needs optional authentication (`allowUnauthenticated: true`) and an explicit `Cache-Control: no-store`, because eligibility is per-customer and the repo sets no cache headers anywhere. Without the header a shared cache would serve one customer's eligibility to another.

### 15. Leaving a trial — every binding method has an exit (Q17)

The rule is absolute: **a customer must always be able to stop a future charge, on every binding method.**

| Binding method | How the customer exits | Today |
|----------------|------------------------|-------|
| card-free (no method) | nothing to stop; the trial ends by itself | ends at N **once Phase 2's manual-trial carve-out lands** — before that it is C2, cancelled ~90 days late |
| `vault` | self-service cancellation of the reorder subscription, or the auto-renew toggle | **the toggle works; cancellation does not (T1)** |
| `provider_subscription` | the provider's own cancellation, already surfaced in the storefront | works (`POST /store/paypal/subscriptions/:id/cancel`, reachable from the panel's `rail === "native"` button) |

Two changes close the gap:

1. **Self-service cancellation must take effect.** The store route must finalize rather than only open a case, or expose a finalize path the customer can reach. The retention flow (case → offer → finalize) is preserved for customers who engage with it, but it must not be the only way out. Run the existing `finalizeCancellationWorkflow` — do not write a second cancellation path.
2. **Cancellation must remove the pending cycle**, so that a subscription cancelled *ahead of* its due date leaves nothing in the due set. This is **defence in depth, not the fix for T5**: Phase 2's due-query exclusion 2 already removes cancelled subscriptions from the selection, and that is what stops the false `renewal.failed`. The deletion covers a narrower window — a cycle already in `failed` survives it, because `ensureNextRenewalCycleStep` deletes `SCHEDULED` cycles only — and it is also what makes "cancelled before the trial ended" produce no charge at all rather than a rejected cycle.

**The plugin half is not sufficient.** Exposing the finalize route gives the API a working exit, but the host storefront renders a cancel action only for `rail === "native"` (`apps/storefront/src/modules/saas/subscription-panel/index.tsx:145-156`), so a vaulted customer still has no button that reaches it. Completing T1 therefore requires a **host-repository change**, which this spec's constraints place outside the work — it is an external dependency the owner must schedule, and the acceptance criterion "the storefront can reach a cancel action on both rails" cannot be satisfied by this repository alone.

**The same is true of the claim button, and it is easy to miss.** The host's trial CTA is an unconditional inert placeholder with no handler (`cards.tsx:252-264`), and the host's only eligibility consumer hardcodes `eligible: true` (`apps/storefront/src/app/api/trial-eligibility/route.ts`). Until someone wires the claim call and consumes the eligibility fields, **the claim endpoint has no caller at all** — every test in this spec would pass against an endpoint nothing invokes. Record it beside T1's cancel button, because both are host work this repository cannot do.

Disabling auto-renew remains a valid and sufficient way to stop the charge on the vault rail, but it is not a substitute for cancellation: the subscription would otherwise sit `active` with a future renewal date and permanently block the customer from claiming a trial again (Q15).

## Step-by-Step Implementation Plan

### Phase 0: Baseline (complete)
- [x] Verify production cycle state and the 2026-10-18 deadline (read-only).
- [x] Verify the host's checkout path and the two dead customer-email subscriptions.

### Phase 1: Data model and settings
- [ ] Migration (renewal): add `abandoned` and `awaiting_manual_resolution` to the `renewal_cycle.status` CHECK constraint; add `last_failure_kind`, `structural_attempt_count`. (The constraint name was read back from a database created by the original migration — `renewal_cycle_status_check` — rather than guessed.)
- [ ] Migration (settings): add the two new columns. §2 lists the fields; this is the second migration that makes the tripwire move by two.
- [ ] Model + enum updates; update every status switch, DTO, Admin badge, filter, and i18n label (en + zhCN) for both new statuses.
- [ ] Settings: `renewal_max_attempts`, `renewal_reminder_lead_days` through module, validator, Admin page, i18n.
- [ ] Bump the migration-count tripwire in `integration-tests/http/migrations.spec.ts` — by **one** here (22 → 23), and again after the settings migration (23 → 24). The count is a single constant asserted against the number of migrations on disk, so it cannot jump by two while only one migration exists.
- [ ] Tests: migration applies and reverts; settings round-trip and validation.

### Phase 2: Retry ownership and the terminal state
- [ ] Extend `excludeNonChargeableCycles` with exclusions 2–4 and carve-out 5.
- [ ] Add the single disposition predicate and use it in both the query and the step.
- [ ] Record `last_failure_kind`; implement the structural cap and abandonment.
- [ ] **R1:** treat a dunning-start failure as structural, subject to the cap, with an alertable event.
- [ ] Tests: paused/cancelled subscriptions stop being selected; a cycle with an open dunning case is not selected; structural failures abandon at the cap; payment failures never increment the structural counter; **a payment failure whose dunning start fails still abandons at the cap instead of looping**.

### Phase 3: Double-charge elimination
- [ ] Extract the shared period-finalization step; consume it from the automatic path, `complete-manual-renewal`, and the dunning recovery path.
- [ ] Dunning recovery finalizes the cycle and advances the cadence (anchored on `scheduled_for`).
- [ ] **R2:** add the cycle-status guard to `run-dunning-retry` — refuse to run when the cycle is `succeeded` or `abandoned`, closing the case instead.
- [ ] Renewal success closes an open case as `recovered` with an explicit reason.
- [ ] Dunning exhaustion (`unrecovered`, automatic and admin) abandons the cycle, leaves the subscription `past_due`, and emits `renewal.abandoned` (R3).
- [ ] Update the pinned test `integration-tests/http/dunning-workflows.spec.ts:315`.
- [ ] Tests: recovery produces exactly one charge for the period and a correct next anchor; a success with an open case closes it; exhaustion abandons without cancelling the subscription; **a settled cycle blocks the dunning retry**.

### Phase 4: Stuck-`processing` reconciliation
- [ ] Reconciliation workflow implementing the three-row decision table, using the cycle↔order link.
- [ ] Job with the 30-minute threshold; alertable event on the parked outcome.
- [ ] Admin route with operator override, including un-parking a cycle in `awaiting_manual_resolution`.
- [ ] Tests: captured → finalized; not captured → retryable; ambiguous → parked (not abandoned) + event; operator override works from both `processing` and `awaiting_manual_resolution`.

### Phase 5: Dunning loop hardening
- [ ] Park pre-transition failures as `awaiting_manual_resolution`; close exhaustion as `unrecovered`.
- [ ] Add the loop iteration cap.
- [ ] Tests: a wedged case stops being due, the job terminates, and other due cases are still processed.

### Phase 6: Event surface completion
- [ ] Emit `renewal.failed`; emit the trial-path `subscription.expired`; persist + emit the five `dunning.*` events.
- [ ] Add `renewal.abandoned` and `renewal.awaiting_manual_resolution` to the activity-log event-type enum **and** to the hardcoded `domainPresetOptions` filter list in `src/admin/routes/subscriptions/activity-log/page.tsx` (an event type absent from that list is written and displayed but not filterable). No catalog keys: `formatEventType` title-cases the raw string, and `docs/admin/i18n.md:154` records that as deliberate. Also add the missing `subscription.expired` to the subscription group while there.
- [ ] Register new names in `forward-saas-events.ts` and document them.
- [ ] Tests: spy on `eventBus.emit` (pattern: `integration-tests/http/manual-renewal.spec.ts:249-275`) asserting each event fires exactly once per occurrence.
- [ ] **Host-side acceptance:** confirm in the host that `saas-email-renewal-failed` and `saas-email-expired` actually send once the events fire. This is the check that proves the two dead emails are alive.

**— cut line: Phases 1–6 must land before 2026-10-18 08:28 UTC —**

### Phase 7: Reminder lookahead
- [ ] Job scanning `renewal_reminder_lead_days`; emits `renewal.upcoming` and `subscription.trial_ending`; deduped through the activity log.
- [ ] Tests: emits once per cycle across repeated runs; includes manual subscriptions; excludes paused/cancelled; `0` disables it.

### Phase 8: Trial conversion and `trial_requires_payment_method`
- [ ] Rewrite the trial-end branch as the three-way decision.
- [ ] Implement the checkout and redemption enforcement of the toggle; default OFF. *(Amended by Phase 13: once the claim endpoint exists, the primary enforcement point moves there, because a claimed trial no longer passes through a cart. The checkout enforcement stays for trials that still arrive that way.)*
- [ ] Tests: auto + method converts and charges exactly once with the correct anchor; auto + no method ends with an alertable reason; manual ends deterministically at `trial_ends_at`; the toggle rejects manual trial checkout when ON and does not when OFF; a native PayPal subscription is never charged by this path.

### Phase 9: Rule retirement
- [ ] Remove the two inputs from both Admin offer forms; verify the store/admin DTOs still round-trip the values.
- [ ] Tests: the i18n gate and the admin-offer HTTP suite still pass; no form field references the removed rules.

### Phase 10: Documentation
- [ ] Write the tutorial; update the eight runtime docs, the known-consequences list, and the AGENTS.md task router.
- [ ] Tests: `corepack yarn test:i18n` plus the docs-consistency expectations in the affected testing docs.

### Phase 11: CI
- [ ] Minimal workflow running `corepack yarn build` and the HTTP integration suite against a Postgres service container, plus the i18n gate. The one phase that can be dropped without weakening the money-safety guarantee.

**— Phases 12–16 below are additive and must not be started before Phase 8 lands —**

### Phase 12: Trial-claim ledger and eligibility
- [ ] Migration: `trial_claim` with the unique constraint on `(customer_id, product_id)`; bump the migration-count tripwire (24 → 25) **and add `"trial-claim"` to the hardcoded `MIGRATION_PATHS` list** in `integration-tests/http/migrations.spec.ts:83-93`. The suite asserts that list against the module directories found on disk and separately checks the app's applied set against the same inventory, so a new module directory fails both cases unless the list is updated.
- [ ] Module, model, and service, following `src/modules/redemption/` — the repo's existing precedent for a small ledger module.
- [ ] A shared ledger step invoked from **each** door that can create a trial (self-service claim, redemption, and the admin action if it is built), with a compensating delete on rollback. Do **not** target `createSubscriptionRecordStep`: the redemption path bypasses it and its input requires `cart_id` and `order_id`, which a no-cart claim does not have.
- [ ] Eligibility predicate: ledger hit OR any subscription for the product, any rail, any status — queried on the `subscription` table's own `customer_id` and `product_id` columns, never on the `subscription_product` link table.
- [ ] ~~Informational read-only check against production~~ — **dropped.** There are no customers, so there is no historical data to inspect, no backfill to plan, and no pre-existing duplicate to reconcile. The `trial_claim` table is created empty by this task's own migration, so its unique index cannot fail to build either.
- [ ] Admin visibility for the ledger, or an explicit decision to defer it (spec Q15 promises one; no other task builds it).
- [ ] Tests: first claim succeeds; a concurrent second claim loses to the constraint; a customer with a paid subscription but no trial is ineligible; a native mirror row makes the customer ineligible.

### Phase 13: Claim entry point and offer rules
- [ ] `trial_bonus_days` in `PlanOfferRules`, its validator, normalization, and both Admin offer forms (JSONB — no migration). **Not `trial_binding_method`** — Q11 and Q14 removed it.
- [ ] The offer form displays the variant's `paypal_subscription.trial_periods` **read-only** beside the offer's own trial values when the product has such a variant, so the operator sees both numbers (Q14).
- [ ] `POST /store/customers/me/trials` creating the trial directly — **no order, no payment, and no checkout** — plus the **template cart** Q18a requires: a cart with an explicit, validated region and one line item for the variant, created through core `createCartWorkflow`, with `completed_at` set so the leaked cart id is inert. The claim is still not a purchase; the cart exists only so the renewal-order builder has a source. Create the initial renewal cycle as the redemption path does.
- [ ] **The ineligible claim is refused with a typed error (Q19).** Do not create a subscription, do not degrade, do not collect a payment method. The DTO's `eligible: false` is what keeps the button off the screen; the endpoint's error is the backstop.
- [ ] Extend the store offer DTO with `trial.eligible` / `reason` / `bonus_days` / `binding`, uncached for signed-in customers.
- [ ] **Amend Phase 8:** `trial_requires_payment_method` gains a third enforcement point at the **claim** endpoint, because a claimed trial no longer passes through a cart. **The checkout enforcement stays** — trials can still arrive that way — and so does the Phase 8 trial-end safety net. When ON, a `binding: "none"` claim is refused. The redemption path is a third door with no cart and no way to collect a method, so "enforce" there needs a definition: refusing the redemption, or degrading it, is a decision Phase 8 left open and this phase must close.
- [ ] Tests: a card-free claim creates the trial with `payment_mode: manual`; **an ineligible claim returns a typed error, creates no subscription and writes no ledger row**; the toggle refuses a card-free claim when ON; the DTO reports eligibility per customer.

### Phase 14: Binding a payment method without charging
- [ ] **Sandbox verification first, before anything is designed around it.** Run the setup-token flow end to end against the PayPal sandbox (credentials and a harness already exist at `D:\Projects\medusa-paypal\.scratch\paypal-subscriptions\`) and confirm the one thing the whole feature rests on: **a vault id obtained through a setup token works with the plugin's existing off-session charge path.** If it does not, stop and report — the design does not work, and there is no fallback rail to retreat to now that Q11 removed `provider_subscription` from the claim path. **The four account-level gates are a pre-launch checklist item, not a blocker:** the owner cannot test production, so they are recorded and checked at deployment. T4 is explicit that the SDK's stubs settle nothing about the account, which is exactly why this is deferred rather than pretended.
- [ ] **Cross-repo (`D:\Projects\medusa-paypal`):** implement the setup-token flow — `createSetupToken` with `ON_PAYER_APPROVAL` and the required `return_url`/`cancel_url`, return the approval link, poll `getSetupToken` until `APPROVED`, then `createPaymentToken` with `{ token: { id, type: "SETUP_TOKEN" } }`. Nothing in that repo calls either endpoint today (T4). **Reorder cannot make these calls itself**: it has no PayPal dependency, no client and no credentials, and the provider class is not reachable through the package's export map — the only programmatic surface is the `paypalSubscription` module resolved from the container by key. The full specification for this half lives in `.agents/specs/2026-09-28-paypal-vault-binding-plan.md`.
- [ ] Binding endpoint on the reorder side: given an approved setup token, store the method on the trial subscription **together with `payment_provider_id`** (T7 requires both), set `payment_mode: auto`, extend `trial_ends_at` to `started_at + (N + M)`, **move `next_renewal_at` with it and re-point the pending `SCHEDULED` cycle through `ensureNextRenewalCycleStep`**, and update the ledger's `binding_method`.
- [ ] **The provider rail needs no new code (Q11, Q14).** A variant carrying `paypal_subscription` is already a provider-managed subscription; its trial comes from the billing plan and its length stays in the variant metadata. The only work is the offer form's read-only display of that value (Phase 13) and confirming that native mirror rows make a customer ineligible for a reorder trial (Phase 12's eligibility rule already covers this — a mirror row carries `product_id`). **There is no cross-repo trial-length contract and no `provider_subscription` value in the offer rules.**
- [ ] **Q18 is resolved as (a)** — the claim creates a template cart. Build the conversion charge against that, not against an assumption that the cart is absent.
- [ ] Tests: a bound trial charges exactly once at the extended date; an unbound trial ends at N; binding on day 5 produces the same end date as binding on day 1; the pending cycle moved rather than duplicated; a `provider_subscription` trial is never charged by this plugin.

### Phase 15: Leaving a trial
- [ ] Make self-service cancellation take effect (T1) by exposing the existing `finalizeCancellationWorkflow` to the customer, keeping the retention case as an option rather than a gate. Do not write a second cancellation path.
- [ ] Verify — do not implement — that the pending `SCHEDULED` cycle is removed on cancellation. `finalizeCancellationStep` already writes `next_renewal_at: null` and the workflow already runs `ensureNextRenewalCycleStep`, which deletes scheduled cycles. This is defence in depth for the pre-due-date case; the actual T5 fix is Phase 2's due-query exclusion.
- [ ] Record the **host-repository dependency** for the storefront half of T1 (no cancel button is rendered for the vaulted rail). This repository cannot satisfy it, and the acceptance criterion below must be restated as an external dependency rather than a passing test.
- [ ] Tests: cancelling during a trial leaves no scheduled cycle and no charge; the auto-renew toggle alone also prevents the charge; the plugin's finalize route is reachable and ownership-checked.

### Phase 16: Trial documentation
- [ ] Document the two rails (and that only the vault rail is a binding method for a claimed trial), where each rail's trial length lives, the claim endpoint, the eligibility rule, and the customer's exit paths in `docs/architecture/subscriptions.md`, `docs/admin/plan-offers.md`, the store API docs, and the self-service tutorial.
- [ ] Record the two rails' different operational profiles (events, dunning, mirroring) as a known consequence — and record that a plan's trial length is immutable once minted, so editing it affects new subscribers only.

## Verification & Testing

**Automated.** Every phase adds HTTP integration coverage under `integration-tests/http/`, following the existing self-contained patterns. The two money-moving jobs — `process-renewal-cycles` and `process-dunning-retries` — currently have **zero** job-level coverage; both gain it here, because they are exactly what this spec changes.

**Pinned tests deliberately changed.** `integration-tests/http/dunning-workflows.spec.ts:315` asserts the old recovery behaviour and must be rewritten. Any other test asserting `renewal_cycle.status === failed` after a recovery, or asserting `attempt_count`-based behaviour, must be reviewed in the same pass.

**Gates.** `corepack yarn build`, `corepack yarn test:integration:http`, `corepack yarn test:integration:modules`, `corepack yarn test:i18n`. The jest gates need the acceptance Postgres and `DB_HOST=localhost` (never `127.0.0.1`); `test:integration:modules` never applies migrations, so any assertion about migration output belongs in the HTTP suite.

**Manual end-to-end rehearsal.** Before deployment, rehearse the failure paths against a disposable database with a mocked failing payment: (1) a payment failure hands off to dunning and the scheduler stops touching the cycle; (2) a payment failure whose dunning start fails still terminates at the cap; (3) a recovered period produces exactly one order and one charge; (4) a structural failure abandons at the cap and leaves the subscription `past_due`; (5) a simulated stuck `processing` cycle reconciles in all three directions, with the ambiguous case parked rather than abandoned. Production deployment itself is out of scope and requires its own authorization, as with the money-basis switch.

The trial-claim phases add their own rehearsal, all against a disposable database: (6) a card-free claim creates a trial with no order and no payment, and ends at `trial_ends_at` with no charge; (7) a second claim for the same product is refused **with a typed error and creates nothing**, and a customer with a paid subscription for that product is refused the same way; (8) binding a method on day 5 produces the same `trial_ends_at` as binding on day 1, the pending cycle moved rather than duplicated, and the trial charges exactly once at the extended date; (9) **a template cart cannot be completed and cannot be subscribed** — the Q18a guard, and the one that proves the leaked cart id is inert; (10) cancelling during a trial leaves no scheduled cycle, no charge, and no `renewal.failed`; (11) disabling auto-renew alone also prevents the charge; (12) a cancelled subscription with a leftover `failed` cycle stops producing `renewal.failed` once Phase 2's exclusion 2 is live — this is the T5 regression, and it is reproducible today without any trial; (13) a subscription with no payment context fails **without creating an order** (T7's fix), so the retry loop cannot mint orphans.

**Release sequencing.** Phases 1–6 are the money-safety core and must land before 2026-10-18 08:28 UTC. Phases 7–11 are additive. If the deadline tightens, the cut line is after Phase 6 — decided in advance (R4) so it is not renegotiated under pressure.

Phases 12–16 (the customer-claimable trial) are additive as well, and **hard-blocked on Phase 8**: until the trial-end branch stops cancelling unconditionally, a claimed trial is a guaranteed churn. Q18, Q19 and Q14 are all resolved, so the charge path, the ineligible path and the config homes have defined mechanisms. One item inside them is not blocked by anything and should start immediately: the **PayPal setup-token sandbox verification** (Phase 14, first bullet), which does not depend on this repository at all.

**Sandbox is the standard.** The owner holds a PayPal business account but cannot test against production, so the four account-level vaulting gates cannot be verified now. They are recorded as a **pre-launch checklist item**, not a blocking verification: the design proceeds on sandbox evidence, and if the gates turn out to be closed at deployment the feature simply does not enable. **Nothing in this spec has an unbounded lead time any more** — the previously flagged "may need a human at PayPal" item is deferred to launch, where it belongs.

**Phase 14 spans a second repository with its own release.** The vault binding needs three PayPal API calls that only `medusa-paypal` can make, and that plugin has its own version number, changelog and publish step. Its work is specified separately in `.agents/specs/2026-09-28-paypal-vault-binding-plan.md`, and it must ship **before** the reorder-side task that consumes it — reorder probes for the capability at runtime and reports `supported: false` when the installed provider is too old, so the two can be deployed in either order without breaking anything, but the feature only turns on once both are present.

Two items are **external dependencies this repository cannot close**, recorded so they are not mistaken for oversights: the host storefront's missing cancel action for the vaulted rail (T1, Phase 15), and the account-level PayPal gates (T4, Phase 14).
