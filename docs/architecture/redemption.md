# Redemption Codes Architecture

This document describes the current architecture of the `Redemption Codes` area in the `Reorder` plugin.

It focuses on the implemented system, not on the initial design assumptions.

## Goal

The `Redemption Codes` area lets merchants distribute subscription entitlements without payment: marketing giveaways, compensation, and partnership perks.

The current implementation supports:
- creating redemption batches with system-generated and custom codes
- per-code redemption limits, per-customer uniqueness, and validity windows
- disabling batches and individual codes
- redeeming codes through the Store API for logged-in customers
- auto-resolving redemption: extending an existing subscription or creating a payment-free one
- free cycles consumed by the existing renewal engine without orders or payments
- automatic termination of free subscriptions at the end of their period

## Architectural Overview

The implementation is split into five layers:

1. domain module
2. workflows
3. admin API and Admin UI
4. store API
5. scheduled job

Each layer has a clear responsibility:

- the `redemption` domain module owns the batch/code/record data model
- workflows own validation, target resolution, and mutations
- the admin API and UI manage campaigns; the store API serves customers
- the daily job finalizes expired free subscriptions

## 1. Domain Module

The `redemption` custom module owns three models:

- `redemption_batch` — the campaign: name, target `variant_id`, grant configuration (`frequency_interval`, `frequency_value`, `free_cycles`), status, validity window, `max_redemptions_per_code`, `code_prefix`
- `redemption_code` — belongs to a batch; `code` (unique case-insensitively, stored uppercase), status, `max_redemptions`, `redemption_count`
- `redemption_record` — one per redemption; outcome (`subscription_created` | `subscription_extended`), `free_cycles_applied`, frequency snapshot; unique index on (`code_id`, `customer_id`) enforcing one redemption per customer per code

Limits and the validity window are configured on the batch and stamped onto codes at creation. Only disable is available per code; batch editing is not supported in v1.

The code generator uses an unambiguous charset (no `0/O`, `1/I/L`) in the shape `RDM-XXXX-XXXX-XXXX`. Custom codes accept letters, digits, and inner hyphens (minimum two characters) and are validated for collisions across all batches.

Grant-target validation (variant exists, enabled plan offer, allowed frequency) belongs to the admin workflow, not the module: the module cannot see commerce entities.

## 2. Workflows

### Admin workflows

- `create-redemption-batch`: validates the grant target through the commerce query, then persists the batch and its codes. Compensation deletes the batch.
- `disable-redemption-batch`, `disable-redemption-code`: idempotent status flips with compensation.

### Store workflows

- `redeem-redemption-code`: the redemption pipeline. Acquires a lock on the code (`redemption-code:<CODE>`) so concurrent redemptions serialize, then:
  1. `resolve-redemption-code` — validates batch/code active, window, exhaustion, per-customer uniqueness, and resolves the target: the customer's ACTIVE/PAST_DUE subscription matching the batch variant (several matches without an explicit `subscription_id` is a 400). Reports `create` or `extend`.
  2. Create branch — mints the subscription (below), links customer/product/variant (no order/cart links), ensures the initial renewal cycle.
  3. Extend branch — increments `free_cycles_remaining`, reactivates the subscription, and recovers any open dunning case for PAST_DUE targets (`recovery_reason: "redemption_free_cycles_applied"`).
  4. Persists the `RedemptionRecord`, increments the code counter, and writes `redemption.redeemed` to the activity log.
- `preview-redemption-code`: the same validation pipeline in read-only mode; reports `create`/`extend` plus the concrete grant.

## 3. Free-Period Semantics

Redemption-created subscriptions are payment-free and terminate on schedule:

- `next_renewal_at = started_at` — the first free cycle is due immediately
- `free_cycles_remaining = free_cycles`
- `cancel_effective_at = started_at + N cadences`
- `metadata.source = "redemption"` — the origin marker
- `is_trial` is always false
- `payment_context.payment_mode = "auto"` keeps the cycles inside the scheduler's due set; the free branch never builds an order or touches payment

The renewal engine's skip branch is generalized: a due cycle succeeds without order/payment when `skip_next_cycle` is set OR `free_cycles_remaining > 0`; the counter decrements and `next_renewal_at` advances one cadence. When the counter reaches zero, no further cycle is pre-created because `scheduled_for` would meet or exceed `cancel_effective_at` (existing scheduling exclusion). This yields exactly N auditable SUCCEEDED cycle records with no off-by-one at the boundary.

There is no paid conversion at the end of the free period (a future feature): the subscription terminates.

## 4. Expiry Job

The `redemption-expiry` job (daily) cancels subscriptions whose `cancel_effective_at` has passed and whose origin marker marks them as redemption-created, writing `subscription.expired` to the activity log. Regular subscriptions are never touched, including those with a past `cancel_effective_at` awaiting period-end cancellation.

## 5. Activity Log

Batch lifecycle is not subscription-scoped and is intentionally not written to the subscription activity log; the admin endpoints surface current state. Subscription-scoped events: `redemption.redeemed`, `subscription.created`, `subscription.expired`.

## 6. Admin UI

- Batches list page with search, status badges, and code/redemption counts
- Create modal: grant config, quantity, per-code limit, validity window, generated and custom codes
- Batch detail: configuration summary, codes table (status, usage, disable action), redemption records table (customer, outcome, free cycles, subscription, timestamp)
- en + zhCN i18n under the `redemptions` namespace

## API Contracts

- `docs/api/admin-redemptions.md` — admin batch/code management
- `docs/api/store-redemptions.md` — customer redemption surface

## Testing

See `docs/testing/redemptions.md`.
