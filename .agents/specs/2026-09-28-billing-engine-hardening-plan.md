# Billing Engine Hardening, Event Completion, and Trial Conversion — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the renewal engine from re-charging a failed period every five minutes, from charging one period twice through two independent retry paths, and from stranding a charged cycle in `processing` forever; deliver the customer notifications that are already written but never fire; make trial end deterministic with conversion on the auto-renew rail; and add a customer-claimable free trial — card-free, with extra days granted for binding a payment method that will be charged when the trial ends, and a working exit on every binding method.

**Architecture:** Four defects share one root cause: no component owns "this period is settled". The fix introduces a single disposition predicate used by both the due query and the process step, two new cycle states (`abandoned` terminal, `awaiting_manual_resolution` parked), a dedicated structural-failure counter, one shared period-finalization step consumed by all three paths that can settle a period, and the event emissions that the host application is already subscribed to. The trial-claim work (Tasks 20–25) adds a claim ledger keyed on `(customer_id, product_id)`, a claim endpoint modeled on the redemption path's payment-free subscription creation, a per-offer binding-method setting, and the self-service cancellation that does not currently take effect.

**Tech Stack:** Medusa v2 (2.20.0 pinned), TypeScript, MikroORM hand-authored migrations, jest HTTP integration suites, Playwright (admin E2E, not extended here), react-i18next (en + zhCN catalogs).

**Spec:** `.agents/specs/2026-09-28-billing-engine-hardening-and-trial-conversion.md` — read it with this plan. The plan argues from the spec; where they disagree, the spec wins and the disagreement is a finding.

## Global Constraints

- **Deadline.** The earliest due renewal cycle in production is **2026-10-18 08:28:48 UTC** and the scheduler runs every five minutes. Tasks 1–12 are the money-safety core and must be deployed before it. Tasks 13–19 may slip; the cut line is written into the plan and is not renegotiated under pressure.
- **Nothing in this plan writes to production.** Production access is read-only (`ssh ubuntu@170.106.132.210`, `sudo -n docker exec medusa-prod-db-1 psql -U medusa -d medusa_store`). Deployment is a separate authorization, as with the money-basis switch.
- **The host repository is not edited.** `D:\Projects\medusa-saas` is used for read-only verification in Task 12 (the two dead email subscribers). Its own tree carries the owner's uncommitted work.
- **English for every artifact** — code, comments, docs, commit messages (repo rule).
- **Never use `any`.** Prefer descriptive domain types. The existing `as never` casts in mirror writers are pre-existing and out of scope.
- **Business rules live in workflows or module services**, never in route handlers or React components.
- **Never modify generated files by hand** — the two `.snapshot-medusa-*.json` files are the exception the repo already makes, and they are edited only with the round-trip-asserted script described in Task 1.
- **Migrations are hand-authored and named by timestamp.** The renewal migration must sort after `Migration20260924120000`; the settings migration after `Migration20260403132519`. Examples below use `20260928120000` / `20260928120001`; substitute the execution date if it differs.
- **The migration tripwire moves one step at a time.** `integration-tests/http/migrations.spec.ts:129` pins `EXPECTED_MIGRATION_COUNT = 22` and asserts it at `:1069` against the migrations actually on disk. Task 1 creates one migration (renewal) → **23**; Task 2 creates the settings migration → **24**; Task 20 creates `trial_claim` → **25**. Bumping straight to 24 in Task 1 fails that task's own gate, because only 23 exist at that moment.
- **The migration suite has a second, hardcoded registration site.** `MIGRATION_PATHS` (`integration-tests/http/migrations.spec.ts:83-93`) lists the nine module directories the probe applies, and the suite asserts that list equals the module directories found on disk and that the app's applied set matches the same inventory. A new module directory therefore fails **two** cases unless `"trial-claim"` is added to that list. Modules themselves need no registration — `medusa plugin:build` compiles to `.medusa/server/src`, the package `exports` map `./modules/*`, and Medusa's `getResolvedPlugins` auto-registers every directory it finds — but the test's list is manual.
- **The cross-repo half has its own plan.** Task 22 consumes a capability that lives in `D:\Projects\medusa-paypal`, specified separately in `.agents/specs/2026-09-28-paypal-vault-binding-plan.md` because the plugin has its own version number, changelog and publish step. Read that document before Task 22. It also carries the uncertainties that can invalidate the design, and its Task P4 Step 2 is the go/no-go — **Task 22 should not be started until it reports a pass.** Task 23 does not touch that repository and is not gated on it.
- **The host repository is not edited, and one requirement lives there.** T1's customer-visible half — a cancel action for the vaulted rail in the storefront panel — cannot be closed from this repository. Task 24 exposes the API and records the dependency; it does not satisfy it.
- **Gates.** `corepack yarn build`, `corepack yarn test:integration:http`, `corepack yarn test:integration:modules`, `corepack yarn test:i18n`. The jest gates need the acceptance Postgres and **`DB_HOST=localhost`** (never `127.0.0.1` — it wedges `PgConnection`); export `DB_HOST`, `DB_PORT`, `DB_USERNAME`, `DB_PASSWORD` in the same shell. `test:integration:modules` never applies a migration, so migration assertions belong in the HTTP suite.
- **Conventional Commits, approval first.** Propose the message and wait for explicit approval before committing or pushing.

---

### Task 1: Two new cycle states and the failure bookkeeping

**Files:**
- Modify: `src/modules/renewal/types/index.ts` (`RenewalCycleStatus`, `RenewalCycleData`)
- Modify: `src/modules/renewal/models/renewal-cycle.ts`
- Create: `src/modules/renewal/migrations/Migration<ts>.ts`
- Modify: `src/modules/renewal/migrations/.snapshot-medusa-renewal.json`
- Modify: `src/modules/renewal/utils/admin-query.ts` (`RenewalCycleRecord.status` union)
- Modify: `src/api/admin/renewals/validators.ts` (`renewalCycleStatusSchema`)
- Modify: `src/admin/types/renewal.ts` (`RenewalCycleAdminStatus`)
- Modify: `src/admin/routes/subscriptions/renewals/page.tsx` (status keys, relative-status keys, filter options, colour)
- Modify: `src/admin/i18n/json/en.json`, `src/admin/i18n/json/zhCN.json` (`renewals.status.*`, `renewals.relativeStatus.*`)
- Modify: `integration-tests/http/migrations.spec.ts` (`EXPECTED_MIGRATION_COUNT`)

**Interfaces:**
- Consumes: nothing.
- Produces: `RenewalCycleStatus.ABANDONED`, `RenewalCycleStatus.AWAITING_MANUAL_RESOLUTION`, and the fields `last_failure_kind: string | null` and `structural_attempt_count: number` on the cycle — consumed by Tasks 3–10.

- [ ] **Step 1: Extend the status enum with the two new members**

`abandoned` is terminal (structural retries exhausted, dunning exhausted). `awaiting_manual_resolution` is parked (a human must decide; the period is neither paid nor written off). Both are naturally outside the due set, which selects `[scheduled, failed]`.

- [ ] **Step 2: Add the two bookkeeping fields to the model**

`last_failure_kind` (`text null`) records `classifyRenewalFailure`'s verdict. `structural_attempt_count` (`integer not null default 0`) counts consecutive structural failures. It is separate from `attempt_count` on purpose: `attempt_count` also counts payment attempts dunning owns, so comparing it against a cap would abandon cycles whose payment retries are still legitimately in flight.

- [ ] **Step 3: Write the migration**

Drop and recreate the status CHECK constraint with all five values, then add the two columns.

The constraint name is **not a guess**: the original table was created with an inline `check ("status" in (...))`, so Postgres generated the name, and it was read back from a database created by that very migration as `renewal_cycle_status_check` (alongside `renewal_cycle_approval_status_check`). Use the explicit name.

```sql
alter table if exists "renewal_cycle" drop constraint if exists "renewal_cycle_status_check";
alter table if exists "renewal_cycle" add constraint "renewal_cycle_status_check"
  check ("status" in ('scheduled', 'processing', 'succeeded', 'failed', 'abandoned', 'awaiting_manual_resolution'));
alter table if exists "renewal_cycle" add column if not exists "last_failure_kind" text null;
alter table if exists "renewal_cycle" add column if not exists "structural_attempt_count" integer not null default 0;
```

`down()` returns `abandoned` and `awaiting_manual_resolution` rows to `failed` before restoring the old constraint — that re-arms them for the scheduler, which is exactly the behaviour these states exist to remove, so the rollback is only safe together with a code rollback. Say so in the migration comment (the repo's style) rather than dropping the rows: losing the record of an unpaid period is worse than retrying it.

- [ ] **Step 4: Update the snapshot with a round-trip-asserted script**

Do **not** hand-edit the JSON. Use a one-off node script that (a) re-serializes the unmodified parse and asserts it is byte-identical to the file on disk — 2-space indent, CRLF, trailing newline — and (b) only then writes the mutation. Add `"abandoned"` and `"awaiting_manual_resolution"` to `status.enumItems`, insert `last_failure_kind` after `last_error`, and `structural_attempt_count` after `attempt_count`. The script is scratch and is deleted afterwards; the snapshot diff must be **insertions only**.

- [ ] **Step 5: Wire the two statuses through the Admin surface**

Add both to `RenewalCycleAdminStatus`, the API validator's enum, `RenewalCycleRecord.status`, `RENEWAL_CYCLE_STATUS_KEYS`, `RENEWAL_RELATIVE_STATUS_KEYS`, the status filter options, and `getCycleStatusColor` (`abandoned` → `grey`, `awaiting_manual_resolution` → `orange`). Add i18n keys to **both** catalogs — the parity test fails if only one is updated:

| key | en | zhCN |
|-----|----|------|
| `renewals.status.abandoned` | `Abandoned` | `已终止` |
| `renewals.status.awaitingManualResolution` | `Awaiting manual resolution` | `待人工处理` |
| `renewals.relativeStatus.abandoned` | `Retries stopped` | `已停止重试` |
| `renewals.relativeStatus.awaitingManualResolution` | `Needs a human` | `需要人工介入` |

- [ ] **Step 6: Move the migration tripwire — by one**

`EXPECTED_MIGRATION_COUNT` 22 → **23**. Not 24: this task creates one migration, and the constant is asserted against the count on disk. Task 2 moves it to 24 when it adds the settings migration.

- [ ] **Step 7: Validate**

```bash
corepack yarn test:i18n
corepack yarn test:integration:http -- -t "migrates every module directory the plugin ships"
```

Both must pass. The migration case proves the constraint recreates cleanly and the count matches.

### Task 2: The two new settings, end to end

**Files:**
- Modify: `src/modules/settings/utils/normalize-settings.ts`
- Modify: `src/modules/settings/models/subscription-settings.ts`
- Modify: `src/modules/settings/service.ts`
- Create: `src/modules/settings/migrations/Migration<ts>.ts`
- Modify: `src/modules/settings/migrations/.snapshot-medusa-subscription-settings.json`
- Modify: `src/api/admin/subscription-settings/validators.ts`
- Modify: `src/admin/routes/settings/subscription-settings/page.tsx`, `.../data-loading.ts`
- Modify: `src/admin/i18n/json/en.json`, `zhCN.json`
- Modify: `integration-tests/http/migrations.spec.ts` (`EXPECTED_MIGRATION_COUNT` 23 → 24)

**Interfaces:**
- Consumes: nothing.
- Produces: `renewal_max_attempts` (default 3, consumed by Task 4) and `renewal_reminder_lead_days` (default 3, consumed by Task 13) on `SubscriptionSettingsShape`.

- [ ] **Step 1: Add both fields to the shape, the defaults, and the normalizer**

`renewal_max_attempts` must be an integer `> 0`; `renewal_reminder_lead_days` an integer `>= 0` (0 disables the reminder job). Follow the existing `assertInteger` + `MedusaError` pattern in `normalize-settings.ts`; do not invent a second validation style.

- [ ] **Step 2: Model, migration, and snapshot**

Columns are `integer not null default 3` each, added with `if not exists`. Use the same round-trip-asserted script approach as Task 1 Step 4. Note for the operator: the settings module has **two** snapshot files; the live one is `.snapshot-medusa-subscription-settings.json` (the module key is `subscriptionSettings`). `.snapshot-medusa-settings.json` is a stale duplicate from before the rename — leave it alone and mention it in the final report rather than silently editing or deleting it.

- [ ] **Step 3: Service pass-through and API validation**

`getSettings()` must fall back to the defaults when a column is null (the settings row may pre-date the migration), and `updateSettings()` must carry both values through its version-checked payload. Add both to the zod schema: `renewal_max_attempts: z.number().int().gt(0).optional()`, `renewal_reminder_lead_days: z.number().int().min(0).optional()`.

- [ ] **Step 4: Admin settings page + i18n (en + zhCN)**

- [ ] **Step 5: Move the migration tripwire — the second and last step of the pair**

`EXPECTED_MIGRATION_COUNT` 23 → **24**. This is the other half of Task 1 Step 6; Task 20 moves it to 25.

- [ ] **Step 6: Validate**

```bash
corepack yarn test:i18n
corepack yarn test:integration:http -- -t "subscription settings"
```

### Task 3: One disposition predicate, and the due-query exclusions

**Files:**
- Modify: `src/modules/renewal/utils/scheduler-query.ts` (`excludeNonChargeableCycles` and its call site)
- Create: `src/modules/renewal/utils/cycle-disposition.ts`
- Modify: `src/workflows/steps/process-renewal-cycle.ts` (consume the predicate defensively)

**Interfaces:**
- Consumes: Task 1's statuses.
- Produces: `resolveCycleDisposition(cycle, subscription, openDunningCase) → "not_chargeable" | "dunning_owns" | "trial_end" | "charge" | "settled"`, used by both the query and the step so ownership cannot drift between them.

- [ ] **Step 1: Extend the exclusions**

`excludeNonChargeableCycles` already loads the subscription for the manual/native filter. Add, in the same pass:

1. subscription status not in (`active`, `past_due`) — stops the silent loop for paused and cancelled subscriptions;
2. `cancel_effective_at` at or before the cycle's `scheduled_for`;
3. an **open** dunning case exists for the cycle — statuses `open`, `retry_scheduled`, `retrying`, `awaiting_manual_resolution` (read `src/modules/dunning/types/index.ts` for the enum; do not hardcode the strings).

For (3), load the cases for the page's cycle ids in one query and build a set — do not query per cycle.

- [ ] **Step 2: Add the manual-trial carve-out**

A manual-mode subscription is excluded, **except** when it is a trial whose cycle is at or after `trial_ends_at`. That cycle must stay processable so the trial-end branch can run at the right time instead of the subscription lingering until the 90-day hygiene cancellation (Task 14 depends on this carve-out). The branch itself never charges a manual subscription.

- [ ] **Step 3: Fix the post-pagination filter while you are here**

The existing `isApprovalEligible` filter runs **after** pagination, so a page consisting solely of excluded rows yields a short batch. Keep the behaviour but leave a comment naming it, and do not "fix" it by moving the filter into the query — the approval predicate is not expressible in the graph filter, and the manual-renewal rework that supersedes this filter is out of scope.

- [ ] **Step 4: Use the predicate in the step**

`process-renewal-cycle` must reject `abandoned` and `awaiting_manual_resolution` defensively (the query already excludes them) alongside the existing `processing` and `succeeded` guards.

- [ ] **Step 5: Tests**

New HTTP suite `integration-tests/http/renewal-retry-ownership.spec.ts`:

- a paused subscription's due cycle is not returned by `listDueRenewalCyclesForProcessing`;
- a cancelled subscription's due cycle is not returned;
- a cycle with an open dunning case is not returned, and one whose case is `recovered`/`unrecovered` **is** returned unless another rule excludes it;
- a manual trial's trial-end cycle **is** returned; a manual non-trial cycle is not.

### Task 4: Structural failure cap, abandonment, and the dunning-start fallback

**Also owns the two structural guards no other task claimed** — the payment-context check moving ahead of order creation (T7, Step 5) and the checkout gate's missing direction (T8, Step 6). Both are "the engine must not create what it cannot sustain", which is this task's family, and both are reachable **today**: neither depends on the trial phases.

**Files:**
- Modify: `src/workflows/steps/process-renewal-cycle.ts` (failure path, `:978-1106`; charge path, `:428-483`)
- Modify: `src/modules/renewal/utils/observability.ts` if a new failure kind is needed
- Modify: `src/modules/subscription/utils/checkout-gate.ts`, `.../native-exclusivity.ts`, `.../native-subscription.ts` (Step 6)
- Modify: `src/modules/subscription/__tests__/checkout-gate.spec.ts`, `.../native-subscription.spec.ts`, `integration-tests/http/native-checkout-gate.spec.ts` (Step 6 — the last one's "never blocks on this plugin's own subscription row" case flips meaning)

**Interfaces:**
- Consumes: Task 1's fields, Task 2's `renewal_max_attempts`.
- Produces: cycles that reach `abandoned` instead of looping; a `renewal.abandoned` emission point (Task 11 wires the event); the payment-context check hoisted above order creation; a checkout gate that blocks in both rail directions.

- [ ] **Step 1: Classify and record every failure**

On the failure path, write `last_failure_kind = classifyRenewalFailure(error)`. `already_processing` and `duplicate_execution` are "blocked", not failures (`isAlertableRenewalFailure` already encodes that set) — they must not increment either counter.

- [ ] **Step 2: Payment-qualified failures hand off to dunning, and only then**

The discriminator already exists: `getPaymentQualifiedFailureContext(error)` returns non-null exactly when the failure came from the payment session/authorize/capture path.

**If `startDunningWorkflow` throws, the failure is structural.** This is the R1 hole: today the error is swallowed at `:1069-1085`, the cycle stays `failed`, no case exists, and the five-minute loop resumes. Treat it as structural — it increments `structural_attempt_count`, is subject to the cap, and emits the alertable log line that already exists. A payment failure whose recovery machinery could not start must never be silently retried forever.

- [ ] **Step 3: Apply the cap**

On a structural failure, increment `structural_attempt_count`. At or above `renewal_max_attempts` from the effective settings, set the cycle `abandoned` with `last_error` carrying the reason, and emit the abandonment event. Otherwise leave it `failed` for a bounded retry. Reset `structural_attempt_count` to 0 on success.

- [ ] **Step 4: Tests**

- a structural failure (e.g. missing `cart_id`) stops being selected after `renewal_max_attempts` attempts and is `abandoned`;
- a payment failure does **not** increment `structural_attempt_count`;
- **with dunning start forced to throw, a payment failure still abandons at the cap instead of looping** — the R1 regression test;
- `already_processing` and `duplicate_execution` increment nothing.

- [ ] **Step 5: The payment-context check moves ahead of order creation (T7)**

Today the check sits *after* `createOrderWorkflow` (`process-renewal-cycle.ts:447-464`, guard at `:472-483`), inside a step with **no compensating function** (`createStep("process-renewal-cycle", handler)`, `:622`), and the order comes from an already-committed sub-workflow. So a subscription that structurally cannot be charged does not produce one failed cycle — it produces **one orphan order per attempt**, up to `renewal_max_attempts`. Those orphans carry the order metadata `subscription_id` / `renewal_cycle_id` (`:458-462`) but are **not linked** to the subscription: both `link.create` calls sit at `:558-576`, after the guard throws, and the failure path writes `generated_order_id: null` (`:997`).

Hoist the decision above the workflow — but note what the order's items do **not** contain. `buildOrderItems` (`:373-414`) returns `{ title, quantity, product_id, product_title, variant_id, variant_title, variant_sku, requires_shipping, is_discountable, metadata }` and **no price at all**; core prices the variant when the order is created. So the pre-order decision cannot be "any positive `unit_price` in the built items" — it has to read the cart's own lines (`cart.items[].unit_price`) and account for the variant swap the order will apply (`appliedPendingChanges?.variant_id`, `:388`).

Make the pre-order check **conservative, and say so**: refuse before creating anything when `subscription.payment_context` has no `payment_provider_id` or no `payment_method_reference` **and** the cart carries a priced line after the swap. Keep the existing post-order check as the authoritative one — it reads the order's real total, which the hoisted check cannot know (promotions, tax, rounding). The two differ in exactly one case, and it is the safe direction: a cart whose order would price to zero through promotions still refuses. Write that in the comment, because a subscription with no payment context is structurally unchargeable and a loud refusal is the intended outcome — today that case creates a free order and "succeeds".

**Classification, verified:** the guard's custom message ("…is missing renewal payment context") matches **neither** branch of `classifyRenewalFailure` — `observability.ts:80-85` looks for `"renewal order creation failed"` or `"missing 'cart_id'"` — so it classifies as `unexpected_error`. That is still alertable (`:90-92`), which is the property the design depends on. If the intent is the `order_creation_failed` bucket, the hoisted throw must drop the custom message or include the phrase; decide it here and assert the recorded `last_failure_kind` in the test.

**A test, not a comment:** a subscription with no payment context fails with **zero orders created** (assert the order count around the attempt), repeated retries mint nothing, and the failure's recorded `last_failure_kind` is the one this step decided on. The existing message text is preserved.

- [ ] **Step 6: The checkout gate gains its missing direction (T8)**

`findBlockingNativeRow` (`native-subscription.ts:89-106`) only matches `NATIVE-%` rows, so the gate on core `/store/carts/:id/complete` (`src/api/middlewares.ts:32-40`) blocks native → reorder and not reorder → native. A customer holding a live vault subscription — or a claimed trial — can complete a checkout for the native plan of the same product: two live subscriptions, two charges, one product. Self-service cancellation on the vault rail does not work yet (T1), so the customer cannot even clean it up.

Add the mirror rule, in the native one's exact shape:

- a reader for the customer's live reorder-rail rows — the same three-condition pushdown as `findLiveNativeRecurrences` (`native-exclusivity.ts:27-40`) with the reference filter inverted (`reference` is NOT NULL, so the inversion is exact — `native-subscription.ts:12-19` says why prefix matching is the only allowed test). Put it in a sibling `src/modules/subscription/utils/reorder-rail-exclusivity.ts`; `native-exclusivity.ts`'s header names it as native-only and should stay true.
- **the same status set**, which is the point: rename `TRACK_OCCUPYING_NATIVE_STATUSES` to a rail-neutral name (value unchanged, all call sites updated, the comment at `native-subscription.ts:61-68` kept). The two directions must not disagree about what "already subscribed" means — that is the invariant `native-exclusivity.ts:17-19` states.
- a blocking rule mirroring `findBlockingNativeRow`, matching any live row whose `product_id` is in the cart.
- the gate's decision gains the second read behind the same fail-open discipline, and the verdict stays final before the cosmetic title read (`resolveCheckoutGate`, `checkout-gate.ts:181-206`; the title read is `readBlockingProductTitle`, `:166-175`).

The rejection keeps the existing body shape (`{ message, type: "not_allowed", data: { product_id, subscription_id } }`) and gets its **own message** — the native wording is pinned verbatim by the existing integration spec (`integration-tests/http/native-checkout-gate.spec.ts:104-123` asserts the message contains the native guard's text and `data` matches `{ product_id }`), so reusing it would make the two directions indistinguishable in that spec and in the logs. The wording must not promise a self-service action that does not exist yet (T1) — name the product and the subscription, keep it factual.

**One existing test changes meaning and must be rewritten, not left green.** `integration-tests/http/native-checkout-gate.spec.ts:165-184` is named "never blocks on this plugin's own subscription row": it seeds a live non-`NATIVE-` row and asserts the response does **not** contain the native guard's message. After this step the gate *does* block that cart — with the new message — so the assertion still passes while asserting the opposite of the shipped behaviour. Flip it to assert the reorder-rail block, and add the `cancelled` reorder-row case that still passes through.

**The eligibility half is already owned.** Task 20 Step 3's `assertEligible` refuses when *any* subscription exists for the customer and product — `NATIVE-` mirrors included, any status — and its Step 6 tests it. Do not write a second eligibility rule here.

**Tests:** a live vault row for a product in the cart blocks completion; a trial row counts as live; `cancelled` does not block; the rewritten integration case asserts the reorder-rail message; the existing native-direction cases still pass unchanged; a read failure on either rail still fails open.

### Task 5: Extract the shared period-finalization step

**Files:**
- Create: `src/workflows/steps/finalize-renewal-period.ts`
- Modify: `src/workflows/steps/process-renewal-cycle.ts`, `complete-manual-renewal.ts`, `run-dunning-retry.ts` (later, in Task 6)

**Interfaces:**
- Consumes: nothing.
- Produces: one step that, given a cycle and the order that paid it, marks the cycle `succeeded`, advances the subscription cadence **anchored on `scheduled_for`**, sets `last_renewal_at`, clears applied pending changes, resets `structural_attempt_count`, ensures the next cycle, and persists + emits `renewal.succeeded`.

- [ ] **Step 1: Extract, do not re-implement**

The automatic path's success block (`process-renewal-cycle.ts:867-977`) and `complete-manual-renewal` both already do this. Extract the shared part and consume it from both. If extraction proves too invasive, implement the step and switch **only** the automatic path now, leaving `complete-manual-renewal` alone — but then Task 6 must implement the identical semantics for dunning and a test must assert parity across all three paths. Record which branch was taken in the final report.

- [ ] **Step 2: Anchor on `scheduled_for`, never `now`**

This is decision R6 and it is deliberate: it keeps the billing anchor from drifting, and its documented consequence is a catch-up charge when a period is recovered days late. Do not "improve" it to `max(now, scheduled_for)` — that is `complete-manual-renewal`'s rule for a different reason (a manual payment can arrive arbitrarily late) and mixing them would make the anchor depend on which rail paid.

- [ ] **Step 3: Tests**

The existing renewal success assertions must still pass after the extraction, and a new case must assert the anchor arithmetic for a period recovered seven days late (next `scheduled_for` equals the original anchor plus one cadence, i.e. in the past).

### Task 6: Recovery finalizes the period, and the settled-cycle guard

**Files:**
- Modify: `src/workflows/steps/run-dunning-retry.ts` (recovery path `:649-714`, guards `:247-287`)

**Interfaces:**
- Consumes: Task 5's finalization step.
- Produces: a recovery path that settles the period exactly once, and a guard that makes both crash windows safe.

- [ ] **Step 1: Finalize on recovery**

When `executePaymentRetry` returns `recovery`, mark the cycle `succeeded` through the shared step with `generated_order_id` set to the order that was actually paid, advance the cadence, and ensure the next cycle — in addition to today's case → `RECOVERED` and subscription → `active` writes.

- [ ] **Step 2: Add the settled-cycle guard (R2)**

At the top of the retry step, load the cycle. If its status is `succeeded` or `abandoned`, close the case instead of charging: `recovered` when the cycle is `succeeded`, and a no-op closure with an explicit `recovery_reason` otherwise. Stop.

This is what makes the write order stop being load-bearing. Without it, a crash between "close the case" and "finalize the cycle" leaves a closed case and a `failed` cycle that the scheduler charges again; the reverse order leaves an open case whose retry would charge an already-settled period.

- [ ] **Step 3: Tests**

- recovery produces **exactly one** order and one charge for the period, and the cycle is `succeeded`;
- a retry against a `succeeded` cycle charges nothing and closes the case;
- a retry against an `abandoned` cycle charges nothing;
- **update the pinned test** `integration-tests/http/dunning-workflows.spec.ts:315`, which asserts the old `FAILED`-after-recovery behaviour. Grep the whole suite for other assertions on `RenewalCycleStatus.FAILED` following a recovery and review each in the same pass.

### Task 7: A success closes the case; exhaustion abandons without cancelling

**Files:**
- Modify: `src/workflows/steps/process-renewal-cycle.ts` (success path)
- Modify: `src/workflows/steps/run-dunning-retry.ts` (exhaustion path)
- Modify: `src/workflows/steps/mark-dunning-unrecovered.ts`

**Interfaces:**
- Consumes: Task 5's step, Task 1's statuses.
- Produces: no open case survives a settled period; no subscription is ever cancelled as a side effect.

- [ ] **Step 1: Close an open case on renewal success (Q4)**

On the automatic success path, if an open case exists for the cycle, close it as `recovered` with a `recovery_reason` that distinguishes this path (the period was paid by a later order). With Task 3's exclusion this is a race guard rather than the main path — say so in the comment.

- [ ] **Step 2: Exhaustion abandons the cycle (R3)**

When a case closes as `unrecovered` — from the automatic exhaustion inside `run-dunning-retry` or from the admin route — set the originating cycle `abandoned`.

- [ ] **Step 3: Never cancel the subscription (R3)**

The subscription is left in `past_due`. **The plugin must not cancel it.** Cancelling a customer relationship is not a side effect a background job performs; the host receives `renewal.abandoned` and decides. Put this in the code comment and in `docs/architecture/dunning.md` (Task 17).

- [ ] **Step 4: Tests**

- a renewal success with an open case closes it;
- exhaustion abandons the cycle and leaves the subscription `past_due`, and **no** cancellation workflow runs;
- the abandoned cycle is not returned by the due query.

### Task 8: Stuck-`processing` reconciliation

**Files:**
- Create: `src/workflows/reconcile-stuck-renewal-cycle.ts` + steps
- Create: `src/jobs/recover-stuck-renewal-cycles.ts`
- Modify: `src/modules/renewal/utils/scheduler-query.ts` if a helper is needed for the stale scan

**Interfaces:**
- Consumes: Task 5's finalization step, Task 1's `awaiting_manual_resolution`.
- Produces: `reconcileStuckRenewalCycleWorkflow` with an optional operator override, consumed by Task 9's route.

- [ ] **Step 1: Find the stale cycles**

Cycles with `status = processing` and `updated_at` older than **30 minutes**. The threshold must exceed any legitimate provider call; state that reasoning in the code. Schedule the job hourly.

- [ ] **Step 2: Find the order the crashed attempt created**

Use the existing `renewal_cycle` ↔ `order` link (registered in `src/links/`), not `cycle.generated_order_id` — that field is only written at the end of a successful run, which is precisely the write that did not happen.

- [ ] **Step 3: Apply the three-row decision table**

| Observed state | Action |
|----------------|--------|
| Linked order's payment **confirmed captured** | Finalize via the shared step; close the attempt `succeeded`; emit `renewal.succeeded`. |
| No linked order, or payment **confirmed not captured** | Return the cycle to `failed` with an explanatory `last_error`; normal retry ownership applies. |
| Anything else (authorized but not captured, unreadable, ambiguous) | **Park** as `awaiting_manual_resolution` with a reason; leave the subscription untouched; emit an alertable event. |

The third row is decision R5: "we do not know" must not be recorded as "there is no hope". Do not collapse it into `abandoned`.

- [ ] **Step 4: Make the override explicit**

The workflow accepts `outcome_override?: "succeeded" | "failed" | "abandoned"` for the operator path. Without an override it applies the table above and never guesses.

- [ ] **Step 5: Tests**

One case per row, plus: the job is idempotent across two runs (the second finds nothing); a cycle parked in `awaiting_manual_resolution` is not re-processed by the job.

### Task 9: The operator entry point for a stuck cycle

**Files:**
- Create: `src/api/admin/renewals/[id]/resolve-stuck/route.ts`
- Modify: `src/api/admin/renewals/middlewares.ts` (if the route needs registration)

**Interfaces:**
- Consumes: Task 8's workflow.
- Produces: `POST /admin/renewals/:id/resolve-stuck` with `{ outcome, reason }`.

- [ ] **Step 1: The route validates and delegates**

Per the repo's route rules: validate input, resolve from `req.scope`, call the workflow, return a DTO. No business rules in the handler. Accept `outcome: "succeeded" | "failed" | "abandoned"` and a required `reason` (it lands in the activity log).

- [ ] **Step 2: Un-parking**

The route must accept a cycle in `awaiting_manual_resolution` as well as `processing`, so a parked cycle has a way out. Add an admin UI affordance on the renewal detail page and i18n keys for both catalogs.

- [ ] **Step 3: Tests**

Override to each outcome; a parked cycle resolves; the activity log records the actor and reason.

### Task 10: Dunning loop hardening

**Files:**
- Modify: `src/jobs/process-dunning-retries.ts` (`:152-218`)
- Modify: `src/workflows/steps/run-dunning-retry.ts` (`:592-608` and the catch at `:870-904`)

**Interfaces:**
- Consumes: `DunningCaseStatus.AWAITING_MANUAL_RESOLUTION` (already exists).
- Produces: a job that always terminates and always makes progress.

- [ ] **Step 1: Pre-transition failures park the case**

When the subscription is not chargeable, or `max_attempts` is already reached, or the case is missing its order/schedule — all of which currently throw **before** the state transition at `:612-624` and leave `next_retry_at` in the past — move the case to `awaiting_manual_resolution` with a reason, or `unrecovered` for exhaustion. The case must leave the due set while staying resolvable; `retry-now` already accepts `awaiting_manual_resolution`.

- [ ] **Step 2: Cap the loop**

Add an iteration cap as a safety net so no future wedge can hold the job lock indefinitely. Keep the fixed-page `skip: 0` re-query — it is what makes concurrent resolution safe — and rely on Step 1 for progress.

- [ ] **Step 3: Tests**

A wedged case (subscription cancelled while a case is pending) stops being due, the job run terminates, and other due cases in the same batch are still processed.

### Task 11: Emit the events that are already subscribed to

**Files:**
- Modify: `src/workflows/steps/process-renewal-cycle.ts` (`:768` trial path, `:1001` failure path)
- Modify: `src/workflows/steps/start-dunning.ts`, `run-dunning-retry.ts`, `mark-dunning-recovered.ts`, `mark-dunning-unrecovered.ts`, `update-dunning-retry-schedule.ts`
- Modify: `src/modules/activity-log/types/index.ts` (the five existing-but-unused `dunning.*` members; the two *new* event types are added by Task 12)

**Interfaces:**
- Consumes: nothing new.
- Produces: `renewal.failed`, `subscription.expired` (trial path), and the five `dunning.*` events on the bus.

- [ ] **Step 1: Emit `renewal.failed` — this is the fix for a live defect**

The host's `apps/backend/src/subscribers/saas-email-renewal-failed.ts:8` declares `{ event: "renewal.failed" }`. The plugin persists the event at `:1001` and never emits it, so **that customer email has never been sent**. Call the existing emit helper at the persist site.

- [ ] **Step 2: Emit `subscription.expired` on the trial path**

Same defect, same cause: `apps/backend/src/subscribers/saas-email-expired.ts:8` is waiting on an event the trial-end branch only persists (`:768-813`). Only `src/jobs/redemption-expiry.ts:105` emits it today.

- [ ] **Step 3: Persist and emit the dunning lifecycle events**

`DUNNING_STARTED`, `DUNNING_RETRY_EXECUTED`, `DUNNING_RECOVERED`, `DUNNING_UNRECOVERED`, `DUNNING_RETRY_SCHEDULE_UPDATED` all already exist in the enum and have **no writer**. Wire them through `createSubscriptionLogEventStep` so they appear in the Admin timeline *and* on the bus. Dunning is currently invisible in the activity log — this closes that too.

- [ ] **Step 4: Tests**

Follow the existing spy pattern (`integration-tests/http/manual-renewal.spec.ts:249-275`): spy on `eventBus.emit` and assert each event fires exactly once per occurrence, including on the trial path and on a dunning recovery.

### Task 12: The two new operational events, and the host-side acceptance

**Files:**
- Modify: `src/modules/activity-log/types/index.ts` (already touched in Task 11)
- Modify: `src/subscribers/forward-saas-events.ts` (registration list `:44-57`)
- Modify: `docs/api/saas-bridge.md`
- Modify: `src/admin/routes/subscriptions/activity-log/page.tsx` (`domainPresetOptions`)

**Interfaces:**
- Consumes: Tasks 4, 7, 8 (the emission points).
- Produces: `renewal.abandoned` and `renewal.awaiting_manual_resolution` persisted + emitted, forwarded, and selectable in the Admin activity-log filter.

- [ ] **Step 1: Add the two event types**

`renewal.abandoned` carries the reason so the host can decide whether to cancel the subscription (R3). `renewal.awaiting_manual_resolution` is emitted when Task 8 parks a cycle. Both are alertable.

- [ ] **Step 2: Make them selectable in the Admin activity-log filter**

`src/admin/routes/subscriptions/activity-log/page.tsx` carries a hardcoded `domainPresetOptions` list of event types per domain (`renewals` at `:134-141`, `subscription.*` at `:120-128`). An event type absent from that list is written and displayed but **not filterable**. Add `renewal.abandoned` and `renewal.awaiting_manual_resolution` to the renewals group, and `subscription.expired` to the subscription group — it is missing today, so the trial-end event Task 11 starts emitting would otherwise be unfilterable the moment it exists.

No i18n work is needed for event types: `formatEventType` title-cases the raw string and `docs/admin/i18n.md` records that as a deliberate exception ("There is no fixed vocabulary to translate"). Do not add catalog keys for them.

- [ ] **Step 3: Register them for forwarding**

Add to the static list in `forward-saas-events.ts` and to the documented whitelist example in `docs/api/saas-bridge.md`. Note in the docs that `renewal.failed` — previously a dead whitelist entry — now actually fires.

- [ ] **Step 4: Host-side acceptance (read-only)**

This is the check that proves the two dead emails are alive. After deployment, confirm in `D:\Projects\medusa-saas` that `saas-email-renewal-failed` and `saas-email-expired` actually send. Do **not** edit that repository. If the emails require configuration that is missing, report it as a finding rather than fixing it here.

- [ ] **Step 5: Tests**

Both events fire exactly once and are present in `domainPresetOptions`, so the filter exposes them.

**— CUT LINE: Tasks 1–12 are the money-safety core and must be deployed before 2026-10-18 08:28 UTC. Tasks 13–19 may slip; Tasks 20–25 may slip further, and are additionally blocked on Task 14. —**

### Task 13: Upcoming-renewal lookahead (Phase 7)

**Files:**
- Create: `src/jobs/emit-renewal-reminders.ts`
- Modify: `src/modules/activity-log/types/index.ts` (`renewal.upcoming`, `subscription.trial_ending`)
- Modify: `src/subscribers/forward-saas-events.ts`, `docs/api/saas-bridge.md`
- Modify: `src/admin/routes/subscriptions/activity-log/page.tsx` (`domainPresetOptions`)

- [ ] **Step 1: Scan forward, not backward**

The charge scheduler selects `scheduled_for <= now`; this job selects `scheduled_for <= now + renewal_reminder_lead_days` for cycles in `scheduled`, plus trial subscriptions whose `trial_ends_at` falls in the same window. Hourly. `renewal_reminder_lead_days = 0` disables it.

- [ ] **Step 2: Include manual subscriptions, exclude paused and cancelled**

Deliberately different from the charge query: for a manual subscription the reminder *is* the moment the customer must act.

- [ ] **Step 3: Dedupe through the activity log**

The unique `dedupe_key` on `subscription_log` gives exactly-once semantics for free. Do not add a second idempotency mechanism.

Add `renewal.upcoming` and `subscription.trial_ending` to `domainPresetOptions` in `src/admin/routes/subscriptions/activity-log/page.tsx`, the same way as Task 12 Step 2 — otherwise the reminders are written but not filterable.

- [ ] **Step 4: Tests**

Running the job twice emits once per cycle; manual subscriptions are included; paused and cancelled are excluded; `0` disables.

### Task 14: Trial conversion (Phase 8)

**Files:**
- Modify: `src/workflows/steps/process-renewal-cycle.ts` (trial branch `:739-821`)

- [ ] **Step 1: Rewrite the branch as a three-way decision**

| Condition | Behaviour |
|-----------|-----------|
| `payment_mode === "auto"` **and** a usable payment method reference **and** the subscription has a cart | **Convert:** fall through to the normal order/charge path for the period starting at `trial_ends_at`. A payment-qualified failure starts dunning so the customer can repair their card. **The cart is a hard prerequisite (T6)** — without it this row throws before charging, which is what Q18a's template cart exists to supply. |
| `payment_mode === "manual"` | **End:** cancel with `cancel_effective_at = trial_ends_at`, cycle `succeeded` with no order, attempt `succeeded`, persist **and emit** `subscription.expired` with a reason naming the manual rail. |
| `auto` but no usable method | **End** with an alertable reason — expected when the offer's rule is ON, a configuration gap when it is OFF. |

- [ ] **Step 2: Rely on Task 3's carve-out for manual trials**

The scheduler now processes a manual trial's trial-end cycle, which is what makes the second row run at `trial_ends_at` instead of 90 days later. Do not add a second mechanism.

- [ ] **Step 3: Never charge a native PayPal subscription**

Native rows are already excluded from the scheduler, and PayPal bills its own trial cycle. Assert it in a test so a future change cannot reintroduce a double charge.

- [ ] **Step 4: Tests**

auto + method converts and charges exactly once with the anchor at `trial_ends_at`; auto + no method ends with an alertable reason; manual ends deterministically; a `NATIVE-` subscription is never charged by this path.

### Task 15: Make `trial_requires_payment_method` real (Phase 8)

**Files:**
- Modify: `src/workflows/steps/validate-subscription-cart.ts` (trial resolution `:311-314`)
- Modify: `src/workflows/steps/redeem-redemption-code.ts` (`:159-160`, currently a dead read)
- Modify: `src/admin/routes/subscriptions/plans-offers/components/*.tsx` (default OFF)

- [ ] **Step 1: Enforce at checkout**

When the offer's rule is ON, a trial checkout that is not in auto mode is rejected with a clear message — only an auto-mode checkout will vault a usable method. The token does not exist yet at checkout (it is written at capture), so the check is on the mode, not on a stored token. Say that in the comment; it is the non-obvious part.

- [ ] **Step 2: Mirror it in the redemption path**

`redeem-redemption-code.ts:159-160` already computes `requires_payment_method` and writes it into an object nothing reads. **Enforce it there** — do not delete the field. Task 21 adds the third enforcement point and would re-open a "delete" decision, so make the choice once, here, in the task that runs first.

The redemption path is a door with no cart and no way to collect a payment method, so "enforce" needs a definition: refuse the redemption outright, or degrade it to a non-trial grant. Pick one and write it in the step; do not leave it to the implementer twice.

- [ ] **Step 3: Default OFF**

The toggle ships defaulting to off, so no existing offer changes behaviour on upgrade.

- [ ] **Step 4: Tests**

ON rejects a manual-mode trial checkout; OFF does not; the redemption path refuses or degrades a trial-enabled redemption per Step 2's definition, and the test pins whichever one was chosen.

### Task 16: Retire the two decorative rules (Phase 9)

**Files:**
- Modify: `src/admin/routes/subscriptions/plans-offers/components/create-plan-offer-modal.tsx`, `edit-plan-offer-drawer.tsx`
- Modify: `docs/admin/plan-offers.md`, `docs/architecture/plan-offers.md`

- [ ] **Step 1: Remove the inputs, keep the fields**

Remove the `minimum_cycles` and `stacking_policy` form controls. Keep the persisted columns, validators, and DTO fields — no migration, no breaking API change.

- [ ] **Step 2: Document the deprecation, and disambiguate the names**

Mark both as **not enforced** in the docs, and state explicitly that `row_stacking_policy` / `max_stacking_cycles` are a different, enforced pair. That name collision is a trap for the next reader.

- [ ] **Step 3: Tests**

The i18n gate and the admin-offer HTTP suite still pass; no form field references the removed rules (grep the two components).

### Task 17: Documentation (Phase 10)

**Files:**
- Create: `docs/api/store-customer-self-service-tutorial.md`
- Modify: `docs/architecture/{renewals,dunning,subscriptions,activity-log,settings}.md`
- Modify: `docs/admin/plan-offers.md`, `docs/api/saas-bridge.md`
- Modify: the matching `docs/testing/*.md`
- Modify: `AGENTS.md` (task router row for the new tutorial)
- Modify: `src/modules/subscription/utils/native-mirror.ts:157` (stale comment)

- [ ] **Step 1: Write the tutorial**

Audience: the owner's frontend developers, building the portal inside the SaaS app. Cover: how an external application obtains and forwards a Medusa customer identity for `/store/customers/me/*` (session vs bearer, and the consequence of each); the nine actions with request/response shapes and error cases; building a "payment failed" banner and retry affordance from `payment_status` + `payment_recovery` **without any new event**; and an explicit *not supported* section — the customer cannot accept a retention offer (application is admin-only), no un-skip, no undo of a scheduled change, no reactivate, no past-charges view, no billing address, swap is same-product variant only and a price change is neither surfaced nor confirmed, guest redemption is unsupported, and the list route is unpaginated. Phase 15 adds a tenth action — finalizing a cancellation — which Task 25 must fold in.

- [ ] **Step 2: Update the runtime docs for behaviour that changed**

Retry ownership and both new statuses (`renewals.md`); parking, recovery finalizing the period, exhaustion abandoning, and the R2 guard (`dunning.md`); trial end and conversion plus the subscription left `past_due` on abandonment (`subscriptions.md`); the new event types (`activity-log.md`); the two new settings (`settings.md`). Add the R6 catch-up-charge consequence to `renewals.md` — it is the kind of behaviour a future reader will otherwise "fix".

- [ ] **Step 3: Fix the two stale comments**

`native-mirror.ts:157` says `paypal.subscription.revised` is "blocked until paypal 0.5.0"; 0.6.1 ships without it (`D:\Projects\medusa-paypal\CHANGELOG.md:78-115` explicitly marks it not delivered). Correct the comment so it names the real blocker instead of a version that has already passed.

`src/modules/plan-offer/types/index.ts:56-58` says "PayPal rejected both the ON_APPROVE vault and the standalone vault API (trial spike 2026-09-19)". **Finding T4 shows that is unsubstantiated**: the pinned SDK exposes `createSetupToken`, `createPaymentToken` and `VaultInstructionAction.OnPayerApproval`, and no record of the spike survives. Rewrite it to say what is actually true — the primitives exist and are callable; account availability is unverified and is a pre-launch checklist item — and drop the `ON_APPROVE` claim, which maps to the wrong enum. **This is the only task that owns that comment**; the PayPal plan flags it as unowned and deliberately does not edit this repository.

- [ ] **Step 4: Validate**

```bash
corepack yarn test:i18n
```

### Task 18: CI (Phase 11)

**Files:**
- Create: `.github/workflows/ci.yml`

- [ ] **Step 1: Minimal, and honest about what it covers**

Postgres service container, `corepack yarn build`, `corepack yarn test:integration:http`, `corepack yarn test:i18n`. The suite needs a role that can `CREATE DATABASE` (a database is created per suite) and `DB_HOST=localhost`. Document the local equivalent in the workflow comments.

- [ ] **Step 2: Do not gate on the E2E suite**

`e2e/` needs a live backend and `DATABASE_URL`, is `workers: 1, retries: 0`, and writes plugin tables directly — it is not hermetic and is out of scope here. Say so in a comment so its absence is a decision, not an oversight.

### Task 19: Final gate and rehearsal

- [ ] **Step 1: Run every gate**

```bash
corepack yarn build
corepack yarn test:integration:http
corepack yarn test:integration:modules
corepack yarn test:i18n
```

Treat "green" as the union of runs plus an isolated `--runInBand` re-run of anything the OS killed; an unattended http run can lose suites to `SIGTERM` workers. Check that any failing file is one the change touched before believing it.

- [ ] **Step 2: Rehearse the failure paths on a disposable database**

With a mocked failing payment: (1) a payment failure hands off to dunning and the scheduler stops touching the cycle; (2) a payment failure whose dunning start fails still terminates at the cap; (3) a recovered period produces exactly one order and one charge; (4) a structural failure abandons at the cap and leaves the subscription `past_due`; (5) a simulated stuck `processing` cycle reconciles in all three directions, with the ambiguous case **parked**, not abandoned.

- [ ] **Step 3: Report**

State which Task 5 branch was taken, the stale-snapshot finding, and anything the rehearsal contradicted. Production deployment is a separate authorization.

**— TRIAL-CLAIM WORK: Tasks 20–25. All of it is blocked on Task 14; Task 22 additionally waits on the PayPal plan's Task P4 reporting a pass. —**

### Task 20: The `trial_claim` ledger and the eligibility rule (Phase 12)

**Files:**
- Create: `src/modules/trial-claim/index.ts`, `.../service.ts`, `.../models/trial-claim.ts`, `.../migrations/Migration<ts>.ts`, `.../migrations/.snapshot-medusa-trial-claim.json`
- Create: `src/workflows/steps/record-trial-claim.ts` (the shared ledger step every door calls)
- Modify: `src/workflows/redeem-redemption-code.ts` and `src/workflows/steps/redeem-redemption-code.ts` (call it from the redemption door)
- Modify: `integration-tests/http/migrations.spec.ts` (`EXPECTED_MIGRATION_COUNT` 24 → 25, **and** add `"trial-claim"` to `MIGRATION_PATHS`)

**Interfaces:**
- Produces: `TrialClaimService.assertEligible(customer_id, product_id)` and `TrialClaimService.record({ customer_id, product_id, variant_id, source, subscription_id, trial_ends_at })` — consumed by Tasks 21, 23 and 24. `recordTrialClaimStep` wraps the latter for workflow use.
- Consumes: nothing.

**Do not target `createSubscriptionRecordStep`.** It is called only by the cart and order flows (`create-subscription-from-cart.ts:174`, `create-subscription-from-order.ts:208`), its input *requires* `cart_id` and `order_id` (`create-subscription-record.ts:20-24`), and the redemption path bypasses it entirely (`redeem-redemption-code.ts:360`). A no-cart claim workflow could not call it either. The ledger must be written by a step each door invokes, or the rule is bypassable through exactly the doors it exists to cover.

- [ ] **Step 1: Model the ledger**

Columns: `id`, `customer_id`, `product_id`, `variant_id`, `claimed_at`, `trial_ends_at`, `source` (`self_service` | `redemption` | `admin`), `subscription_id`, `binding_method` (`none` | `vault`). There is no `provider_subscription` value — a provider-managed subscription never passes through any door that writes this ledger (Q11), so nothing could ever write one. Follow `src/modules/redemption/models/redemption-record.ts` — that module is the existing precedent for a small ledger module in this repo, down to the `index.ts` `Module(...)` shape.

- [ ] **Step 2: The migration, with a unique constraint**

```sql
create table if not exists "trial_claim" (...);
create unique index if not exists "trial_claim_customer_product_unique"
  on "trial_claim" ("customer_id", "product_id");
```

The constraint is the race-safe anchor: two concurrent claims cannot both win, and because it lives on a table this feature owns, no webhook-driven mirror write can break it.

Do **not** instead put a partial unique index on `subscription (customer_id, product_id) where is_trial`. Two real reasons, neither of them the one that first comes to mind: a paid non-trial subscription never sets `is_trial`, so the index cannot express the "any subscription counts" half of the rule; and a constraint failure inside a webhook-driven mirror write is a far worse failure mode than a rejected claim. (Native mirror rows are in fact written `is_trial: false`, `native-mirror-sync.ts:70`, so they would *not* collide — that is not the objection.)

`down()` drops the table. Unlike Task 1's status rollback, this one loses no money-relevant state: the trial subscriptions themselves survive.

- [ ] **Step 3: The eligibility predicate**

`assertEligible(customer_id, product_id)` returns ineligible when **either** a ledger row exists **or** any subscription exists for that customer and product — any rail (`NATIVE-` mirrors included), any status.

Query the `subscription` table's own `customer_id` and `product_id` columns (`query.graph` on the `subscription` entity, or `listSubscriptions` as the redemption path does). **Do not query the `subscription_product` link table** — those links are created only by the redemption path (`redeem-redemption-code.ts:657-668`); the checkout path links customer, cart and order only (`link-subscription-commerce-entities.ts:41-75`). A link-based query silently passes every customer who bought the plan, which is precisely the case this half of the rule exists to catch.

Both columns are NOT NULL and indexed (`src/modules/subscription/models/subscription.ts:12` and `:14`), and mirror rows always carry a resolved `product_id` (the mirror builder refuses a row without one, `native-mirror.ts:163-167`).

- [ ] **Step 4: Write the ledger from each door**

Create `recordTrialClaimStep` and call it from **every** workflow that can create a trial: the new claim workflow (Task 21), the redemption workflow, and the admin action if it is built. Guard on `is_trial`. Give the step a compensating delete so a downstream failure does not leave a ledger row for a subscription that was rolled back.

The spec says "all three doors"; only two exist today. There is no admin subscription-creation route anywhere (`src/api/admin/subscriptions` has no POST create). Either build the admin door in this task or record that the rule covers two doors — do not leave the spec's "three" standing on a door nobody built.

- [ ] **Step 5: Admin visibility for the ledger**

Spec Q15 promises "an Admin view" and no task builds one. Build it here — a read-only list filtered by customer and product is enough — or record the deferral explicitly. This is the last substantive step of the task; the historical-data query that used to sit here is **dropped**, because there are no customers and therefore no historical data to inspect, no backfill to plan, and no pre-existing duplicate to reconcile. The `trial_claim` table is created empty by this task's own migration, so its unique index cannot fail to build either.

- [ ] **Step 6: Tests**

First claim succeeds and writes one row; a second claim for the same product is refused; a concurrent pair of claims leaves exactly one row; a customer holding a paid subscription but no trial is ineligible; a `NATIVE-` mirror row makes the customer ineligible.

### Task 21: The claim endpoint, the offer rules, and the storefront contract (Phase 13)

**Files:**
- Modify: `src/modules/plan-offer/types/index.ts` (`PlanOfferRules`, optional fields + defaults)
- Modify: `src/modules/plan-offer/utils/rules.ts` (`PLAN_OFFER_RULES_DEFAULTS`, `resolvePlanOfferRules`)
- Modify: `src/api/admin/subscription-offers/validators.ts`
- Modify: `src/workflows/steps/shared-plan-offer.ts` (`normalizeRules`)
- Modify: `src/modules/plan-offer/utils/admin-query.ts` (`mapRules`), `src/admin/types/plan-offer.ts`
- Modify: `src/admin/routes/subscriptions/plans-offers/components/create-plan-offer-modal.tsx`, `edit-plan-offer-drawer.tsx`
- Modify: `src/admin/i18n/json/en.json`, `src/admin/i18n/json/zhCN.json` (the two new form labels — the i18n gate scans `src/admin` for key literals and fails on any missing key, and requires en/zhCN parity)
- Create: `src/api/store/customers/me/trials/route.ts`, `src/api/store/customers/me/trials/middlewares.ts`, `src/workflows/create-trial-subscription.ts`
- Modify: `src/api/middlewares.ts` (register the new matcher)
- Modify: `src/api/store/products/[id]/subscription-offer/route.ts`, `src/api/store/products/middlewares.ts`, `src/api/store/customers/me/subscriptions/utils.ts`

**Interfaces:**
- Consumes: `TrialClaimService.assertEligible` / `.record` (Task 20); the three-way trial branch (Task 14).
- Produces: `POST /store/customers/me/trials`, and `trial.bonus_days` / `trial.eligible` / `trial.reason` / `trial.binding` on the store offer DTO — consumed by Tasks 22–24 and by the host storefront.

- [ ] **Step 1: One new offer rule, no migration — but several code sites**

`rules` is JSONB with no CHECK and no generated column (`Migration20260329153000.ts:6`), so the database needs nothing. The code does:

| Field | Type | Meaning |
|-------|------|---------|
| `trial_bonus_days` | `number \| null` | Extra days granted once a payment method is bound. `null`/`0` disables the bonus button. |

**One field, not two.** `trial_binding_method` was in an earlier revision and is deliberately absent (Q11, Q14): the rail is a property of the product — a variant carrying `paypal_subscription` metadata is a provider-managed subscription and the storefront already routes to it — so an offer rule for it would be a second, conflicting place to express the same fact.

Add one more thing to this step: when the product has such a variant, the offer form **displays that variant's `paypal_subscription.trial_periods` read-only** beside the offer's own trial values, so the operator sees both numbers and cannot edit the wrong one by accident. The native rail's trial is part of the PayPal plan's identity and stays in the variant metadata — a plan is immutable and cached by a hash that includes `trial_periods`, so making the offer its source would mean every save mints a new plan and strands existing subscribers on the old one.

Declare it **optional** and add it to `PLAN_OFFER_RULES_DEFAULTS` (`src/modules/plan-offer/utils/rules.ts:17-30`). This is the v1.6.0 precedent for adding a rule, and it matters here: pre-existing offer rows have no such key, so a non-optional declaration reads `undefined` at every call site.

Then the write path, which is a **whitelist** — `normalizeRules` constructs the persisted object key by key (`shared-plan-offer.ts:316-327`), so a key not explicitly added there is silently dropped on every upsert:

- `PlanOfferRules`, `PLAN_OFFER_RULES_DEFAULTS`
- `normalizeRules` (`shared-plan-offer.ts`), the zod schema (`subscription-offers/validators.ts:39-48`), `mapRules` (`admin-query.ts:170-183`), and the Admin DTO type (`src/admin/types/plan-offer.ts:45-54`)
- **one** form control in each of the two offer components, plus its `planOffers.*` i18n key in **both** catalogs

**The read-only display needs data the offer form does not load today.** `src/modules/plan-offer/utils/admin-query.ts:100-105` requests only `variants.id`, `variants.title`, `variants.sku`, so variant metadata is not in the detail response; the create modal loads variants only while the picker is open. Either extend that query or call `sdk.admin.product.listVariants(productId)` — Medusa 2.20's `defaultAdminProductVariantFields` already includes `metadata`, so no API change is needed, but the data loading is new work and belongs in this step's file list.

**And the display is under-specified in two ways that must be settled here, not by the implementer.** (i) A **product-scoped** offer covers all four of the host's variants, two of which are native — so "that variant's `trial_periods`" has no single referent. Show all native variants' values, or show the value only for a variant-scoped offer and say so otherwise. (ii) **Display `setup_fee` as well as `trial_periods`.** The live native variant carries `setup_fee: 2`, and it is charged at approval; showing a zero-price trial beside a 14-day offer while hiding the fee leaves the operator blind to the one thing that actually charges. The display exists to prevent a misconfiguration — showing the wrong field would not prevent it.

Extend `trial_days`'s existing cross-field validation (`subscription-offers/validators.ts:41-70`): bonus days must be null when the trial is disabled, positive when set.

- [ ] **Step 2: The claim endpoint**

```
POST /store/customers/me/trials
  { variant_id, region_id, binding?: "none" | "vault" }
```

**The request names only whether to bind, not which rail.** `"vault"` is the only binding mechanism (Q11); the provider rail is a different product reached through the storefront's existing native path, not through this endpoint. `region_id` is required because the template cart's region determines every future renewal order's currency (Q18a) — validate that the variant has a price there and fail with a clear message if it does not, rather than letting core throw `Variants with IDs … do not have a price`.

Copy the payment shape of the redemption path (`redeem-redemption-code.ts:292-310`): **no order and no payment**. A card-free claim writes `payment_mode: manual`, `is_trial: true`, `trial_ends_at = now + trial_days`, `next_renewal_at = trial_ends_at`.

**Create the template cart (Q18a), in the same workflow.** Use core `createCartWorkflow` with a `region_id` and one line item for the variant — the same call shape `src/api/store/saas/carts/route.ts:122-150` already uses. Then point the subscription's `cart_id` at it. The cart is **never completed and never paid**; it exists only so `createRenewalOrder` has a source.

This is not optional and it is not a workaround: every charge path in the plugin refuses a subscription without a cart (`process-renewal-cycle.ts:828-832`, `create-manual-renewal.ts:140-144`, and `force-renewal-cycle` runs the same workflow, so there is no operator escape hatch). Verified against every field `createRenewalOrder` reads — `region_id`, `sales_channel_id`, `currency_code` and at least one item are required and all present on a fresh cart; `shipping_methods` may be absent (`buildShippingMethods` returns `[]`); `completed_at`, metadata, promotions and tax lines are never consulted. Nothing in this plugin or in Medusa core 2.20 expires, mutates or deletes an abandoned cart, and `loadCart` does not select `completed_at`.

**The cart id does leak, and that is Q18a(i)'s subject.** `buildOrderItems` writes `renewal_source_cart_id` into the order's line-item metadata and the host storefront requests `*items.metadata`, so the customer receives it. **The fix is to delete that field** — it is written in two places (`process-renewal-cycle.ts:409-411`, `create-manual-renewal.ts:273`) and read nowhere — and the `completed_at` write below is defence in depth, not the primary guard.

**Set `completed_at` after creation, not during it.** `createCartWorkflow` cannot create a completed cart: it runs `updateCartPromotionsWorkflow`, whose field list includes `completed_at`, whose `validateCartStep` throws "Cart … is already completed", and whose compensation then deletes the cart. Create the cart, then set the column with `updateCartsStep` in the same workflow. What that buys: `addToCart`, `addShippingMethodToCart`, `refreshCartItems`, `sync-subscription-cart-pricing` and `createPaymentCollectionForCart` all refuse a completed cart, and a payment collection is what `completeCartWorkflow` requires. Note that `updateCart` and `updateLineItemInCart` are **blind** to the column — their queries omit it — so a holder of the id can still mutate the cart's email, addresses and quantities. Accept that, or add the column to the plugin-side checks; either way, say which.

**Create the initial renewal cycle too**, the way the redemption path does (`redeem-redemption-code.ts:161-167` calls `ensureNextRenewalCycleStep`). Without it there is no cycle at `trial_ends_at`, so Task 22's re-point, Task 14's conversion, and this task's own Step 6 assertion have nothing to act on.

**Authentication is not inherited.** There is no wildcard `/store/customers/me/*` guard — each group registers its own matcher, and `src/api/middlewares.ts` is the registration list. Create `src/api/store/customers/me/trials/middlewares.ts` with `authenticate("customer", ["session", "bearer"])` on `/store/customers/me/trials*` and register it, exactly as `redemptions/middlewares.ts` does for its own prefix. Take the customer from the session; never accept a `customer_id` in the body.

- [ ] **Step 3: The ineligible claim is refused with a typed error — there is no degradation branch (Q19)**

When `assertEligible` fails, return a typed, actionable error and **create nothing**. Do not create a subscription, do not collect a payment method, do not "degrade to paid".

The earlier revision asked this endpoint to degrade instead, on the reasoning that the sale must not be blocked. **That reasoning is withdrawn**, because it asks an endpoint that collects no payment to produce a row that must later be charged: the charge path refuses a subscription whose `payment_context` has no `payment_provider_id` or `payment_method_reference` (`process-renewal-cycle.ts:472-483`), and the redemption-shaped context this endpoint copies sets **both to null**. The row would be permanently unchargeable, and the guard that catches it fires *after* order creation in a step with no compensating function, so each retry would mint another orphan order (T7).

**Nothing is blocked by refusing.** The offer DTO already returns `trial.eligible: false` with a reason, so the storefront never renders the trial button for an ineligible customer, and the ordinary subscribe button sits beside it. This endpoint's refusal is the backstop against a client that calls it anyway — and for that, a clear error is the correct answer.

If a one-click "just subscribe me" is ever wanted, it must run a real checkout the storefront completes, not a subscription fabricated without payment.

- [ ] **Step 4: The storefront contract**

Extend the store offer DTO (today at `src/api/store/customers/me/subscriptions/utils.ts:746-753`) with `bonus_days`, `eligible`, `reason`, and `binding: { method, supported }`. `binding.method` is `"vault"` whenever `trial_bonus_days` is set — there is no `provider_subscription` value (Q11). `supported` is `false` until Task 22 lands, and the storefront hides the bound button while it is false.

**That route is anonymous today.** `/store/products/:id/subscription-offer` carries no auth middleware (`src/api/store/products/middlewares.ts` has query validation only), so it cannot see a customer at all. Add optional authentication (`allowUnauthenticated: true`) and set `Cache-Control: no-store` explicitly — the repo sets no cache headers anywhere, and without the header a shared cache would serve one customer's eligibility to another.

- [ ] **Step 5: Amend Task 15 — and amend it in Task 15**

Task 15 Step 2 leaves "enforce the dead redemption field or delete it" open, and Task 15 runs before this task. Answer it now, in Task 15, so the implementer does not make a decision this task reverses: **enforce it**. The redemption path is a third door that creates trials with no cart and no way to collect a method, so "enforce" there also needs a definition — refusing the redemption or degrading it. Pick one and write it down; do not leave it implicit.

The claim endpoint gains a third enforcement point: when the rule is ON and `binding: "none"` is requested, refuse with a clear message. **Keep the checkout enforcement too** — trials can still arrive through a cart, and Task 15 already builds that gate. Q13 is the union of all three, not a replacement.

- [ ] **Step 6: Tests**

A card-free claim creates the trial with `payment_mode: manual`, one cycle at `trial_ends_at`, one ledger row, and a template cart with `completed_at` set; **an ineligible claim returns a typed error, creates no subscription and writes no ledger row**; the toggle refuses a card-free claim when ON and permits it when OFF; the DTO reports eligibility correctly for two different customers against the same product; a template cart cannot be completed and cannot be subscribed.

### Task 22: Binding a payment method without charging — PayPal setup token (Phase 14, `vault`)

**Files:**
- Create: `src/workflows/bind-trial-payment-method.ts`, `src/workflows/steps/bind-trial-payment-method.ts`
- Create: `src/api/store/customers/me/trials/[id]/bind/route.ts`
- Modify: `src/modules/trial-claim/*` (update `binding_method`)
- Modify: `src/api/store/customers/me/trials/middlewares.ts` (the bind route shares the prefix registered in Task 21; confirm it is covered rather than assuming)
- **Not this repository:** the provider half — the three PayPal Vault v3 calls — is specified in `.agents/specs/2026-09-28-paypal-vault-binding-plan.md`. Reorder has no PayPal dependency, no client and no credentials, and the provider class is not reachable through `medusa-paypal`'s export map; the only programmatic surface is `container.resolve("paypalSubscription")`.

**Interfaces:**
- Consumes: `paypalSubscription.startVaultApproval({ customer_id, return_url, cancel_url })` → `{ setup_token_id, approve_url }`, and `.completeVaultApproval({ setup_token_id })` → `{ status, vault_id?, customer_id? }`. Detect support by duck-typing the resolved service — reorder cannot import the package's capability constant.
- Produces: a trial subscription with `payment_mode: auto`, a `payment_provider_id` **and** a `payment_method_reference` (both, per T7), and an extended `trial_ends_at` — consumed by Task 14's conversion branch.

- [ ] **Step 1: The capability must be verified first — and that is not this task**

The provider half is specified in `.agents/specs/2026-09-28-paypal-vault-binding-plan.md`. **Read that document's "Uncertainties" section before writing a line here.** The one that matters most to this task is whether a setup-token vault id works with the plugin's existing off-session charge path — and **if it does not, there is no fallback**: Q11 removed `provider_subscription` from the claim path, so the "bind and get more days" feature simply does not ship. That is an owner decision about what to do instead, not something an implementer should work around.

The reorder-side consequence of that verification is one line: **do not start this task until the other plan's Task P4 reports a pass.**

- [ ] **Step 2: Call the capability — do not build it here**

The three PayPal Vault v3 calls are **not this repository's work** and must not be implemented here. Resolve the provider's module and call it:

```ts
const paypal = container.resolve("paypalSubscription")
if (typeof paypal.startVaultApproval !== "function") {
  // the installed provider predates the capability — report supported: false
}
```

Detection is by duck-typing because this plugin has no dependency on that package and cannot import its capability constant. The full provider-side specification is `.agents/specs/2026-09-28-paypal-vault-binding-plan.md` Tasks P1–P2; this step consumes it and nothing more.

- [ ] **Step 3: Bind on the reorder side**

Given an approved setup token: store `payment_method_reference` **and** `payment_provider_id` on the trial subscription — both are required by the charge gate (T7), and the provider id must be the **real registered one**, not a guess. The only precedent in this repo is a hardcoded literal (`native-mirror-sync.ts:80` writes `"pp_paypal_paypal"`); do not copy that. Read it from the payment module's provider declaration, the way `medusa-paypal`'s own `findPaypalProviderDeclaration` does, so a host that registers the provider under a different key still works.

Then set `payment_mode: auto`, set `trial_ends_at = started_at + (trial_days + trial_bonus_days)`, keep `next_renewal_at` equal to the new `trial_ends_at`, move the pending cycle through `ensureNextRenewalCycleStep` (not a direct `scheduled_for` write), and update the ledger's `binding_method` to `vault`.

**Anchor the extension on `started_at`, never on `now`** — otherwise binding on day 5 yields a different end date than binding on day 1, and the customer sees the date move for no stated reason. This is the same anchoring rule as R6.

- [ ] **Step 4: Move the cycle, and know what the real risk is**

The cycle was created at the original `trial_ends_at`. If the extension writes `trial_ends_at` and `next_renewal_at` but leaves the cycle where it is, the scheduler picks it up at the old date, the trial-eligibility gate rejects it as "still in trial" every five minutes for M days, and — once Task 11 is live — each rejection persists a `renewal.failed`. That is the failure mode, not a duplicate charge.

**A second `SCHEDULED` cycle is not possible.** A partial unique index enforces at most one per subscription (`src/modules/renewal/migrations/Migration20260924120000.ts:85`), so a duplicate insert fails loudly rather than silently charging twice. Move the existing row through `ensureNextRenewalCycleStep`, which already adopts and re-points the open scheduled cycle when `next_renewal_at` changes (`ensure-next-renewal-cycle.ts:886-944`) — do not write `scheduled_for` directly.

Assert exactly one cycle exists for the subscription afterwards, and that its `scheduled_for` equals the extended `trial_ends_at`.

- [ ] **Step 5: Tests**

A bound trial has exactly one scheduled cycle at the extended date and charges exactly once there; binding on day 5 produces the same `trial_ends_at` as binding on day 1; an unbound trial ends at the original date; a binding attempt that fails leaves the trial untouched and still card-free.

### Task 23: The provider rail — which needs almost nothing (Phase 14)

**No new mechanism.** Q11 and Q14 settled this: the provider rail is **not** a second binding method for a claimed trial. A variant carrying `paypal_subscription` metadata *is* a provider-managed subscription, the storefront already routes to it (`isNativeVariant`), its trial is a cycle in the PayPal billing plan, and its length stays in the variant metadata. `trial_binding_method` is not in the offer rules, and there is no cross-repo trial-length contract to build.

That removes everything an earlier revision of this task contained. What is left is two small, unrelated pieces of work — plus four prohibitions in Step 4 that are the real record of what was removed:

**Files:**
- Modify: `src/jobs/emit-renewal-reminders.ts` (Task 13's file — this task adds one exclusion)
- Tests alongside Tasks 13 and 20.

**Interfaces:**
- Consumes: nothing new.
- Produces: nothing new. This task asserts an existing rule and closes a latent risk.

- [ ] **Step 1: The offer form's read-only display is already Task 21's**

Do not duplicate it. Task 21 Step 1 owns the read-only display of a variant's `paypal_subscription.trial_periods`.

- [ ] **Step 2: Assert that the eligibility rule counts native subscriptions**

Task 20's `assertEligible` should already cover it: a `NATIVE-` mirror row carries a real `product_id` (the mirror builder refuses a row without one, `native-mirror.ts:163-167`), so "any subscription for the product, any rail, any status" catches a customer who already took a native trial. **Assert it in a test rather than assuming it** — this is the one place the two rails meet, and it is the only thing that stops a customer from taking a native trial and then claiming a reorder one.

- [ ] **Step 3: Pin the reminder job's exclusion**

Task 13's lookahead job scans trial subscriptions by `trial_ends_at` with no `NATIVE-` exclusion. It skips provider trials today only because the mirror writer sets `is_trial: false` and no `trial_ends_at` (`native-mirror-sync.ts:70-77`) — an accident, not a guarantee (spec §11 item 6). Add the explicit exclusion, or a test pinning the mirror's null `trial_ends_at`, so a future mirror change cannot start mailing provider-trial customers a reminder this plugin has no business sending.

- [ ] **Step 4: Nothing else — and specifically not these four**

Do **not** add a `provider_subscription` value to any offer rule; do **not** write the trial length onto the cart line item or the session data; do **not** write the variant metadata; do **not** teach the claim endpoint to create a provider subscription. Q11 and Q14 removed all four, and each would re-introduce the drift they were written to remove — a second place to configure one fact, or a channel that is client-forgeable.

### Task 24: Leaving a trial (Phase 15)

**Files:**
- Create: `src/api/store/customers/me/subscriptions/[id]/cancellation/finalize/route.ts`
- Modify: `src/api/store/customers/me/subscriptions/validators.ts` if a body is required
- Modify: `src/api/admin/cancellations/[id]/finalize/route.ts` only if the shared workflow needs an ownership-agnostic entry point

**Interfaces:**
- Consumes: the existing `finalizeCancellationWorkflow` — do not write a second cancellation path.
- Produces: a customer-reachable exit on the vault rail.

- [ ] **Step 1: Expose the finalize the customer already needs**

`finalizeCancellationWorkflow` exists and has exactly one caller: the admin route. Add a store route that runs the same workflow against the customer's own case, ownership-checked the way every other `/store/customers/me/*` route is.

**The ids do not line up and the step must say how.** The route is keyed by subscription id; the workflow takes a `cancellation_case_id`. Resolve the customer's open case for that subscription first — the repo already does this lookup (`src/api/store/customers/me/subscriptions/utils.ts:168-179`, `:557`) — and use the same ownership helper the other store routes use, so a customer cannot finalize someone else's case.

Keep `POST .../cancellation` (which opens a retention case) exactly as it is — the retention flow is an option the customer may engage with, not a gate they must pass. Do not make the existing route finalize by default: that would delete the retention path for every customer in order to fix the one who wants out.

- [ ] **Step 2: The pending cycle must go with it — and it already does**

`finalizeCancellationStep` writes `next_renewal_at: null` and the workflow runs `ensureNextRenewalCycleStep`, which deletes every `SCHEDULED` cycle once `shouldSubscriptionHaveUpcomingRenewalCycle` sees `cancelled_at` (`src/modules/renewal/utils/upcoming-cycle.ts:88-114`). So this is a **verification** step, not an implementation step: confirm the deletion happens for a trial cancelled before `trial_ends_at`, because T5 says a leftover cycle becomes a false `renewal.failed` event and customer email once Task 11 is live.

- [ ] **Step 3: Confirm the other two exits still work**

The auto-renew toggle must remain sufficient on its own, and the native rail's provider cancellation must stay reachable. Neither is changed by this task; both are asserted so a future refactor cannot quietly remove them. Q17 is absolute: **every binding method has a working exit.**

Careful with the reasoning for the toggle: `payment_mode: manual` removes a row from the chargeable set (`scheduler-query.ts:127-138`) — **except for a manual trial**, which Task 3's carve-out deliberately keeps processable so the trial-end branch can run. For a manual trial the guarantee is not "excluded from the scheduler" but "the trial-end branch never charges a manual subscription". State it that way, or the next reader will treat the carve-out as a hole in this guarantee.

The third item this step must record is the **host-repository dependency**: the storefront renders a cancel action only for `rail === "native"`, so the vaulted customer still has no button that reaches the new route. This repository cannot close that, and the spec's Phase 15 acceptance criterion is an external dependency, not a passing test here.

- [ ] **Step 4: Tests**

Cancelling during a trial leaves no `SCHEDULED` cycle, produces no charge at `trial_ends_at`, and emits no `renewal.failed`; the auto-renew toggle alone also prevents the charge; a customer who cancels and then tries to claim again is ineligible (the ledger row survives the cancellation — that is the point of Task 20).

### Task 25: Trial documentation and the trial rehearsal (Phase 16)

**Files:**
- Modify: `docs/architecture/subscriptions.md`, `docs/admin/plan-offers.md`, `docs/api/store-subscription-offers.md`, `docs/api/store-redemptions.md`
- Modify: `docs/api/store-customer-self-service-tutorial.md` (created in Task 17)
- Modify: the matching `docs/testing/*.md`

- [ ] **Step 1: Document the two shapes and the two binding methods**

The trial has two shapes (card-free, bound) and the bound shape has two mechanisms (`vault`, `provider_subscription`) that behave differently in every operational dimension: a `provider_subscription` trial produces no renewal events, no dunning, and no reminder, because the provider owns the recurrence. Same product, two profiles. Write that down — it is exactly the kind of asymmetry that reads as a bug six months later.

- [ ] **Step 2: Document the eligibility rule and the exit paths**

The rule is "no prior subscription for this product, on any rail, at any status", and the ledger is what makes it race-safe. The exit paths are per binding method. Both belong in `subscriptions.md`, and the customer-facing half belongs in the tutorial Task 17 creates.

- [ ] **Step 3: Rehearse on a disposable database**

(6) a card-free claim creates a trial with no order and no payment, and ends at `trial_ends_at` with no charge; (7) a second claim for the same product is refused, and a customer with a paid subscription for that product is refused as well; (8) binding on day 5 produces the same `trial_ends_at` as binding on day 1 and the trial charges exactly once at the extended date; (9) cancelling during a trial leaves no scheduled cycle and produces no charge and no `renewal.failed` — this is the T1/T5 regression; (10) disabling auto-renew alone also prevents the charge.

- [ ] **Step 4: Report**

State whether the PayPal setup-token verification passed. **If it did not, that is not an account-gate question** — the gates cannot be checked without production access and are a pre-launch checklist item, so a failure means U1: the vault id does not work with the off-session charge path, and the feature does not ship. There is no fallback rail. Record it as an owner decision.

## Self-Review

**Spec coverage:** every spec section maps to a task — §1 data model (Task 1), §2 settings (Task 2), §3 retry ownership incl. R1 (Tasks 3–4), §4 double-charge elimination incl. R2/R3 (Tasks 5–7), §5 stuck reconciliation incl. R5 (Tasks 8–9), §6 dunning loop (Task 10), §7 event surface (Tasks 11–12, plus Task 13 for the two lookahead events), §8 trial conversion (Tasks 14–15), §9 rule retirement (Task 16), §10 docs (Task 17), §12 the two trial shapes (Tasks 21–23), §13 the ledger and eligibility (Task 20), §14 the claim entry point and storefront contract (Task 21), §15 the exit paths (Task 24). The spec's phases 1–11 map onto tasks 1–18 in order, with the cut line between Tasks 12 and 13; phases 12–16 map onto tasks 20–25, all of them after the cut line.

**Spec coverage gaps — stated rather than papered over.** The two requirements that previously had **no owning task** now do: **T7's guard move** (the payment-context check moving ahead of order creation, so a structurally unchargeable subscription mints no order — §11 item 3 and rehearsal item 13 both assume it) is **Task 4 Step 5**, and **T8's second gate direction** (a live reorder-rail row for the product must block a native purchase; today the gate only fires the other way, so a vault trialist can buy the native plan and be charged twice) is **Task 4 Step 6**. Both are pre-deadline work and neither depends on the trial phases. **§11's mapping is per item, not by range:** item 1 is deliberately task-less (cart-id-as-capability is documented, not fixed — Q6), item 2 is Task 17 Step 2, item 3 is Task 4 Step 5, item 4 is Task 17 Step 2, item 5 is Task 25 Step 2, item 6 is Task 25 Step 1. The earlier revision claimed a range that did not match.

**Blockers and external dependencies.** Q18 (a template cart, with `completed_at` set and an explicit region), Q19 (an ineligible claim is refused, not degraded) and Q14 (each rail keeps its own trial length) are all resolved, and each closed a problem rather than deferring it: Q19 deletes T7's broken path outright, and Q14 removes the cross-repo trial-length contract that Task 23 previously existed to build.

What remains cannot be closed from this repository and is recorded rather than solved: the host storefront's missing cancel action for the vaulted rail (T1 — Task 24 exposes the API and says so), the host's dependency bump when the PayPal plugin ships 0.7.0, and the PayPal account gates, which the owner cannot verify without production access and which are therefore a **pre-launch checklist item** rather than a blocker. Pretending otherwise would make this plan look complete when it is not.

**Placeholder scan:** no TBD/TODO. Migration timestamps are given as `<ts>` with the ordering constraint and concrete examples, because the execution date is not known at plan time; every other name, path, and line reference is concrete. The claim endpoint's request field is `binding?: "none" | "vault"` — it names only *whether* to bind, not which rail, because there is only one binding rail and the provider rail is a different product (Q11). One thing is deliberately left to the owner rather than resolved here: the host-storefront half of T1 (Task 24 Step 3).

**Type consistency:** `resolveCycleDisposition`, `structural_attempt_count`, `last_failure_kind`, `renewal_max_attempts`, `renewal_reminder_lead_days`, `abandoned`, `awaiting_manual_resolution`, `renewal.abandoned`, `renewal.awaiting_manual_resolution`, `trial_bonus_days`, `trial_claim`, `binding_method`, `vault`, `TrialClaimService.assertEligible` / `.record`, `startVaultApproval`, `completeVaultApproval` — each is introduced once and reused verbatim. `trial_binding_method` and the `provider_subscription` value were removed from the design by Q11 and Q14 and appear nowhere as identifiers. The finalization step is named `finalize-renewal-period` throughout.

**Risks the plan does not remove:** the three tasks that touch `run-dunning-retry.ts` (6, 7, 10) are the highest-blast-radius edits in the repository, and the two money jobs have no existing coverage to catch a regression — Tasks 6, 7, and 10 each add their own.

On the trial side, the risks are external rather than technical. The setup-token question is **settled as of 2026-09-28** (full record in `medusa-paypal`'s `.scratch/paypal-subscriptions/issues/07-sandbox-verification-and-docs.md`): the whole chain ran in the sandbox against the plugin's own app — setup token → buyer approval → `VAULTED` → exchange → `paypal-core.createOrder({ …, vaultId })` charged with no payer present (twice), and a follow-up probe with `permit_multiple_payment_tokens: true` proved the exchange also **mints** a fresh token (the first run's id turned out to be payer-level reuse, which is the documented behaviour of the production setting). **The design is viable and the go/no-go has passed**; the only design detail the sandbox changed is that `completeVaultApproval` must accept `VAULTED` as well as `APPROVED` (Task P1 Step 3). The remaining PayPal account gates are a pre-launch checklist item the owner cannot check without production access — with a known failure signature now (a bare `403 NOT_AUTHORIZED` on the direct vault calls). Neither the `trial_claim` constraint nor any data migration is a risk: there are no customers, so the table is created empty and nothing needs backfilling.

Task 22 Step 4 is the trial-side step most worth its own assertion, but **not because it double-charges** — a partial unique index makes a second `SCHEDULED` cycle impossible. The real failure there is a stale cycle that gets rejected every five minutes and, once Task 11 is live, mails the customer a `renewal.failed` each time.

## Execution Handoff

Plan saved to `.agents/specs/2026-09-28-billing-engine-hardening-plan.md`. Two execution options:

**1. Subagent-Driven (recommended)** — a fresh subagent per task, review between tasks, fast iteration.
**2. Inline Execution** — execute in this session with checkpoints.

**Two things should start regardless of which option is chosen**, because neither depends on this repository's code:

- **`.agents/specs/2026-09-28-paypal-vault-binding-plan.md` Task P4** — the sandbox verification of the setup-token flow. **Done (2026-09-28):** the full chain is proven against the plugin's own sandbox app — setup token `6S3005987E8102221` → buyer approval → `VAULTED` → exchange → `paypal-core.createOrder({ …, vaultId })` charged twice (captures `54T943881F833092B`, `5KR07836HJ7095947`) with no payer present, plus a fresh-token probe (`31b973135p8542309`) proving the exchange mints tokens. **The go/no-go for Task 22 has passed**, with one implementation correction: `completeVaultApproval` must accept `VAULTED` as well as `APPROVED` (Task P1 Step 3).
- **The host storefront's two changes** — someone has to schedule them in `D:\Projects\medusa-saas`, which this plan is not allowed to edit: the cancel button for the vaulted rail (the host half of T1, Task 24 Step 3) **and** wiring the trial CTA to the claim endpoint. Without the second one the claim endpoint has no caller at all, and every trial test would pass against an endpoint nothing invokes.

Which approach?
