# Store Redemption API

This document describes the implemented Store API contract for redeeming codes, part of the `Redemption Codes` area of the `Reorder` plugin.

All routes are under:

`/store/customers/me/redemptions`

## Authentication

All routes require customer authentication (`session` or `bearer`) and a publishable API key header. Guest redemption is not supported: every redemption is attributed to a customer.

## Concepts

A redemption code belongs to a batch that fixes the grant: one variant, one frequency and a number of free cycles. Redeeming is **auto-resolving**:

- if the customer has an ACTIVE or PAST_DUE subscription of that variant → the subscription is **extended** by the granted free cycles
- otherwise → a **new payment-free subscription** is created

Extending a PAST_DUE subscription recovers its open dunning case (`recovery_reason: "redemption_free_cycles_applied"`) and flips the subscription back to ACTIVE — the failed charge obligation is replaced by the free cycles. Normal billing resumes automatically when the free-cycle counter reaches zero. PAUSED and CANCELLED subscriptions are never extended; with no ACTIVE/PAST_DUE match, redemption creates a new subscription. When several matching subscriptions exist and no `subscription_id` was supplied, redemption fails with a disambiguation error.

Redemption-created subscriptions (`reference` starting with `SUB-RDM-`, `metadata.source = "redemption"`) get their first free cycle due immediately (`next_renewal_at = started_at`) and `cancel_effective_at` preset to the end of the free period. The renewal engine consumes each free cycle as SUCCEEDED (no order, no payment) while `free_cycles_remaining > 0`, and a daily job cancels the subscription once the boundary passes. Regular subscriptions are never affected by the expiry job.

## Endpoints

### `POST /store/customers/me/redemptions/preview`

Validates a code read-only and reports what redeeming would do. Same validation pipeline as redeem; consumes nothing.

Request body:

| Field | Type | Required |
|-------|------|----------|
| `code` | string | yes |
| `subscription_id` | string | no — only honored as a disambiguator |

Response:

```json
{
  "kind": "create",
  "grant": {
    "product_id": "prod_...",
    "product_title": "Pro Plan",
    "variant_id": "variant_...",
    "variant_title": "Monthly",
    "frequency_interval": "month",
    "frequency_value": 1,
    "free_cycles": 3
  },
  "target_subscription_id": null
}
```

`kind` is `create` or `extend` (with `target_subscription_id` set for `extend`).

Error responses (400/404): invalid code, disabled batch/code, outside validity window, code exhausted, already redeemed by this customer, no matching subscription for an explicitly passed `subscription_id`, ambiguous target (several matches without `subscription_id`), and a customer row that is gone (`Redemption customer <id> not found`, 404).

### `POST /store/customers/me/redemptions`

Redeems the code.

Request body: same shape as preview.

Response:

```json
{
  "subscription_id": "sub_...",
  "subscription_reference": "SUB-RDM-01J...",
  "redemption_record_id": "redrec_...",
  "outcome": "subscription_created",
  "free_cycles_remaining": 3,
  "dunning_recovered": false
}
```

`outcome` is `subscription_created` or `subscription_extended`. `free_cycles_remaining` is returned for extensions (the new counter value); `dunning_recovered` is true when a PAST_DUE extension recovered an open dunning case.

Validation is enforced under a lock on the code: batch/code active, validity window, per-code `max_redemptions`, one redemption per customer per code (schema-level unique index on (`code_id`, `customer_id`) as backstop).

**Failure disclosure.** This route runs the same workflow as
`POST /store/saas/redeem`, so a failure that is not one of the refusals that
workflow declares answers with one of three fixed strings
(`redemption target not found` / `redemption was refused` / `redemption failed`)
while the step name and the serialized error go to the server log: a driver fault
is a 500 and never a 422 quoting `table` and `detail`. What differs from the bridge
route is only the status a *declared* refusal carries — this route answers it with
the type the step threw it as, so an unknown code stays **404** here where the
bridge has always flattened refusals to **400**. A session that outlived its
customer row is one of those declared refusals: **404** `Redemption customer <id>
not found`, naming the id the caller authenticated as and no variant.
The shared mechanism is
`src/workflows/utils/store-step-failure.ts` and its `preserveQuotedStatus` option.

### `GET /store/customers/me/redemptions`

Lists the customer's redemption records, newest first.

Response: `{ redemptions: [{ id, batch_id, code_id, outcome, free_cycles_applied, frequency_interval, frequency_value, subscription_id, created_at }], count, offset, limit }`

`outcome` is `subscription_created` or `subscription_extended`.

## Activity Log

- `redemption.redeemed` — written on every successful redemption (outcome, code, batch in `new_state`)
- `subscription.created` — the redemption-created subscription
- `subscription.expired` — written by the daily expiry job when the free period ends
