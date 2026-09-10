# Payments Architecture

This document describes how the `Reorder` plugin charges subscriptions and how the payment method of a subscription is managed.

It focuses on the implemented system, not on the initial design assumptions.

## Goal

Recurring charges happen without the customer being present. The plugin therefore needs a reusable payment method reference that can be charged off-session at renewal time, and a way to replace that reference when it stops working.

The current implementation supports:
- capturing a reusable payment method at subscription checkout
- charging renewals off-session with that payment method
- retrying failed renewal charges from the dunning flow
- listing the saved payment methods of a customer
- changing the payment method a subscription renews with, from Admin and from the storefront

## Provider Model

The plugin is payment provider agnostic. It never talks to a payment service directly and never depends on a provider SDK.

All payment operations go through the Medusa Payment Module:
- account holders link a Medusa customer to a customer record in the payment service
- `listPaymentMethods` returns the payment methods saved for an account holder
- payment sessions and `authorizePaymentSession` / `capturePayment` perform the charge

Any payment provider implementing that interface works. The Stripe Module Provider (`pp_stripe_stripe`) does, and is the provider this area is primarily exercised with.

Provider specific requirement for Stripe: the storefront must initialize the checkout payment session with `setup_future_usage: "off_session"`, otherwise Stripe does not save the card and no reusable payment method reference exists at renewal time.

## Payment Context

`subscription.payment_context` is the operational record of how a subscription is charged. It is a JSON column on the subscription model with the following fields:

- `payment_provider_id`
  the Medusa payment provider used for renewals, for example `pp_stripe_stripe`
- `payment_method_reference`
  the reusable payment method identifier charged off-session at renewal time
- `customer_payment_reference`
  the customer identifier in the payment service, derived from the account holder
- `source_payment_collection_id`
  the payment collection of the original checkout
- `source_payment_session_id`
  the payment session of the original checkout

`source_payment_collection_id` and `source_payment_session_id` document the original checkout. They are never rewritten after the subscription is created, including when the payment method changes.

## Lifecycle

### 1. Checkout

`validate-subscription-cart` builds the payment context while completing a subscription cart.

The reusable payment method reference is resolved in this order:
1. `payment_method` on the cart payment session data
2. the most recently saved payment method of the customer's account holder for that provider

Checkout fails with a validation error when neither is available, because a subscription that cannot be renewed must not be created.

### 2. Renewal

`process-renewal-cycle` creates the renewal order, then charges it when the order total is greater than zero:
1. resolve the order's payment collection through the shared `resolveOrderPaymentCollection` helper (`workflows/utils/resolve-order-payment-collection.ts`)
2. create a payment session for `payment_provider_id` with `payment_method`, `off_session: true`, `confirm: true` and `capture_method: "automatic"`
3. authorize the payment session
4. capture the payment

A missing `payment_provider_id` or `payment_method_reference` fails the cycle before any charge is attempted.

A failure of the resolve-or-create helper is wrapped as a payment-qualified renewal error with source `payment_session`, so it opens a dunning case instead of surfacing as an unexpected error.

#### The resolve-or-create payment collection helper

All three charge paths (automatic renewal, dunning retry, manual renewal) resolve the renewal order's payment collection through one shared helper. It never reads the order summary.

Medusa 2.20's read-time total decoration recomputes `pending_difference = total − pending_return_total − transaction_total` and zeroes it whenever it is at or below the currency epsilon (`10^-decimal_digits` of the order currency: `0.01` for USD/CNY, `1` for zero-decimal currencies such as JPY/KRW). The core `create-or-update-order-payment-collection` workflow validates the charge against that decorated value, so it rejects fresh renewal orders priced at or below the currency epsilon with `Amount cannot be greater than ...`. The helper therefore re-implements the same resolve-or-create semantics from the live order total passed in by the caller:

- a linked `not_paid` / `awaiting` collection is reused and its amount synced to the charge amount
- a linked `authorized` / `partially_authorized` collection is canceled and replaced: only authorized (non-captured) payments are released, a collection with captured money is never canceled, and the canceled collection ends up `partially_captured` when it holds captured money
- otherwise a new collection is created in the order currency and attached to the order via the order ↔ payment collection remote link
- a canceled, failed, or completed collection counts as missing

### 3. Dunning

Failures are classified by source (`payment_session`, `payment_provider`, `payment_capture`) and open a dunning case. `run-dunning-retry` replays the same charge against the renewal order using the subscription's current payment context: the retry resolves the renewal order's payment collection through the shared helper (reusing the existing chargeable collection instead of creating a duplicate), creates a new off-session session, and authorizes and captures the payment. Helper failures flow through the existing retry classification, so a temporary helper failure reschedules the retry instead of closing the case.

Because retries read the payment context at retry time, changing the payment method of a subscription with an open dunning case makes the next retry use the new payment method. This is the recovery path for a declined or expired card.

## Payment Method Management

`update-subscription-payment-method` changes which payment method a subscription renews with.

Behavior:
- allowed for subscriptions in `active`, `paused` or `past_due` status
- the payment method must be a saved payment method of the subscription's own customer for the target provider, otherwise the update is rejected
- `provider_id` is optional and defaults to the subscription's current `payment_provider_id`; it is required when the subscription has no provider configured
- only `payment_provider_id`, `payment_method_reference` and `customer_payment_reference` are rewritten
- the step compensates by restoring the previous subscription record
- a `subscription.payment_method_updated` activity-log event records the change

The workflow does not trigger a payment retry. Retrying is an explicit action through the dunning retry routes.

## Exposed Data

Payment method summaries returned by the Store and Admin APIs are normalized and contain no raw provider payload:

```
{
  "id": "pm_123",
  "provider_id": "pp_stripe_stripe",
  "type": "card",
  "brand": "visa",
  "last4": "4242",
  "exp_month": 4,
  "exp_year": 2030,
  "created_at": 1700000000
}
```

Card fields are read defensively. Providers that expose no card metadata yield `null` fields rather than an error.

Resolving the summary of the currently stored payment method is best effort in both the Store and Admin detail responses: when the payment method was removed in the payment service or the provider is unreachable, `payment_method` is `null` while `payment_provider_id` is still returned. The Admin subscription detail view renders a warning in that case, because it means renewals will fail until a new payment method is selected.

## Activity Log

`subscription.payment_method_updated` records the payment method change.

The event stores only non-sensitive identifiers in `previous_state` and `new_state`:
- `payment_provider_id`
- `brand`
- `last4`
- `exp_month`
- `exp_year`

Payment method references, customer payment references and payment session identifiers are part of the activity-log sensitive key set and are never persisted in log state.

## Related Documents

- `architecture/subscriptions.md`
- `architecture/renewals.md`
- `architecture/dunning.md`
- `api/admin-subscriptions.md`
- `api/store-subscription-payment-methods.md`
- `api/store-subscription-checkout.md`
