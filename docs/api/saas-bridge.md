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

## Failure disclosure on the three workflow-backed endpoints

`renew`, `auto-renew` and `redeem` run a workflow with `throwOnError: false` and
translate the engine's `errors` into an HTTP answer. The rule is the same on all
three, and it exists because the engine hands back a **deserialized** failure —
`{ action, handlerType, error }`, where `error` is a plain object built from the
thrown value's own properties (`message`, `name`, `type`, and for a driver error
`code`, `table`, `detail`). Nothing there is an `Error` instance, so no route may
`instanceof`-check it, and none of its text may be forwarded blindly.

- **A refusal may be repeated only when it is declared.** Each route lists the
  refusals it is allowed to quote — the step that raises them, the
  `MedusaError` type they carry, and their exact text. A declared refusal answers
  **400 `invalid_data`** with its own wording, which is the status these
  endpoints have always answered a refusal with, so a SaaS screen that shows the
  message to the end customer keeps working. The text is part of the declaration
  for *every* step, guard steps included: the engine reports a failure under the
  `action` of whatever step was running, and a guard that reads the row first can
  be reported for a driver fault the DAL converted into an `invalid_data` whose
  message names a column (`db-error-mapper.js`). Step identity alone therefore
  authorizes nothing.
- **Anything that is not a declared refusal keeps the status of the
  `MedusaError` it was thrown as, and never its text:** `not_found` → 404,
  `invalid_data` / `not_allowed` → 400, `conflict` → 409, `duplicate_error` /
  `payment_authorization_error` → 422. The body message is the route's own fixed
  string. A business rejection added later therefore arrives with its own status
  instead of being flattened into a permanent 500.
- **Everything else is a 500** (`unexpected_state`) with the route's own fixed
  string: driver and connection faults, deserialized Postgres errors,
  `database_error`, `unauthorized` / `forbidden` (the caller's identity is the
  middleware's question, never a step's), `unexpected_state`,
  `invalid_argument`, and any unrecognized shape.
- **No internal text from a failed workflow reaches a customer.** The deserialized
  value is never rethrown as it stands: `formatException` switches on `err.code`, so
  a `23505` / `23503` / `23502` that survived serialization would otherwise be
  rewritten into a 422/404/400 whose body embeds `err.table` and `err.detail`. The
  cause — step name plus the original serialized error — goes to the request logger
  instead. A `409` is the one class whose body text is not ours to choose: core
  replaces every conflict message with its own retry sentence. The rule is not
  bridge-only: `POST /store/customers/me/redemptions` runs the same redeem workflow
  and classifies it the same way, differing only in the status a declared refusal
  keeps.
- **This section covers the workflow run. The routes' own reads are covered by a
  second boundary, *Tenant-scoping read failures* below**, which is what the
  pre-workflow reads (the tenant check's `listSubscriptions` / `retrieveCustomer` /
  `listCustomers`, and `carts` / `reconcile`'s `query.graph` reads) now go through:
  a DAL fault there no longer reaches the body in `db-error-mapper`'s words. That
  gap was the *Deferred* item in
  `.agents/specs/2026-09-24-1.6.0-acceptance-fixes.md`; it is closed for these
  routes' tenant-scoping reads and for nothing else. Still core's error path: every
  admin route, the store reads that answer no tenant-scoping question, and the
  reads under `src/api/store/customers/me/**`, which §D of
  `.agents/specs/2026-09-25-post-acceptance-backlog.md` classifies and leaves there
  on purpose.

Inventories — all three owned by the workflow that composes the steps, so no
route decides on its own what may be quoted:
`AUTO_RENEW_CUSTOMER_REFUSALS` in `src/workflows/set-subscription-auto-renew.ts`,
`RENEW_CUSTOMER_REFUSALS` in `src/workflows/create-manual-renewal.ts`,
`REDEEM_CUSTOMER_REFUSALS` in `src/workflows/redeem-redemption-code.ts`. Each
entry names the step, the `MedusaError` type and the anchored copy
(`db-error-mapper.js:36-37` is why the copy is mandatory: an `undefined_column`
surfacing on a guard step's own read arrives as an `invalid_data` carrying that
step's name). The shared mechanism is `src/workflows/utils/store-step-failure.ts`;
routes must not re-implement any part of it, and each route keeps only its own
fixed response texts.

### `POST /store/saas/ensure-customer`

`{ email?, external_id?, display_name? }` (at least one of email /
external_id) → `{ customer: { id, email } }`. Idempotent per tenant; lookup
priority external_id (tenant-scoped) → email (tenant-scoped, with adoption of
unstamped customers). Pinned: `customer.id`, `customer.email`. A candidate read that
faults answers **404** `customer not found for this tenant` — the only path on which
this route answers 404; a read that legitimately finds no candidate ends in an
adopted or created customer, as before. See *Tenant-scoping read failures*.

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

This route has no workflow, and all nine of its reads — the three scoping reads and
the six that shape the response — are behind the boundary, so a fault on any of them
answers **404** with that branch's own sentence above rather than a 500 or a body
naming a table and column. See *Tenant-scoping read failures*.

### `POST /store/saas/renew`

`{ subscription_id }` → `{ order_id, redirect_url, total, currency_code,
reused }`. `order_id` is always present; `redirect_url` is nullable (only
redirect providers such as epay produce one). Runs the create-manual-renewal
workflow by direct typed import; payment confirmation stays with the
`payment.captured` subscriber — never here.

Customer-visible refusals (400, own wording): the row is a provider-managed
mirror, it is not in manual payment mode, or it is not `active`. Not repeated
verbatim, but still classified: `Renewal '…' is already processing` answers
**409** (retryable — it was a 400 before the disclosure rule), a row that
vanished between this handler's existence check and the step answers **404**, and
a subscription whose `cart_id` is missing answers **400** with the route's own
text because the message names an internal column. See *Failure disclosure*.

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

Both refusals are the only copy this endpoint repeats: they come from the
workflow's two guard steps, and each keeps its own wording at 400. Any other
failure of the write step answers the route's own fixed text — 404 if it is a
`not_found` (the row vanished after this handler validated it), 409 for a
`conflict`, 500 for a driver or connection fault. See *Failure disclosure*.

The endpoint is serialized against itself — `set-subscription-auto-renew` holds
the workflow lock `auto-renew:<subscription_id>` for the whole run, so two
concurrent calls for one subscription cannot interleave the overdue check and the
write, and a run that refuses releases the lock before it answers — while the
renewal scheduler, which locks `renewal:<renewal_cycle_id>`, is not serialized
against it: that race is the open item in §C of
`.agents/specs/2026-09-25-post-acceptance-backlog.md`, and nothing here closes it.

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

Both of this route's reads are behind the boundary: a faulting `retrieveCustomer`
answers **404** `customer not found for this tenant` — the sentence a customer
stamped for another tenant already answers with — and a faulting `region`
`query.graph` answers **404** `No region configured for currency '<code>'`, while a
currency with no region configured keeps its **400** with that same sentence. Only
the fault moved; see *Tenant-scoping read failures*.

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

Customer-visible refusals (400, own wording), all raised by
`resolve-redemption-code`: unknown or malformed code, code disabled, batch
disabled, outside the validity window, code exhausted, already redeemed by this
customer, a trial code for a returning customer, an ambiguous target
(`pass subscription_id`), "no active subscription of this variant to
extend", and a customer row the step cannot read (`Redemption customer <id>
not found` — the caller's own id, never a variant id). That last one is the
race this handler's existence check leaves open: it has already seen the row,
and the row is gone by the time the step queries it. A `customer_id` with no
row at all is answered here first, by this handler's own `retrieveCustomer`, at
**404** with this route's `redemption target not found` — that read is behind the
boundary, so core's `Customer with id '…' was not found` and the id it echoed no
longer appear here. A code the store does not know is thrown as a
`not_found` by the workflow and is still answered **400** here, which is what the
byte-compatible bridge contract does — the customer-scoped
`/store/customers/me/redemptions` route lets the domain error through untouched
and answers **404** for the same case. Anything else — a batch whose variant row
is gone, a driver fault, a core error surfacing under the same step name — keeps
the status of the `MedusaError` it was thrown as (404 / 409 / 422) or answers
500, and always with the route's own text. See *Failure disclosure*.

## Tenant-scoping read failures (all six endpoints)

Every read these six routes make goes through one wrapper, `readTenantScoped`
(`src/api/store/saas/lib/tenant-ownership.ts`) — the nineteen sites §D of
`.agents/specs/2026-09-25-post-acceptance-backlog.md` enumerates: the pre-workflow
scoping reads, `reconcile`'s response reads, and `carts`'s region lookup. Writes are
not behind it: `ensure-customer`'s `createCustomers` and its adoption
`updateCustomers` still answer a failure their own way. On success the wrapper is
`await read()`. On any throw it asks
`classifyStoreReadFailure` (`src/modules/subscription/utils/store-read-failure.ts`)
what may be disclosed, and that function consults nothing about the error: whatever
arrived, the answer is `not_found` with the fixed sentence the caller passes — the
same sentence the route already answers when the row genuinely is not there. The raw
cause is logged by the calling route (`[reorder] <context>: tenant-scoped read
failed`) and never rethrown into the response.

What a caller observes, per route:

| Route | Reads behind the boundary | A read fault now answers | What the same fault answered before |
| --- | --- | --- | --- |
| `POST /store/saas/auto-renew` | `listSubscriptions` + `retrieveCustomer` (the tenant check) | **404** `subscription not found` | 500, or a 400/422 quoting a table and column |
| `POST /store/saas/renew` | `listSubscriptions` + `retrieveCustomer` | **404** `subscription not found` | 500, or a 400/422 quoting a table and column |
| `POST /store/saas/redeem` | `retrieveCustomer` | **404** `redemption target not found` | 500 / internals-quoting 400; a customer row that is gone answered **404** with core's `Customer with id '…' was not found`, id echoed |
| `POST /store/saas/carts` | `retrieveCustomer`; `query.graph` `region` | **404** `customer not found for this tenant`; **404** `No region configured for currency '<code>'` | 500 / internals-quoting 400. A region that genuinely is not configured keeps its **400** with the same sentence — only the fault moved |
| `POST /store/saas/ensure-customer` | the two `listCustomers` candidate reads | **404** `customer not found for this tenant` — a status this route did not answer at all before, on a fault path only | 500 / internals-quoting 400. A lookup that legitimately finds no candidate is unchanged: it ends in an adopted or created customer |
| `POST /store/saas/reconcile` | all nine reads: the `order` / `subscription` / `customer` scoping reads and the six response reads | **404** with that branch's own absence sentence — `Order '<id>' not found`, `Subscription '<id>' not found`, `Customer '<id>' not found` on the three id lookups, and `order` / `subscription` / `customer` `not found for this tenant` on the tenant check and the response reads | 500 / internals-quoting 400, on any of the nine |

Through the shared helper (`assertCustomerTenantVisible`, reached from `reconcile`'s
order and subscription branches) a faulting `retrieveCustomer` answers
`<resource> not found for this tenant`, which replaces core's
`Customer with id '…' was not found` — the status was 404 either way; the wording is
what changed. The two 404s that helper authors itself (`<resource> has no customer`,
`<resource> not found for this tenant`) are unchanged in text and status: one is
thrown before anything is read, the other after the read succeeded.

**A database outage on a tenant-scoping read of these six routes now presents as a
404, not as a 500.** That is a deliberate decision, recorded as risk **R1** in §D of
`.agents/specs/2026-09-25-post-acceptance-backlog.md`: a fault must be
indistinguishable from the absence the same read answers with, so that no response
body can be probed for schema internals. The cost is that an operator reading only
the HTTP layer sees "not found" where the database is down — which is why the raw
cause is logged at the route, and why the boundary is confined to these scoping
reads. Widening `readTenantScoped` to reads that carry domain meaning turns the
masking into the incident; the reads under `src/api/store/customers/me/**` are
outside it for exactly that reason (their customer id comes from
`req.auth_context.actor_id`, so a masked 404 would deny a caller its own resource),
and so are the admin routes.

Pinned per route by the seven cases of the
`POST /store/saas/* — a tenant-scoping read fault never quotes internals` describe in
`integration-tests/http/saas-bridge.spec.ts:1538`. Each injects the
`db-error-mapper` shape into the underlying read and asserts the route's own sentence,
`type: not_found`, and that neither the canary column name nor the case's marker
substring reaches the body.

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
