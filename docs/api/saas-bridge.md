# SaaS Bridge — optional shared-secret integration surface

The plugin can expose a byte-compatible replacement for the retired
[`@mengyyy369/medusa-saas-bridge`](https://github.com/MengYYY369/medusa-saas-bridge)
plugin: six `/store/saas/*` shared-secret endpoints for a SaaS entitlement
application, plus lifecycle event forwarding into the
[`@mengyyy369/medusa-webhooks`](https://github.com/MengYYY369/medusa_webhooks)
signed fan-out. The SaaS application requires **zero code changes** — route
paths, auth headers, and request/response bodies are identical to the bridge
plugin it replaces.

Everything lives in the self-contained `src/modules/saas-bridge/` module; the
route and subscriber files at conventional paths are thin. Upstream syncs from
reorder-js only ever conflict on two shared files: `src/api/middlewares.ts`
(the middleware aggregation point) and `package.json` (the optional peer
entry).

## Configuration

```ts
// medusa-config.ts — after the merge, one plugin entry provides the whole stack
{
  resolve: "@mengyyy369/reorder",
  options: {
    saas_bridge: {
      // single-tenant shorthand — treated as tenant_id "default"
      shared_secret: "<random secret>",        // MEDUSA_BRIDGE_SECRET on the SaaS
      subscriptions: [
        "order.placed", "order.updated", "payment.captured",
        "subscription.created", "subscription.paused", "subscription.resumed",
        "subscription.canceled", "subscription.plan_change_scheduled",
        "renewal.succeeded", "renewal.failed",
      ],
      // multi-tenant form (independent secrets and customer pools):
      // tenants: [
      //   { tenant_id: "pbo-saas",  shared_secret: "<secret-A>" },
      //   { tenant_id: "map-tools", shared_secret: "<secret-B>" },
      // ],
    },
  },
}
```

Semantics:

- **Absent `saas_bridge` = exactly today's plugin.** Every `/store/saas/*`
  route fails closed with `401 {"error": "bad-secret"}` (indistinguishable
  from a wrong secret — the routes' existence leaks nothing) and no event is
  forwarded. No optional dependency is touched at boot.
- **Configured without a `subscriptions` whitelist** → the endpoints stay
  active but nothing is forwarded (the old bridge's empty-default semantics).
- **Fail-fast:** booting with a *non-empty* `subscriptions` whitelist while
  `@mengyyy369/medusa-webhooks` is not installed throws at init, naming the
  missing package. Endpoints-only configurations boot without the peer,
  because nothing ever resolves it. The peer is declared as an **optional
  peer dependency** and is never imported at the top level of a boot-loaded
  file — module discovery loads subscriber files even when `saas_bridge` is
  unconfigured.

## Multi-tenancy

- One tenant entry per connected SaaS site; each has its own secret and its
  own customer/entitlement scope.
- `X-Tenant-Id` + `X-Bridge-Secret` (the per-tenant value) on every call.
- With **multiple tenants configured, `X-Tenant-Id` is REQUIRED**. With
  exactly one, the header may be omitted and resolves the implicit default.
  This fallback is contract, not convenience: the SaaS webhook receiver calls
  reconcile without `X-Tenant-Id` and relies on it.
- Tenant isolation: `ensure-customer` stamps `metadata.tenant_id` on creation
  and looks up per tenant (the same email can exist under two tenants as two
  records; unstamped customers sharing the email are *adopted*). `reconcile`,
  `renew`, `auto-renew`, `carts` and `redeem` resolve the owning customer and
  answer **404** (existence never leaked) when the customer is stamped for a
  different tenant.
  A customer with **no** stamp is treated as this tenant's when the deployment
  configures exactly one tenant — that is what keeps pre-bridge customers
  visible under the implicit default above — and is invisible to every tenant
  when several are configured (claim it with `ensure-customer` first).
  The rule is implemented once, in `src/modules/saas-bridge/tenant-ownership.ts`
  behind `src/api/store/saas/lib/tenant-ownership.ts`; routes must not re-type
  the comparison.

## Auth

Every call is a server-to-server `POST` carrying:

- `x-publishable-api-key` — the standard store requirement, unchanged
- `x-bridge-secret` — the tenant secret, compared timing-safely
- `x-tenant-id` — required with multiple tenants (see above)

Wrong or missing secret → `401` with `{"error": "bad-secret" |
"unknown-tenant" | "tenant-required"}`.

## The six endpoints

All request bodies are snake_case; unknown-body drift on the pinned response
fields breaks the SaaS.

### `POST /store/saas/ensure-customer`

`{ email?, external_id?, display_name? }` (at least one of email /
external_id) → `{ customer: { id, email } }`. Idempotent per tenant; lookup
priority external_id (tenant-scoped) → email (tenant-scoped, with adoption of
unstamped customers). Pinned: `customer.id`, `customer.email`.

### `POST /store/saas/reconcile`

Exactly one of `{ order_id | subscription_id | customer_id }` (snake_case
enforced — wrong casing 400s). Returns the authoritative snapshot for
webhook-loss recovery:

- `order.orderId`, `order.paymentStatus` (legacy
  pending/authorized/captured/canceled vocabulary mapped from the payment
  collection), `order.currencyCode`, `order.total`, `order.customerId`,
  `order.cartId`, `order.subscriptionId`, `order.metadata` (the SaaS reads
  `plan`, `email`, `frequency_interval`)
- `order.cart.currency_code`, `order.cart.items[].unit_price`,
  `order.cart.items[].quantity`
- subscription snapshot `id`, `reference`, `status`, `frequencyInterval`,
  `frequencyValue`, `nextRenewalAt`, `cancelEffectiveAt`, `paymentMode`,
  `hasPaymentMethod`, `orderId`
- `customer_id` queries return `{ subscriptions: [ ...snapshots ] }` (an empty
  list means the customer genuinely has no subscriptions; a customer belonging
  to another tenant, or an unknown id, answers **404** instead — this endpoint
  changed from returning an empty list for both, which the webhook receiver
  could not tell apart from "nothing to reconcile")

### `POST /store/saas/renew`

`{ subscription_id }` → `{ order_id, redirect_url, total, currency_code,
reused }`. `order_id` is always present; `redirect_url` is nullable (only
redirect providers such as epay produce one). Runs the create-manual-renewal
workflow by direct typed import; payment confirmation stays with the
`payment.captured` subscriber — never here.

### `POST /store/saas/auto-renew`

`{ subscription_id, enabled: boolean }` → strictly `{ subscription_id,
payment_mode }` (`"auto" | "manual"`); the SaaS treats any body deviation as
an error. Non-boolean `enabled` or malformed ids → 400. Enabling auto on an
overdue subscription (renewal date more than 24h in the past, or `past_due`)
is rejected — the scheduler would charge immediately. A subscription whose
reference marks it as a mirror of a provider-owned recurrence (`NATIVE-…`) is
rejected with 400 as well: this call rewrites `payment_context`, and one
request would otherwise turn a row the schedulers ignore into a chargeable one.
See *Native mirror rows* in `docs/architecture/subscriptions.md`.

### `POST /store/saas/carts`

`{ customer_id, currency_code, variant_id, frequency_interval?, frequency_value? }`
(defaults month/1) → `{ cart_id, currency_code, customer_id, email }`.
Creates the cart AS the tenant customer (the store cart-create validator
rejects `customer_id`, which would strand orders as guest carts) and attaches
the subscription line metadata (`is_subscription`, `payment_mode: "manual"`,
frequency fields).

> **LOAD-BEARING placeholder address.** The cart ships with
> `first_name: "Digital", last_name: "Delivery", address_1: "N/A", city:
> "N/A", postal_code: "00000", country_code: "cn"`. The SaaS never sets
> addresses itself and cart completion depends on this placeholder — it is
> cleanup candidate in appearance only. Do not "fix" it.

### `POST /store/saas/redeem`

`{ code, customer_id, subscription_id? }` → `{ subscription_id,
subscription_reference, redemption_record_id, outcome, free_cycles_remaining,
dunning_recovered, is_trial, trial_ends_at }`. `outcome` is
`subscription_created`, `subscription_extended`, or null;
`dunning_recovered` defaults false; on the create branch the workflow carries
no `free_cycles_remaining` (it surfaces as null). `is_trial` /
`trial_ends_at` mirror the created subscription's trial state (additive since
the plan-offer trial rules landed; both neutral — false/null — for non-trial
grants). Runs the same redeem-redemption-code workflow as the
customer-scoped store route (direct typed import), so the code lock,
per-customer dedup and quota checks apply unchanged.

## Event forwarding

Every whitelisted event is re-published into the medusa-webhooks fan-out
(which signs deliveries with the endpoint's secret). Order-ish events are
enriched with `order_id`, `cart_id`, `customer_id`, `email`, plus
`display_id`, `payment_status`, `currency_code`, `total`, and `metadata`.
Forwarding failures are logged and never thrown into the event pipeline.
Amounts are informational; the reconcile endpoint is authoritative.

## Cross-repo coupling — check these on upstream syncs

An upstream reorder-js sync touching any of these can silently break the
SaaS integration; re-run the harness suite (see below) after such syncs:

1. **Cart validation** — the carts endpoint depends on what
   `createCartWorkflow` accepts (customer attachment, address requirements,
   metadata passthrough). The v2.20 validator that rejects `customer_id` on
   `/store/carts` is the reason this endpoint exists.
2. **`create-manual-renewal` workflow** — the renew endpoint calls it by
   direct typed import; renames are compile-time errors, but input/output
   shape changes (e.g. `renewal_order_id`, `redirect_url`) are contract
   changes.
3. **`redeem-redemption-code` workflow** — same: its result mapping
   (`subscription_id`, `record_id`, `outcome`, `free_cycles_remaining`,
   `dunning_recovered`) is pinned by tests.

## Deployment harness

The host repo (medusa-test) carries zero-dependency verify scripts that run
against a live store: `verify-subscription-bridge.mjs` (reconcile,
ensure-customer, renew, negative auth), `verify-webhooks.mjs` (signed
deliveries), and `verify-saas-carts-redeem-auto-renew.mjs` (carts, redeem,
auto-renew). Note the harness env loading prefers the remote config — for
local runs override the base URL explicitly.
