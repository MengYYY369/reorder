## [1.6.0] - 2026-09-22

**Requires Medusa 2.20 / mikro-orm 6.6.14**

### Features

- **relationship model:** one entitlement row per (customer × product), across all
  three payment tracks (#05, #07, #08, #09, #12).
  - Three new plan-offer rules — `consent_from_session`, `row_stacking_policy`,
    `max_stacking_cycles`. All three default to the behavior that shipped before, so
    an offer that is not reconfigured is unaffected, and `rules` is a jsonb column
    so no migration is involved. The discount-stacking `stacking_policy` is
    unchanged and is *not* the row-stacking setting.
  - **Extend in place** (#08): a repeat purchase of the same product pushes the
    existing active row's `next_renewal_at` forward from its current period end
    instead of creating a second row, which removes the structural cause of two
    live rows charging twice in overlapping windows. Accumulated cycles are counted
    in `metadata.cycles_purchased`, and `max_stacking_cycles` refuses a purchase
    over the cap during cart validation, before anything is written.
    `row_stacking_policy: "allow_multiple"` opts an offer out.
  - **Consent flip** (#07): where the offer declares
    `consent_from_session: "customer_id"` and the checkout payment session carries
    that field, the row moves `payment_mode: manual → auto` with
    `mechanism → reorder_auto` in the same update that persists the payment method,
    and the flip is recorded on the activity log naming the proof. The storefront
    no longer has to poll and re-issue the change.
  - **Mutual exclusion** (#09, #12): while a native recurrence for the product is
    `active` or `paused`, a purchase from the other track is refused with the
    product named; `cancelled` and `past_due` are let through so a customer whose
    provider charge just failed can still buy that period themselves. This needs two
    enforcement points because the two purchase paths share no validation step: the
    subscription track is refused in cart validation, and a plain one-time purchase
    — which never reaches this plugin at all — by a method-level middleware on the
    core `POST /store/carts/:id/complete`.
- **Native mirror rows** (#06): `paypal.subscription.*` events upsert
  `NATIVE-{paypal_subscription_id}` rows into the subscription table so "does this
  customer already pay for this product" is an indexed local read, and an hourly
  reconcile pass covers provider subscriptions that predate the plugin. Mirror rows
  are excluded from every path that could charge, extend or dun them — the
  scheduler, the manual-renewal hygiene job, dunning retry, manual renewal
  creation, forced renewal — and from the two sites that rewrite
  `payment_context` (`POST /store/saas/auto-renew`, payment-method update), since
  one call there would otherwise turn an ignored row into a chargeable one.
  Recognition is by `reference` prefix, never by the `mechanism` key inside jsonb.
  Consuming `paypal.subscription.revised` awaits medusa-paypal 0.5.0; the reconcile
  pass notices plan drift meanwhile.
- **Store subscription list** (#04): `frequency_interval`, `frequency_value`,
  `payment_mode` and `has_payment_method` are returned by
  `GET /store/customers/me/subscriptions`, so a benefit card can render the plan
  tier and the auto-renew state without a detail request per row.
- **Peer dependencies** (`74167f4`): `react` and `react-dom` `^18.2.0` are declared
  as peers so the admin bundle resolves against the host's single React copy
  instead of vendoring a second one.

### Fixes

- **Observability** (#01): a failed subscription creation is now a structured
  `subscription.creation_failed` activity-log event carrying the serialized
  workflow error chain and the failing step, instead of `error.message` (which
  truncated the chain and printed `[object Object]` for non-`Error` rejections).
  `subscription_id` and `subscription_reference` became nullable, since this
  failure happens before any subscription row exists.
- **Address validation** (#02): the shipping-address snapshot is decided by
  completeness. A region-seeded country-only stub, or no address at all, produces a
  recognizable digital-goods placeholder instead of failing the purchase; a
  complete address still produces the strict snapshot.
- **saas-bridge** (#03): tenant ownership is decided once, with the two rules it
  actually needs — visibility, and `ensure-customer`'s adoption of unstamped
  customers — replacing five drifted inline comparisons. An unstamped customer
  belongs to the sole tenant on a single-tenant host and to nobody on a
  multi-tenant one. `reconcile` no longer answers a tenant mismatch with an empty
  subscription list, which was indistinguishable from "nothing to reconcile".

### Fixes (acceptance round, 2026-09-24)

The twelve tickets above passed their gates, then three defects were proven by
execution and several verified mediums were ruled into the round. None of the three
was covered by any assertion in the http suite.

- **renewals: a stacked purchase can no longer leave two chargeable cycles (#08).**
  `ensure-next-renewal-cycle` reconciles the rows a subscription already carries
  instead of matching by exact date and appending another. The new pure selector
  `resolveUpcomingCycle` (`src/modules/renewal/utils/upcoming-cycle.ts`) answers
  `match | adopt | defer | create`: `adopt` moves the existing row onto the
  entitlement date and keeps its id, its `renewal_attempt` children and its
  `generated_order_id` history; `defer` writes nothing and logs one warning naming
  the cycle and the order when the only candidate already has money in flight (a
  `processing` row, or one carrying a generated order — `create-manual-renewal`
  reuses a due `SCHEDULED` row without changing its status, so a row can be billed
  while it still reads `scheduled`). Before this, a repeat purchase pushed
  `subscription.next_renewal_at` forward, the step matched on that date, found
  nothing, and created a second future `SCHEDULED` cycle — which the scheduler
  charged at both dates. That is the RE-7 failure ticket #08 claimed was
  structurally eliminated.
- **renewals: the at-most-one-row half of the invariant is a database constraint
  now, not a convention.** A new renewal migration, `Migration20260924120000`,
  creates the partial unique index
  `renewal_cycle_one_scheduled_per_subscription` on `subscription_id`, restricted to
  `status = 'scheduled' and deleted_at is null`. **`up()` normalizes before it
  constrains**, because indexing a drifted database fails outright: rows already
  carrying a duplicate live `SCHEDULED` cycle are **soft-deleted** (stamped with a
  `last_error` marker), and the row kept is the one whose `scheduled_for` already
  equals `subscription.next_renewal_at`, falling back to the most recent one.
  Soft-delete, never `failed` — `scheduler-query` selects `status in [scheduled,
  failed]`, so a `failed` row would be re-armed for a charge. **`down()` drops the
  index only and does not resurrect those rows**: returning a second chargeable
  cycle to the queue is worse than the asymmetry, and an operator rolling back must
  know the normalized cycles are not coming back. The index is hand-authored because
  the model generator cannot express the extra `status` predicate, so a later
  `medusa plugin:db:generate` may propose dropping it — that drop is a regression,
  not cleanup. Two rollback defects found on the way are fixed with it: the step's
  `deleted` compensation now restores at most one live row and recreates extras
  soft-deleted, so a rollback cannot violate the index it is rolling back; and the
  reconciliation write shares one declared field list with its restore, so adding a
  column to the write without adding it to the rollback is a type error rather than
  a half-repaired row.
- **activity log: the creation-failure migration can roll back (#01).**
  `Migration20260922120000.down()` re-added the 25-value `event_type` CHECK
  constraint *before* deleting the `subscription.creation_failed` rows the migration
  introduced, and `ADD CONSTRAINT` validates existing data — so the rollback aborted
  on any database holding one of those rows. The delete now runs first, then the
  constraint, then the NOT NULL restoration. `up()` is unchanged, which is why this
  migration was corrected in place rather than superseded: a host that already ran
  it has nothing to re-apply.
- **consent flip: a provider-owned row is recognized by its reference, not by jsonb
  (#06).** `resolveConsentFlip` tested `payment_context.mechanism` — the one
  predicate this release documents as unusable, since rows persisted before the
  discriminator carry no such key — so the guard passed exactly the rows it exists
  to protect, and a flip could hand a PayPal-owned recurrence to reorder's
  scheduler. It now tests the `NATIVE-` reference prefix through the shared
  predicate. `reference` is a **required** input of `ConsentFlipInput` (omitting it
  does not compile), a reference that is neither a string nor an explicit `null` is
  answered by a new outcome, `reference_undecidable` — left alone rather than
  assumed "not native" — and the extend path now carries the real reference
  (`extend_subscription_reference`, surfaced by the stacking decision) instead of
  nothing.
- **activity log: sensitive-key masking is one shared set (#01).** The two writers
  that sanitize before persistence each kept a private list, and they had drifted
  apart in both directions: the error serializer masked `api_key` / `secret` /
  `token`, the normalizer masked address, postal-code, phone, payment-reference and
  raw-error keys. Both now import one union, `ACTIVITY_LOG_SENSITIVE_KEYS`
  (`src/modules/activity-log/utils/sensitive-keys.ts`). Behavior change to expect:
  **the normalizer masks three keys more than before**, and an error's own fields —
  which `describeOwnFields` JSON-dumps into the human-readable `reason` the Admin
  activity-log screen renders — can no longer carry an address or a payment
  reference.
- **subscriptions: the extend write claims only the keys it owns (#08).**
  `create-subscription-record` built a fresh `{ source, source_order_id }` +
  `cycles_purchased` object and passed it to `updateSubscriptions` as the whole
  `metadata` column, while every other metadata writer in the module spreads the
  stored object first. **This lost no customer data**, and the entry does not claim
  it did: `updateSubscriptions` reaches `manager.assign(..., { mergeObjectProperties:
  true })`, which merges when both the stored and the incoming values are plain
  objects, so `payment_method_update_context` and `pause_context` survived the
  incomplete payload. The merge is path-dependent, not universal — the same
  repository's batch path (`nativeUpdateMany`, reached through `upsert` /
  `upsertWithReplace`) overwrites the column, and a stored non-object takes the
  non-merging branch too. The defect was a payload whose correctness depended on
  which DAL method the caller happened to use; extend now merges into the row's
  stored metadata locally, newest purchase winning `source` and `source_order_id`.
- **checkout gate: a read failure no longer decides anything (#12).** Ticket 12's rule
  is that an unreadable state lets the request reach the core handler. The
  completion middleware called `listSubscriptions` unguarded, so a throw there
  rejected the middleware promise and hung or 500-ed checkout over a plugin-side
  read. The decision is now a pure, injectable unit
  (`src/modules/subscription/utils/checkout-gate.ts`) that is total — a rejected
  read *or* an unexpected result shape both answer "allow" — and
  `src/api/store/carts/completion-gate.ts` is the thin re-export the middleware
  registration imports. The unit sits in the module because no jest `testMatch`
  executes anything under `src/api/`, and its duplicated query shape was folded into
  the one pushdown, `findLiveNativeRecurrences`, that the subscription-track guard
  already used. Fail-open is bounded to the reads the rule itself needs: the product
  title is read only after the verdict exists and behind its own guard, so a
  cosmetic failure degrades the wording and never turns a real collision back into
  a silent pass.
- **native mirror: the dead reconciliation helper is gone (#06).**
  `listExistingMirrorReferences` had no caller. Out-of-band cancellation is covered
  by the event surface (`paypal.subscription.cancelled` is subscribed), and the
  residual gap — a provider row deleted with no event at all — is now stated as a
  limitation in `docs/architecture/subscriptions.md` instead of being papered over
  with an unused function.
- **saas: the auto-renew toggle left the route handler, and route failures stopped
  quoting internals.** `POST /store/saas/auto-renew` held its own native write-side
  guard and performed the `payment_context` write from the request handler — against
  AGENTS.md's "no business rules in route handlers" — duplicating a predicate that
  already existed elsewhere and writing `payment_mode` without its `mechanism`
  partner. The toggle is now the `set-subscription-auto-renew` workflow (guard,
  overdue check, one compensating write), and `payment_mode` / `mechanism` are
  written as a single derived pair by `buildPaymentModeFields`
  (`src/workflows/utils/payment-mode-mechanism.ts`) from both write sides. The
  preserved contract: a refusal answers 400 and `payment_mode` still reads `manual`.
  Fixing the guards exposed a disclosure defect shared by `auto-renew`, `renew` and
  `redeem`: the workflow engine hands back a *serialized* failure, so `instanceof
  Error` never holds, and every step failure was re-wrapped as `invalid_data` —
  which both reported infrastructure faults as the caller's error and echoed
  internal text to the SaaS bridge. Only refusals the plugin authors as customer
  copy are quoted now, declared per route; anything else keeps the `MedusaError`
  type it was thrown as (a 404 stays 404, a 409 stays 409) and answers with one of
  the route's own fixed strings, while the step name and the raw serialized error go
  to the log, which is the only place that text may go. A deserialized database
  error is never rethrown as it stands: `formatException` switches on `err.code` and
  would rewrite it into a 422 whose body embeds `table` and `detail`.
- **saas: the fourth caller of the redeem workflow stopped quoting internals too.**
  `POST /store/customers/me/redemptions` runs the same `redeem-redemption-code`
  workflow with the default `throwOnError: true`, and that mode makes the engine
  answer with `throw ret.errors[0].error` — the serialized failure, `code`, `table`
  and `detail` included. It classifies through the same mechanism now, with
  `preserveQuotedStatus` so a declared refusal keeps the status this route has always
  given it (an unknown code stays 404 where the bridge says 400) while every other
  failure gets one of the route's fixed strings and a driver fault becomes a 500
  rather than a 422 naming a table. Closing it also exposed the whitelist's own weak
  point: matching a declared refusal on step and type alone was enough to echo
  `column redemption_code.redemption_cont does not exist` to a storefront, because
  `db-error-mapper` turns a schema fault on a guard step's own read into an
  `invalid_data` wearing that step's name. A refusal is now matched on its exact
  text as well, which is what the third field of `CustomerRefusal` was always for.
- **activity log: the log write is typed.** `persist-log-event.ts` carried the only
  real `as any` in the sequence; the helper now takes the module's own input type, so
  a renamed field fails the build instead of arriving untyped at the database.
- **redemption: a vanished customer is reported as a vanished customer.**
  `resolve-redemption-code` threw `noMatchingSubscription` from its own customer read,
  so a session that outlived the row was refused with the wrong reason and with a
  variant id interpolated into the message. `redemptionErrors.customerNotFound`
  (`not_found`) owns that branch now and `REDEEM_CUSTOMER_REFUSALS` declares it, so
  `POST /store/customers/me/redemptions` answers **404** `Redemption customer <id> not
  found` — the caller's own id, no variant id — and `POST /store/saas/redeem` answers
  the same refusal with its promised **400**. A `customer_id` that never existed is
  still stopped by that handler's own `retrieveCustomer` before the workflow runs, so
  on the bridge the new wording appears only when the row goes between the two reads.
- **renewals: the stale upcoming cycle a reconciliation leaves behind is retired, not
  left chargeable (#08).** `resolveUpcomingCycle` answered
  `match | adopt | defer | create` correctly and still left a second live `SCHEDULED`
  row standing: `match` reports the exact-date hit and never looks at the neighbour,
  `adopt` moves only the candidate, and `defer` refuses to move anything — and refusing
  to touch a row is not the same as protecting it. That neighbour stayed in the
  scheduler's due set (`status in [scheduled, failed]`, `deleted_at` null) and was
  charged on its own date while the step reported a clean run, and the 1.6.0 index does
  not close the hole either: its predicate covers only
  `status = 'scheduled' and deleted_at is null`, so a `SUCCEEDED` or `FAILED` row on the
  entitlement date with one live `SCHEDULED` neighbour is a shape it permits. The
  selector now names those rows in a `retire` field that `match`, `adopt` and `defer`
  each carry (`create` has none, because reaching it means no open row existed), and
  `ensure-next-renewal-cycle` acts on the set on every path that can carry it — the two
  that return early, the `defer` report and the unchanged-row report, plus the path
  that follows a reconciliation write. The write is a soft delete — the row keeps its id, its
  `renewal_attempt` children, its date and its status, and only `deleted_at` is stamped
  — taken after a re-read that drops any row which picked up a `generated_order_id`
  between the two reads and reports it as `withheld`. Every retirement logs, and so does
  its undo: a workflow failing after the step clears `deleted_at` again and logs the
  restore, while a retire that throws on the `updated` / `adopted` path is reported as a
  permanent step failure carrying the rollback instead of throwing out of `invoke`, where
  the engine would never have compensated the adopt it had already applied. A run whose
  only write was a retirement reports `retired` rather than `noop`. Behavior to expect
  after this: a retired cycle leaves the Admin renewals list, its `count`, and
  `GET /admin/renewals/:id`, which answers `404 not_found` for its id like any cycle
  that does not exist. A `retired` line in the log does not by itself mean a host lost
  the index — the terminal-row shape above retires with the constraint standing; two
  live `SCHEDULED` cycles for one subscription may indicate it, since that is the pair
  the constraint refuses.
- **saas: a failed tenant-scoping read no longer quotes internals — and now answers
  404.** All nineteen reads the six `/store/saas/*` routes make themselves (the tenant
  check's `listSubscriptions` / `retrieveCustomer` / `listCustomers`, `carts`'s and
  `reconcile`'s `query.graph` reads, the shared helper's customer read) go through
  `readTenantScoped` (`src/api/store/saas/lib/tenant-ownership.ts`), which decides what
  may be disclosed in `classifyStoreReadFailure`
  (`src/modules/subscription/utils/store-read-failure.ts`) — a unit under
  `src/modules/**`, where a gate executes it, not under `src/api/**`, where none does.
  Customer-visible consequences: a read fault that reached core's handler as a 500, or
  as a 400/422 whose body named a table and a column, answers **404** with the route's
  own sentence on all six; `POST /store/saas/ensure-customer` gained that 404 on fault
  paths only; a `carts` region *fault* answers 404 where a region that genuinely is not
  configured keeps its **400**; and a customer row that is gone still answers 404 but
  with the route's text, no longer core's `Customer with id '…' was not found`. A
  database outage on these scoping reads therefore presents as a 404 — risk **R1** of
  `.agents/specs/2026-09-25-post-acceptance-backlog.md`, accepted deliberately there,
  with the raw cause logged at `[reorder] … tenant-scoped read failed`. Admin routes,
  non-tenant store reads and the reads under `src/api/store/customers/me/**` are
  unchanged and still on core's error path, the last group by that spec's own ruling.

### Chores

- **plan-offer and relationship documentation (#10):** the relationship-model
  document opened with "none of the mechanism/rule fields described below exist in
  the code yet", wrote R1-R5 in the future tense, and named a
  `payment_context.native_subscription_id` field that exists nowhere in `src/`. It
  now describes implemented behavior in the present tense, and mirror identity is
  written the way the code holds it: the `NATIVE-{paypal_subscription_id}` prefix on
  the unique `reference`, with the provider's own id in
  `payment_context.customer_payment_reference`. The per-rule statements cite the
  file each was taken from, because a document describing a field that does not
  exist is how this round started.
- **Migrations shipping with 1.6.0:** `Migration20260922120000` (activity-log —
  `down()` corrected in place, `up()` unchanged) and `Migration20260924120000`
  (renewal — the new partial unique index, plus the normalization that soft-deletes
  drifted duplicate cycles and is *not* undone by `down()`). Host upgrade steps:
  `docs/releases/1.6.0-host-upgrade.md`.
- All migrations now import `Migration` from `@medusajs/framework/mikro-orm/migrations`,
  removing four direct imports of a package the plugin does not declare; the host
  resolves mikro-orm once.
- **the package ships the plugin, not the repository:** `files` packed the whole
  `.medusa/server` build output, so a host install carried everything `medusa
  plugin:build` compiles — 29 Playwright files under `.medusa/server/e2e`,
  `.medusa/server/playwright.config.js` and the compiled `scripts/` tree, whose
  seed script alone is 193.5 kB — and, under `src`, the 28 compiled
  `src/**/__tests__/*.spec.js` files (440.5 kB). `files` is now
  `[".medusa/server/src", "!**/__tests__/**"]`: measured against one and the same
  build output, 400 files / 929.7 kB became 366 files / 826.7 kB and then
  338 files / 738.4 kB (5.0 MB unpacked → 4.5 MB → 4.0 MB), and listing the final
  tarball with `tar -tzf` shows no `__tests__` entry at all. The negation carries
  no `./` prefix because that prefix makes npm ignore it — measured on one tree:
  `!./**/__tests__/**` packs 366 files, `!**/__tests__/**` packs 338.
  Nothing importable was lost, and that is asserted rather than assumed:
  `scripts/assert-package-surface.mjs` (`npm run verify:package`, or
  `corepack yarn verify:package`) extracts the tarball with the system `tar` —
  retrying with GNU tar's `--force-local`, without which that tar refuses an
  absolute `X:\…\reorder-1.6.0.tgz` argument as a remote host — and fails on any
  `exports` target missing from the packed tree, on any target left under
  `.medusa/server/` outside `src` (the exact path class `files` no longer
  ships), on any pattern target matching no packed file unless the script names
  it in its own `EMPTY_PATTERN_ALLOWLIST`, and on a packed manifest that leaves
  the check with nothing to compare. `exports` itself is unchanged from 1.5.0, so
  the seven keys and nine targets a host resolves through point at the same files
  they did before; each was resolved through Node's resolver against the final
  338-file tree, and the repo's own `jest src/modules/renewal` gate still runs the
  TypeScript specs (3 suites, 24 tests) because the exclusion reaches the package
  only. `prepublishOnly` still runs the build and nothing else. One target is
  allowlisted because it is empty, not because it was forgotten: `./providers/*`
  matches no packed file — `src/providers/` holds only the Medusa template README,
  as it did in 1.5.0 — so `@mengyyy369/reorder/providers/<name>` never resolved,
  and the verifier prints that exemption by name instead of passing it quietly.

## [1.5.0] - 2026-09-19

### Features
- **saas-bridge:** merge the medusa-saas-bridge plugin into reorder as an
  optional, self-contained module — six shared-secret `/store/saas/*`
  endpoints (ensure-customer, reconcile, renew, auto-renew, carts, redeem)
  and lifecycle event forwarding into the medusa-webhooks fan-out, behind a
  nested `saas_bridge` plugin option (`shared_secret`/`tenants` +
  `subscriptions` whitelist). Absent option = exactly the previous behavior:
  every `/store/saas/*` route fails closed with 401 and nothing is forwarded,
  so adopting the merge is zero-risk for existing deployments. The wire
  contract is byte-identical to `@mengyyy369/medusa-saas-bridge` (which
  becomes deprecated at 1.4.0) — SaaS applications need zero changes. Workflow
  invocations became direct typed imports (manual renewal, redemption), the
  bridge's self-heal-from-configModule options workaround is replaced by the
  module service capturing plugin options, and `@mengyyy369/medusa-webhooks`
  is an optional peer dependency with boot-time fail-fast when a
  `subscriptions` whitelist is configured without it. The carts placeholder
  shipping address (postal `00000`, country `cn`) is load-bearing contract —
  the SaaS never sets addresses itself. See `docs/api/saas-bridge.md`.

## [1.4.1] - 2026-09-10

### Fixes
- **renewals:** charge renewals through a summary-independent payment collection
  resolver (7e55d5a) — on Medusa 2.20 the core create-or-update workflow rejected
  fresh renewal orders priced at or below the currency epsilon (0.01 for USD/CNY,
  1 for JPY/KRW) with "Amount cannot be greater than ..." before any payment was
  attempted, and the failure bypassed dunning classification. Auto renewal, dunning
  retry, and manual renewal now share a resolveOrderPaymentCollection helper that
  never reads the order summary: it reuses chargeable collections (syncing the
  amount), cancels-and-replaces authorized ones without touching captured money,
  and otherwise creates a collection plus the order link; helper failures in the
  auto path open a payment_session-sourced dunning case. Epsilon-boundary (0.01)
  regression tests pin all three paths.

## [1.4.0] - 2026-09-09

### Features
- **redemption:** add redemption codes for payment-free subscription grants (c6371d4) —
  merchants create batches of single-use codes bound to a plan-offer variant with a
  configurable free-cycle grant; customers redeem them via
  `POST /store/customers/me/redemptions` (preview via `/preview`) to start a
  subscription without payment, or extend an existing one. Includes the redemption
  module (batches, codes, records), redeem/preview/create-batch workflows, expiry
  scheduler, admin API routes, admin UI page with batch management and record view,
  PAST_DUE recovery via redemption, activity-log `redemption.redeemed` events,
  EN/zh-CN i18n, HTTP + module integration tests, and Playwright E2E coverage.

### Fixes (during acceptance)
- **admin:** replace nonexistent `Ticket` icon with `ReceiptPercent` so the plugin
  admin bundle builds against the host's `@medusajs/icons`.
- **admin:** forward the selected product id between chained picker modals so the
  variant picker no longer renders an empty "Select a product first." state.
- **api:** accept the `direction` sort param in the admin batches list validator so
  the admin DataTable no longer receives a 400 on load.

## [1.3.1] - 2026-09-08

### Fixes
- **subscribers:** export the missing `config` from payment-captured-manual-renewal —
  without it Medusa skipped the subscriber ("missing a config. skipped."), so
  manual renewal orders could never finalize via the payment.captured path.

## [1.3.0] - 2026-09-07

### Sync
- Merged upstream v1.1.0: payment method management, analytics module alias
  rename (`subscriptionAnalytics`), zod v4 idioms, Playwright E2E scaffolding,
  widget-zone layout composer compliance.

### Features (this fork)
- Order-driven subscription creation with manual payment mode (mc02)
- Manual renewal workflow + lifecycle events (mc03/mc04)
- Simplified-Chinese admin translations incl. payment-method UI (i18n)

## [1.1.0] - 2026-09-06

### Features
- **subscriptions:** add payment method management for off-session renewals (758448e)
- **admin:** add hover tooltips to trend charts (7ac6a47)
- **analytics:** replace active trend with created subscriptions bar chart (8677886)
- **local-dev:** add subscription storefront discovery and concurrent startup (4c6fdb8)
- **local-dev:** enhance local-dev skill with clean port management and dual background tasks (13bee89)
- **ai:** restructure guidelines, introduce agent skills, add 2-stage sync-docs skill, and automate local dev sync script (1afae9e, 68173a8, d843fc3)
- **testing:** add wipe-test-data script and skill with safety confirmation (9d2995f)
- **testing:** add Playwright E2E PoC for admin subscriptions list (1787fb5)

### Fixes
- **subscriptions:** resolve payment method API leak and add test coverage (28690f9)
- **analytics:** namespace module alias to avoid medusa collision (3cd909b)
- **analytics:** resolve latest order fallback for renewal cycles in daily snapshots (af32d79)
- **analytics:** include initial subscription order in MRR calculation (2f83bbc)
- **admin:** update widget zones and docs to comply with layout composer (e9bb8ba)
- **local-dev:** extract publishable token in sync script and clarify restart steps (dad001d)
- **dev-env:** preserve inventory in wipe script and auto-sync publishable key (586d5d4)

### Chores & Docs
- **docs:** redesign README with social proof, screenshots, new hero, and Why Reorder section
- **chore:** add release-plugin skill for automated publishing (179e2a1)
- **test:** implement E2E specs for plan creation, cancellation, pause-resume, and renewals
- **test(integration):** use worker concurrency to prevent in-band OOM (8e11e82)
- **chore:** update to latest medusa (6fd3a9f)
