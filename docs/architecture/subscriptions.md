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

Those rows are upserted by the `paypal-subscription-mirror` subscriber from
`paypal.subscription.*` events, keyed on the unique reference
`NATIVE-{paypal_subscription_id}`, and refreshed hourly by the
`native-subscription-backfill` job (which also covers provider subscriptions
that predate the plugin, and plan swaps until `paypal.subscription.revised`
exists).

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
mirror follows the provider as far as the provider talks:
`paypal.subscription.cancelled` and `paypal.subscription.expired` move the row to
`cancelled`, and the hourly pass re-reads the provider module's own
`paypal_subscription` rows and refreshes a mirror for every one of them it can map.
Two properties of that pass are worth stating exactly, because both limit what can
ever clear a stale mirror:

- it reads the provider module's **local table** through the query layer
  (`loadProviderSubscriptionRecords`,
  `src/modules/subscription/utils/native-mirror-sync.ts`), never the provider
  account. Reorder only ever reads that table and never deletes a row from it, so a
  recurrence whose local row keeps reporting a live status keeps its mirror live no
  matter what the provider account itself looks like
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

Behavior: an unauthenticated request, a failed read of the customer's live
`NATIVE-` rows, an unreadable cart (no cart id, no cart row, or a failing read), or
a cart whose products match none of those rows is passed through untouched. Each
read failure is a deliberate **fail-open**, and the decision sits in the pure unit
`resolveCheckoutGate` (`src/modules/subscription/utils/checkout-gate.ts`;
`src/api/store/carts/completion-gate.ts` is the thin re-export the middleware
registration imports): a rejected subscription read returns `allow` — before the
cart is loaded at all — instead of throwing, so a plugin-side failure can never hang
or 500 checkout, and the core handler runs and reports cart problems its own way. A
collision answers `400` with `{ message, type, data: { product_id, subscription_id } }`
for the **whole cart** — the plugin never edits the cart to drop the offending line,
because that would move totals, shipping and promo thresholds behind the customer's
back.

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

The Store API layer uses:
- customer authentication middleware
- storefront-specific DTO mapping
- workflow-backed mutations
- ownership checks before mutation execution

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
