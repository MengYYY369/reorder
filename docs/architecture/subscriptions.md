# Subscriptions Architecture

This document describes the current architecture of the `Subscriptions` area in the `Reorder` plugin.

It focuses on the implemented system, not on the initial design assumptions.

## Goal

The `Subscriptions` area provides Admin users with an operational view over recurring subscriptions.

The current implementation supports:
- listing subscriptions
- viewing subscription details
- showing subscription context on standard Medusa order details
- showing subscription discount context on standard Medusa order details
- pausing subscriptions
- resuming subscriptions
- cancelling subscriptions
- scheduling plan changes
- editing the shipping address
- changing the payment method used for renewals
- skipping the next delivery
- creating subscriptions from store carts
- customer-facing Store API for subscription account actions

See `architecture/payments.md` for how the payment context is captured, charged off-session, and changed.

## Architectural Overview

The implementation is split into five main layers:

1. domain module
2. workflows
3. admin API
4. store API
5. admin UI

Each layer has a clear responsibility:

- the domain module owns the subscription data model and persistence
- workflows own business mutations
- admin API exposes read and write endpoints for the dashboard
- store API exposes storefront-safe read and write endpoints for customer account and PDP
- admin UI renders list and detail views and calls the admin endpoints

## 1. Domain Module

The `subscription` custom module is the owner of the recurring subscription domain.

It contains:
- domain types
- data model
- service
- module export

Key design choice:
- the subscription entity stores the operational state required by Admin and future renewal flows directly in its own model
- Admin read models use live enrichment from linked customer and product records where available
- persisted snapshots remain on the subscription as operational fallback and historical context

This keeps the operational model stable while allowing Admin to show current linked customer and product data.

## 2. Data Model

The `subscription` model stores:
- identity and lifecycle fields
- cadence fields
- scheduling fields
- operational flags
- snapshots used by Admin and future renewals

Core scalar fields include:
- `id`
- `reference`
- `status`
- `customer_id`
- `product_id`
- `variant_id`
- `frequency_interval`
- `frequency_value`
- `started_at`
- `next_renewal_at`
- `last_renewal_at`
- `paused_at`
- `cancelled_at`
- `cancel_effective_at`
- `skip_next_cycle`
- `is_trial`
- `trial_ends_at`

Snapshot JSON fields include:
- `customer_snapshot`
- `product_snapshot`
- `pricing_snapshot`
- `shipping_address`
- `pending_update_data`
- `metadata`

Why snapshots are used:
- the Admin should display a stable picture of the subscription even if the linked customer or product changes later
- future renewal logic needs operational data local to the subscription
- current Admin read models use snapshot fallback when linked records are missing or unresolved

### The `metadata` jsonb column

`metadata` is one JSON object shared by several writers (`source` and
`source_order_id` from checkout, `cycles_purchased` from stacking,
`payment_method_update_context` from the payment-method update, `pause_context` from
pause, the plan-change and cancellation bookkeeping from their own steps), so what a
write does to the keys it does not mention matters:

- a write through `updateSubscriptions` **merges recursively**: keys the incoming
  object does not mention keep their stored value, and a value that is a plain
  object on both sides is merged the same way rather than swapped wholesale
  (`@medusajs/utils/dist/dal/mikro-orm/mikro-orm-repository.js:224-230` →
  `@mikro-orm/core/entity/EntityAssigner.js:106-108` →
  `@mikro-orm/core/utils/Utils.js:289-318`). Everything else — a scalar, an array, an
  empty string — is assigned over the stored value, so no key is ever dropped by
  being set to `""`
- `metadata: null` clears the whole column: the merge only runs when both the stored
  and the incoming value are plain objects, so an absent, null, or otherwise
  non-object value is assigned exactly as given
- a batch/upsert write (`upsertSubscriptions`, `upsertWithReplace`) overwrites the
  column with the object it is handed and performs no merge at this level, so a
  partial object there does lose the keys it omits. No code path in this plugin
  takes that route today
- because the outcome depends on which DAL method a caller happened to use, each
  writer of subscription `metadata` in this plugin re-reads the row and spreads the
  stored object into its own payload instead of relying on the merge: the extend
  path of `create-subscription-record`, `pause-subscription`, `resume-subscription`,
  `cancel-subscription`, `schedule-subscription-plan-change`, `skip-next-delivery`,
  `update-subscription-payment-method`, the retention and cancellation metadata
  helpers, and the mirror reconciliation in `native-mirror-sync`

Writing `metadata: null` and writing a partial object over a batch path are both
therefore ways to lose stored keys, and neither is prevented by the framework; the
spread in each writer is the prevention.

### `shipping_address` snapshot rule

`shipping_address` is NOT NULL, so every subscription carries one, but a
digital-goods purchase has nothing to fulfil. Checkout therefore decides by
**completeness** (`src/modules/subscription/utils/shipping-address.ts`):

- the cart address holds `first_name`, `last_name`, `address_1`, `city`,
  `postal_code` and `country_code` → strict snapshot, values trimmed and the
  country upper-cased
- otherwise (a region-seeded stub carrying only `country_code`, or no address at
  all) → placeholder: names from the customer record falling back to
  `Digital Delivery`, `address_1`/`city` `N/A`, `postal_code` `00000` (same
  placeholder this plugin writes for SaaS carts in `src/api/store/saas/carts/route.ts`),
  and the country from the stub or the cart region's first country

The placeholder is deliberately recognizable: a fulfillment-enabled product must
not be silently sold a subscription with no deliverable address. If neither the
address nor the region yields a country, checkout fails with an explicit error
instead of inventing one.

### Native mirror rows

A subscription the customer set up **at the payment provider** (PayPal) is not
managed by this plugin, but it must still be visible locally: checkout has to
know that the customer already pays for this product, and that question has to be
answered by an indexed local read before money moves.

The provider side is reached only through the capability view
(`providerDescriptors`, `medusa-payment-methods` ≥ 0.3.0 — the host registers one
descriptor per provider, and nothing in this repository names a provider, its key
or its protocol). Which rail a row belongs to is readable from the `kind` segment
of its reference, so a second native provider needs no change here.

Those rows are upserted by the `native-subscription-mirror` subscriber from the
rail-neutral `payment-rail.native_subscription.changed` event — a name owned by
`medusa-payment-methods`, not by this plugin and not by the provider — keyed on the
unique reference `NATIVE-{kind}-{provider_subscription_id}`, and refreshed hourly
by the `native-subscription-backfill` job (which also covers provider subscriptions
that predate the plugin, and plan swaps, by reading the provider's records through
the capability view rather than through the provider's own table).

A mirror row is **never** charged, extended or dunned by reorder:

| path | exclusion |
| --- | --- |
| off-session scheduler | `excludeNonChargeableCycles` in `src/modules/renewal/utils/scheduler-query.ts` |
| manual-renewal hygiene job | filtered out before lapsed manual rows are cancelled |
| dunning retry | permanent failure with `native_subscription`, before any charge |
| manual renewal creation | rejected |
| forced renewal (Admin) | rejected |
| `POST /store/saas/auto-renew` | refused by the `assert-subscription-auto-renew-not-native` step of `set-subscription-auto-renew`, before the write step runs |
| payment method update | rejected, for the same reason |

The toggle's own run is serialized: `set-subscription-auto-renew` acquires the
workflow lock `auto-renew:<subscription_id>` before that guard and releases it
when the run ends, so two concurrent `POST /store/saas/auto-renew` calls for one
subscription cannot interleave the guard's snapshot and the write's re-read —
while the renewal scheduler, which locks `renewal:<renewal_cycle_id>`, is not
serialized against them, and that race stays open (§C of
`.agents/specs/2026-09-25-post-acceptance-backlog.md`).

Recognition is `reference LIKE 'NATIVE-%'`, defined once in
`src/modules/subscription/utils/native-subscription.ts`. It is deliberately not
`payment_context->>'mechanism'`: that column is JSON, rows predating the field
have no such key, and in SQL `NULL != 'native'` is NULL rather than true, so an
exclusion filter built on it silently drops every existing row. `mechanism` is
still written to new rows as human-readable context.

Mirror rows carry no renewal cycle, no cart link, and an inert shipping-address
placeholder whose `N/A` country marks the row as a mirror. Their
`next_renewal_at` is whatever PayPal last reported and may be null; nothing
infers a date from the event type.

**Known limitation — a mirror moves only as far as the provider reports.** A
mirror follows the provider as far as the provider talks: the provider maps its own
states onto the four-word rail vocabulary (`active | paused | past_due |
 cancelled`) before the event is published, and the hourly pass re-reads the
provider's records through the capability view (`native.listRecords`) and refreshes
a mirror for every one of them it can map. Two properties of that pass are worth
stating exactly, because both limit what can ever clear a stale mirror:

- it asks the provider for its records through the capability view
  (`capability.native.listRecords(container)`,
  `src/modules/subscription/utils/native-mirror-sync.ts:186`), which the provider
  answers from its own local table — never from the provider's account. Reorder only
  ever reads those records and never deletes one, so a recurrence whose provider
  record keeps reporting a live status keeps its mirror live no matter what the
  provider account itself looks like
- the pass is **one-directional**: it creates and refreshes mirrors from provider
  rows and never enumerates the mirror rows already in the database against that
  set, so nothing here clears a mirror whose provider row is gone or unreadable

A provider row is also skipped rather than mirrored whenever it cannot be mapped
without guessing — a provider state with no reorder equivalent (`APPROVAL_PENDING`
is deliberately mapped to nothing, so a recurrence the customer never finished
approving cannot block a checkout), a variant that resolves to no product, or a
cadence that is not a whole positive week/month/year count
(`src/modules/subscription/utils/native-mirror.ts`).

Reorder never charges these rows, so the residue cannot bill anyone; what it can do
is refuse a checkout for a recurrence that no longer occupies the billing track. The
refusal stands on both purchase tracks — the subscription track through
`assertNoNativeRecurrence` (`src/workflows/steps/validate-subscription-cart.ts`)
and the one-time track through the completion gate below — until support cancels the
mirror row.

### Checkout completion gate

The mutual-exclusion rule has to hold for a **plain one-time purchase** too, and
such a purchase never enters this plugin's validation step (there is no
subscription line item to validate). The only place it can be refused before money
moves is the core `POST /store/carts/:id/complete` route, so the plugin registers
a method-level middleware for it:

```ts
{ matcher: "/store/carts/:id/complete", methods: ["POST"], middlewares: [rejectConflictingPurchase] }
```

Why this form and not the alternatives:

- **not a `route.ts` on the same path** — for a given `(matcher, method)` only one
  registration survives, so a plugin route there would replace the core handler
  outright.
- **not a workflow hook** — the core route runs `completeCartWorkflow` without
  hooks, and a hook can only be subscribed by the workflow that declares it.
- method-scoped middlewares land in the static bucket that preserves insertion
  order, which is registered ahead of the route for the same path, so this runs
  first and can answer before anything is written.

Behavior: the gate runs **two rail readers** beside each other and blocks on
either — the mutual-exclusion rule must hold whichever rail the existing
subscription runs on:

- live `NATIVE-` mirror rows (a provider-managed recurrence for the product
  blocks the purchase), and
- live reorder-rail rows (this plugin's own subscriptions for the product —
  the exact negation of the native reference filter). This second direction is
  what stops a customer holding a live vault subscription — or a trial — from
  buying the provider-managed plan of the same product and being charged
  twice for one product.

Ticket 12 (D12) opens exactly **one exception on the reorder rail**: when the
cart itself runs on the subscription track (`metadata.is_subscription` on a line
for the colliding product — the same boolean wording `validate-subscription-cart`
reads), a live row the engine's own `extend` stacking would fold the purchase
into no longer blocks — a live trial row (`status: ACTIVE`, `is_trial`, whether or
not it has bound a payment method) or a paid ACTIVE row carrying a provider
(`payment_context.payment_provider_id`). That purchase becomes an `extend` of the
existing row, not a second subscription. The exception is a **true subset** of the
stacking fold condition (`isFoldableReorderRailRow`), so it can never let through
a cart the engine would not fold. Everything else still blocks: a `PAUSED` row, a
redemption-shaped row with no provider (its free period ends at
`cancel_effective_at`, leaving an extension's billing undefined), a native
recurrence, and any pure one-time purchase — a cart with no subscription signal
never gets the exception.

A trial row qualifies whether or not it has bound a payment method. An earlier
version admitted only the card-free shape, on the grounds that a bound auto trial
"would double-charge against the method it already holds"; that assumed the row
keeps two independent charge dates, and it does not. The extend anchors on the
row's own `next_renewal_at` (`extendSubscriptionRenewalDate`),
`ensureNextRenewalCycleStep` reconciles the upcoming cycle onto that date by role
(`resolveUpcomingCycle`'s `adopt`, not a date-equality match), and
`process-renewal-cycle` refuses any cycle dated before `trial_ends_at` — so the
conversion charge *is* the slot the prepaid cadence moved, and the extend clears
`is_trial` / `trial_ends_at` on the way through. See the known limitation below
for the one window this does not close.

Both readers apply the **same occupying status set**, so the two directions
cannot disagree about what "already subscribed" means. An unauthenticated
request, a failed read of the customer's rows on either rail, an unreadable
cart (no cart id, no cart row, or a failing read), or a cart whose products
match none of those rows is passed through untouched. Each read failure is a
deliberate **fail-open**, and the decision sits in the pure unit
`resolveCheckoutGate` (`src/modules/subscription/utils/checkout-gate.ts`;
`src/api/store/carts/completion-gate.ts` is the thin re-export the middleware
registration imports): a rejected subscription read returns `allow` — before the
cart is loaded at all — instead of throwing, so a plugin-side failure can never hang
or 500 checkout, and the core handler runs and reports cart problems its own way. A
collision answers `400` with `{ message, type, data: { product_id, subscription_id } }` for the
**whole cart** — the plugin never edits the cart to drop the offending line,
because that would move totals, shipping and promo thresholds behind the customer's
back.

The two directions answer with **different messages**, so a log line or a
test names the rail:

- native rail: `You already have an active subscription for '<product>' managed
  by your payment provider. Change or cancel that subscription first, or remove
  this item to continue ordering.`
- reorder rail: `You already have an active subscription for '<product>' on this
  account (subscription <id>). A product can be covered by only one active
  subscription at a time, so this checkout cannot be completed.`

The reorder-rail wording stays factual on purpose: it must not promise a
self-service action the vault rail does not have yet. The structured
`data.product_id` / `data.subscription_id` payload is identical in both
directions and is what a storefront acts on.

That fail-open is bounded to the reads the rule itself needs, and the bound is part
of the rule: the product title naming the colliding item is a cosmetic input, read
only after the verdict exists and behind its own guard (`readBlockingProductTitle`),
so **a failed title read degrades the wording and never the verdict** — it falls
back to the product id, the same fallback the production reader uses
(`readProductTitle`, `src/modules/subscription/utils/native-exclusivity.ts`), and a
real collision stays a block. Hoisting that read above the decision, or widening the
decision's `try` to cover it, would answer a cosmetic failure exactly like a rule
read's failure: by letting the purchase through.

**Known limitation — an empty product title reaches the message text.** The fallback
above is for a title that cannot be read, not for one that reads back empty: the
reader substitutes the product id only when the product row is missing or its title
is `null`/`undefined`, so a product whose stored `title` is an empty string is
reported as `an active subscription for '' managed by your payment provider` — here
and in the subscription track's refusal in `assertNoNativeRecurrence`, which
interpolates the same reader. The structured `data.product_id` and the verdict are
unaffected; only the sentence is. An empty title is not blocked upstream either: the
framework's product validators type `title` as `z.string()` with no minimum length
in both the create and the update schema
(`@medusajs/medusa/dist/api/admin/products/validators.js:167`, `:207`), so `""` is a
value nothing rejects. Nothing in this repository pins either the reachability or
that wording.

**Known limitation — an in-flight renewal cycle is not moved by a prepay.**
`resolveUpcomingCycle` (`src/modules/renewal/utils/upcoming-cycle.ts`) reconciles
the subscription's upcoming cycle onto `next_renewal_at` with an `adopt`, but it
declines to adopt a row whose money is already in motion (`status: processing`, or
`generated_order_id` set) and answers `defer` instead: every row is left where it
is, and the overlap is named for an operator rather than repaired. A repeat
purchase landing in that window therefore extends `next_renewal_at` while the
in-flight cycle keeps its own date, leaving two chargeable slots for one period.
The checkout gate tolerates this on every rail it admits — a paid row carries an
in-flight order exactly as a bound trial can — so it is a property of the `defer`
branch, not of the exception above.

Two consequences follow, and neither is hypothetical:

- **no cycle lands on the new entitlement date.** `create` is the only branch that
  writes one, and `defer` is not it. A row that later turns auto-renewal on has no
  cycle for the scheduler to fire, so the renewal it was switched on for never
  happens.
- **the stranded cycle stays chargeable once the row is not in manual mode.**
  `resolveCycleDisposition` (`src/modules/renewal/utils/cycle-disposition.ts`)
  answers `not_chargeable` for a `manual` row and `charge` for anything else, and
  `process-renewal-cycle` holds no guard tying a cycle's `scheduled_for` to
  `next_renewal_at`. A stranded cycle therefore bills its own slot the moment the
  subscription is not `manual` — and turning auto-renewal on is exactly that
  transition.

`is_trial` / `trial_ends_at` do not shield this for long: `process-renewal-cycle`
refuses a cycle dated before `trial_ends_at`, but the prepay that creates the
overlap is also what clears both fields, so the shield expires with the purchase
that needed it. Resolving the overlap is the operator's job, as `defer` says:
retire the stranded cycle and let the next reconciliation create the anchor's own.
Closing the window in code needs either a refusal at the prepay boundary or a
disposition that reads the entitlement date, and is not done here.

## 3. Read Path

The read path is optimized for Admin list and detail views.

Main components:
- admin route handlers under `src/api/admin/subscriptions`
- normalization helpers in `src/api/admin/subscriptions/utils.ts`
- query helpers in `src/modules/subscription/utils/admin-query.ts`

### List Flow

For the list view:
1. the Admin UI sends query params to `GET /admin/subscriptions`
2. the admin route validates and normalizes query input
3. `listAdminSubscriptions(...)` builds filters and sorting rules
4. the query layer reads subscriptions through `query.graph(...)`
5. live customer and product display data are enriched through query-time reads with snapshot fallback
6. records are mapped to Admin DTOs used by the DataTable

Supported capabilities include:
- pagination
- search
- filtering
- sorting

Some sorting is handled in the database, while some derived fields are sorted in memory.

### Detail Flow

For the detail view:
1. the Admin UI requests `GET /admin/subscriptions/:id`
2. the route resolves the subscription through the query helper
3. the result is mapped to a detail DTO
4. the Admin detail page renders the current subscription state and pending plan change preview

Read models now expose both:
- `next_renewal_at` as the technical billing anchor used by renewal processing
- `effective_next_renewal_at` as the projected next delivery shown in Admin and Storefront when `skip_next_cycle` is enabled

## 4. Write Path

All state-changing operations are routed through workflows.

Implemented mutations:
- `pause`
- `resume`
- `cancel`
- `schedule-plan-change`
- `update-shipping-address`
- `skip-next-delivery`
- `create-subscription-from-cart`

Write path pattern:
1. the Admin UI submits a mutation to a custom admin route
2. the route validates the request payload
3. the route calls a workflow
4. the workflow performs business validation and updates the subscription
5. the route returns the refreshed subscription detail payload

This keeps business logic out of HTTP handlers.

### Store purchase flow

The store create flow uses:
- `POST /store/carts/:id/sync-subscription-pricing`
- `POST /store/carts/:id/subscribe`
- `create-subscription-from-cart`

The flow validates subscription metadata on the line item, synchronizes the cart pricing for the selected cadence, blocks mixed cart usage, completes the cart into a standard Medusa `order`, checks idempotency through the `subscription-order` link, creates the `subscription`, records a `subscription.created` activity-log event for newly created subscriptions with the storefront customer as the actor, links it to `customer`, `cart`, and `order`, and creates the first upcoming `renewal_cycle`.

### Repeat purchase of the same product

Buying a product the customer is already subscribed to **extends the existing
row** rather than opening a second one (`src/modules/subscription/utils/stacking.ts`):

- merge key `customer_id + product_id`, status `active`, excluding provider
  mirrors — keyed on the product, not the variant, so moving between variants of
  one product continues the same relationship
- `next_renewal_at` advances by the purchased cadence **from the current period
  end**, so a purchase made mid-period is added to the end rather than restarting
  the clock
- accumulated periods are counted in `metadata.cycles_purchased`, and
  `rules.max_stacking_cycles` is checked during cart validation, so a purchase
  that would exceed the ceiling is refused before any row is written
- `rules.row_stacking_policy: allow_multiple` opts an offer out of all of the
  above and keeps one row per purchase

The extension links the new order to the row it extended, which is what keeps a
replayed order from stacking the row a second time. The row keeps its **original
source cart**: the manual renewal flow builds renewal orders from that cart, and
the subscription↔cart link is one-to-one, so a repeat purchase adds an order link
and leaves the cart link alone.

An extension that proves auto-renew consent (`rules.consent_from_session`) also
switches the row to automatic charging — but only when that row **already holds a
chargeable payment method**. On a fresh row the method has not come back from a
redirect provider yet, and a mode the scheduler can act on with nothing to charge
is worse than staying manual; that case is flipped later, at `payment.captured`.

### Trial shapes, and who owns recurrence

A "trial" reaches a customer through three different arrangements, and the
difference that matters operationally is **who owns the recurrence**:

| shape | created by | payment state at creation | recurrence owner |
| --- | --- | --- | --- |
| **card-free** (claimed) | `POST /store/customers/me/trials` with `binding: "none"`, or a trial-enabled redemption code | `payment_mode: manual`, no provider id, no method reference | this plugin |
| **bound** (claimed, then bound) | the same claim with `binding: "vault"`, completed through the two-phase bind endpoint | `payment_mode: auto`, a real provider id and a vault id | this plugin |
| **native PayPal** | the storefront's native path (a variant carrying `paypal_subscription` metadata) | PayPal's own subscription, mirrored locally as a `NATIVE-` row | PayPal |

The claim endpoint is the self-service door (`POST /store/customers/me/trials`,
`{ variant_id, region_id, binding? }`). It copies the redemption path's payment
shape — no order and no payment — and adds the template cart (Q18a): a cart in
the requested region holding one line for the variant, with `completed_at` set
after creation. The cart is never completed and never paid; it exists only
because every charge path in the plugin refuses a subscription without a cart,
and the conversion branch is one of them. The claim creates the subscription
`payment_mode: manual` with `trial_ends_at = now + trial_days`,
`next_renewal_at = trial_ends_at`, and the initial renewal cycle at that date.

**Binding is `vault`, and only `vault`.** A claimed trial becomes bound through
`POST /store/customers/me/trials/:id/bind`, deliberately two-phase because the
customer leaves for PayPal and comes back:

- `{ action: "start", return_url, cancel_url }` asks the provider for a setup
  token and answers `{ phase: "approval_pending", approve_url, … }`. The token
  id is parked as `metadata.trial_binding`; nothing chargeable changes, and a
  later start replaces an abandoned pending approval.
- `{ action: "complete", setup_token_id }` exchanges the approved setup token
  for a vault id and lands the binding in one pass: the real registered
  provider id **and** the vault id as `payment_context.payment_method_reference`
  (both are required by the charge gate), `payment_mode: auto`, `trial_ends_at`
  extended by the offer's `trial_bonus_days` **anchored on `started_at`**
  (binding on day 5 lands on the same date binding on day 1 would have), and
  the open scheduled cycle re-pointed through `ensureNextRenewalCycleStep`.

There is no `provider_subscription` binding value: a provider-managed
subscription never passes through the claim endpoint, so no door could produce
one. The native rail is **not** a third binding method — it is a different
product/variant reached through the storefront's existing native path, and its
trial length stays in the variant metadata (`paypal_subscription.trial_periods`)
rather than in the offer rules: a PayPal plan is immutable and cached by a hash
that includes `trial_periods`, so the offer must never become its source.

#### The native rail's operational signature is the opposite, on purpose

The two shapes this plugin manages and the native rail produce different
operational signatures for the same word, "trial". The difference is ownership
of recurrence, and each line below is deliberate — a reader who meets only the
native rail will otherwise read the missing events as broken wiring:

| operational signal | card-free (claimed) | bound (claimed) | native PayPal |
| --- | --- | --- | --- |
| `renewal.upcoming` / `subscription.trial_ending` reminders | yes | yes | **never** |
| `renewal.succeeded` / `renewal.failed` | no `renewal.succeeded` — the cycle finishes with no order and the trial ends with `subscription.expired` | yes, once the trial converts | **never** — PayPal bills its own cycle |
| dunning (`dunning.*` events) | n/a (nothing to charge) | yes — a payment-qualified conversion failure starts dunning | **never** — PayPal owns recovery |
| exit | auto-renew toggle, or customer-finalized cancellation | customer-finalized cancellation, or toggle | provider cancellation only |

The reminder job excludes `NATIVE-` rows explicitly
(`src/jobs/emit-renewal-reminders.ts`) rather than relying on the mirror writer
leaving `is_trial: false`; a future mirror change must not start mailing
provider-trial customers a reminder this plugin has no business sending. The
same rail split is why the offer form displays a native variant's trial values
read-only beside the offer's own (`docs/admin/plan-offers.md`).

### Trial eligibility: one claim per customer and product

The rule is: **no prior subscription for this product, on any rail, at any
status, and no prior claim.** `TrialClaimModuleService.assertEligible` checks
both halves before anything is created:

- a `trial_claim` ledger row for the (`customer_id`, `product_id`) pair, or
- any `subscription` row for that customer and product — any rail (`NATIVE-`
  provider mirrors included), any status (a `cancelled` row still counts).

The ledger is the race-safe anchor. `trial_claim` carries a unique index on
(`customer_id`, `product_id`), partial on `deleted_at IS NULL` (the repo's
soft-delete convention), so two concurrent claims for the same pair cannot both
win no matter which door each came through, and because the constraint lives on
a table this feature owns, no webhook-driven mirror write can collide with it.
A losing insert surfaces as the same typed refusal the pre-check produces. The
subscription half reads the `subscription` table's own `customer_id` /
`product_id` columns — deliberately not the `subscription_product` link table,
whose links are created only by the redemption path and would silently pass
every customer who bought the plan through checkout.

Every door that can create a trial writes one ledger row:
`POST /store/customers/me/trials` (`source: self_service`), a trial-enabled
redemption code (`source: redemption`), and — if an admin create door is ever
built — `source: admin`. The row survives the trial's cancellation: a customer
who cancels a trial and comes back cannot claim it again.

The store offer DTO exposes the verdict per customer:
`subscription_offer.trial.eligible` with a `reason` (`trial_not_offered`,
`authentication_required`, `already_claimed_or_subscribed`,
`eligibility_unavailable`), so the storefront never renders a trial button the
claim endpoint would refuse. The endpoint's refusal is the backstop against a
client that calls it anyway; an ineligible claim creates nothing — no
subscription, no cart, no ledger row (there is no degradation branch).

Admin visibility is a read-only ledger list: `GET /admin/trial-claims` filtered
by `customer_id`, `product_id` and `source`.

### Trials and trial end

A subscription carries `is_trial` and `trial_ends_at` (trials are configured
through offer rules — `trial_days` and friends — and are created by checkout,
by a redemption code, or by the self-service claim above). The trial end is
deterministic on both payment rails:

- the scheduler's due query excludes manual-mode subscriptions **except** a
  trial whose cycle is at or after `trial_ends_at` — the one manual cycle it
  picks up, so the trial-end branch runs on time instead of the subscription
  lingering until the 90-day manual-hygiene cancellation. The branch itself
  never charges a manual subscription.
- at that cycle the engine applies a three-way decision:

| condition | behaviour |
| --- | --- |
| `payment_mode` is `auto` **and** a usable payment method is on file | **Convert.** The cycle falls through to the normal order/charge path for the period starting at `trial_ends_at`. A payment-qualified failure starts dunning exactly like any renewal, so the customer can repair their card. The subscription's cart is a hard prerequisite of that path. |
| anything not `auto` (manual mode, or rows predating the field) | **End.** Cancel with `cancel_effective_at = trial_ends_at`, cycle `succeeded` with no order, and `subscription.expired` persisted **and** emitted with a reason naming the manual rail. |
| `auto` but no usable method | **End** the same way, with an alertable reason — expected when the offer's `trial_requires_payment_method` rule is on, a configuration gap when it is off. |

Two guards make the convert row safe, and both refuse **before any order is
created**, so a structurally unchargeable subscription fails without minting
anything:

1. the subscription's `cart_id` must exist (the renewal-order builder reads the
   cart's region, channel, currency and items);
2. the payment context must carry a provider **and** a stored method reference
   whenever the cart still prices a line. This check sits **ahead of order
   creation** — historically it sat after the order workflow, and each retry
   then minted one orphan order per attempt. A subscription with no payment
   context is loudly refused, with zero orders created, instead of producing a
   free order and "succeeding".

A cycle that fails structurally is retried a bounded number of times and then
abandoned (`renewals.md`). **An abandoned cycle leaves the subscription
`past_due`.** No job cancels the subscription: the plugin emits
`renewal.abandoned` and the host application decides what happens to the
customer relationship. `past_due` is therefore a state a subscription can sit
in indefinitely, by design.

### `trial_requires_payment_method`

The per-offer rule (default **OFF**) is enforced at every door that can create a
trial:

- **Checkout:** when the rule is ON, a trial checkout that is not in `auto`
  payment mode is rejected — only an auto-mode checkout will vault a usable
  method. The check is on the *mode*, not on a stored token: at checkout the
  reusable token does not exist yet (it is written when the payment is
  captured).
- **Redemption:** a redemption code whose offer turns the rule on is **refused
  outright** (`Redemption code <code> grants a trial that requires a payment
  method, which redemption codes cannot collect`). The redemption door has no
  cart and no way to collect a payment method, so silently degrading the grant
  to a non-trial subscription was rejected — it would make the offer's rule a
  lie.
- **Claim:** a card-free claim (`binding: "none"`) is refused; the request must
  name `binding: "vault"` to take such a trial
  (`This trial requires binding a payment method. Send binding: "vault" to
  claim it.`).

Because the rule ships OFF by default, no existing offer changes behaviour on
upgrade.

### Leaving a trial

Every shape has a working exit, and the two managed shapes differ in which exit
is the short one:

- **card-free trial** — the **auto-renew toggle is sufficient on its own**. A
  manual-mode subscription is outside the scheduler's chargeable set, and the
  trial-end branch never charges a manual subscription (it ends the trial
  deterministically with `subscription.expired`). This is not "the cycle is
  excluded from the scheduler": the manual trial's trial-end cycle *is*
  processable by design, so the guarantee is the branch's decision, not the due
  query's filter. The second exit is the customer-finalized cancellation.
- **bound trial** — the **customer-finalized cancellation** is the direct
  exit: `POST /store/customers/me/subscriptions/:id/cancellation/finalize`
  finalizes the customer's own open cancellation case. `finalizeCancellationStep`
  writes `next_renewal_at: null` and the workflow runs
  `ensureNextRenewalCycleStep`, which deletes every `SCHEDULED` cycle once the
  subscription is cancelled — so cancelling during a trial leaves no scheduled
  cycle, no charge at `trial_ends_at`, and no `renewal.failed`. The auto-renew
  toggle also works: disabling it puts the row back on the manual rail, where
  the trial-end branch ends the trial.
- **native PayPal trial** — only the provider can cancel it; the plugin's
  mirror row follows the provider's events (see *Native mirror rows*).

The finalize route is keyed by subscription id while the workflow takes a
`cancellation_case_id`; the route resolves the customer's own open case for
that subscription first, using the same ownership helper as every other
`/store/customers/me/*` route. `POST .../cancellation` (which opens the
retention case) is untouched: finalizing is an explicit second step the
customer may take after opening a case, so the retention flow stays an option
rather than a gate. A subscription with no open case answers `404`, and a case
that can no longer be finalized answers `409`.

Pricing synchronization is handled by a dedicated workflow:
- load subscription line items from the cart
- resolve effective `Plans & Offers` config for the selected cadence
- apply or remove the manual line-item adjustment
- refresh cart items, taxes, and payment collection before checkout continues

Current adjustment semantics:
- adjustment identity uses `provider_id = "subscription_discount"`
- adjustment description is `Subscription discount`
- adjustment amount is stored tax-inclusive
- cart adjustments intentionally avoid `code`, so Medusa promotion flows do not treat them as promo codes

### Store customer account flow

The current store account flow uses:
- `GET /store/customers/me/subscriptions`
- `GET /store/customers/me/subscriptions/:id`
- `POST /store/customers/me/subscriptions/:id/pause`
- `POST /store/customers/me/subscriptions/:id/resume`
- `POST /store/customers/me/subscriptions/:id/change-frequency`
- `POST /store/customers/me/subscriptions/:id/change-address`
- `POST /store/customers/me/subscriptions/:id/skip-next-delivery`
- `POST /store/customers/me/subscriptions/:id/swap-product`
- `POST /store/customers/me/subscriptions/:id/retry-payment`
- `POST /store/customers/me/subscriptions/:id/cancellation`
- `POST /store/customers/me/subscriptions/:id/cancellation/finalize`
- `POST /store/customers/me/trials`
- `POST /store/customers/me/trials/:id/bind`

These routes:
- require customer auth
- validate ownership against the authenticated customer
- reuse existing workflows where possible
- return storefront-safe DTOs instead of admin detail contracts
- expose projected read-model fields such as `effective_next_renewal_at`
- expose `scheduled_plan_change` when a pending plan update already exists

### Store PDP offer flow

The current PDP offer flow uses:
- `GET /store/products/:id/subscription-offer`

The route resolves effective `Plans & Offers` config with `variant > product` precedence and returns storefront-safe offer data for PDP pricing and cadence selection.

## 5. Workflows

Workflows are the mutation boundary of the `Subscriptions` area.

They are responsible for:
- validating legal state transitions
- updating subscription lifecycle fields
- updating pending plan change data
- updating shipping address data
- returning a consistent subscription result back to the API layer

The route layer remains thin and orchestration-focused.

## 6. Admin API Architecture

The Admin API exposes custom routes dedicated to the `Subscriptions` pages.

Implemented read routes:
- `GET /admin/subscriptions`
- `GET /admin/subscriptions/:id`
- `GET /admin/trial-claims` (read-only list of the `trial_claim` ledger, filtered by `customer_id`, `product_id`, `source`)

Implemented mutation routes:
- `POST /admin/subscriptions/:id/pause`
- `POST /admin/subscriptions/:id/resume`
- `POST /admin/subscriptions/:id/cancel`
- `POST /admin/subscriptions/:id/schedule-plan-change`
- `POST /admin/subscriptions/:id/update-shipping-address`

The API layer uses:
- Zod validators
- authenticated admin requests
- query helpers for reads
- workflows for writes

## 7. Store API Architecture

The Store API exposes custom storefront routes dedicated to:
- subscription checkout
- customer account subscription list and detail
- customer account subscription actions
- PDP subscription offer resolution

Implemented read routes:
- `GET /store/customers/me/subscriptions`
- `GET /store/customers/me/subscriptions/:id`
- `GET /store/products/:id/subscription-offer`

Implemented mutation routes:
- `POST /store/carts/:id/sync-subscription-pricing`
- `POST /store/carts/:id/subscribe`
- `POST /store/customers/me/subscriptions/:id/pause`
- `POST /store/customers/me/subscriptions/:id/resume`
- `POST /store/customers/me/subscriptions/:id/change-frequency`
- `POST /store/customers/me/subscriptions/:id/change-address`
- `POST /store/customers/me/subscriptions/:id/skip-next-delivery`
- `POST /store/customers/me/subscriptions/:id/swap-product`
- `POST /store/customers/me/subscriptions/:id/retry-payment`
- `POST /store/customers/me/subscriptions/:id/cancellation`
- `POST /store/customers/me/subscriptions/:id/cancellation/finalize`
- `POST /store/customers/me/trials`
- `POST /store/customers/me/trials/:id/bind`

The Store API layer uses:
- customer authentication middleware
- storefront-specific DTO mapping
- workflow-backed mutations
- ownership checks before mutation execution

### Tenant-scoping read failures

The six `/store/saas/*` routes decide tenant visibility with their own reads
(`listSubscriptions`, `retrieveCustomer`, `listCustomers`, `query.graph`) before any
workflow runs, and every one of those reads is made through `readTenantScoped`
(`src/api/store/saas/lib/tenant-ownership.ts`). What a failure of such a read may
disclose is decided by the pure `classifyStoreReadFailure`
(`src/modules/subscription/utils/store-read-failure.ts`), which reads nothing from
the error it is given: the answer is always `not_found` with the fixed sentence the
caller passes — the sentence the same route already answers when the row genuinely
is not there — while the raw cause is logged by the route. A DAL fault that
`db-error-mapper` turns into an `invalid_data` naming a table and column therefore
cannot reach a customer body from these routes.

Two consequences belong to this design and are stated as such: a database outage on
a tenant-scoping read of `/store/saas/*` presents as a **404**, and a customer row
that is gone answers with the route's own sentence rather than core's
`Customer with id '…' was not found`. The first is §D's risk **R1** in
`.agents/specs/2026-09-25-post-acceptance-backlog.md`, accepted deliberately for
scoping reads only, because a fault that reads differently from an absence is a
probeable difference. The boundary is therefore not applied to the customer-account
routes under `src/api/store/customers/me/**`, whose reads take the customer id from
`req.auth_context.actor_id`: masking their failure as a 404 would deny an
authenticated caller a resource it owns. Admin routes and store reads that answer no
tenant-scoping question are core's error path for the same reason. Per-route statuses
are in `docs/api/saas-bridge.md` (*Tenant-scoping read failures*).

## 8. Admin UI Architecture

The Admin UI is implemented as custom Medusa Admin routes.

Current screens:
- subscriptions list page
- subscription detail page

It also extends the built-in Medusa `Order detail` page with a widget that resolves the `subscription_order` link and renders subscription status plus a link to the linked subscription.

### List Page

The list page is built with Medusa `DataTable`.

It supports:
- pagination
- search
- filters
- sorting
- row actions
- row navigation to detail

Data loading follows the Medusa pattern:
- the display query always loads on mount
- modal and drawer queries are separate from the main display query

### Detail Page

The detail page contains:
- subscription overview
- customer and product information
- shipping address
- pending plan change preview
- top-right action menu

It also provides two edit flows through Drawers:
- schedule plan change
- edit shipping address

This matches the Medusa pattern of using Drawers for editing existing data.

## 9. Query Invalidation Strategy

The Admin UI uses explicit query invalidation after mutations.

After a successful mutation:
- the subscriptions list query is invalidated
- the subscription detail query is invalidated

This ensures that:
- the detail page stays fresh after edits
- the list reflects the latest status after navigation back

## 10. Error and Loading Handling

The `Subscriptions` UI follows Medusa-style state handling:
- list pages use DataTable loading and empty states
- detail pages show explicit loading and error states
- drawers show local loading and error states for modal-only data

This avoids coupling the main display state to drawer-only data loading.

## 11. Testing Strategy

The area is covered by:
- module/service tests
- workflow and query integration tests
- admin HTTP integration tests
- scenario-based admin flow integration test

Important note:
- there is no browser E2E layer in the current plugin
- the main end-to-end business flow is verified through Medusa-supported integration tests

## 11. Boundaries of Responsibility

`Subscriptions` currently owns:
- the subscription entity
- Admin operational management of subscriptions
- pending plan changes
- shipping address updates
- lifecycle materialization for `active`, `paused`, `past_due`, and `cancelled`
- lifecycle fields such as `paused_at`, `cancelled_at`, `cancel_effective_at`, and `next_renewal_at`

It does not yet own:
- offer definition and subscription configuration rules
- renewal execution
- payment recovery and dunning
- cancellation and retention process state
- retention recommendation state
- retention offer history
- churn reason classification workflow

Those concerns are intentionally left for later areas:
- `Plans & Offers`
- `Renewals`
- `Dunning`

The implemented `Cancellation & Retention` area now adds a separate process layer on top of the subscription lifecycle.

Current boundary with `Cancellation & Retention`:
- `Subscription` remains the source of truth for lifecycle state
- `CancellationCase` remains the source of truth for cancellation and retention process state
- `RetentionOfferEvent` remains the source of truth for concrete retention-offer history

This means:
- `paused` and `cancelled` may be materialized by cancellation workflows
- but those workflows materialize into `Subscription`, they do not replace it as the lifecycle owner
- final cancel sets `cancel_effective_at`
- final cancel clears `next_renewal_at`
- retained outcomes do not set `cancel_effective_at`

## 12. Why This Structure

This architecture keeps the system practical:
- reads are optimized for Admin operations
- writes are centralized in workflows
- UI state is separated cleanly from domain logic
- future renewal and dunning logic can build on the same subscription core without rewriting the Admin layer
