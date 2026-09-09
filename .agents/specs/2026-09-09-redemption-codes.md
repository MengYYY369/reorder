# Spec: Redemption Codes

## TLDR & Overview

Merchants need a way to hand out subscription entitlements without payment: marketing giveaways, compensation, partnership perks. This spec adds a **redemption** domain to the plugin: admins create **batches** of redemption codes; a code locks a variant + frequency + a number of free cycles. A logged-in customer redeems a code through the Store API. Redemption auto-resolves: if the customer has an active subscription for that variant it is **extended** by N free cycles; otherwise a **new payment-free subscription** is created that terminates automatically when the free period ends. The renewal engine consumes free cycles through a generalized skip mechanism, so every free period remains auditable as a renewal cycle.

## Problem Statement

Merchants cannot grant a subscription (or additional subscription time) without routing the customer through checkout and payment. There is no way to issue a code that a customer can redeem for a subscription, and no way to append free cycles to an existing subscription outside the metadata-only retention offer. Compensation, giveaways, and partnership perks therefore have no operational path.

## Solution

A new `redemption` domain alongside the existing domains:

- Admins create a **redemption batch** (name, variant, frequency, number of free cycles, quantity, limits, validity window). Codes are generated (`RDM-XXXX-XXXX-XXXX`, unambiguous charset) or supplied as custom codes (alphanumeric + hyphens). Codes are unique case-insensitively.
- Customers preview a code (read-only: what they will get) and redeem it. Redeeming either extends their existing active subscription for that variant by N free cycles, or creates a new free subscription that auto-terminates after N cycles.
- Free cycles are consumed by the existing renewal scheduler: each due cycle during a free period succeeds without an order or payment, the free-cycle counter decrements, and normal billing resumes when the counter hits zero.
- Admins manage batches and codes (list, detail, disable) in the Admin UI, with per-batch redemption records and full activity-log traceability.

## User Stories

### Admin

1. As an admin, I want to create a redemption batch with a name, a target variant, a frequency, and a number of free cycles, so that a campaign grants a well-defined entitlement.
2. As an admin, I want the batch to auto-generate N codes in a safe charset, so that I can distribute codes at scale without inventing them by hand.
3. As an admin, I want to paste my own custom codes (e.g. `BLACKFRIDAY2026`) alongside generated ones, so that marketing campaigns can use memorable codes.
4. As an admin, I want a per-code total redemption limit (`max_redemptions`), so that a code can be a one-shot gift or a bulk promotion code.
5. As an admin, I want one redemption per customer per code, so that a single customer cannot drain a bulk code.
6. As an admin, I want a validity window (`starts_at` / `expires_at`) on a batch, so that campaigns run only inside their planned period.
7. As an admin, I want to see a batch with its codes, configuration, and redemption counts, so that I can audit a campaign.
8. As an admin, I want to disable a whole batch, so that I can stop an incident immediately.
9. As an admin, I want to disable a single code, so that a leaked code stops working without killing the campaign.
10. As an admin, I want to see who redeemed which code and what they received, so that support and finance can trace every entitlement.
11. As an admin, I want redemption events in the activity log, so that batch creation, redemptions, and disables appear in the customer's timeline.

### Customer (storefront, logged in)

12. As a customer, I want to enter a code and preview what I will get, so that I can confirm before redeeming.
13. As a customer, I want redeeming a code with no matching subscription to give me a working subscription immediately, so that I get my entitlement without paying or checking out.
14. As a customer, I want redeeming a code for a product I already subscribe to, so that my subscription is extended by the granted free cycles instead of duplicated.
15. As a customer, I want my subscription to bill normally again once the free cycles run out, so that the redemption is a bonus and not a permanent free ride.
16. As a customer, I want a redemption-created subscription to simply end when its free period is over, so that I am never charged for something I got for free.
17. As a customer, I want to see my redemption history, so that I can verify what I redeemed and when.
18. As a customer, I want redeeming a code for my overdue subscription to clear the unpaid state, so that the free cycles replace the failed charge and my subscription is healthy again.

### System / Operations

19. As the system, I want redemption code validation and consumption to be atomic under concurrency, so that a code can never be redeemed past its limit.
20. As the system, I want free periods to appear as renewal cycles that succeed without orders or payments, so that audit trails and analytics stay complete.
21. As the system, I want a daily job to terminate free subscriptions whose redemption period has ended, so that no charge is ever attempted against them.

## Proposed Architecture & Data Model

### New module: `redemption`

- **RedemptionBatch**: `id`, `name`, `variant_id`, `frequency_interval` (week|month|year), `frequency_value`, `free_cycles` (number of granted cycles), `status` (`active` | `disabled`), `starts_at`, `expires_at`, `max_redemptions_per_code` (default stamped onto codes), `code_prefix` (default `RDM`), `metadata`. Limits and window are configured once per batch and stamped onto its codes at creation; per-code overrides are not in v1 (only per-code disable).
- **RedemptionCode**: `id`, `batch_id`, `code` (unique index, stored uppercase, case-insensitive lookups), `status` (`active` | `disabled`), `max_redemptions`, `redemption_count` (counter maintained by the redeem workflow; records are the source of truth). Exhaustion is derived (`redemption_count >= max_redemptions`).
- **RedemptionRecord**: `id`, `batch_id`, `code_id`, `customer_id`, `subscription_id`, `outcome` (`subscription_created` | `subscription_extended`), `free_cycles_applied`, `frequency_interval`, `frequency_value`, `metadata`. Unique index on (`code_id`, `customer_id`) enforces the per-customer limit at the schema level.

### Subscription model change

- New column `free_cycles_remaining` (integer, default `0`). New subscriptions created from redemption carry `free_cycles_remaining = free_cycles`; extension increments it.

### Free-period timing semantics (normative)

Redemption-created subscriptions schedule their free cycles for engine consumption, not for display:

- At creation: `next_renewal_at = started_at` (the first free cycle is due immediately), `free_cycles_remaining = free_cycles` (N), and `cancel_effective_at = started_at + N cadences`.
- The generalized renewal skip branch consumes exactly N cycles: each due cycle is recorded SUCCEEDED (no order, no payment), the counter decrements, `next_renewal_at` advances one cadence. When the counter reaches zero, no further cycle is pre-created because `scheduled_for` would meet or exceed `cancel_effective_at` (existing scheduling exclusion), and the daily expiry job finalizes the subscription as CANCELLED.
- This yields exactly N auditable free-cycle records with no off-by-one at the boundary; the counter never dangles.
- Extension is symmetric: applying N free cycles to an existing subscription makes the next N due cycles free (SUCCEEDED, no order, no payment); billing resumes automatically at zero.
- Redemption-created subscriptions carry a persistent origin marker (`metadata.source = "redemption"`) so the expiry job can never terminate a regular subscription whose `cancel_effective_at` has passed.

### Workflows

- `createRedemptionBatchWorkflow` (admin): validates the grant target — variant exists, has an enabled plan-offer, and the batch frequency is within the offer's `allowed_frequencies` — then generates requested codes (unambiguous charset, deduplicated against existing codes) merged with custom codes, stamps limits/window.
- `disableRedemptionBatchWorkflow`, `disableRedemptionCodeWorkflow` (admin).
- `redeemRedemptionCodeWorkflow` (store): acquires a lock on the code, validates (batch active, window, code active, not exhausted, per-customer unique), resolves the target — the customer's ACTIVE or PAST_DUE subscription whose variant matches the batch variant; if several match and no `subscription_id` was supplied, validation fails with a disambiguation error — then branches:
  - **Create**: writes the subscription record directly (no cart, no order, no checkout). New reference scheme `SUB-RDM-xxxx`. `is_trial` is always false. `free_cycles_remaining = free_cycles`. Per the free-period timing semantics above: `next_renewal_at = started_at`, `cancel_effective_at` preset to N cadences after `started_at`, an origin marker in metadata, and the initial renewal cycle created SCHEDULED so the engine owns every period including the first free one. Product/variant/customer links are created as usual; no order/cart links.
  - **Extend**: increments `free_cycles_remaining`; for a PAST_DUE subscription it also marks any open dunning case recovered and flips the subscription back to ACTIVE (the failed charge obligation is replaced by the free cycles); ensures the next renewal cycle exists.
  - Writes a `RedemptionRecord` and activity-log events.
  - **Interim behavior before the extension branch ships**: while redemption ships with the create branch only, a validation error stating that extending an existing subscription is not yet supported is returned when an ACTIVE/PAST_DUE match exists. It never silently creates a duplicate subscription.
- Daily job `redeem-expiry`: cancels subscriptions whose `cancel_effective_at` has passed **and** whose origin marker marks them as redemption-created (reusing the existing cancellation step), logging a `subscription.expired` activity event. Regular subscriptions are never touched, even with a past `cancel_effective_at`.

### Activity log events

New event types following the dot-notation convention: `redemption.batch_created`, `redemption.redeemed`, `redemption.batch_disabled`, `redemption.code_disabled`, `subscription.expired`. Emitted through the shared log-event step (with its bus-event emission); corresponding i18n event keys are added to the admin i18n JSON files and the event denylist documentation is kept in sync. The free-period expiry is exclusive to redemption-created subscriptions (origin marker in metadata); the expiry job is a no-op for regular subscriptions, including those with a past `cancel_effective_at` awaiting period-end cancellation.

### API surface

Store (customer auth, session/bearer):
- `POST /store/customers/me/redemptions/preview` — validates a code read-only and returns the resolution ("will create" / "will extend" plus the concrete grant).
- `POST /store/customers/me/redemptions` — redeems; body: `code` (required), `subscription_id` (optional disambiguator, only honored when several matching subscriptions exist).
- `GET /store/customers/me/redemptions` — the customer's redemption history.

Admin:
- Batch CRUD-lite: create (generated + custom codes), list, get, disable.
- Code disable; redemption records listed per batch.

### Admin UI

- Batches list page (DataTable) + create modal (grant config, quantity, limits, window, generated vs custom codes).
- Batch detail page: configuration, codes table with per-code status/counts and disable action, redemption records table.
- en + zhCN i18n for all new surfaces.

## Implementation Decisions

1. **One code type, auto-resolving redemption.** A code locks variant + frequency + N free cycles; redemption extends an existing matching subscription or creates a new one. No separate grant-type field.
2. **Match by variant, exactly.** The batch locks a variant; target resolution matches subscriptions of that variant only.
3. **Extension eligibility: ACTIVE and PAST_DUE.** PAUSED and CANCELLED subscriptions are never extended; with no ACTIVE/PAST_DUE match, redemption creates a new subscription. PAST_DUE extension closes the open dunning case as recovered and reactivates the subscription.
4. **Free subscriptions terminate, never convert.** No off-session conversion, no dunning on expiry — `cancel_effective_at` presets make the scheduler structurally skip them, and the daily expiry job finalizes the state.
5. **Free cycles ride the existing renewal engine.** The `process-renewal-cycle` skip branch generalizes from `skip_next_cycle` to "skip flag OR `free_cycles_remaining > 0`": the due cycle is recorded SUCCEEDED with no order and no payment, the counter decrements, `next_renewal_at` advances one cadence. No new accounting engine is built; extension therefore resumes normal billing automatically at zero.
6. **No cart/order fabrication.** Redemption-created subscriptions bypass checkout entirely; they reference the variant through the standard subscription links and use their own reference scheme. The renewal engine never builds orders for them: every scheduled cycle within the free period is consumed by the generalized skip branch, and no cycle beyond the free period is ever pre-created because `cancel_effective_at` bounds scheduling.
7. **The free-cycle engine change ships with the create path.** Generalizing the renewal skip branch is part of the same delivery as the first code path that writes a non-zero `free_cycles_remaining`; shipping the counter without the consumer would let the scheduler fail redemption subscriptions into dunning.
8. **New `redemption` domain; no Medusa Promotion bridge.** The plugin deliberately bypasses the core promotion flow, and Promotion cannot express "code grants a subscription".
9. **Redemption requires a logged-in customer** (store API, customer auth). No guest redemption.
10. **Limits enforced in-transaction under a code lock**, with the schema-level unique index on (`code_id`, `customer_id`) as the backstop.
11. **Batch grant validation lives in the admin workflow layer**, not the module service: the module persists batches; checking that the variant exists, has an enabled plan-offer, and that the frequency is allowed requires commerce lookups the module layer does not own.
12. **analytics stays untouched in v1**; the redemption record table and activity log cover operational queries.

## Step-by-Step Implementation Plan

### Phase 1 — Domain foundation (ticket 01)
- [ ] `redemption` module: models, migration, service, types.
- [ ] Code generator utility (unambiguous charset, prefix + grouping, uppercase normalization, uniqueness check against existing codes) with unit tests.
- [ ] Module integration tests for batch creation (mixed generated/custom codes, dedupe, normalization).

### Phase 2 — Admin management (ticket 02)
- [ ] Admin workflows (create batch with grant-target validation: variant exists, enabled plan-offer, allowed frequency; disable batch; disable code) + admin API routes with validators.
- [ ] Admin UI: batches list, create modal, batch detail (codes + disable actions).
- [ ] i18n (en, zhCN); activity-log events for batch created / disabled, code disabled.
- [ ] Admin API docs (`docs/api/admin-redemptions.md`).
- [ ] HTTP integration tests for the admin surface.

### Phase 3 — Store redemption, create path + free-cycle engine (ticket 03)
- [ ] `free_cycles_remaining` migration on subscription (ships here, with its consumer).
- [ ] Generalized renewal skip branch: due cycles succeed without order/payment while `free_cycles_remaining > 0` (or `skip_next_cycle`), counter decrements, `next_renewal_at` advances.
- [ ] `redeemRedemptionCodeWorkflow` create branch (validation, target resolution, subscription creation per the free-period timing semantics, initial cycle due immediately, origin marker, links, record, events). Extension match at this stage → explicit "not yet supported" error, never a duplicate.
- [ ] Store API: preview, redeem, history; customer auth middleware.
- [ ] Daily expiry job (origin-marker-scoped).
- [ ] Store API docs update (`docs/api/store-subscription-checkout.md` sibling: `docs/api/store-redemptions.md`).
- [ ] HTTP integration tests: full create-path redemption, per-cycle engine consumption (exactly N SUCCEEDED cycles, no orders/payments, counter to zero), limits, window, disable, per-customer uniqueness, disambiguation-error placeholder, expiry job behavior incl. regular-subscription safety.

### Phase 4 — Extension path (ticket 04)
- [ ] Extend branch of the redeem workflow (ACTIVE/PAST_DUE resolution, `free_cycles_remaining` increment, next-cycle ensure; PAST_DUE: dunning case recovered + reactivation); preview returns "will extend"; interim "not yet supported" error removed.
- [ ] Extension API docs additions to the store redemptions doc.
- [ ] HTTP integration tests: free cycles applied to an existing subscription then billing resumes, PAST_DUE recovery, extension of active subscriptions, preview parity.

### Phase 5 — Records visibility + consolidated docs (ticket 05)
- [ ] Admin redemption-records endpoint (per batch) + records table on the batch detail page + i18n.
- [ ] Admin UI compatibility check for order-less subscriptions (subscription list/detail render gracefully without order references).
- [ ] Runtime docs: architecture doc, testing doc, docs README (domain list and scope), i18n event-key coverage.

### Phase 6 — Admin E2E (ticket 06)
- [ ] Playwright spec: create a batch through the UI (POM), verify codes appear, disable a code/batch, verify toasts and DataTable state per repo E2E conventions.

## Verification & Testing

- `yarn build`
- `yarn test:integration:modules` — redemption module tests.
- `yarn test:integration:http` — admin + store HTTP suites.
- `yarn test:e2e` — admin UI E2E (requires running backend).
- Focused runs per ticket using the `run-tests` skill.

## Testing Decisions

- **Test external behavior only**: HTTP requests and responses, subscription/cycle/database-visible state, activity-log events. No testing of internal step wiring.
- **Seams (all existing, no new ones)**:
  1. HTTP integration tests (`integration-tests/http/`) for both the admin and store API surfaces — the highest-level seam that exercises validation, workflows, and persistence together.
  2. Module integration tests (`test:integration:modules`) only for the pure-domain pieces (code generator, service-level constraints) where HTTP would be noise.
  3. Playwright E2E (`e2e/` with the POM pattern) for the admin UI, seeding data via the Medusa API per repo conventions.
- **Prior art**: cancellation/retention HTTP specs for redemption-adjacent flows (retention offers, subscription termination), subscription HTTP specs for renewal-cycle assertions, plans-offers E2E for admin CRUD pages.
- **Renewal engine change** is verified through HTTP renewal-flow tests (scheduler-triggered processing of a redemption subscription), not by unit-testing the skip branch in isolation.

## Out of Scope

- Analytics snapshots/metrics for redemptions (v2).
- Wallet/credit ledger and balance-based redemption.
- Paid conversion at free-period end (upsell path at expiry is a later feature).
- Extending PAUSED subscriptions; per-code limit/window overrides; editing a batch after creation (only disable).
- Guest (unauthenticated) redemption; storefront UI (the plugin ships APIs only).
- Bridging to the Medusa core Promotion module.

## Further Notes

- The plugin's checkout flow deliberately does not use `code`-based cart adjustments so Medusa promotions do not treat it as a promo code; the redemption domain keeps that separation intact.
- Codes are stored uppercase and matched case-insensitively; the generated charset excludes ambiguous glyphs (0/O, 1/I/L) to keep codes readable when shared.
- The `subscription.expired` terminal path is exclusive to redemption-created subscriptions; regular subscriptions are unaffected by the expiry job.
- Spec authored from the grilling design session on 2026-09-09; all decisions confirmed by the user.
