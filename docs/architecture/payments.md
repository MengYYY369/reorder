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

[`@mengyyy369/medusa-paypal`](https://github.com/MengYYY369/medusa-paypal) (`pp_paypal_paypal`) is a second exercised provider: it vaults the buyer's PayPal wallet at checkout and charges the stored token off-session at renewal time.

Provider specific requirement for Stripe: the storefront must initialize the checkout payment session with `setup_future_usage: "off_session"`, otherwise Stripe does not save the card and no reusable payment method reference exists at renewal time.

Provider specific requirement for PayPal: the storefront must create the checkout payment session with `customer_id` in the session data so the provider vaults the wallet on successful capture (`store_in_vault: "ON_SUCCESS"`, usage type `MERCHANT`, associated with `customer_id` as `merchant_customer_id`). After capture the provider writes the vault token id into the session data as `payment_method`, which is exactly the reference `validate-subscription-cart` reads. Renewal sessions the scheduler creates carry that token id back to the provider, which charges it with an Orders API `payment_source.paypal.vault_id` purchase — no buyer interaction. PayPal requires RDA (risk data) on the approval flow and enables vaulting per account: reference-transaction approval, an eligibility review, and the "Save payment methods" toggle on the API application in the PayPal Developer Dashboard (sandbox included).

## Payment Context

`subscription.payment_context` is the operational record of how a subscription is charged. It is a JSON column on the subscription model with the following fields:

- `payment_provider_id`
  the Medusa payment provider used for renewals, for example `pp_stripe_stripe`
- `payment_method_reference`
  the reusable payment method identifier charged off-session at renewal time
- `customer_payment_reference`
  the customer identifier in the payment service, derived from the account holder
- `payment_mode`
  `"auto"` (charged by this plugin's off-session scheduler) or `"manual"`
  (renewals are paid through an interactive cashier link; the scheduler skips
  the row). Defaults to `"auto"` for carts that declare no mode.
- `mechanism`
  which system owns the recurrence: `"manual"`, `"reorder_auto"`, or `"native"`
  (a provider-owned subscription this row only mirrors). Written as context for
  anyone reading the record. It is **never** a query predicate: the column is
  JSON, rows predating it have no `mechanism` key, and `NULL != 'native'` is
  NULL rather than true, so filtering on it silently drops every existing row.
  Mirror rows are identified by their `NATIVE-` reference instead
  (`src/modules/subscription/utils/native-subscription.ts`).
- `source_payment_collection_id`
  the payment collection of the original checkout
- `source_payment_session_id`
  the payment session of the original checkout

`source_payment_collection_id` and `source_payment_session_id` document the original checkout. They are never rewritten after the subscription is created, including when the payment method changes.

`payment_mode` and `mechanism` change together: no path updates a stored mode and
leaves the old label standing. The rule that derives the label from the mode being
committed — `auto` → `reorder_auto`, `manual` → `manual` — is `buildPaymentModeFields`
(`src/workflows/utils/payment-mode-mechanism.ts:32-39`), and two sites call it: the
write step of the auto-renew switch
(`src/workflows/steps/set-subscription-auto-renew.ts:192-195`) and the payment-method
update, which keeps the stored mode and re-derives the label that matches it
(`src/workflows/steps/update-subscription-payment-method.ts:104-122`, the spread at
`:109`). Because the label is re-derived rather than carried over from the stored
annotation, a label that had drifted from the mode is corrected by the next write
through either of those two sites instead of surviving it.

The helper is not the only writer of the column. The paths below write the mode
themselves instead — for most of them it is a mode being minted for the first time
with its label, and for the consent flip it is a mode being changed without the
helper:

- checkout mints the payment context, and the declared mode picks the pair:
  `manual` → `manual` (`src/workflows/steps/validate-subscription-cart.ts:489-508`)
  or `auto` → `reorder_auto` (`:525-537`), where the mode is the subscription line
  item's own `payment_mode` metadata with the step's default behind it
  (`:197-200,590-601`). The context is persisted with the new row
  (`src/workflows/steps/create-subscription-record.ts:123`)
- a proven consent flip writes both in the same update that stores the token. The
  pair comes from `resolveConsentFlip`'s flip branch
  (`src/modules/subscription/utils/consent-flip.ts:128-134`) and is merged by
  `applyConsentFlip` (`:198-212`, the two assignments at `:208-209`). Two paths
  reach it: the `payment.captured` subscriber
  (`src/subscribers/payment-captured-save-payment-method.ts:160-174`, written at
  `:186-189`) and the extend decision taken during cart validation
  (`src/workflows/steps/validate-subscription-cart.ts:274-285,578-588`, written at
  `src/workflows/steps/create-subscription-record.ts:187-191,230`)
- a native mirror row is created with `manual` + `native`
  (`src/modules/subscription/utils/native-mirror-sync.ts:75-83`). This is the only
  place `native` is ever written, and the only place a `mechanism` value is not a
  function of reorder's own mode. No write that *changes* a mode can reach a mirror
  row: all three of those writers test the `NATIVE-` reference prefix before they
  write (`isNativeSubscriptionReference`,
  `src/modules/subscription/utils/native-subscription.ts`; the guards at
  `src/workflows/steps/set-subscription-auto-renew.ts:105-109`,
  `src/workflows/steps/update-subscription-payment-method.ts:68-72`, and
  `src/modules/subscription/utils/consent-flip.ts:113,117` for the flip), the flip's
  extend target is already filtered on the same predicate
  (`src/modules/subscription/utils/stacking.ts:164-168`), and the mirror's own
  reconcile update never touches `payment_context` at all
  (`src/modules/subscription/utils/native-mirror.ts:274-296`)
- a subscription created by redeeming a code is written with `payment_mode: "auto"`
  and **no** `mechanism` key at all (the constant
  `src/workflows/steps/redeem-redemption-code.ts:287-296`, spread into the trial
  context at `:298-305`, used for both the free and the trial row, written at
  `:390-392`). Redemption's extend branch changes no mode: its update names status,
  free cycles and metadata only (`:502-513`)

So the pair has one derivation rule and several writers, and a row can even be
created without the `mechanism` key at all. What that label never becomes is a
SQL or filter predicate: it is a jsonb key rows predating it do not carry, so
`payment_context->>'mechanism'` is NULL there and `NULL != 'native'` is NULL
rather than true, and an exclusion filter built on it silently returns zero rows
— see the `mechanism` bullet under Payment Context above,
`src/modules/subscription/utils/native-subscription.ts:12-21`, and the
`.agents/lessons.md` entry *Never Filter On A Missing jsonb Key*, which is the
same rule stated as a guard. It *is* read back in two places, always to carry a
value forward and never to classify a row: `resolveConsentFlip` reads the stored
label and returns it as the mechanism of every "leave the row alone" answer
(`src/modules/subscription/utils/consent-flip.ts:84,93`; the reader itself is
documented at `:178-191`), and the `payment.captured` subscriber compares it as
one of the four conditions under which it skips the write entirely
(`src/subscribers/payment-captured-save-payment-method.ts:176-184`). Both read a
row already in hand; neither turns the label into a query, and the native
question stays decided by the `NATIVE-` reference prefix.

A row that stores no mode at all is readable, and the default is the caller's
choice. Two callers state it through `readStoredPaymentMode`
(`src/workflows/utils/payment-mode-mechanism.ts:49-60`): the auto-renew switch
treats a modeless row as `"manual"`
(`src/workflows/steps/set-subscription-auto-renew.ts:118,187` — a row nobody
opted into cannot be overdue), the payment-method update as `"auto"`
(`src/workflows/steps/update-subscription-payment-method.ts:100` — the
pre-existing auto-by-default shape). Two more pick the same default inline instead
of going through the helper: the scheduler's exclusion compares
`payment_mode === "manual"` on an optional-chained read, so a row with no stored
mode stays chargeable (`src/modules/renewal/utils/scheduler-query.ts:132-136`),
and the manual-renewal hygiene job writes `?? "auto"` before comparing for
`"manual"` (`src/jobs/manual-renewal-hygiene.ts:46`). The helper is where a
caller names its default explicitly, not the only place a default is picked.

## Lifecycle

### 1. Checkout

`validate-subscription-cart` builds the payment context while completing a subscription cart.

The reusable payment method reference is resolved in this order:
1. `payment_method` on the cart payment session data
2. the most recently saved payment method of the customer's account holder for that provider

Checkout fails with a validation error when neither is available, because a subscription that cannot be renewed must not be created.

#### Consent to automatic renewals

A checkout that settles through a redirect provider is created in `"manual"`
mode, and the vaulted payment method only becomes visible on `payment.captured`.
The `payment-captured-save-payment-method` subscriber stores that token and, when
the offer declares `rules.consent_from_session`, decides there and then whether
the customer consented. The decision is the pure function `resolveConsentFlip`
(`src/modules/subscription/utils/consent-flip.ts`), and every answer that leaves
the row alone names its own reason in `skip_reason`; the subscriber logs that
reason verbatim, so "why is this row still manual" is readable from the process
log without re-running the rule:

- rule off (`null`, the default) → `consent_from_session_disabled`; the mode stays
  manual, and the customer opts in later through `POST /store/saas/auto-renew`,
  which runs the `set-subscription-auto-renew` workflow
- rule on but the payment session carries no non-empty value in the named field
  (`customer_id` today) → `consent_field_missing`; the token is still stored, the
  mode stays manual
- the row is provider-owned → `native_reference`; never flipped, because that
  would put two systems on one product. Ownership is decided the same way as
  everywhere else in the plugin, by the `NATIVE-` prefix on the subscription's own
  `reference` (`isNativeSubscriptionReference`,
  `src/modules/subscription/utils/native-subscription.ts`), which the
  `payment.captured` subscriber reads off the row it loaded
  (`src/subscribers/payment-captured-save-payment-method.ts`). It is deliberately
  **not** decided by `payment_context.mechanism`: see `mechanism` under Payment
  Context above for why that jsonb field can never be a predicate
- the row already stores `payment_mode: "auto"` → `already_auto`
- the caller named no readable row → `reference_undecidable`. `reference` is a
  required input and is typed `string | null`, so an omitted argument is a compile
  error; the runtime branch covers the case a compiler cannot see — a value that
  is neither a string nor an explicit `null`, which says nothing about ownership.
  It is answered "left alone", not "not native", because "not native" is the one
  answer that must never be reached by silence. Neither checkout path can reach it:
  the `payment.captured` subscriber passes the reference of the row it loaded, and
  the stacking decision names the row being folded into
  (`extend_subscription_reference`, `src/modules/subscription/utils/stacking.ts`),
  which is what the extend-time flip below consumes

Only when none of those applies does the row flip: `payment_mode` becomes `"auto"`
and `mechanism` becomes `"reorder_auto"` **in the same update** as the token, so no
observer can see a row with a stored method but a mode that still says manual.

A repeat purchase that folds into an existing row proves consent through the same
function, during cart validation rather than on capture, and additionally requires
the row to already hold a chargeable method
(`src/workflows/steps/validate-subscription-cart.ts`; see *Repeat purchase of the
same product* in `architecture/subscriptions.md`).

Every flip writes a `subscription.payment_method_updated` activity-log event
naming the session field the proof came from, deduped per subscription, so
"why is this charging automatically" is answerable from the audit trail.

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

Decline classification is provider agnostic and reads the `decline_code` a provider attaches to a thrown error. Codes map through the existing rules: `insufficient_funds`, `generic_decline` and `do_not_honor` are temporary; anything whose message reports a decline (PayPal's `INSTRUMENT_DECLINED` included) is permanent, because the same instrument will fail again without buyer action or a method change; unknown codes default to temporary.

## Payment Method Management

`update-subscription-payment-method` changes which payment method a subscription renews with.

Behavior:
- allowed for subscriptions in `active`, `paused` or `past_due` status
- the payment method must be a saved payment method of the subscription's own customer for the target provider, otherwise the update is rejected
- `provider_id` is optional and defaults to the subscription's current `payment_provider_id`; it is required when the subscription has no provider configured
- the step rejects a provider-owned (`NATIVE-`) row (`src/workflows/steps/update-subscription-payment-method.ts:68-72`) before it looks a payment method up at the provider (`:85-89`) and before it writes (`:102-130`), for the same reason the auto-renew switch does. It does not run first: the row is read to have a `reference` to test (`:52-54`), and the status check (`:56-62`, allowed: `active`/`paused`/`past_due`) and the `payment_method_id` presence check (`:64-66`) are both answered before the mirror rule is consulted
- `payment_provider_id`, `payment_method_reference` and `customer_payment_reference` take new values. `payment_mode` keeps the stored value (a row with no stored mode is read as `"auto"`) and `mechanism` is re-derived from it through the same pair-writer the auto-renew switch uses, so the two can never disagree; the two source identifiers of the original checkout are carried forward explicitly
- the change is recorded in `metadata.payment_method_update_context` as `{ triggered_by, updated_at }`, spread over the row's stored metadata rather than replacing it
- the step compensates by restoring the previous subscription record
- a `subscription.payment_method_updated` activity-log event records the change

The workflow does not trigger a payment retry. Retrying is an explicit action through the dunning retry routes.

## Automatic Renewal Switch

`POST /store/saas/auto-renew` changes which mode a subscription renews in
(`manual` ↔ `auto`) by running the `set-subscription-auto-renew` workflow
(`src/workflows/set-subscription-auto-renew.ts`), not by writing the row from the
request handler. The route validates the body, applies the request-bound tenant
rule, runs the workflow and shapes the response.

The workflow is three steps, and both refusals happen before anything is written:

1. `assert-subscription-auto-renew-not-native` — the write-side mirror guard, using
   the same `isNativeSubscriptionReference` predicate as every other site
2. `assert-subscription-auto-renew-not-overdue` — switching a row **on** is refused
   while it is `past_due` or its `next_renewal_at` is more than
   `AUTO_RENEW_OVERDUE_GRACE_MS` (24 hours) in the past, because the scheduler
   would charge in the same request that enabled the switch. Switching **off** is
   never refused, and a row that already stores `payment_mode: "auto"` is not
   re-checked for being overdue
3. `update-subscription-payment-mode` — the only state-changing write: it re-reads
   the row, merges the stored `payment_context`, and replaces just the mode and its
   label through `buildPaymentModeFields`. It compensates by restoring the previous
   `payment_context` verbatim

Only two failures are quoted, because only two are declared: the mirror guard and
the overdue guard, listed as `AUTO_RENEW_CUSTOMER_REFUSALS`
(`src/workflows/set-subscription-auto-renew.ts:51-62`). Each answers 400 with its
own customer-facing text.

Anything else is neither blamed on the caller nor quoted: it keeps the HTTP status
of the `MedusaError` it was thrown as, and the body carries one of the route's own
fixed strings instead (`src/api/store/saas/auto-renew/route.ts:42-46,123-145`). A
`not_found` — the row vanishing after this handler validated it
(`src/workflows/steps/set-subscription-auto-renew.ts:101-103,181-183`) — is
therefore still a 404 and a `conflict` still a 409; the preserved types and the
statuses they map to are the `PRESERVED_TYPES` table in
`src/workflows/utils/store-step-failure.ts`. Only what falls outside that table
collapses to a 500 — the fallthrough return of `classifyStepFailure` — and that
class is the one that is genuinely a fault of this plugin: driver and connection
faults, deserialized Postgres errors, `database_error`, `unauthorized`/`forbidden`,
`unexpected_state`, `invalid_argument`, an unrecognized shape. For every failure
that is not quoted, the step name and the serialized error go to the request
logger (`src/api/store/saas/auto-renew/route.ts:137-142`,
`store-step-failure.ts`'s `logUnquotedStepFailure`), so engine-reported text never
reaches the SaaS caller. The per-status contract is documented in
`api/saas-bridge.md` (*Failure disclosure on the three workflow-backed endpoints*).

A stale stored method reference is not checked here; it surfaces as a failed
renewal and a `past_due` transition on the scheduler side.

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
- `api/saas-bridge.md`
