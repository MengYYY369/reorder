# Subscription Relationship Model

> **Status:** implemented behavior of the **1.6.0 series** (tickets `reorder 05-09`
> and `12`). Every field and rule described below exists in `src/`, and each
> statement names the file it was written from. Where a piece is deliberately not
> implemented, the sentence says so and names what stands in for it until then.

This document defines the relationship between the three payment tracks a
storefront can offer for a subscription-enabled product:

- **One-time payment** — a single charge at checkout, optionally with
  auto-renew consented (checkbox).
- **Auto-renew** — the consented renewal mechanism: reorder charges the saved
  payment method at each `next_renewal_at`.
- **Native PayPal subscription** — PayPal Billing owns the recurring charges;
  reorder only mirrors the subscription.

It is the follow-up to `plan-offers.md` (which covers offer configuration).
The behavioral rules are implemented in the checkout validation step
(`src/workflows/steps/validate-subscription-cart.ts`), the record write
(`src/workflows/steps/create-subscription-record.ts`), the pure decision units
under `src/modules/subscription/utils/`, the PayPal event bridge
(`src/subscribers/paypal-subscription-mirror.ts`) and its reconciliation job
(`src/jobs/native-subscription-backfill.ts`).

Documentation split: this document covers the relationship rules (R1-R5) and the
three rule fields (`consent_from_session`, `row_stacking_policy`,
`max_stacking_cycles`); the full rules set
(`minimum_cycles`, `trial_*`, and `stacking_policy` as discount stacking) lives
in `plan-offers.md`.

## Concepts

**One-time payment = an entitlement grant.** Paying once adds the purchased
period to the customer's coverage window. It is *not* a second subscription and
never creates a duplicate row for the same product.

**Auto-renew and native subscription = mutually exclusive billing mechanisms.**
A subscription row carries exactly one mode, and the shape it is recorded in is
the `payment_context` jsonb column:

```ts
// src/modules/subscription/types/index.ts:74-82
type SubscriptionPaymentContext = {
  payment_provider_id: string | null
  payment_mode: SubscriptionPaymentMode            // "manual" | "auto"
  mechanism?: "manual" | "reorder_auto" | "native" // optional: see below
  source_payment_collection_id: string | null
  source_payment_session_id: string | null
  payment_method_reference: string | null
  customer_payment_reference: string | null
}
```

- `payment_mode` is the field the schedulers read: `auto` charges the stored
  method off-session, `manual` waits for an interactive cashier payment.
- `mechanism` is a label that says the same thing to whoever reads the row. It is
  written together with the mode and derived from the mode being committed, never
  carried over from the stored annotation — but `buildPaymentModeFields`
  (`src/workflows/utils/payment-mode-mechanism.ts:32-39`) is that rule only for the
  two sites that rewrite a stored mode; it is not the only writer of the pair.
  Checkout mints it with the new row
  (`src/workflows/steps/validate-subscription-cart.ts:489-508,525-537`), the consent
  flip writes both values itself
  (`src/modules/subscription/utils/consent-flip.ts:130-131`, merged at `:208-209`),
  and the mirror mints `manual` + `native`
  (`src/modules/subscription/utils/native-mirror-sync.ts:77-78`). The full write-side
  census is in `payments.md` (*Payment Context*).
  It is **optional on the type and never a query predicate**: `payment_context` is
  a nullable jsonb column, so for every row persisted before the label existed
  `payment_context->>'mechanism'` is NULL, `NULL != 'native'` is NULL rather than
  true, and an exclusion filter built on it silently drops every existing row
  (`src/modules/subscription/utils/native-subscription.ts:10-21`, and the
  `.agents/lessons.md` entry *Never Filter On A Missing jsonb Key*). It is read back
  in two places and only ever to carry a value forward: `resolveConsentFlip` echoes
  the stored label on every "leave the row alone" answer
  (`src/modules/subscription/utils/consent-flip.ts:84,93`), and the `payment.captured`
  subscriber compares it as one of the four conditions under which it skips the write
  (`src/subscribers/payment-captured-save-payment-method.ts:176-184`). No path
  classifies a row from it — native-ness is the reference prefix. And because every
  write that *changes* a mode derives the label from the mode being committed (the
  payment-method update re-derives it even while keeping the stored mode,
  `src/workflows/steps/update-subscription-payment-method.ts:106-109`), a row created
  without a `mechanism` key gets a correct one from the first mode change or
  payment-method update it survives, instead of being interpreted at read time.
- **A provider-owned row has no `native_subscription_id` field.** Identity is two
  values on the row itself:
  - `reference` = `NATIVE-{paypal_subscription_id}`
    (`NATIVE_SUBSCRIPTION_REFERENCE_PREFIX` and `buildNativeSubscriptionReference`,
    `src/modules/subscription/utils/native-subscription.ts:23,40-50`; built from the
    event at `src/modules/subscription/utils/native-mirror.ts:141`; written at
    `src/modules/subscription/utils/native-mirror-sync.ts:50`). `reference` is
    `model.text().unique()` (`src/modules/subscription/models/subscription.ts:10`),
    so the prefix test is exact, indexable, and cannot be silently NULL.
  - the provider's own id, stored verbatim in
    `payment_context.customer_payment_reference`
    (`src/modules/subscription/utils/native-mirror-sync.ts:82`), alongside
    `payment_mode: "manual"` and `mechanism: "native"` (`:77-78`).

  The prefix is the only thing any of the exclusions test
  (`isNativeSubscriptionReference`, `src/modules/subscription/utils/native-subscription.ts:28-33`).

## Rules

### R1 — Grants extend in place

A one-time payment for a product the customer already holds extends the
existing active row's `next_renewal_at` by the purchased period (the new
variant's frequency), from the date the current period already ends at
(`extendSubscriptionRenewalDate`,
`src/modules/subscription/utils/stacking.ts:175-189`). No second row is created
for the same product; the merge key is `customer_id + product_id`, deliberately
not the variant (`src/modules/subscription/utils/stacking.ts:11-21`). If no row
exists, a new row is created (`resolveExtendTarget`, `:152-173`). The write itself
touches only the subscription row — date, cadence, snapshots, metadata
(`src/workflows/steps/create-subscription-record.ts:164-243`).

The extension is bounded by `rules.max_stacking_cycles`: when the accumulated
extension would exceed the cap, `validateSubscriptionCartStep` refuses the
purchase with `invalid_data` before anything is written
(`src/workflows/steps/validate-subscription-cart.ts:238-243`). Accumulated cycles
are counted in `metadata.cycles_purchased`
(`STACKING_CYCLES_METADATA_KEY`, `src/modules/subscription/utils/stacking.ts:23-24`),
and `null` means unlimited (`:218-228`).

One-time stacking only applies to *subscribable* products — those with an
enabled plan-offer; the pre-existing `planChangeNotAllowed` validation is
unchanged (`src/workflows/steps/validate-subscription-cart.ts:206-208`).

Because a stacked purchase moves the entitlement date, the upcoming renewal cycle
follows it rather than being appended: `ensure-next-renewal-cycle` reconciles the
rows the subscription already carries, and a partial unique index makes a second
live `SCHEDULED` row impossible to write. That is R1's other half and it is
documented in `renewals.md` (*The one-upcoming-cycle invariant*).

### R2 — Consent flips manual → auto

When the source payment session carries the field configured by
`rules.consent_from_session` (`"customer_id"` today,
`src/modules/subscription/utils/consent-flip.ts:35-38`), the row flips
`payment_mode: manual → auto` with `mechanism → reorder_auto` **in the same
update** the payment method is persisted (no polling window) — the decision is the
pure function `resolveConsentFlip` (`:81-135`) and the merged context is
`applyConsentFlip` (`:198-212`). The flip is recorded on the subscription log as a
`subscription.payment_method_updated` event naming the session field the proof came
from (`src/subscribers/payment-captured-save-payment-method.ts:233,242-246`).
Every answer that leaves the row alone carries its own `skip_reason`
(`consent_from_session_disabled`, `reference_undecidable`, `native_reference`,
`already_auto`, `consent_field_missing`; `:66-79`), and the subscriber logs it
verbatim (`:194-196`).

Two moments can prove consent, and each is handled where the method is in hand:
a redirect-provider checkout persists the vaulted method on `payment.captured`
and flips there (`src/subscribers/payment-captured-save-payment-method.ts`); a
repeat purchase that folds into an existing row flips during validation, and only
when that row already holds a chargeable method
(`src/workflows/steps/validate-subscription-cart.ts:274-285`) — flipping a row with
nothing to charge would hand the scheduler a mode it cannot act on.

Neither path flips a native mirror row, and neither decides native-ness from
`mechanism`: `reference` is a **required** input of `ConsentFlipInput`
(`src/modules/subscription/utils/consent-flip.ts:40-64`), so a caller that omits it
does not compile, and a value that is neither a string nor an explicit `null` is
answered `reference_undecidable` — left alone, not "not native" — because "not
native" is the one answer that must never be reached by silence (`:102-111,168-170`).
The extend path carries the real reference from the stacking decision
(`extend_subscription_reference`, `src/modules/subscription/utils/stacking.ts:116-128`).

Later, the customer can also change the mode themselves through
`POST /store/saas/auto-renew`, which runs the `set-subscription-auto-renew`
workflow; its native guard refuses a mirror row before anything is written
(`src/workflows/steps/set-subscription-auto-renew.ts:91-121`). See `payments.md`
(*Automatic Renewal Switch*).

### R3 — Native subscription is exclusive

While a native row for the same product is `active` or `paused`
(`TRACK_OCCUPYING_NATIVE_STATUSES`,
`src/modules/subscription/utils/native-subscription.ts:70-73`), the customer may
not buy that product again from the other track: both the *one-time +
auto-renew* combination and a **plain one-time purchase** are refused (400, "one
payment track per product at a time"), and the message points to the
switch-subscription flow (R5). `cancelled` and `past_due` rows do not block, so a
customer whose provider charge just failed can still buy the period themselves
(`:61-69`).

There is no per-offer switch for this. An earlier draft had
`allow_auto_renew_with_native`; under strict exclusion it would only allow two
live recurrences on one product with different billing dates — the exact failure
R1/R4 exist to remove — so the field was dropped rather than implemented.

Enforcement is split, because the two purchase paths share no validation step:

| purchase | refused by |
| --- | --- |
| subscription checkout | `assertNoNativeRecurrence`, `src/workflows/steps/validate-subscription-cart.ts:253-256,540`, before its payment-mode branch (the one-time path never reaches it) |
| plain one-time checkout | `rejectConflictingPurchase`, `src/modules/subscription/utils/checkout-gate.ts:276-303`, a method-level middleware on the core `POST /store/carts/:id/complete` registered at `src/api/middlewares.ts:37-39` |

Both read the same predicate, the `NATIVE-%` reference pattern pushed down with the
customer and the track-occupying statuses
(`findLiveNativeRecurrences`, `src/modules/subscription/utils/native-exclusivity.ts:27-40`,
and `findBlockingNativeRow`, `src/modules/subscription/utils/native-subscription.ts:89-106`);
never a `payment_context->>'mechanism'` comparison, whose NULL-versus-NULL
behaviour would silently exclude every pre-existing row.

The one-time gate **fails open**: every failure of the reads the rule needs is
answered "let the request through", so a plugin-side read failure can neither hang
nor 500 checkout (`src/modules/subscription/utils/checkout-gate.ts:122-156`). The
verdict is final before the cosmetic product-title read, which is behind its own
guard (`:166-175`), so a title that cannot be read degrades the wording and never
the block. See `subscriptions.md` (*Checkout completion gate*).

### R4 — Cross-plan rows

`rules.row_stacking_policy: "allow_multiple"` permits separate rows for
different plans/offers — it short-circuits the fold-in before any row is read
(`src/modules/subscription/utils/stacking.ts:160-162`). The same product is still
bound by R1: `extend` never holds two rows.

### R5 — Native re-purchase requires cancellation first; plan changes switch in place

An existing active native subscription for the product rejects a *new* native
(subscription-payment) purchase with a clear 400 ("cancel the current
subscription first"). **Reorder implements no part of this refusal**: a native
purchase is a provider-side flow, and nothing in `src/` sees it. The consequence
inside this repository is that the mirror is keyed purely on the provider's own
subscription id (`src/modules/subscription/utils/native-mirror-sync.ts:42-49`), so
if a second provider recurrence for one product ever existed upstream it would
arrive as a second mirror row with a different `reference` — not as a conflict.

Changing plan/frequency within the same product uses PayPal's native **revise**
endpoint instead (the *switch subscription* flow): the same subscription is revised
in place — no cancel, no new subscription — and the new price takes effect at the
next billing cycle (no proration). On the reorder side this is **not implemented
yet and is blocked externally**: `paypal.subscription.revised` is subscribed to
(`src/modules/subscription/utils/native-mirror.ts:56-65`) but refused at build time
until medusa-paypal 0.5.0 emits it with the plan and frequency fields the mirror
needs (`:153-160`, reason `revised_not_supported_until_paypal_0_5_0`). What
actually keeps a mirror honest meanwhile is the hourly reconciliation pass, which
reads the provider module's local `paypal_subscription` rows and, when a row's
plan id differs from the one recorded on the mirror, updates `metadata.plan_id` and
`plan_changed_at` and logs a warning
(`src/modules/subscription/utils/native-mirror-sync.ts:99-118`). Because the
subscription stays ACTIVE upstream, no cancelled/activated events fire.

## Native mirror rows

The event bridge subscribes to the paypal plugin's lifecycle events
(`PAYPAL_SUBSCRIPTION_EVENT_NAMES`: `activated`, `suspended`, `resumed`,
`revised`, `cancelled`, `expired`, `payment_succeeded`, `payment_failed`;
`src/modules/subscription/utils/native-mirror.ts:56-65`) and upserts read-only
mirror rows (`src/subscribers/paypal-subscription-mirror.ts`):

- every row is built from the payload alone. `customer_id`, `product_id`,
  `variant_id`, `frequency_interval` and `frequency_value` are required to exist
  (`MIRROR_BUILD_FIELDS`, `:122-128`) and the frequency must be a whole positive
  week/month/year count (`readFrequency`, `:192-219`); anything else is skipped
  with its reason logged rather than written with a guessed value. The mirror
  never derives product or frequency from reorder's own plan or offer data: every
  field a row needs comes from the event payload (`:9-21`), the plan id is the
  provider's own (`record.paypal_plan_id`, `:255`, read from medusa-paypal's
  `paypal_subscription` row, whose shape is declared at `:221-238`), and the
  backfill maps such a row through `buildNativeMirrorFieldsFromRecord`
  (`:244-267`), which takes `product_id` from the caller precisely because the
  provider row knows only the variant (`:240-243`)
- `status` maps PayPal's five states onto reorder's four; `EXPIRED` becomes
  `cancelled`, and `APPROVAL_PENDING` maps to nothing at all so a recurrence the
  customer never approved cannot block a checkout
  (`STATUS_BY_PAYPAL_STATE`, `:80-86`, its reason comment at `:76-78`);
  `payment_failed` forces `past_due` and
  `expired` forces `cancelled` whatever the payload says (`:102-115`)
- `next_renewal_at` is only ever what the provider last reported and may be null;
  no date is inferred from the event type, and an update leaves out a date the
  event did not carry rather than overwriting a real one with null
  (`nativeMirrorReconcileFields`, `:269-296`)
- renewal, dunning and collection skip mirror rows, and so do the two paths that
  rewrite `payment_context`. Every one of those exclusions tests the same
  reference predicate: the scheduler
  (`src/modules/renewal/utils/scheduler-query.ts:131`), the manual-renewal hygiene
  job (`src/jobs/manual-renewal-hygiene.ts:45`), manual renewal creation
  (`src/workflows/steps/create-manual-renewal.ts:122`), forced renewal
  (`src/workflows/steps/force-renewal-cycle.ts:68`), dunning retry
  (`src/workflows/steps/run-dunning-retry.ts:430`), the auto-renew switch
  (`src/workflows/steps/set-subscription-auto-renew.ts:105`), the payment-method
  update (`src/workflows/steps/update-subscription-payment-method.ts:68`), and the
  extend target (`src/modules/subscription/utils/stacking.ts:164-168`)
- the upsert is idempotent — it is keyed on the unique `reference`, so a replayed
  event or an out-of-order delivery cannot produce two rows for one PayPal
  subscription (`src/modules/subscription/utils/native-mirror-sync.ts:27-49`)
- existing provider subscriptions are covered by a scheduled reconcile pass rather
  than a one-off script: `native-subscription-backfill` runs once an hour
  (`src/jobs/native-subscription-backfill.ts`, `config.schedule = "17 * * * *"`),
  because subscriptions created before this plugin was installed never re-emit
  their `activated` event (`:8-22`)
- the pass is **one-directional**: it creates and refreshes mirrors from provider
  rows and never enumerates the mirror rows already in the database against that
  set, and it reads the provider module's *local* table
  (`loadProviderSubscriptionRecords`,
  `src/modules/subscription/utils/native-mirror-sync.ts:125-159`). A mirror whose
  provider row was deleted out of band therefore stays live until support cancels
  it. That gap is documented rather than papered over with an unused reconciliation
  helper, and `subscriptions.md` (*Known limitation*) states it

Having the mirror locally turns "does this customer already hold a native
subscription?" (R3/R5) into a plain indexed table query.

## plan-offer rules reference

The `rules` object on a plan offer accepts (all optional on the type, because rows
persisted before this field set carry none of the keys; conservative defaults equal
the behavior such rows already have — read them through `resolvePlanOfferRules`):

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `consent_from_session` | `"customer_id" \| null` | `null` | Session field whose presence means "checkout consent for auto-renew". `"customer_id"` enables R2. |
| `row_stacking_policy` | `"extend" \| "allow_multiple"` | `"extend"` | R1 extend-in-place vs R4 per-plan rows. |
| `max_stacking_cycles` | `number \| null` | `null` | R1 cap: maximum number of purchased cycles the window may be extended. `null` = unlimited. |

Type and defaults: `src/modules/plan-offer/types/index.ts:52-87`. `rules` is a jsonb
column, so these three fields involve no migration. The read path resolves them
through `resolvePlanOfferRules` (`src/modules/plan-offer/utils/rules.ts`, spread
into the Admin shape at `src/modules/plan-offer/utils/admin-query.ts:175-182`), so a
row persisted without the key gets the default in the table above; the Admin
validator (`src/api/admin/subscription-offers/validators.ts`) and the write mapper
(`normalizeRules`, `src/workflows/steps/shared-plan-offer.ts`) name each key.

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

- behavior: this file plus the per-domain documents it points at
  (`subscriptions.md`, `payments.md`, `renewals.md`, `plan-offers.md`)
- the acceptance-fix round that moved R1's cycle invariant from "by convention" to
  "by constraint": `.agents/specs/2026-09-24-1.6.0-acceptance-fixes.md`
- release-level statements: `CHANGELOG.md` (`[1.6.0]`) and
  `docs/releases/1.6.0-host-upgrade.md`

The original per-ticket breakdown under `.scratch/source-repo-fixes/issues/` is
gitignored working notes; where it disagrees with this file, this file is the
record of what shipped.
