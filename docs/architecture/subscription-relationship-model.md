# Subscription Relationship Model

> **Status:** this document describes the design for the **1.6.0 series**, to be
> implemented by tickets `reorder 05-09` in `.scratch/source-repo-fixes/issues/`.
> None of the mechanism/rule fields described below exist in the code yet; every
> other document in this directory describes shipped behavior.

This document defines the relationship between the three payment tracks a
storefront can offer for a subscription-enabled product:

- **One-time payment** — a single charge at checkout, optionally with
  auto-renew consented (checkbox).
- **Auto-renew** — the consented renewal mechanism: reorder charges the saved
  payment method at each `next_renewal_at`.
- **Native PayPal subscription** — PayPal Billing owns the recurring charges;
  reorder only mirrors the subscription.

It is the follow-up to `plan-offers.md` (which covers offer configuration).
The behavioral rules below will be implemented by the `create-subscription-from-order`
workflow, the checkout validation path, and the native-event subscribers.

Documentation split: this document covers the relationship rules (R1-R5) and the
three new rule fields (`consent_from_session`, `row_stacking_policy`,
`max_stacking_cycles`); the full rules set
(`minimum_cycles`, `trial_*`, and `stacking_policy` as discount stacking) lives
in `plan-offers.md`.

## Concepts

**One-time payment = an entitlement grant.** Paying once adds the purchased
period to the customer's coverage window. It is *not* a second subscription and
never creates a duplicate row for the same product.

**Auto-renew and native subscription = mutually exclusive billing mechanisms.**
A subscription row carries exactly one mechanism:

```ts
payment_context: {
  payment_mode: "manual" | "auto",
  payment_provider_id: string | null,
  payment_method_reference: string | null,
  mechanism: "manual" | "reorder_auto" | "native",   // discriminator
  native_subscription_id: string | null,             // native mirror rows: I-xxx
}
```

Rows created before this model carry no `mechanism`; they will be interpreted from
`payment_mode` (`manual` → `manual`, `auto` → `reorder_auto`).

## Rules

### R1 — Grants extend in place

A one-time payment for a product the customer already holds extends the
existing active row's `next_renewal_at` by the purchased period (the new
variant's frequency). No second row is created for the same product. If no row
exists, a new row is created with `mechanism: "manual"`.

The extension is bounded by `rules.max_stacking_cycles` (see below): when the
accumulated extension would exceed the cap, the purchase is rejected at
checkout with a clear 400. Unlimited by default.

One-time stacking only applies to *subscribable* products — those with an
enabled plan-offer; the existing `planChangeNotAllowed` validation is unchanged.

### R2 — Consent flips manual → auto

When the source payment session carries the field configured by
`rules.consent_from_session` (`"customer_id"`), the row flips
`payment_mode: manual → auto` and `mechanism → reorder_auto` **in the same
update** the payment method is persisted (no polling window). The flip is
recorded on the subscription log with the consent source. Unconfigured offers
keep the previous behavior (mode stays manual).

Two moments can prove consent, and each is handled where the method is in hand:
a redirect-provider checkout persists the vaulted method on `payment.captured`
and flips there; a repeat purchase that folds into an existing row flips during
validation, and only when that row already holds a chargeable method — flipping
a row with nothing to charge would hand the scheduler a mode it cannot act on.
Neither path flips a native mirror row.

### R3 — Native subscription is exclusive

While a native row for the same product is `active` or `paused`, the customer may
not buy that product again from the other track: both the *one-time +
auto-renew* combination and a **plain one-time purchase** are refused (400, "one
payment track per product at a time"), and the message points to the
switch-subscription flow (R5). `cancelled` and `past_due` rows do not block, so a
customer whose provider charge just failed can still buy the period themselves.

There is no per-offer switch for this. An earlier draft had
`allow_auto_renew_with_native`; under strict exclusion it would only allow two
live recurrences on one product with different billing dates — the exact failure
R1/R4 exist to remove — so the field was dropped rather than implemented.

Enforcement is split, because the two purchase paths share no validation step:

| purchase | refused by |
| --- | --- |
| subscription checkout | `validate-subscription-cart`, before its payment-mode branch (the one-time path never reaches it) |
| plain one-time checkout | a method-level middleware on the core `POST /store/carts/:id/complete` |

Both read the same predicate, `reference LIKE 'NATIVE-%'`
(`src/modules/subscription/utils/native-subscription.ts`); never a
`payment_context->>'mechanism'` comparison, whose NULL-versus-NULL behaviour
would silently exclude every pre-existing row.

### R4 — Cross-plan rows

`rules.row_stacking_policy: "allow_multiple"` permits separate rows for
different plans/offers. The same product is still bound by R1: it never holds
two rows.

### R5 — Native re-purchase requires cancellation first; plan changes switch in place

An existing active native subscription for the product rejects a *new* native
(subscription-payment) purchase with a clear 400 ("cancel the current
subscription first"). Enforced in **medusa-paypal** (its `paypal_subscription`
rows carry customer_id + variant_id; an ACTIVE duplicate for the same customer
× product is rejected at its store subscription route).

Changing plan/frequency within the same product uses PayPal's native **revise**
endpoint instead (the *switch subscription* flow, spec decision 19): the same
subscription is revised in place — no cancel, no new subscription — the new
price takes effect at the next billing cycle (no proration). Because the
subscription stays ACTIVE, no cancelled/activated events fire; medusa-paypal
emits `paypal.subscription.revised` (payload: `subscription_id` / `plan_id` /
`variant_id` / `frequency_interval` / `frequency_value` / `next_billing_at`)
and reorder updates the mirror row's plan and frequency in place (same
`native_subscription_id`).

## Native mirror rows

Reorder will subscribe to the paypal plugin's already-emitted lifecycle events
(`paypal.subscription.activated / suspended / resumed / revised / cancelled /
expired / payment_succeeded / payment_failed`) and will upsert read-only
`mechanism:"native"` rows:

- every event payload carries the mirror row's NOT NULL columns directly
  (`product_id` / `variant_id` / `frequency_interval` / `frequency_value`) plus
  `next_billing_at` / `last_billing_at` — the mirror never derives product or
  frequency from plan/offer data (the paypal plan table lives in the other
  package and is unreachable from reorder);
- `status` and `next_renewal_at` will be synced from events;
- `paypal.subscription.revised` will update the mirror row's plan and frequency
  in place (same `native_subscription_id`, no new row);
- renewal / dunning / collection engines will **skip** native rows — reorder
  will never charge on behalf of PayPal Billing;
- event replay will be idempotent; existing native subscriptions will be
  backfilled once (reconciliation task or script).

Having the mirror locally turns "does this customer already hold a native
subscription?" (R3/R5) into a plain table query.

## plan-offer rules reference

The `rules` object on a plan offer accepts (all optional, conservative
defaults — an unconfigured offer behaves exactly as before):

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `consent_from_session` | `"customer_id" \| null` | `null` | Session field whose presence means "checkout consent for auto-renew". `"customer_id"` enables R2. |
| `row_stacking_policy` | `"extend" \| "allow_multiple"` | `"extend"` | R1 extend-in-place vs R4 per-plan rows. |
| `max_stacking_cycles` | `number \| null` | `null` | R1 cap: maximum number of purchased cycles the window may be extended. `null` = unlimited. |

The existing `stacking_policy` field (discount stacking:
`allowed` / `disallow_all` / `disallow_subscription_discounts`) is unchanged and
is **not** the row-stacking setting.

## Example offer

```jsonc
{
  "name": "PRO Monthly One-time",
  "scope": "variant",
  "variant_id": "variant_...ZX779",
  "is_enabled": true,
  "allowed_frequencies": [{ "interval": "month", "value": 1 }],
  "rules": {
    "minimum_cycles": null,
    "trial_enabled": false,
    "trial_days": null,
    "trial_requires_payment_method": false,  // required by the rules schema
    "stacking_policy": "disallow_all",      // discount stacking, unchanged
    "consent_from_session": "customer_id",  // R2: checked consent enables auto-renew
    "row_stacking_policy": "extend",        // R1: repeat purchases extend the window
    "max_stacking_cycles": 24               // R1 cap: at most 24 purchased monthly cycles
  }
}
```

## Source of truth

Behavioral program for this round (defects MP-1..MP-5 / RE-1..RE-7 and this
model's implementation) lives in the host's
`medusa-saas/docs/plugins/2026-09-21-source-fix-spec.md`; the per-package work
breakdown is under `.scratch/source-repo-fixes/issues/`.