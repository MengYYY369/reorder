# Store Subscription Checkout

## `POST /store/carts/:id/sync-subscription-pricing`

Synchronizes subscription pricing on a cart before payment-session creation or subscription completion.

Purpose:
- resolve the effective `Plans & Offers` config for the subscription line item
- apply or remove the manual line-item adjustment for the selected cadence
- refresh cart totals, taxes, and payment collection before checkout continues

Current adjustment semantics:
- the cart adjustment is stored as a manual line-item adjustment
- it uses `provider_id = "subscription_discount"`
- it uses `description = "Subscription discount"`
- it is marked `is_tax_inclusive = true`
- the cart adjustment intentionally does not use `code`, so Medusa promotion flows do not treat it as a promo code

Current route behavior:
- returns whether subscription items were found
- returns whether cart adjustments changed
- is safe to call repeatedly during cart, delivery, and payment steps

## `POST /store/carts/:id/subscribe`

Completes a subscription cart and creates the linked subscription record.

MVP metadata contract:

- `line_item.metadata.is_subscription: boolean`
- `line_item.metadata.frequency_interval: "week" | "month" | "year"`
- `line_item.metadata.frequency_value: positive integer`

Optional cart metadata:

- `cart.metadata.purchase_mode: "subscription"`

Rules:

- line item metadata is the source of truth
- if `purchase_mode` is present, it must be `"subscription"`
- mixed cart is not supported in MVP
- subscription checkout currently supports exactly `1` subscription line item with quantity `1`
- mixed cart or missing subscription item returns `400`
- standard Medusa cart completion for one-time checkout stays unchanged
- route is idempotent after cart completion: if the created order is already linked to a subscription, the existing subscription is returned

Checkout sequencing:

- subscription pricing is synchronized before `completeCartWorkflow`
- the cart is refreshed before completion so payment collection and order totals use the discounted amount
- after order creation, the order adjustment may be labeled with `subscription_discount` for Medusa Admin display
- when the subscription record is created for the first time, the plugin also appends a `subscription.created` activity-log entry for that subscription and records the storefront customer as the actor

## Mutual exclusion with a provider-managed subscription

While the customer has a live subscription for the same product **at the payment
provider** (a `NATIVE-…` mirror row in status `active` or `paused`), this route
returns `400` naming the product and tells the customer to change or cancel that
subscription instead.

Two guards, because the two purchase paths share no validation step:

| purchase | guarded by |
| --- | --- |
| subscription checkout (this route) | cart validation in `validate-subscription-cart`, before the payment-mode branch |
| plain one-time checkout | a method-level middleware on the core `POST /store/carts/:id/complete`, see `docs/architecture/subscriptions.md` |

A one-time purchase never reaches the validation step above — it has no
subscription line item, so that step is not even invoked for it. Guarding only
there would pass every plain purchase through in production while still passing
its own tests.

`cancelled` and `past_due` provider subscriptions are deliberately **not**
blocked: a customer whose provider charge just failed keeps the option of buying
that period themselves, and a subscription that ended long ago must not lock them
out for the rest of its nominal term.
