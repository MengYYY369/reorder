# Store Subscription Offers

This document describes the storefront read endpoint used by PDP to resolve subscription offer data from `Plans & Offers`.

## Endpoint

### `GET /store/products/:id/subscription-offer`

Returns the effective subscription offer for a product or variant.

Query params:
- `variant_id` optional

Response:
- `subscription_offer.is_subscription_available`
- `subscription_offer.product_id`
- `subscription_offer.variant_id`
- `subscription_offer.source_offer_id`
- `subscription_offer.source_scope`
- `subscription_offer.allowed_frequencies`
- `subscription_offer.discount_semantics`
- `subscription_offer.minimum_cycles`
- `subscription_offer.trial`

The route accepts optional customer authentication: an anonymous request is
answered with `trial.eligible: false, reason: "authentication_required"`, while
an authenticated one is evaluated against that customer. The response is sent
with `Cache-Control: no-store` — the trial half is per-customer, and without the
header a shared cache could serve one customer's eligibility to another.

## Frequency payload

Each `allowed_frequencies` item contains:
- `frequency_interval`
- `frequency_value`
- `label`
- `discount`

`discount` contains:
- `type`
- `value`

## Trial payload

`subscription_offer.trial` is `null` when no plan offer resolves for the
product/variant. When set:

| Field | Type | Meaning |
|-------|------|---------|
| `is_enabled` | boolean | the offer's `trial_enabled` rule |
| `days` | number \| null | the offer's `trial_days` |
| `requires_payment_method` | boolean | the offer's `trial_requires_payment_method` rule (default `false`) |
| `bonus_days` | number \| null | the offer's `trial_bonus_days`: extra days granted when the customer binds a payment method to a claimed trial. `null` hides the bind-and-extend option. |
| `eligible` | boolean | whether **this** customer can claim a trial for this product right now |
| `reason` | string \| null | why `eligible` is `false` |
| `binding.method` | `"vault"` | the only binding mechanism for a claimed trial |
| `binding.supported` | boolean | whether **any** registered provider ships the binding capability. Provider-agnostic by construction (`medusa-payment-methods` ≥ 0.3.0): reorder asks the capability view, never a named provider, so a second provider with binding support flips this to `true` without a code change. When `false`, hide the bind-and-extend control |

`reason` values:

- `trial_not_offered` — the offer is disabled, has no trial, or has no trial
  days; `eligible` is `false` for every customer
- `authentication_required` — the request carried no customer identity
- `already_claimed_or_subscribed` — the customer has a prior claim, or any
  subscription for this product on any rail at any status (the storefront
  should show the ordinary subscribe button, which sits beside the trial CTA)
- `eligibility_unavailable` — the eligibility read failed; the conservative
  answer, re-checked authoritatively by the claim endpoint

The claim endpoint (`POST /store/customers/me/trials`) is the only writer of
trial claims; see `store-customer-self-service-tutorial.md` for the claim and
bind request/response shapes.

## Resolution semantics

- variant-level offer takes precedence over product-level offer
- disabled or missing offer returns `is_subscription_available: false`
- cadence is returned in canonical backend form:
  - `week`
  - `month`
  - `year`

## Purpose

- PDP subscription selector
- PDP pricing and savings display
- storefront validation of allowed subscription cadence
