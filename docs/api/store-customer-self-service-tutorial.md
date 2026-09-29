# Store Customer Self-Service Tutorial

This tutorial is written for frontend developers building the subscription
portal inside the SaaS application. It explains how the portal reaches the
plugin's customer-facing Store API, what each action does, and where the
boundaries are — including the actions that do **not** exist.

It documents implemented behaviour only. Every endpoint described here is
shipped in this plugin; nothing in the *Not supported* section is planned
behind the scenes.

The endpoints live under `/store/customers/me/*` in the reorder plugin:

| # | Endpoint | Purpose |
|---|----------|---------|
| 1 | `GET /store/customers/me/subscriptions` | List the customer's subscriptions |
| 2 | `GET /store/customers/me/subscriptions/:id` | Subscription detail |
| 3 | `POST /store/customers/me/subscriptions/:id/pause` | Pause |
| 4 | `POST /store/customers/me/subscriptions/:id/resume` | Resume |
| 5 | `POST /store/customers/me/subscriptions/:id/skip-next-delivery` | Skip the next renewal |
| 6 | `POST /store/customers/me/subscriptions/:id/change-frequency` | Change the cadence |
| 7 | `POST /store/customers/me/subscriptions/:id/swap-product` | Swap to another variant of the same product |
| 8 | `GET /store/customers/me/subscriptions/:id/payment-methods` | List saved payment methods |
| 9 | `POST /store/customers/me/subscriptions/:id/payment-method` | Change the payment method used for renewals |
| 10 | `POST /store/customers/me/subscriptions/:id/retry-payment` | Retry a failed renewal payment |
| 11 | `POST /store/customers/me/subscriptions/:id/cancellation` | Request cancellation (opens a case) |
| 12 | `POST /store/customers/me/subscriptions/:id/cancellation/finalize` | Finalize your own open cancellation case |
| 13 | `GET` / `POST /store/customers/me/redemptions` (+ `/preview`) | Redemption codes |
| 14 | `POST /store/customers/me/trials` | Claim a card-free trial |
| 15 | `POST /store/customers/me/trials/:id/bind` | Bind a payment method to a claimed trial (two-phase) |

Two more read routes exist beside this set: `GET /store/products/:id/subscription-offer`
(pricing/cadence data for the product page) and the checkout routes under
`/store/carts/:id/*` (see `store-subscription-checkout.md`). They are not part
of the portal's account area and are not covered here.

## 1. Forwarding a customer identity

Every route in the table above is registered with
`authenticate("customer", ["session", "bearer"])` (see the middleware groups in
`src/api/middlewares.ts` and the per-area files under
`src/api/store/customers/me/*/middlewares.ts`). Medusa accepts a request as an
authenticated customer through two mechanisms, and the two have different
operational consequences for a portal that lives inside another application.

Both mechanisms additionally require the standard store header
`x-publishable-api-key` on every call.

### Session authentication (cookie)

1. The browser calls Medusa's core auth route, e.g.
   `POST /auth/customer/emailpass` with `{ email, password }`.
2. Follow it with `POST /auth/session` while carrying the returned token —
   core converts the verified identity into an HTTP session and sets the
   session cookie (`connect.sid` by default).
3. The browser then calls the portal with credentials included, and the
   session cookie reaches Medusa.

Consequences:

- The cookie is `HttpOnly`; JavaScript cannot read it, it must simply be
  forwarded untouched by whatever proxies the browser's request to Medusa.
- The session does not expire on a short clock the way a JWT does — it lives
  as long as the server-side session — so there is no refresh machinery.
- `DELETE /auth/session` logs the customer out.
- This is the natural fit when the portal's backend proxies browser requests
  to Medusa (or when portal and Medusa share a parent domain so the cookie
  flows directly).

### Bearer authentication (JWT)

1. The portal (browser or its backend) calls
   `POST /auth/customer/emailpass` with `{ email, password }` and receives
   `{ token }` — a JWT whose lifetime comes from Medusa's
   `http.jwtExpiresIn` configuration.
2. Every subsequent call carries `Authorization: Bearer <token>` plus the
   publishable key header.

Consequences:

- The token expires. When it does, routes start answering `401` and the
  portal must re-authenticate with the customer's credentials. Core's
  `POST /auth/token/refresh` re-mints a token, but it authenticates with the
  current JWT first — so it works only while the token is still valid
  (proactively, not after a `401`) — and once a token has expired the only
  path is a fresh `POST /auth/customer/emailpass`. Build the portal around a
  `401` from any `/store/customers/me/*` call.
- A token is a credential in its own right: it must not be logged, must not
  be embedded in URLs, and a server-side portal holds it per customer, never
  shared.
- This is the natural fit when the portal's backend already knows the
  customer's Medusa credentials (or mints a token through a dedicated
  integration) and wants stateless calls.

### What the plugin itself does with the identity

The plugin derives the customer id exclusively from the authenticated
identity — `req.auth_context.actor_id` (see `requireStoreCustomer` in
`src/api/store/customers/me/subscriptions/utils.ts`). There is no
`customer_id` parameter and no way to act on behalf of another customer by
passing an id.

Ownership is enforced by filtering every read with `customer_id = actor_id`
and by re-reading the row through that filter before every mutation. A
subscription that exists but belongs to someone else answers **`404`
not_found**, not `403` — the API deliberately does not reveal that the id
exists. Build the portal's "not found" and "not yours" handling as the same
case.

An unauthenticated request (expired token, missing session) answers `401`
before any route code runs.

## 2. Reading state: list and detail

### `GET /store/customers/me/subscriptions`

Returns the customer's subscriptions, newest first.

```json
{
  "subscriptions": [
    {
      "id": "sub_01J...",
      "reference": "SUB-RDM-...",
      "status": "active",
      "created_at": "2026-09-01T10:00:00.000Z",
      "product_title": "Pro plan",
      "variant_title": "Monthly",
      "frequency_interval": "month",
      "frequency_value": 1,
      "next_renewal_at": "2026-10-01T10:00:00.000Z",
      "effective_next_renewal_at": "2026-11-01T10:00:00.000Z",
      "payment_mode": "auto",
      "has_payment_method": true,
      "active_cancellation_case": null
    }
  ]
}
```

- `effective_next_renewal_at` is the projected renewal date the customer
  experiences: when `skip_next_cycle` is set, this is the date after the
  skipped period while `next_renewal_at` stays the technical billing anchor.
- `payment_mode` is `"auto"` or `"manual"` (`null` only for rows created
  before the field existed).
- `has_payment_method` says whether a chargeable payment method is on file.
- `active_cancellation_case` is `{ id, status }` when a cancellation is in
  progress (statuses `requested`, `evaluating_retention`, `retention_offered`)
  and `null` otherwise.

**The list route is unpaginated.** There are no `limit`/`offset` parameters;
the response always contains every subscription the customer holds. A
customer's subscription count is small by construction, but the portal should
not build pagination UI on this endpoint.

Error cases: `401` (no/invalid customer identity). There is no empty-vs-not
distinction beyond the empty array.

### `GET /store/customers/me/subscriptions/:id`

The detail payload is the render model for the whole portal page:

```json
{
  "subscription": {
    "id": "sub_01J...",
    "reference": "SUB-...",
    "status": "past_due",
    "product_id": "prod_01J...",
    "variant_id": "variant_01J...",
    "product_title": "Pro plan",
    "variant_title": "Monthly",
    "frequency_interval": "month",
    "frequency_value": 1,
    "skip_next_cycle": false,
    "next_renewal_at": "2026-10-01T10:00:00.000Z",
    "effective_next_renewal_at": "2026-10-01T10:00:00.000Z",
    "last_renewal_at": "2026-09-01T10:00:00.000Z",
    "shipping_address": { "first_name": "Jane", "city": "Copenhagen" },
    "payment_status": "recovery_required",
    "payment_provider_id": "pp_stripe_stripe",
    "payment_method": { "id": "pm_123", "brand": "visa", "last4": "4242" },
    "payment_recovery": {
      "dunning_case_id": "dcase_01J...",
      "state": "retry_scheduled",
      "retry_eligible": true,
      "attempt_count": 1,
      "max_attempts": 3,
      "next_retry_at": "2026-09-29T15:00:00.000Z",
      "last_error_code": "insufficient_funds",
      "last_error_message": "Your card was declined.",
      "last_attempt_status": "failed"
    },
    "active_cancellation_case": null,
    "scheduled_plan_change": null,
    "scheduled_frequency_change": null,
    "available_frequencies": [
      { "frequency_interval": "month", "frequency_value": 1, "label": "Every month" },
      { "frequency_interval": "year", "frequency_value": 1, "label": "Every year" }
    ]
  }
}
```

Notes on the fields the portal builds UI from:

- `payment_method` is the resolved card summary of the method the
  subscription renews with (best effort: a removed method or an unreachable
  provider yields `null`, never an error). Card fields are provider-dependent
  and may be `null`.
- `scheduled_plan_change` and `scheduled_frequency_change` are two views of
  the same pending update (`pending_update_data`): the first includes the
  target variant, the second only the cadence. Exactly one of them is set
  when a change is pending; both are `null` when nothing is scheduled.
- `available_frequencies` comes from the active plan offer for the product
  and is the authoritative option set for the change-frequency action.
- `shipping_address` is the delivery snapshot — there is no billing address
  anywhere in this payload (see *Not supported*).

Error cases: `401` unauthenticated; `404` unknown id **or** a subscription
the customer does not own (indistinguishable by design).

## 3. The mutation actions

All mutation routes follow one contract:

- Request bodies are small, optional-heavy objects validated by Zod schemas
  (`src/api/store/customers/me/subscriptions/validators.ts`). Unknown or
  malformed fields answer `400 invalid_data`.
- The route validates ownership **before** running the workflow (`404` for a
  foreign or unknown subscription).
- On success the route re-reads the subscription and answers **the same
  detail payload as `GET .../:id`**, so the portal can replace its render
  model with the response body without a second request.
- Timestamps in request bodies are ISO-8601 datetime strings.

### `POST .../pause`

```json
{ "reason": "Taking a break", "effective_at": "2026-10-05T00:00:00.000Z" }
```

Both fields optional (`reason` up to 500 chars). Pausing stops future
renewal charges; the scheduler will not select cycles of a paused
subscription.

Errors: `409 conflict` when the subscription is not in a pausable state
(e.g. already paused or cancelled) — the workflow raises
`Subscription '<id>' can't pause from status '<status>'`.

### `POST .../resume`

```json
{ "resume_at": "2026-10-05T00:00:00.000Z", "preserve_billing_anchor": true }
```

Both fields optional. Errors: `409` when the subscription is not `paused`
(the only status resume works from).

### `POST .../skip-next-delivery`

No request body. Sets `skip_next_cycle`; `next_renewal_at` in the response
stays the technical anchor while `effective_next_renewal_at` moves out by one
cadence — render the effective date. Errors: `409` when the next cycle is
already skipped (`Subscription '<id>' already has the next cycle skipped`).
There is **no un-skip** (see *Not supported*).

### `POST .../change-frequency`

```json
{ "frequency_interval": "month", "frequency_value": 2 }
```

`effective_at` optional. The pair must be allowed by the active offer —
`available_frequencies` from the detail payload is the option set. The
current variant is unchanged. Errors: `400` when the frequency is not allowed
by the offer; the change lands as a pending update that applies at the next
renewal (it appears as `scheduled_frequency_change` / `scheduled_plan_change`
in the response).

### `POST .../swap-product`

```json
{
  "variant_id": "variant_01J...",
  "frequency_interval": "month",
  "frequency_value": 1
}
```

Despite the route name, this is a **variant swap within the same product**:
the target variant must belong to the subscription's own product. Errors:
`400` when the variant belongs to another product (`Variant '<id>' does not
belong to subscription product '<productId>'`) or no active offer configures
that variant/frequency. Like change-frequency, the swap schedules a pending
change that applies at the next renewal; the response's
`scheduled_plan_change` reflects it. **No price is surfaced and none is
confirmed** — the portal cannot show "you will be charged X" from this
endpoint (see *Not supported*).

### `GET .../payment-methods`

Lists saved payment methods of the customer with the subscription's provider:

```json
{
  "payment_provider_id": "pp_stripe_stripe",
  "payment_methods": [
    { "id": "pm_123", "brand": "visa", "last4": "4242", "is_current": true }
  ]
}
```

`payment_provider_id` is `null` when the subscription has no payment context
yet, and the list is empty when there is nothing saved. `is_current` marks
the method the subscription currently renews with. This endpoint is the data
source for the change-payment-method picker. Errors: `404` unknown/foreign
subscription.

Saving a *new* payment method is a storefront/provider concern (see
`store-subscription-payment-methods.md`); these routes only select among
already-saved methods.

### `POST .../payment-method`

```json
{ "payment_method_id": "pm_123" }
```

`provider_id` optional (defaults to the subscription's current provider; required
when the subscription has none). Allowed for `active`, `paused` and
`past_due` subscriptions. It records a `subscription.payment_method_updated`
activity-log event and does **not** trigger a payment by itself. Errors:
`400` unknown method or method not owned by the customer; `409` when the
subscription status disallows the change (native provider-managed mirror
rows are always rejected).

### `POST .../retry-payment`

```json
{ "reason": "Card fixed, try again" }
```

Runs one dunning retry against the failed renewal order, immediately
(`ignore_schedule`). There must be an active recovery case in a retryable
state. On success the response is the refreshed detail — if the retry
recovered the payment, `payment_status` is `"ok"`, `payment_recovery` is
`null` and `status` is back to `"active"`.

Errors:

- `404` — subscription unknown or not owned by the customer.
- `409 conflict` — the subscription has no active payment recovery case, or
  the case is mid-retry/closed (`retrying`, `recovered`, `unrecovered`). Use
  `payment_recovery.retry_eligible` to decide whether to render the retry
  button; a `409` after a rendered button is a stale-state race, not a bug.
- Provider-side failures of the retry itself surface as workflow errors that
  the route maps to `404` / `400` / `409` by message class; the detail
  payload in `payment_recovery` (last error, next retry) is the source of
  truth for what happened.

### `POST .../cancellation`

```json
{
  "reason": "Too expensive",
  "reason_category": "price",
  "notes": "Customer used the portal"
}
```

`reason` required; `reason_category` (`price`, `product_fit`, `delivery`,
`billing`, `temporary_pause`, `switched_competitor`, `other`), `notes` and
`metadata` optional. This **opens a cancellation case** — it does not cancel the subscription. The response is the case, not
a subscription detail:

```json
{
  "cancellation_case": {
    "id": "ccase_01J...",
    "status": "requested",
    "subscription_id": "sub_01J...",
    "reason": "Too expensive",
    "reason_category": "price",
    "notes": "Customer used the portal",
    "created_at": "2026-09-29T12:00:00.000Z",
    "updated_at": "2026-09-29T12:00:00.000Z"
  }
}
```

While the case is open it appears as `active_cancellation_case` in list and
detail. The portal should treat "cancellation requested" as a pending state:
the subscription remains `active` (and keeps renewing) until the case is
finalized — by the customer through the action below, or by an operator.

### `POST .../cancellation/finalize`

The customer's own exit. No request body: the route resolves the customer's
open cancellation case for this subscription and finalizes it through the same
workflow the Admin route uses.

```json
{
  "cancellation_case": {
    "id": "ccase_01J...",
    "subscription_id": "sub_01J...",
    "status": "canceled",
    "final_outcome": "canceled",
    "cancellation_effective_at": "2026-09-29T12:00:00.000Z"
  }
}
```

The subscription becomes `cancelled` immediately (this is not a scheduled
cancellation), `next_renewal_at` is cleared, and the pending renewal cycle is
deleted — no further charge and no `renewal.failed` event. Errors:

- `401` — no customer identity.
- `404` — the subscription is unknown or not owned, **or** it has no open
  cancellation case to finalize. Opening a case first
  (`POST .../cancellation`) is required.
- `409 conflict` — the case can no longer be finalized (already finalized, or
  the subscription status disallows cancellation). The reason recorded when
  the case was opened is reused; there is no body to re-state it.

This is a separate step on purpose: `POST .../cancellation` still opens the
retention case and never finalizes by itself, so the retention flow stays an
option the customer may engage with rather than a gate they must pass.

### Redemption codes

`GET /store/customers/me/redemptions` lists the customer's redemptions;
`POST /store/customers/me/redemptions` redeems a code against the customer's
subscription, and `POST /store/customers/me/redemptions/preview` previews a
code without consuming it. All three require the customer identity — a guest
cannot redeem (see *Not supported*). Error cases and the workflow's refusal
vocabulary are documented in `store-redemptions.md`.

### Trials: claiming and binding

A trial is offered per product through the offer rules, and the product page's
`GET /store/products/:id/subscription-offer` answers whether **this** customer
can claim it. `subscription_offer.trial` carries `is_enabled`, `days`,
`requires_payment_method`, `bonus_days`, `eligible`, `reason` and
`binding: { method, supported }`. Render the trial CTA only when
`trial.eligible` is `true`; `reason` is one of `trial_not_offered`,
`authentication_required`, `already_claimed_or_subscribed`,
`eligibility_unavailable`. The rule behind it: a customer can take a trial for
a product once — no prior subscription for that product on any rail at any
status, and no prior claim.

#### `POST /store/customers/me/trials` — claim a card-free trial

```json
{ "variant_id": "variant_01J...", "region_id": "reg_01J...", "binding": "none" }
```

`region_id` is required: the template cart's region fixes the currency of every
future renewal order, so the variant must be priced there. `binding` defaults
to `"none"` (card-free); send `"vault"` to claim the trial already intending to
bind a payment method. When the offer's `trial.requires_payment_method` is
true, a card-free request is refused
(`This trial requires binding a payment method. Send binding: "vault" to claim
it.`).

Response `201`:

```json
{
  "trial": {
    "subscription_id": "sub_01J...",
    "subscription_reference": "SUB-TRIAL-...",
    "trial_ends_at": "2026-10-13T10:00:00.000Z",
    "cart_id": "cart_01J...",
    "claim_recorded": true
  }
}
```

The claim creates no order and takes no payment. The subscription then appears
in the normal account payloads as an `active` subscription with
`next_renewal_at = trial_ends_at`; the list's `payment_mode` is `"manual"` for
a card-free claim and `"auto"` after a successful binding. Keep the returned
`trial_ends_at`: the account payloads do not carry a trial marker (see *Not
supported*).

Error cases:

- `401` — no customer identity.
- `400 invalid_data` — the product has no trial (`This product does not offer a
  trial.`), the payment-method rule refuses a card-free claim, the variant is
  not priced in the region, the product has no configured renewal frequency, or
  the region is unknown.
- ineligible — `Trial has already been claimed for customer <id> and product
  <id>`; nothing is created (no subscription, no cart, no claim record) on any
  refusal.

#### `POST /store/customers/me/trials/:id/bind` — bind a payment method

Two phases, because the customer leaves for PayPal and comes back:

1. `{ "action": "start", "return_url": "<absolute URL>", "cancel_url":
   "<absolute URL>" }` →
   `{ "bind": { "phase": "approval_pending", "setup_token_id": "...",
   "approve_url": "...", "trial_ends_at": "..." } }`.
   Redirect the customer to `approve_url`; nothing chargeable has changed yet.
   A later `start` replaces an abandoned approval.
2. `{ "action": "complete", "setup_token_id": "<the one start returned>" }` →
   `{ "bind": { "phase": "bound", "payment_provider_id": "...",
   "payment_method_reference": "...", "trial_ends_at": "...",
   "next_renewal_at": "...", "bonus_days_applied": 7, "payment_mode": "auto" } }`.

   On success the trial is extended by the offer's `trial_bonus_days`
   (`bonus_days_applied`), **anchored on the trial's start** — binding on day 5
   produces the same end date as binding on day 1 — and the subscription
   switches to automatic renewal, so it will be charged when the trial ends.

Errors: `401` unauthenticated; `404` unknown or foreign subscription; `400`
when the subscription is not an active trial, already has a bound method, has
no pending approval (complete without start), the setup token does not match
the pending approval, or the PayPal approval is not complete yet (`The payment
method approval is not complete yet (status '...')`); `400 not_allowed` when
the installed PayPal provider does not ship the vault capability, or the
PayPal provider is not declared on the payment module. `binding.supported` in
the offer DTO tells the portal whether the capability is present — hide the
bind-and-extend control when it is `false`.

#### Leaving a trial

- **Card-free trial:** switching auto-renew off is sufficient on its own — a
  manual trial is never charged when it ends; it expires at `trial_ends_at`.
  The cancellation actions below work too.
- **Bound trial:** `POST .../cancellation` then
  `POST .../cancellation/finalize` cancels it; nothing is charged at
  `trial_ends_at` and the pending renewal cycle is deleted. Disabling
  auto-renew also works.
- **Provider-managed (native PayPal) trials** are not in this API at all: they
  live at PayPal and the storefront's native path handles their cancellation. A
  `NATIVE-` mirror row is visible in the list, but every reorder-side write
  (payment method, auto-renew, retry) is rejected for it.

## 4. Building the "payment failed" banner and the retry affordance

Everything the portal needs is already in the detail (and list) payload. No
event, webhook, or polling channel beyond these fields is required — the
plugin emits `renewal.failed` and the `dunning.*` lifecycle events on the
event bus (see `saas-bridge.md`), but a customer portal does not need them:
reading the detail is authoritative and simpler.

### When to show the banner

Show a payment-problem banner when the detail payload has
`payment_status === "recovery_required"`. That flag is `true` when either:

- `status === "past_due"` (a renewal charge failed and the subscription is
  overdue), or
- an open dunning case exists in state `open`, `retry_scheduled`,
  `retrying`, or `awaiting_manual_resolution`.

Otherwise `payment_status` is `"ok"` and no banner is warranted.

### What the banner says

`payment_recovery` is `null` exactly when there is nothing to recover; when
set it carries:

| Field | Use |
|-------|-----|
| `state` | The dunning case status — renders the pipeline stage (`open` → `retry_scheduled` → `retrying` → `recovered`/`unrecovered`, with `awaiting_manual_resolution` meaning "operator will take over") |
| `retry_eligible` | Whether the customer can trigger a retry **right now** |
| `attempt_count` / `max_attempts` | "Retry 1 of 3" |
| `next_retry_at` | When the next automatic retry runs — "we'll try again on …" |
| `last_error_code` / `last_error_message` | The most recent decline, for the banner text |
| `last_attempt_status` | Outcome of the most recent attempt |

A minimal banner: "Your last payment failed
(`<last_error_message>`). We will retry automatically on
`<next_retry_at>` (attempt `<attempt_count>` of `<max_attempts>`)."

When `retry_eligible` is `true`, render the retry affordance:

- Button: **Retry payment now** → `POST .../retry-payment` with an optional
  reason.
- On success: replace the page model with the response body. If the retry
  recovered the payment the banner disappears by itself
  (`payment_status === "ok"`, `payment_recovery === null`, `status ===
  "active"`). If the retry failed again, the refreshed
  `payment_recovery` carries the new error and the next `next_retry_at`.
- When `retry_eligible` is `false` but the case is active, render the
  schedule instead of the button — the case is mid-retry or parked for an
  operator.
- Pair the banner with the payment-method picker when
  `payment_method` is `null` or the customer reports a dead card: the
  recovery flow is "pick a working saved method" (`POST .../payment-method`)
  and then "retry now" (`POST .../retry-payment`). The retry reads the
  subscription's payment context at retry time, so it charges the newly
  selected method.

The plugin never cancels a subscription because payments failed — an
exhausted recovery leaves the subscription `past_due` with the cycle
abandoned and emits `renewal.abandoned` to the host, and the host decides
what happens to the customer relationship (see `dunning.md`). The banner
should not promise cancellation or write-off either way; it reflects the
dunning state only.

## 5. Not supported

These are deliberate boundaries of the customer-facing API. Do not build UI
that promises them, and do not look for hidden parameters — the capability
does not exist server-side.

- **Accepting a retention offer.** A customer can open a cancellation case and
  can finalize it themselves (`POST .../cancellation/finalize`), but applying a
  retention offer is an Admin action. The portal can show
  `active_cancellation_case.status` and explain that the request is being
  handled, with the finalize action as the customer's own way out.
- **No trial marker on the account payloads.** `is_trial` and `trial_ends_at`
  are not exposed by the subscription list/detail routes; the portal learns a
  trial's end date from the claim or bind response (`trial.trial_ends_at`).
- **No un-skip.** Once the next delivery is skipped there is no API to
  un-skip it; `skip_next_cycle` clears only when the skipped period elapses
  or an Admin acts.
- **No undo of a scheduled change.** A pending plan/frequency change
  (`scheduled_plan_change` / `scheduled_frequency_change`) cannot be
  cancelled or edited once scheduled; it applies at the next renewal.
  Scheduling a *new* change replaces the pending one — that is the only
  customer-side lever.
- **No reactivate.** A `cancelled` subscription is terminal; there is no
  resume or re-subscribe-from-existing-row endpoint. Renewal means a new
  purchase.
- **No past-charges view.** No endpoint exposes the customer's renewal
  orders or invoices; the portal has nothing to render a billing history
  from.
- **No billing address.** Only the shipping address exists
  (`POST .../change-address` updates `shipping_address`); the payload has no
  billing address field, and one cannot be added customer-side.
- **Swap is same-product variant only, and no price is surfaced or
  confirmed.** `swap-product` refuses variants of other products, and its
  request/response carry no price — the portal cannot display the new price
  for confirmation before scheduling the swap. (The product page's
  `GET /store/products/:id/subscription-offer` is the only pricing surface
  and is not tied to an existing subscription.)
- **Guest redemption is unsupported.** The redemption routes sit under
  `/store/customers/me/*` and require a customer identity; there is no
  anonymous redemption path. (The SaaS bridge's `/store/saas/redeem` is a
  server-to-server endpoint behind the bridge secret, not a customer-facing
  fallback.)
- **The list route is unpaginated.** No `limit`/`offset` exist on
  `GET /store/customers/me/subscriptions`.

## 6. Status vocabulary reference

Subscription statuses the portal will encounter: `active`, `paused`,
`past_due`, `cancelled`. Dunning case states (in `payment_recovery.state`):
`open`, `retry_scheduled`, `retrying`, `awaiting_manual_resolution`,
`recovered`, `unrecovered`. Cycle-level states (`scheduled`, `processing`,
`succeeded`, `failed`, `abandoned`, `awaiting_manual_resolution`) are **not**
exposed on store routes — the customer sees their consequences through
`status` and `payment_recovery` only.

## Related documents

- `api/store-customer-cancellations.md` — the per-route contract for the
  subscription actions
- `api/store-subscription-payment-methods.md` — payment method routes and
  the recovery flow
- `api/store-redemptions.md` — redemption codes
- `api/saas-bridge.md` — the event stream a SaaS host can subscribe to
  instead of polling
- `architecture/dunning.md` — what the recovery machinery does behind
  `payment_recovery`
- `architecture/subscriptions.md` — the domain model behind the payloads
