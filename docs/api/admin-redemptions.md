# Admin Redemption Batches API

This document describes the implemented Admin API contract for the `Redemption Codes` area of the `Reorder` plugin.

All routes are under:

`/admin/redemptions`

## Authentication

All routes are Admin-only routes.

- routes use `AuthenticatedMedusaRequest`
- request validation is handled through Medusa middleware and Zod schemas
- all mutations are executed through workflows, not in the route handlers

## Data Model

A redemption batch grants a fixed entitlement: one variant, one frequency (`frequency_interval` + `frequency_value`) and a number of free cycles. Codes belong to a batch and inherit its configuration:

- system-generated codes use an unambiguous charset (`RDM-XXXX-XXXX-XXXX` by default)
- custom codes accept letters, digits and inner hyphens (minimum two characters)
- codes are unique case-insensitively
- limits (`max_redemptions_per_code`) and the validity window (`starts_at` / `expires_at`) are configured on the batch and stamped onto every code at creation
- codes can be disabled individually; disabling a batch disables redemption for all of its codes

## Endpoints

### `POST /admin/redemptions/batches`

Creates a batch and its code set.

Request body:

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `name` | string | yes | max 200 chars |
| `variant_id` | string | yes | must exist and have an enabled plan offer |
| `frequency_interval` | `week` \| `month` \| `year` | yes | must be in the offer's `allowed_frequencies` |
| `frequency_value` | integer | yes | >= 1 |
| `free_cycles` | integer | yes | >= 1 |
| `code_prefix` | string | no | 1-8 letters/digits, default `RDM` |
| `max_redemptions_per_code` | integer | no | default 1 |
| `starts_at` | date | no | window start |
| `expires_at` | date | no | window end, must be after `starts_at` |
| `generated_code_count` | integer | no | 0-10000 |
| `custom_codes` | string[] | no | max 10000, must not collide with existing codes |
| `metadata` | object | no | |

At least one code must be produced (`generated_code_count + custom_codes.length >= 1`).

Response: `{ redemption_batch: AdminRedemptionBatchSummary, codes: AdminRedemptionCodeSummary[] }`

Validation errors (400):

- variant does not exist / has no enabled plan offer / frequency not allowed
- no codes requested
- inverted validity window
- invalid or colliding custom code

### `GET /admin/redemptions/batches`

List batches, newest first.

Query parameters: `limit`, `offset`, `q` (name search), `status` (`active` | `disabled`), `variant_id`.

Response: `{ redemption_batches: AdminRedemptionBatchSummary[], count, offset, limit }`

### `GET /admin/redemptions/batches/:id`

Response: `{ redemption_batch: AdminRedemptionBatchSummary, codes: AdminRedemptionCodeSummary[] }`

`redemption_batch` includes `code_count` and `total_redemptions` aggregates. Returns 404 for unknown ids.

### `POST /admin/redemptions/batches/:id/disable`

Disables the batch. Disabled batches stop redeeming immediately (honored by the store redemption flow). Idempotent. Returns the updated batch detail.

### `POST /admin/redemptions/codes/:id/disable`

Disables a single code. Idempotent. Returns `{ code }`.

### `GET /admin/redemptions/batches/:id/records`

Lists the batch's redemption records (newest creation order via the module's default ordering is ascending; the UI shows them in insertion order).

Response:

```json
{
  "redemption_records": [
    {
      "id": "redrec_...",
      "batch_id": "batch_...",
      "code_id": "code_...",
      "customer_id": "cus_...",
      "subscription_id": "sub_...",
      "outcome": "subscription_created",
      "free_cycles_applied": 3,
      "frequency_interval": "month",
      "frequency_value": 1,
      "created_at": "2026-09-09T12:00:00.000Z"
    }
  ],
  "count": 1
}
```

`outcome` is `subscription_created` or `subscription_extended`.

## Activity Log

Batch lifecycle is not subscription-scoped, so batch creation/disable and code disable are intentionally **not** written to the subscription activity log. The Admin UI surfaces current state through these endpoints. Subscription-scoped events (`redemption.redeemed`, `subscription.expired`) are covered in the store redemption docs.
