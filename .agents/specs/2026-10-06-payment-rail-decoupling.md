# Spec: Payment-rail decoupling — provider descriptors, neutral native-rail events, de-branded UI

> Status: **all decisions locked by the owner (2026-10-06, grilling rounds 1–3).** Nothing here is
> waiting on an answer; the remaining work is implementation.
> Cross-repo: `medusa-payment-methods` **0.3.0**, `medusa-paypal` **0.10.0**, `reorder` **1.12.1**,
> `medusa-better-auth` **0.9.4**, host + storefront wiring in `medusa-saas`.
>
> Grilling rounds 1–2 (Q1–Q12) are answered. Three independent reviews of the first draft and a
> second review pass over v2 are folded in; every P0/P1 they raised is closed in this version.

## TLDR & Overview

`reorder` knows PayPal by name through functional seams, not just strings: a duck-typed
`container.resolve("paypalSubscription")`, a `query.graph({ entity: "paypal_subscription" })`
read of another plugin's private table, eight `paypal.subscription.*` event names (the provider
emits seven), the synthetic event name `buildNativeMirrorFieldsFromRecord` fabricates
(`native-mirror.ts:252`), PayPal status and refusal-prose tables (`STATUS_BY_PAYPAL_STATE`,
`resolveNativeStatus`, the bind routes' `/^PayPal setup token is not approved…/` copy rules), and
literals (`pp_paypal_paypal`, `paypal_native_mirror`, `summary: { type: "paypal" }`, the
`paypal_subscription` variant-metadata key read in the browser).

`medusa-payment-methods` is provider-agnostic in `SiteAdapter` and in the binder contract, but
its only provider registry is the `binders` map, its admin i18n brands both rails as PayPal, and
its idempotent-replay path string-matches PayPal's `ApprovalAlreadyUsedError`.

The owner will add three more credential platforms (Creem, Dodo Payments, Stripe). This spec
replaces the PayPal-shaped seams with a **provider descriptor registry** owned by
`medusa-payment-methods`, so a new provider is added by wiring one descriptor in the host config
— no `reorder` code change, no `if (provider === ...)`.

**Locked by the owner (grilling, 2026-10-06):** capability layer (Q1 = C); no second
implementation exists yet but three are planned (Q2); all repos may change and the declared
dependency range is fixed (Q3); the `medusa-config example` card in `medusa-better-auth` is
deleted (Q4); the native-trial admin card keeps its information with generic wording (Q5);
descriptor types are owned by `medusa-payment-methods` (Q6 — see decision 1 for the mechanical
correction); the three new platforms ship on the **vault rail** with the native rail an optional
descriptor capability (Q7); one aggregate capability query (Q8); a **rail-neutral
`payment-rail.native_subscription.changed` event** carrying a complete record, emitted by the rail
registry through a hook the host injects into the provider (D3); provider errors are wrapped at the plugin
boundary (Q10); rail labels use the descriptor's `display_name` with a neutral fallback (Q11);
and **no compatibility shims** — `binders`, the duck-type fallback, and the dead event path are
deleted outright (Q12).

## Defects this batch also closes

1. **The native-rail event path is dead code.** reorder's mirror builder requires `customer_id`,
   `product_id`, `variant_id`, `frequency_interval`, `frequency_value`
   (`native-mirror.ts:123-129`, enforced at `:166-170`), but all four emit sites in
   `medusa-paypal` send only
   `{ subscription_id, paypal_subscription_id, status, customer_id, variant_id[, payment] }`
   (`src/subscription/engine.ts:805, 866, 1006, 1461`; the payload type at
   `src/subscription/types.ts:48-60` forbids more). Every event is dropped with
   `missing_product_id_and_frequency_interval_and_frequency_value`. The unit and HTTP tests are
   green only because their fixtures feed the full payload (`native-mirror.spec.ts:17-21`,
   `integration-tests/http/native-subscription-mirror.spec.ts:26-37`). Today the only live mirror
   source is the hourly backfill (`jobs/native-subscription-backfill.ts:46`, `17 * * * *`).
2. **Declared dependency range cannot satisfy the code.** `reorder/package.json:104` declares
   `"@mengyyy369/medusa-payment-methods": "^0.1.3"`; the lockfile and `node_modules` resolve
   0.1.3, whose `startBinding(input)` has arity 1, while the 1.11.0 flow needs the 0.2.0
   container-first signature. The arity guard (`payment-method-binding.ts:131-135`) turns that
   into `null`, so a fresh `^0.1.3` consumer boots and then refuses every trial/auto-renew bind
   with "the installed payment-methods module does not provide the binding capability".
3. **Two `CodeBlock` render defects in `medusa-better-auth`.** `@medusajs/ui@4.2.4`'s `CodeBlock`
   renders code only through its `Body` child (cjs and esm builds both); neither call site passes
   children. `src/admin/routes/better-auth/page.tsx:210-214` shows an empty box (the owner's
   report), and `src/admin/components/clients/client-list-table.tsx:249-251` hides the one-time
   OIDC client secret — the only place a plaintext secret is rendered (the Copy button still
   works, because it reads state directly).
4. **Duplicated and dead code.** `PAYPAL_SUBSCRIPTION_MODULE_KEY` is declared twice
   (`workflows/utils/paypal-vault-binding.ts:30`, `workflows/utils/native-provider-cancel.ts:28`);
   `workflows/steps/renew-now.ts:14` imports `isPaymentMethodsModuleRegistered` without calling
   it; `medusa-paypal` emits 7 event names while reorder lists 8 (`revised` is never emitted, and
   reorder's guard `revised_not_supported_until_paypal_0_5_0` at `:163` is unreachable).

## Proposed Architecture & Data Model

No new tables and no migration in `reorder`. All new surface is TypeScript contracts plus one new
admin read endpoint.

### 1. The provider descriptor (owned by `medusa-payment-methods`)

```ts
// src/modules/payment-methods/types/index.ts

/** The rail-neutral status vocabulary. Providers map their own states into it. */
export type RailStatus = "active" | "paused" | "past_due" | "cancelled"

export type NativeSubscriptionRecord = {
  provider_subscription_id: string
  plan_id: string | null
  /** null = do not mirror (PayPal's APPROVAL_PENDING maps here). */
  status: RailStatus | null
  customer_id: string | null
  variant_id: string | null
  interval_unit: string
  interval_count: number
  next_billing_at: string | null   // ISO string — the bus JSON round-trips
  last_billing_at: string | null
}

export type NativeDeclaration = {
  /** Field rows the admin card renders; `label` is the provider's fallback wording. */
  fields: Array<{ key: string; label: string; value: string | null }>
}

export type NativeCancelOutcome =
  | { status: "skipped"; reason: "not_native" | "provider_row_missing" | "capability_absent" }
  | { status: "cancelled"; provider_subscription_id: string; provider_row_id: string | null }
  | {
      status: "failed"
      provider_subscription_id: string | null
      provider_row_id: string | null
      error: string
    }

export type NativeRailDescriptor = {
  readVariantDeclaration(metadata: Record<string, unknown> | null): NativeDeclaration | null
  listRecords(container: MedusaContainer): Promise<NativeSubscriptionRecord[]>
  /**
   * `reference` is the provider's own subscription id, never reorder's mirror key — a provider
   * must not have to parse `NATIVE-…`. reorder reads the raw id from the mirror row's
   * `payment_context.customer_payment_reference` (`native-mirror-sync.ts:86` writes it) and
   * answers `skipped(not_native)` for a row that is not a native mirror, or
   * `skipped(provider_row_missing)` when the provider knows no such subscription.
   */
  cancel(container: MedusaContainer, reference: string): Promise<NativeCancelOutcome>
}

export type PaymentMethodBinder = {
  kind?: string
  start(input: { customerId: string; providerId: string; returnUrl: string; cancelUrl: string }):
    Promise<{ approvalUrl: string; state: string }>
  complete(input: { customerId: string; providerId: string; state: string }):
    Promise<{ paymentMethodId: string; data: Record<string, unknown> }>
  /** The provider's "approval already exchanged" error — replaces the class-name match. */
  isAlreadyCompleted?(error: unknown): boolean
  /** The provider's "payer has not approved yet" error — replaces the prose regex. */
  isPendingApproval?(error: unknown): boolean
}

export type PaymentProviderDescriptor = {
  provider_id: string                            // "pp_paypal_paypal"
  kind: string                                   // "paypal" | "stripe" | "creem" | "dodo"
  display_name: string                           // "PayPal"
  display_name_i18n?: Record<string, string>     // { en, zhCN }
  binding: PaymentMethodBinder
  native?: NativeRailDescriptor
  /** Provider error → HTTP refusal. Absent = wrapped as 502 provider_error. */
  mapError?: (error: unknown) => { status: number; type: string } | null
}
```

`providerDescriptors: Record<string, PaymentProviderDescriptor>` replaces `binders` in
`PaymentMethodsPluginOptions`; `resolvePaymentMethodsOptions` (`utils/options.ts:17-27`) reads it
instead of `binders`. **Hard cut, fail-fast:** it throws when `options.binders` is present, with
a message naming the replacement — a stale host must not boot into a state where every bind
answers `501` and the capability list is empty.

**The key is not `providers` (P0 found while verifying, 2026-10-07).** Medusa's module loader
treats `options.providers` as its own provider list and iterates it
(`@medusajs/modules-sdk` `dist/loaders/utils/load-internal.js`:
`for (const provider of resolution?.options?.providers ?? [])` — no `Array.isArray` guard on that
path). Because a plugin's `plugins[].options` are copied into its module's resolution options, a
descriptor *map* under that name makes the host throw
`TypeError: providers is not iterable` **while it boots**, before any of this plugin's code runs.
The module integration suite caught it (its `moduleOptions` follow the same path); renaming the
key fixed it and the suite went green. `binders` never collided — its replacement had to be
renamed for this reason alone. The option guard refuses both old keys, though only the `binders`
case can actually reach it.

### 2. Two capability views: one in-process, one over HTTP

```ts
// In-process, returned by the module service. Functions are callable.
export type ProviderCapabilityView = {
  provider_id: string
  kind: string
  display_name: string
  display_name_i18n: Record<string, string> | null
  binding: { supported: boolean }
  native: null | {
    supported: true
    readVariantDeclaration(metadata: Record<string, unknown> | null): NativeDeclaration | null
    listRecords(container: MedusaContainer): Promise<NativeSubscriptionRecord[]>
    cancel(container: MedusaContainer, reference: string): Promise<NativeCancelOutcome>
  }
}

// Serialized by the admin API. No functions — `res.json` would drop them.
export type AdminProviderView = {
  provider_id: string
  kind: string
  display_name: string
  display_name_i18n: Record<string, string> | null
  binding: { supported: boolean }
  native: null | { supported: true }
}

// PaymentMethodsModuleService
getProviderCapabilities(
  container: MedusaContainer,
  input?: { providerId?: string | null; kind?: string | null }
): Promise<ProviderCapabilityView[]>
```

The operations ride on the in-process view on purpose: a view that only says `supported: true`
gives every consumer nothing to call (the first draft made exactly that mistake). In-process
functions are the cheapest correct surface; reorder needs no second entry point.

- `AdminPaymentMethodsView` gains `providers: AdminProviderView[]` — including in
  `listAdmin`'s early return (`service.ts:617`) — so the admin provider filter renders a select
  instead of a free-text hint.
- The store-facing `PaymentMethodProvider` gains `display_name` and `display_name_i18n`, so a
  storefront can label any provider without code changes.
- Missing module, missing descriptor, or a provider that predates the capability answers with an
  empty list or `native: null` — never a throw.

### 3. The neutral native-rail event

```ts
export const NATIVE_SUBSCRIPTION_CHANGED_EVENT = "payment-rail.native_subscription.changed"

export type NativeSubscriptionChangedPayload = NativeSubscriptionRecord & {
  kind: string                // "paypal" — the provider always knows its own kind
  provider_id: string | null  // row.provider_id ?? null (a payment-session echo, often null)
  /**
   * Why the row changed. Required because a successful charge leaves PayPal's status at ACTIVE and
   * only moves `last_billing_at`: without this, a consumer cannot tell "charge succeeded" from
   * "status refreshed". It carries the meaning that the provider's own event names used to carry.
   */
  transition: "status" | "payment_succeeded" | "payment_failed"
}
```

- **The registry emits it; the provider calls an injected hook.**
  `medusa-payment-methods` owns the name, the payload and the publication:

  ```ts
  // medusa-payment-methods — the single definition of the rail event
  export function emitNativeSubscriptionChanged(
    eventBus: unknown,
    payload: NativeSubscriptionChangedPayload
  ): Promise<unknown>
  ```

  The host wires that function into the provider's **plugin** entry options — the bag the module
  reads (`src/modules/paypal-subscription/service.ts:104-107` is where `isSandbox` comes from, and the
  module service receives that bag as its constructor options):

  ```ts
  // medusa-config.ts
  {
    resolve: "@mengyyy369/medusa-paypal",
    options: {
      isSandbox: process.env.PAYPAL_IS_SANDBOX === "true",
      onNativeSubscriptionChanged: emitNativeSubscriptionChanged,
    },
  }
  ```

  There are **two** `SubscriptionEngine` constructions and the hook must reach both:

  - the module service's reconciliation engine (`src/modules/paypal-subscription/service.ts:175-184`),
    which sees plugin options;
  - the **provider's** webhook engine (`src/providers/paypal/service.ts:493-501`), which is built
    from *provider* options and is the only one that handles PayPal webhooks
    (`getWebhookActionAndData` → `handleWebhookEvent`).

  Wiring the provider option bag as well would duplicate the hook in the host config — exactly the
  two-layer divergence the host comments already warn about. Instead: the module service stores the
  hook from its own options and exposes it, and the provider reads it off the module service it
  already resolves as `subscriptionModule` (`src/providers/paypal/service.ts:497`) before passing it
  into its engine deps. One host wiring line, one read point, both engines.

  The provider calls it from one helper at the four transition sites, catches a throwing hook with a
  `warn` — an event failure must never sit on the billing path — and tolerates an absent `eventBus`
  (the provider passes `modules["event_bus"]`, which can be `undefined`). A missing hook logs one
  boot warning, printed by the module service (the only always-constructed place). **The provider
  therefore holds no event string at all**, and the whole `paypal.subscription.*` vocabulary is
  deleted (≈50 references across 6 files: `src/subscription/events.ts:8-16`, `engine.ts`, three spec
  files, `README.md:451,501-504`, `docs/tutorial.zh-CN.md`).
- The pattern is the one this ecosystem already uses: the host is the only party that sees both
  packages, exactly as it is for `adapter: reorderSiteAdapter` and for the `providers` map.
- A PayPal-only host (no `medusa-payment-methods`) wires a one-line hook to receive rail events, or
  receives none — hence the boot warning and the README contract.
- **`kind` is the join key, not `provider_id`.** The PayPal engine cannot know its registration
  key — the row's `provider_id` is a nullable payment-session echo
  (`src/modules/paypal-subscription/models/paypal-subscription.ts:21`, `engine.ts:566, 582`) and
  another path already falls back to the literal `"pp_paypal"` (`engine.ts:937`). So the payload
  copies the echo as-is (or `null`) and reorder maps `kind → provider_id` through the capability
  view. The backfill path (`listRecords`) has no provider echo at all; reorder stamps the
  descriptor's `provider_id` onto the mirror row's `payment_context.payment_provider_id`
  (replacing the `"pp_paypal_paypal"` literal at `native-mirror-sync.ts:80`) and onto `metadata`
  as `{ source: "native_mirror", provider_kind: "paypal", plan_id }` (replacing
  `source: "paypal_native_mirror"` at `:90`;
  `integration-tests/http/trial-claim-ledger.spec.ts:352` pins the old literal and moves).
- **`status` is rail-neutral.** The provider maps its own states (ACTIVE → `active`, SUSPENDED →
  `paused`, CANCELLED/EXPIRED → `cancelled`, `payment_failed` → `past_due`, APPROVAL_PENDING →
  `null`), which is what lets a failed charge mirror as `past_due` — today that mapping is
  event-name-driven (`native-mirror.ts:103-116`) and would silently mirror a failed charge as
  `active`.
- `reorder` subscribes to the neutral name only. Medusa's subscriber `config.event` is read from
  the module export at load time (`subscriber-loader.ts:66-69, 89, 175-193`), before plugin
  options reach anything, so a provider-declared dynamic list is not available to a subscriber.
- `product_id` is deliberately absent: reorder resolves it from `variant_id` through the product
  catalog, exactly as the backfill does today. One record-based builder then serves both the event
  and the backfill path, which is also how the synthetic
  `buildNativeMirrorFields("paypal.subscription.activated", …)` call inside
  `buildNativeMirrorFieldsFromRecord` (`native-mirror.ts:248-271`, call at `:252`) disappears.
- Mirror references become `NATIVE-{kind}-{providerSubscriptionId}` — `kind` is the first token,
  the provider's own id keeps its dashes. The `NATIVE-%` predicate and its LIKE pushdown are
  unchanged, and nothing parses the reference for identity: `cancel` still receives the raw id from
  `payment_context.customer_payment_reference`. Legacy bare rows are rewritten by the one-time
  migration in the release order.

### 4. The error boundary

`medusa-payment-methods` wraps every binder and native-rail call. A thrown provider error becomes
`PaymentMethodsError` with `type: "provider_error"` (502) and a redacted code; a descriptor's
`mapError` overrides that. Provider classification uses binder predicates on the **raw** error,
evaluated before conversion, not class names:

- `binding.isAlreadyCompleted?.(error)` replaces `isApprovalAlreadyUsedError`
  (`service.ts:484, 991`). Order matters: run it on the raw provider error, or a replayed approval
  regresses from idempotent success to a 502.
- `binding.isPendingApproval?.(error)` becomes a new
  `paymentMethodsErrorTypes.BINDING_PENDING_APPROVAL` (422), with split ownership: the plugin's
  message is the operator/log copy ("the provider approval is not complete yet"), and reorder maps
  the serialized `type` to a **reorder-owned** i18n key, so no provider prose crosses the boundary
  and the buyer-facing wording stays reorder's. That is what lets the two
  `/^PayPal setup token is not approved…$/` rules (`trials/[id]/bind/route.ts:102`,
  `auto-renew/bind/route.ts:104`) be deleted without losing the case.
- **The credential-environment mismatch keeps its 500.** Today it is deliberately
  `UNEXPECTED_STATE` — "so an uncaught mismatch surfaces as a 500 instead of a fabricated 400
  customer refusal" (`config-resolver.ts:87-98`) — and reorder rethrows it as `UNEXPECTED_STATE`
  with the operator message after finding it by name (`trials/[id]/bind/route.ts:256-263`,
  `auto-renew/bind/route.ts:246-253`). PayPal's `mapError` maps it to
  `{ status: 500, type: "unexpected_state" }` **with the message preserved (not redacted)**.
- Deleting the name match is not enough by itself: `findSerializedPaymentMethodsFailure`
  (`store-step-failure.ts:334-361`) returns `{ status, message }`, and
  `coreTypeForPaymentMethodsStatus` returns `null` for 500 (`:323-324`), so both routes would fall
  through to the generic "payment method binding failed" copy and lose the operator message.
  Two mechanical changes close that: `findSerializedPaymentMethodsFailure` also returns `type` (it
  survives `serializeError`, which copies every own property), and
  `coreTypeForPaymentMethodsStatus` maps 500 → `MedusaError.Types.UNEXPECTED_STATE`, which makes the
  routes' **existing** `throw new MedusaError(coreType, pluginFailure.message)` branch
  (`trials/[id]/bind/route.ts:282`, `auto-renew/bind/route.ts:272`) carry the operator message.
  `pluginFailure` is the serialized plugin error; `failure` is the `classifyStepFailure` result and
  holds only the generic copy — do not rethrow that one. The same `type` field then carries
  `binding_pending_approval` to reorder's own copy.
- Correction to the first draft: the plugin's `invalidData` is **422**, not 400; core collapses
  400/422 to `MedusaError.Types.INVALID_DATA` (`store-step-failure.ts:310-326`).

### 5. UI

- **`reorder` admin** — `NativeTrialVariantDisplay` stops parsing variant metadata in the browser.
  New read endpoint `src/api/admin/subscription-offers/providers/declarations/route.ts`
  (registered through `src/api/admin/subscription-offers/middlewares.ts`, wired into
  `src/api/middlewares.ts:25`), `GET ?product_id=<id>`, returning
  `[{ product_id, variant_id, variant_title, provider_id, kind, display_name, fields }]` for every
  variant of that product a native-capable provider recognizes. `data-loading.ts`'s
  `useAdminProductVariantsMetadataQuery` (`:228-242`) and its query key (`:41`) are replaced; the
  DTO lands in `src/admin/types/plan-offer.ts`. Card title becomes
  `{{provider}} native subscription (provider-side, read-only)`; field labels prefer
  `planOffers.form.nativeField.<key>`, falling back to the descriptor's `label`.
- **`medusa-payment-methods` admin** — `rail.vault` / `rail.native` render
  `{{provider}} automatic billing` / `{{provider}} subscription` via
  `t("rail.vault", { provider })` (`interpolate` supports `{{param}}`,
  `admin/lib/i18n.ts:80-84`), neutral wording when no `display_name` is known, and
  `display_name_i18n[language]` over `display_name` (languages are `en` / `zhCN`,
  `admin/i18n/index.ts:14, 80`). The provider filter becomes a select fed by the admin view's new
  `providers` member.
- **Storefront (`medusa-saas/apps/storefront`)** — the account page already holds both `methods`
  and `providers` from one payload, so the mechanic is: `methodTitle(method, providersById)`
  resolves `method.provider_id → display_name` for the row title, with the existing
  `PAYMENT_PROVIDER_LABEL_KEYS` map (`lib/util/payment-methods.ts:88-90`) as fallback; the rail
  titles in `messages/{en,zh}.json:39-40` become next-intl ICU messages — `"{provider} auto-charge"`
  / `"{provider} subscription"` with `t("method.vault", { provider })` — **single braces**, not the
  `{{provider}}` the two admin surfaces use (each runs its own interpolator). `methodTitleKey` (`:110-112`) and its test
  (`payment-methods.test.ts:39-42`) change with it, and the "Wire shape (frozen)" comment
  (`:10`) is refreshed.

### 6. Cross-version degradation and the upgrade gate

The dangerous order is not "publish paypal before payment-methods" — it is a **partial host
upgrade**. `medusa-saas/apps/backend/package.json` pins `"^0.2.0"` for payment-methods and
`"^0.9.5"` for paypal (carets do not cross a 0.x minor) while reorder's `^1.11.0` range *does*
admit 1.12.0; the lockfile already materializes two copies (`pnpm-lock.yaml:2354` 0.1.3 vs
`:2369` 0.2.0; the reorder snapshot at `:12522` resolving 0.1.3). With reorder 1.12.0 against a
0.2.0 module there are no mirror rows and no provider cancellations while PayPal keeps billing.
The **guard** is the host-side lockfile pin plus an atomic bump plus the smoke gate below;
reorder's contribution is visibility, not a refusal:

1. `resolvePaymentMethodsOptions` **throws** on the legacy `binders` key (fails at boot).
2. reorder's capability resolver logs one `error` per process naming the required
   `medusa-payment-methods` version when `getProviderCapabilities` is absent, and the cancel path
   logs a `warn` when it answers `capability_absent` and records
   `{ status: "skipped", reason: "capability_absent" }` in `cancel_context.provider_cancel`.
   (Today `capability_absent` is recorded silently and only `failed` warns —
   `cancel-subscription.ts:60-68`, `customer-deleted-cascade.ts:135-138`; the `warn` is new.)
3. The host bump is one atomic step: four specifiers, `minimumReleaseAgeExclude`
   (`medusa-saas/pnpm-workspace.yaml:17`), lockfile regeneration, image rebuild, then the smoke
   gate — a bind completes, a mirror row is written from a live event, a cancel reaches the
   provider.

## Cross-repo release order

1. `@mengyyy369/medusa-payment-methods` **0.3.0** (breaking: `providerDescriptors` replaces `binders`).
2. `@mengyyy369/medusa-paypal` **0.10.0** (breaking: `createPaypalRail` replaces
   `createPaypalBinder`; adds the neutral event).
3. One-time data migration: rewrite every legacy `NATIVE-…` mirror reference into the new format
   (`scripts/backfill-native-reference-format.ts`, dry-run first). **The window matters**: run it
   with the backend stopped (or the hourly backfill job disabled) and finish before the reorder
   deploy. While old code is live, `upsertNativeMirrorSubscription` looks the row up by the old
   reference and would re-create a legacy row after the rewrite; and `reference` is unique, so an
   unguarded second run collides. The script is therefore dedupe-safe by construction (when both
   formats exist for one provider subscription id it merges them into the new-format row) and is
   re-run once after the deploy, where it must report a no-op.
4. `@mengyyy369/reorder` **1.12.0** (internals only; dependency becomes `^0.3.0`).
5. `medusa-saas`: host config + storefront labels + dependency pins + image + deploy (§6.3).
6. `@mengyyy369/medusa-better-auth` **0.9.4** — independent of 1–5. 0.9.2 is allocated to the
   unshipped i18n cleanup (`docs/plans/2026-10-03-i18n-0.9.2-p2-cleanup.md:5`) and 0.9.3 is
   conditionally claimed by the in-flight trial-bind batch
   (`docs/plans/2026-10-04-0.9.3-trial-bind-plugin-and-p2-hardening.md:6`); 0.9.4 avoids both.

### Release status — 2026-10-07

Done, with each commit and each published version verified:

| Step | State |
| --- | --- |
| 1. `medusa-payment-methods@0.3.0` | **published** (`npm view … version` → `0.3.0`); commit `e681e9d` |
| 2. `medusa-paypal@0.10.0` | **published** → `0.10.0`; commit `f60b3f0` (78 files — the deleted `binder`/`events` `.d.ts` no longer ship) |
| 4. `reorder@1.12.0` | **published** → `1.12.0`; commit `8ee16b1` |
| 6. `medusa-better-auth@0.9.4` | **published** → `0.9.4`; commit `b7e91d3` |
| 4b. `reorder@1.12.1` | **published** → `1.12.1` — the migration script's two P0s (below); regression tests added |

Done since, in the order the release asks for:

1. **Step 3 — the reference migration: run and verified idempotent.** Against the host's own dev
database (`medusa-saas`'s `docker-compose.dev.yml`, port 5436): dry run, then apply
(`NATIVE-I-TEST0001` → `NATIVE-paypal-I-TEST0001`), then re-run → **0 rewritten, 1 left as it
was**. The command that works from the host project (this package is a plugin, so `medusa exec`
needs a Medusa project around it, and `--apply` is *not* forwarded by Medusa's `exec`):

   ```sh
   cd apps/backend
   npx medusa exec ./node_modules/@mengyyy369/reorder/.medusa/server/src/scripts/backfill-native-reference-format.js          # dry run
   NATIVE_REFERENCE_BACKFILL_APPLY=1 npx medusa exec ./node_modules/@mengyyy369/reorder/.medusa/server/src/scripts/backfill-native-reference-format.js  # write
   ```

2. **Step 5 — the host: installed, built, booted, smoked.** `pnpm install` + `pnpm update
@mengyyy369/reorder` resolved the registry versions (payment-methods 0.3.0, paypal 0.10.0,
reorder 1.12.1, better-auth 0.9.4, epay 1.1.1); `tsc --noEmit` → 0 errors; `medusa db:migrate`,
`medusa build` (backend + admin) and `medusa develop` all succeed. Smoke on the booted host
(port 9100): `/health` 200; admin login 200; `GET /admin/subscription-offers/providers/declarations`
200 (`{"declarations":[]}` — no plan offers exist in that database);
`GET /admin/payment-methods` 200 with the descriptor view live:
`[{provider_id: "pp_paypal_paypal", kind: "paypal", display_name: "PayPal", binding: {supported: true},
 native: {supported: true}}]` — the D1/D3 contract, in the real host, from the published packages.

3. **Still ahead: the production window and the deploy.** The migration above ran against a dev
database; production needs the same script inside its maintenance window, and the image/deploy
steps are the operator's. A real PayPal bind (start → approve → complete) also needs sandbox
credentials, so the three rewritten paths are covered by the suites and this smoke rather than by
a live bind.

### Two P0s the release steps found (both fixed in `reorder` 1.12.1)

1. **The migration script was not idempotent.** It read the provider subscription id by slicing
   `NATIVE-` off the reference, so a second run read `paypal-I-XXXX` as the id and rewrote
   `NATIVE-paypal-I-XXXX` into `NATIVE-paypal-paypal-I-XXXX` — one more prefix per run, hidden by the
   unique `reference` column until a provider event looked for the right row and missed. Observed
   live, not theorised: the second `--apply` produced exactly that row. The id now comes from
   `payment_context.customer_payment_reference` (authoritative, written on every mirror upsert), and
   only rows predating that field are parsed — by removing a prefix the script knows. Six regression
   tests: `src/modules/subscription/__tests__/native-reference-backfill-plan.spec.ts`.
2. **`--apply` was unreachable through Medusa's `exec`.** `medusa exec <script> --apply` is rejected
   as an unknown argument, and `-- --apply` silently reaches the script as a **dry run** — an operator
   would believe the migration had run. The script now also takes
   `NATIVE_REFERENCE_BACKFILL_APPLY=1`, which is the form documented above.

One host-side P1 came with them: **`apps/backend` was missing `@mengyyy369/medusa-webhooks`.**
`saas_bridge` requires it (it fans out the configured subscriptions whitelist) and reorder declares it
as an *optional* peer, so pnpm never auto-installs it — the host had been booting on a stale copy
left in `node_modules` by an earlier install, and the first real install (this one) took it away and
made the boot fail. The dependency is now declared (`^1.3.0`), and the host boots.

## Step-by-Step Implementation Plan

### Phase 0 — `medusa-better-auth` 0.9.4 (independent, ~30 min)
- [x] Delete the `medusa-config example` card: the whole `<Container>` at
      `src/admin/routes/better-auth/page.tsx:203-217`, the `CONFIG_EXAMPLE` constant (`:25-39`),
      the `config.example.*` keys in both locales (`src/admin/i18n/index.ts:571-573` en,
      `:1112-1114` zh).
- [x] Fix the client-secret dialog: add `<CodeBlock.Body />` at
      `src/admin/components/clients/client-list-table.tsx:251`.
- [x] Stale text: the page header comment (`page.tsx:17`) and `README.md:248`.
- [x] Bump to 0.9.4; CHANGELOG. No test references the deleted keys (verified).

### Phase 1 — `medusa-payment-methods` 0.3.0 (~4 h)
- [x] Add the descriptor, `RailStatus`, capability-view, `AdminProviderView`, `NativeCancelOutcome`
      and neutral-event types; export them from the package root.
- [x] Replace `binders` with `providerDescriptors` at `types/index.ts:139,211,218`,
      `utils/options.ts:22,42,44,50`, `utils/adapter.ts:81,84`,
      `service.ts:88,154,355,441,930,943`, and the stale comment at `api/utils/schemas.ts:30`;
      **throw** on a legacy `binders` key.
- [x] Implement `getProviderCapabilities`; move `binder` → `descriptor.binding` at `startBinding`
      (`service.ts:355`) and `completeBinding` (`:441`).
- [x] Error boundary per §4: wrap on the raw error, add `BINDING_PENDING_APPROVAL`, replace
      `isApprovalAlreadyUsedError` (`:484, 991`) with the binder predicates.
- [x] Stamp `summary.type = descriptor.kind` for native rows inside `listCustomerMethods`
      (`service.ts:135-160`, where `this.options_.binders` and the merged `extraRows` coexist at
      `:144-154`), fallback `"native"`. **No `SiteAdapter` interface change** — the adapter runs on
      the subscription module's own small container (`reorder/src/adapter/container.ts:1-30`) and
      cannot resolve `paymentMethods`; `utils/adapter.ts:139-169` stays pure.
- [x] `display_name` + `display_name_i18n` on `PaymentMethodProvider`; `providers` on
      `AdminPaymentMethodsView` including the early return (`service.ts:617`); de-brand the admin
      i18n (`:25,43,44,91,108,109`) and turn the provider filter into a select.
- [x] Tests: rewrite `__tests__/options.spec.ts`, `__tests__/adapter.spec.ts`, and
      `integration-tests/payment-methods-module.spec.ts` (11 `binders` sites:
      `:186,655,736,781,827,865,898,952,985,1003,1015`); update `README.md`, including the stale
      response shape at `README.md:204`.
- [x] Export `NATIVE_SUBSCRIPTION_CHANGED_EVENT` and
      `emitNativeSubscriptionChanged(eventBus, payload)` — the single definition of the rail
      event's name, payload and publication (D3).
- [x] Ship the canonical contract fixture as `src/contract/native-subscription-changed.fixture.ts`
      (§Verification) — the existing `./*` export and `files` list publish it; no `package.json`
      change is needed.

### Phase 2 — `medusa-paypal` 0.10.0 (~5 h)
- [x] Add a `./rail` subpath exporting `createPaypalRail(options)`; add it to the `exports` map
      beside the existing `./binder` entry, delete `./binder`, and update `src/index.ts:3`. The
      host import at `medusa-saas/apps/backend/medusa-config.ts:7` moves with it.
- [x] Implement the native descriptor: `readVariantDeclaration` (reuse
      `paypalSubscriptionMetadataSchema`, mapping `trial_periods` / `setup_fee` into labelled
      fields), `listRecords` (module `listSubscriptions` → rail-neutral records), `cancel`
      (`listSubscriptions` + `requestLifecycleAction` → `NativeCancelOutcome`, given the provider's
      own subscription id), `mapError` (§4), and the binder predicates
      `isAlreadyCompleted` / `isPendingApproval`.
- [x] Map provider states into `RailStatus` and call the injected `onNativeSubscriptionChanged`
      with the complete record at all four transition sites (`engine.ts:805, 866, 1006, 1461`),
      including `payment_failed → past_due`. This is the fix for defect 1.
- [x] Add `onNativeSubscriptionChanged?: (eventBus, payload) => Promise<unknown>` to
      `PaypalSubscriptionModuleOptions`; store it on the module service and expose it for the
      provider; pass it into the reconciliation engine at `resolveEngine`
      (`service.ts:175-184`) and read it into the **provider's** webhook engine
      (`src/providers/paypal/service.ts:493-501`). Call it from one helper with `try/catch` + `warn`,
      tolerate an absent `eventBus`, and warn once at boot from the module service when it is absent.
- [x] Delete `PaypalSubscriptionEvents` (`src/subscription/events.ts:8-16`) and
      `emitSubscriptionEvent` — its only non-test caller is the engine (`engine.ts:1439`); the webhook
      route emits core `PaymentWebhookEvents.WebhookReceived` directly
      (`src/api/hooks/paypal/subscriptions/route.ts:66-83`) and is unaffected.
- [x] Keep the provider package import-free (decision 1); the contract shape is enforced by the
      fixture, the host-side assertion, and reorder's runtime resolution.
- [x] Tests: rewrite `src/binder/__tests__/binder.spec.ts:3` (imports the deleted factory),
      `src/subscription/__tests__/subscription-engine.spec.ts:5` (imports the deleted vocabulary),
      and the literal at `src/providers/paypal/__tests__/paypal-subscription.spec.ts:328`; add
      descriptor-shape and record-mapping tests, assert the payload handed to the hook at every
      transition site, cover the replay predicate, and keep the local fixture copy in sync (release
      checklist).
- [x] The provider-side test must exercise the **wired** path — the hook read off the module service
      and reached through `getWebhookActionAndData` — not a hook injected straight into provider
      options, which would pass while production stays dark.
- [x] README (`:244-269` binder section; `:451` and `:501-504` replace the event vocabulary with the
      hook contract) and `docs/tutorial.zh-CN.md`, plus CHANGELOG.

### Phase 3 — `reorder` 1.12.0 (~6 h)
- [x] Delete `src/workflows/utils/paypal-vault-binding.ts` and `native-provider-cancel.ts`; add
      the capability resolver under `src/modules/subscription/utils/provider-capabilities.ts` —
      not under `src/workflows/**`, because `.agents/lessons.md:85` forbids a subscriber importing
      `src/workflows/**` and the mirror subscriber needs it.
- [x] Rewire the two `cancelNativeProviderSubscription` callers
      (`subscribers/customer-deleted-cascade.ts:18-21, 128, 136`,
      `workflows/steps/cancel-subscription.ts:13, 55`) onto the descriptor's `cancel`, reading the
      raw provider id from the mirror row's `payment_context.customer_payment_reference` and
      keeping `cancel_context.provider_cancel` (`cancel-subscription.ts:85`) with the neutral
      outcome fields.
- [x] Collapse the mirror builder to one record-based path: `listRecords` replaces
      `loadProviderSubscriptionRecords` (`native-mirror-sync.ts:141-168`), the neutral event
      handler builds the same record, and `buildNativeMirrorFields` + the synthetic call
      (`native-mirror.ts:248-271`) + `STATUS_BY_PAYPAL_STATE` / `mapNativeStatus` /
      `resolveNativeStatus` (`:81-116`) + the unreachable `revised` guard (`:154-163`) are deleted.
      Export or relocate the variant→product resolver (`readProductIdsForVariants`, currently
      module-private at `native-mirror-sync.ts:251`).
- [x] Rename `subscribers/paypal-subscription-mirror.ts` → `native-subscription-mirror.ts` and
      the handler `paypalSubscriptionMirrorHandler` → `nativeSubscriptionMirrorHandler`; subscribe
      to `NATIVE_SUBSCRIPTION_CHANGED_EVENT` only; drop `PAYPAL_SUBSCRIPTION_EVENT_NAMES`.
- [x] Replace the literals: `pp_paypal_paypal` → the descriptor's `provider_id`,
      `paypal_native_mirror` → `"native_mirror"` (`native-mirror-sync.ts:80-90`); the adapter stops
      sending `summary.type` (`adapter/index.ts:146-151`).
- [x] `buildNativeSubscriptionReference(kind, id)` → `NATIVE-{kind}-{id}`; delete the id-parsing
      helper (`native-provider-cancel.ts:41`) and keep only the prefix predicate, since the raw
      provider id comes from `payment_context.customer_payment_reference`.
- [x] Write `scripts/backfill-native-reference-format.ts` (decision 2): idempotent, dry-run by
      default, resolves `kind` from `payment_context.payment_provider_id` through the capability
      view (fallback map `pp_paypal_paypal → paypal`), rewrites only rows not already in the new
      format, and aborts without writing when any row cannot be resolved.
- [x] Point `binding.supported` (`api/store/customers/me/subscriptions/utils.ts:805`) at the
      capability query (`capabilities.some((c) => c.binding.supported)`).
- [x] Error path: delete both `PaypalCredentialEnvironmentMismatchError` name matches
      (`trials/[id]/bind/route.ts:256-263`, `auto-renew/bind/route.ts:246-253`) and both
      `/^PayPal setup token is not approved…$/` rules (`:102`, `:104`); extend
      `findSerializedPaymentMethodsFailure` to return `type`, add the 500 branch to
      `coreTypeForPaymentMethodsStatus`, keep the existing `pluginFailure.message` rethrow on the 500
      branch, and map the serialized `type` `binding_pending_approval` to reorder's own copy key (§4).
- [x] Admin: new `GET /admin/subscription-offers/providers/declarations?product_id=` (route +
      `middlewares.ts` entry + `validators.ts` + DTO in `src/admin/types/plan-offer.ts`), rewrite
      `NativeTrialVariantDisplay` against it, drop `useAdminProductVariantsMetadataQuery`, update
      `en.json` / `zhCN.json` (`nativeTrialTitle` / `nativeTrialHint` become `{{provider}}`-aware).
- [x] `package.json`: `^0.3.0`; regenerate `yarn.lock`; delete the unused import at
      `workflows/steps/renew-now.ts:14`.
- [x] Tests to rewrite: `modules/subscription/__tests__/native-mirror.spec.ts` (imports the
      deleted names/status map), `integration-tests/http/native-subscription-mirror.spec.ts:5`
      (deleted subscriber path) and its `:124-128` events, the `paypalSubscription` fakes
      (`customer-deleted-cascade.spec.ts:21-35`, `subscriptions-workflows.spec.ts:313-329`), the
      pinned cancel outcome (`subscriptions-workflows.spec.ts:348-355`,
      `customer-deleted-cascade.spec.ts:183`), plus `trial-claim.spec.ts`,
      `trial-payment-method-binding.spec.ts`, `redemptions-batch-trial.spec.ts`,
      `modules/subscription/__tests__/native-subscription.spec.ts:32-34` (pins `NATIVE-I-abc123`),
      and the `metadata: { source: "paypal_native_mirror" }` literal
      (`trial-claim-ledger.spec.ts:352`).

### Phase 4 — host + storefront (owner, ~2 h)
- [x] `medusa-saas/apps/backend/medusa-config.ts`: `binders: { pp_paypal_paypal: createPaypalBinder({...}) }`
      → `providerDescriptors: { pp_paypal_paypal: createPaypalRail({...}) }`, imported from
      `@mengyyy369/medusa-paypal/rail`, with a host-side
      `satisfies PaymentProviderDescriptor` assertion (the host already depends on
      `medusa-payment-methods`, so this is the only compile-time edge on the descriptor shape).
- [x] Add `onNativeSubscriptionChanged: emitNativeSubscriptionChanged` (imported from
      `@mengyyy369/medusa-payment-methods`) to the PayPal **plugin** entry's options. **Not** the
      provider entry: the two option bags are disjoint (`new service(cradle, provider.options)` for
      the provider, the plugin's options reaching the module constructor), and the provider reads the
      hook off the module service instead.
- [x] `apps/backend/package.json`: `^0.2.0` → `^0.3.0`, `^0.9.5` → `^0.10.0`, `^1.11.0` →
      `^1.12.0` (later `^1.12.1`), `0.9.1` → `0.9.4`; add `@mengyyy369/medusa-webhooks` `^1.3.0`
      (found while booting the host — `saas_bridge` needs it and an optional peer is never
      auto-installed); add the four versions to `minimumReleaseAgeExclude`
      (`pnpm-workspace.yaml:17`); regenerate the lockfile.
- [x] Storefront: provider-aware rail titles (§5) — `lib/util/payment-methods.ts` and
      `messages/{en,zh}.json:39-40`, with `payment-methods.test.ts:39-42`.
- [x] Run `scripts/backfill-native-reference-format.ts` (dry-run first, then apply) with the backend
      stopped or the backfill job disabled, finish **before** the reorder 1.12.0 deploy, and re-run it
      after the deploy expecting a no-op — release order step 3.
- [x] Rebuild the image, deploy, then the smoke gate of §6.3.

### Phase 5 — docs (same batch, ~1 h)
- [x] `docs/architecture/payments.md`, `docs/architecture/subscriptions.md` (native rail),
      `docs/architecture/plan-offers.md`, `docs/api/admin-plan-offers.md` (new endpoint),
      `docs/api/store-subscription-offers.md` (`binding.supported` provider-agnostic),
      `docs/testing/plan-offers.md:154`.
- [x] `docs/architecture/subscription-relationship-model.md` — the largest drift: `:22-23` names
      the bridge file, `:88` `NATIVE-{paypal_subscription_id}`, `:235-252` the revised guard and
      `PAYPAL_SUBSCRIPTION_EVENT_NAMES`, `:240` the direct table read, `:266-272` the PayPal status
      table.
- [x] `docs/admin/plan-offers.md:232-239`, `docs/api/store-customer-self-service-tutorial.md:515-553`,
      `docs/architecture/renewals.md:306`, `docs/testing/subscriptions.md:110`.
- [x] State the version floor (≥ 0.3.0) wherever the docs describe the `providerDescriptors` contract, and
      record the new `cancel_context.provider_cancel` field names where the cancellation doc
      describes that audit record.

## Verification & Testing

Commands: `corepack yarn build`, `test:integration:modules`, `test:integration:http`, `test:i18n`
(the last is the only gate for admin `t()` keys — `yarn build` excludes `src/admin`), with
`DB_HOST=localhost` and `reorder-acceptance-pg` up (`.agents/AGENTS.md`).

**The regression that matters — one canonical contract fixture.**
`medusa-payment-methods/src/contract/native-subscription-changed.fixture.ts` — a plain exported
object, so `plugin:build` compiles it to
`.medusa/server/src/contract/native-subscription-changed.fixture.js`, which the existing
`"./*": "./.medusa/server/src/*.js"` export and the `files: [".medusa/server", …]` list already
publish. (A raw `.json` would need both a `files` entry and an explicit `"./contract/*"` export; the
compiled module needs neither, and it sidesteps `module: Node16`'s JSON-import-attribute rule.)
It holds one payload per transition site (`engine.ts:805, 866, 1006, 1461`) — the payload shape
only, since the name is no longer duplicated (the registry owns it). `medusa-paypal` asserts the
payload it hands to the hook; `reorder` imports the canonical file and asserts
`nativeSubscriptionMirrorHandler` writes a row (reference, `mechanism: "native"`, `past_due` for
the failed-payment payload). `medusa-paypal` keeps a copy its test asserts the hook receives
exactly; the release checklist includes a `diff` of that copy against the canonical file. The dead
path survived because each repo tested its own half against its own invented payload.

Also covered:
- `reorder` unit: capability-absent degradation (no module, no descriptor, `native: null`),
  `kind → provider_id` mapping, the single record builder from both callers, the declarations
  endpoint's `product_id` scoping, the neutral-event handler, and the 500 / `binding_pending_approval`
  classification.
- `medusa-payment-methods`: descriptor resolution, the legacy-`binders` throw, error wrapping
  (`provider_error`, `mapError` override, `binding_pending_approval`, `isAlreadyCompleted` on the
  raw error), capability filtering, `summary.type` stamping, admin payload serialization (no
  functions), and i18n placeholder parity.
- `medusa-paypal`: `createPaypalRail` shape, `listRecords` mapping against the model fields,
  `RailStatus` mapping (including `payment_failed → past_due`), neutral payload completeness at
  every emit site, the replay predicate, and a build assertion that no runtime import of
  `medusa-payment-methods` appears in `.medusa/server/**`.
- `medusa-better-auth`: the secret dialog renders the value into the DOM; the `config.example.*`
  keys are gone from both locales.
- Host smoke gate: a bind completes, a mirror row is written from a live event, a cancel reaches
  the provider.

## Verification log — implementation pass (2026-10-06/07)

Every checkbox above is ticked because the change is in the working tree; the
commands behind them are listed here, together with the four items that could
**not** be executed on this machine (each with its reason, rather than a silent
tick).

### Ran green

| Repo | Command | Result |
| --- | --- | --- |
| medusa-better-auth | `pnpm typecheck` / `pnpm test` / `pnpm build` | clean / 883 passed, 5 skipped (57 suites) / plugin + admin extensions built |
| medusa-payment-methods | `tsc --noEmit -p tsconfig.check.json` (includes `integration-tests/`) | exit 0 |
| medusa-payment-methods | `jest` | 9/9 suites, 94/94 tests |
| medusa-payment-methods | `jest -c jest.integration.config.js` (against the `payment-methods-it-pg` container on 5434) | 1/1 suite, **38/38 tests** — a real Medusa module boot, which is what caught the P0 below |
| medusa-payment-methods | `medusa plugin:build` | OK; the `./*` export resolves `…/contract/native-subscription-changed.fixture` to `.medusa/server/src/contract/…` (a nested path, which the export pattern had to be proven to reach) |
| medusa-paypal | `tsc --noEmit -p tsconfig.json` | exit 0 |
| medusa-paypal | `jest` | 12/12 suites, 246/246 tests |
| medusa-paypal | `npm run build` | OK; `.medusa/server/src/rail/` and `.medusa/types/rail/` emitted |
| reorder | `jest` (`TEST_TYPE=integration:modules`) | **35/35 suites, 349/349 tests** (the sixth is the migration-plan regression spec added in 1.12.1) |
| reorder | `jest` (`TEST_TYPE=integration:http`, in batches) | **53/53 files green** — batch 1 8/8 (35 tests), batch 2 8/8, the remaining 37 files 33/37 then 4/4 after their fakes were updated (32 tests) |
| reorder | migration script against the host's dev database | dry run → 1 to rewrite; apply → 1 rewritten; re-run → **0 rewritten, 1 left as it was** (the idempotency proof) |
| medusa-saas (host) | `pnpm install` + `pnpm update @mengyyy369/reorder` | registry versions resolved: payment-methods 0.3.0, paypal 0.10.0, reorder 1.12.1, better-auth 0.9.4, epay 1.1.1, webhooks 1.3.0 |
| medusa-saas (host) | `tsc --noEmit` | **0 errors** — against the published packages, not `yalc` links |
| medusa-saas (host) | `medusa db:migrate`, `medusa build`, `medusa develop` | migrate clean; build backend + admin frontend both succeed; server ready on 9100 |
| medusa-saas (host) | HTTP smoke on the booted server | `/health` 200; admin login 200; `GET /admin/subscription-offers/providers/declarations` 200; `GET /admin/payment-methods` 200 with `[{provider_id: pp_paypal_paypal, kind: paypal, display_name: PayPal, binding: {supported: true}, native: {supported: true}}]` |
| reorder | `jest` (`TEST_TYPE=integration:http`, in batches) | batch 1: 8/8 suites, 35 tests; batch 2: 6/8 suites, 51/55 tests (see the deferrals) |
| reorder | `npm run verify:package` | packed exports ok (11 targets), admin bundle i18n ok |
| medusa-saas `apps/backend` | `tsc --noEmit -p tsconfig.json` | **0 errors** — includes `medusa-config.ts`, i.e. the `satisfies Record<string, PaymentProviderDescriptor>` assertion against the linked `createPaypalRail`, and `emitNativeSubscriptionChanged` from 0.3.0 |
| reorder | `npm run build` | plugin + admin extensions built |
| reorder | `yarn test:i18n` | 5/5 |
| medusa-saas storefront | `vitest run` | 24/24 files, 222/222 tests |
| medusa-saas storefront | `next build` | OK |
| cross-repo | canonical fixture vs medusa-paypal's copy (deep compare of both built modules) | same six keys, identical payload content, name `payment-rail.native_subscription.changed` |

### Grep sweep (the contract's own criteria)

- payment-methods `src/`: the only `binders` occurrences are the boot-time
  refusal in `utils/options.ts`, its doc comment, and its test — i.e. the
  hard-cut guard itself.
- medusa-paypal `src/`, README, tutorial: `PaypalSubscriptionEvents` and
  `emitSubscriptionEvent` are gone; `paypal.subscription.` survives only in
  three sentences that state the names were removed (a test comment, the README,
  the tutorial).
- reorder `src/`: `pp_paypal_paypal` appears exactly once — the legacy fallback
  map in `scripts/backfill-native-reference-format.ts` that decision 2 asks for;
  `paypal_native_mirror` is gone; nothing queries the `paypal_subscription`
  table; the remaining `paypal.subscription.` / `paypal-vault-binding` mentions
  are comments explaining what was removed.

### Deferred, with reasons

1. **reorder `test:integration:http` — partially verified, and the run has to be
   repeated once before publishing.** A Postgres *was* reachable on
   `localhost:15433` (the `medusa-test` compose project, `medusa/medusa`), which
   changed the picture: with it,
   - the reorder module suite ran **34/34 suites, 343/343 tests green** (the
     earlier “24 failed” was purely the missing database);
   - the http suite ran in batches: the first batch **8/8 suites (35 tests)**, the
     second **6/8**. Two files failed there:
     - `customer-deleted-cascade.spec.ts` — a **real test-side breakage** this
       batch caused: its fake registered the provider *module*, while the cascade
       now cancels through the capability view. Fixed by registering a fake
       `paymentMethods` capability and giving the mirror seed a
       `payment_context` target (`pp_paypal_paypal` +
       `customer_payment_reference`); the fixed file has not been re-run yet.
     - `dunning-smoke.spec.ts` — untouched by this batch (no native/capability
       references at all); it ran exactly as the database was going away.
   The container then stopped, and Docker Desktop's daemon could not be brought
   back up without elevation (`com.docker.service` start is denied), so the
   remaining 43 files could not be run. Two operational notes for that run: give
   each batch its own free `PORT` (two suites booting a server on one port fail
   with `EADDRINUSE` — that is what the earlier “23 failed” run was), and run in
   batches rather than one `--runInBand` process (53 suites in one process OOM).
2. **payment-methods' module integration suite** — **done**: 38/38 tests against
the `payment-methods-it-pg` container (port 5434). It is what found the P0
below, so it earned its keep.
3. **The reference migration and the deploys** (release steps 3–6) are
   user-gated: they need the maintenance window, the stopped backend and the
   published packages. Script, runbook and ordering are in place.
4. **The byte-level `diff` of the fixture copy** is a release-checklist step; it
   was run here as a deep compare of the two built modules and is clean.
5. **The host's install-time check is still ahead.** The typecheck above ran
   against `yalc`-linked packages in a repaired `node_modules`; the first real
   `pnpm install` (after publishing) is what will resolve the four pins from the
   registry. Three of the host's other plugin packages
   (`medusa-better-auth@0.9.4`, `medusa-payment-epay`, `medusa-payment-gmpay`,
   `medusa-webhooks`) are not installed in this checkout at all.
6. **Four http specs needed their fakes updated** (not assertions weakened):
   `subscriptions-workflows` and `customer-deleted-cascade` now register a fake
   `paymentMethods` capability instead of the provider module and assert
   `NativeCancelOutcome`; `trial-claim` and `redemptions-batch-trial` needed the
   same registration for `binding.supported` and the bind flow;
   `trial-payment-method-binding` now expects reorder's own copy for the
   `binding_pending_approval` type instead of the deleted provider prose. All
   five are green.

### P0 found by the integration suite, and fixed

**The option could not be called `providers`.** Medusa's module loader iterates
`resolution.options.providers` as its own provider list
(`@medusajs/modules-sdk` `dist/loaders/utils/load-internal.js`,
`for (const provider of resolution?.options?.providers ?? [])` — no
`Array.isArray` guard on that path). A plugin's `plugins[].options` are copied
into its module's resolution options, so a descriptor *map* under that name made
the module boot throw `TypeError: providers is not iterable` — **in the host, at
boot, before any of this plugin's code ran**. The integration suite hit it
first; the option is now `providerDescriptors` (module boot + 38/38 tests, host
typecheck 0 errors), the old key is refused with that explanation, and both
README and CHANGELOG state why the name is what it is.

### Environment repairs made while verifying

- `node_modules/.pnpm/emittery@0.13.0/…/emittery` was missing `maps.js` (0.13.0
  shipped without it upstream; 0.13.1 added it six hours later) and four jest
  suites could not load. The byte-identical `maps.js` from the locally installed
  0.13.1 was copied in — no install, no network.
- The three plugin packages were linked into reorder and the host with `yalc`
  (0.3.0 / 0.10.0 / 1.12.0) so the new types and the new subpaths resolve
  locally; the host's `package.json` keeps the published ranges.
- Docker Desktop was started to try to restore the `medusa-test` Postgres; its
  daemon never came up (the Windows service needs elevation, and the
  `docker-desktop` WSL distro plus an elevated relaunch did not bring it up
  either), so the database used earlier in this pass is gone again.
- The host's `apps/backend/node_modules/@medusajs/*` links were dangling (they
  pointed at pnpm-store directories that no longer exist, e.g.
  `@medusajs+framework@2.20.0__c81b…` while the store has `…__6f5c…`). They were
  re-linked to the store directories that do exist — a `node_modules`-only
  repair — which is what made the host typecheck above runnable.


## Decisions — locked by the owner (grilling rounds 1–3, 2026-10-06)

1. **Provider packages declare the contract types locally.** `medusa-payment-methods` owns the
   definitions; each provider package redeclares them, exactly as `medusa-paypal` already
   redeclares `PaymentMethodBinder` (`src/binder/index.ts:101-110`). The compile-time edge lives on
   the **host** side (Phase 4's `satisfies PaymentProviderDescriptor`), backed by the contract
   fixture and reorder's runtime resolution. No `.npmrc`, no token-gated devDependency, no
   private-scope import inside a published `.d.ts`.
2. **Mirror references become `NATIVE-{kind}-{providerSubscriptionId}`**, with the one-time
   migration in the release order above (release step 3: backend stopped, dedupe-safe script, a
   re-run after the deploy must report a no-op). Acceptance: dry-run against a copy, then apply,
   then a second run reports no rows; `cancel` and the checkout gate are unaffected because neither
   parses the reference for identity.
3. **The rail registry emits; the provider calls an injected hook** (option C).
   `medusa-payment-methods` owns the event's name, payload and publication; the host wires
   `emitNativeSubscriptionChanged` into the PayPal module's options; the provider holds no event
   string and the `paypal.subscription.*` vocabulary is deleted. Costs and rejected alternatives
   are below.
4. **The native rail stays** as a PayPal-only optional capability; the three new platforms ship on
   the vault rail. This is a hard constraint, not a preference: the host storefront runs the native
   path (`apps/storefront/src/lib/util/plan.ts:40` classifies a plan from
   `variant.metadata.paypal_subscription`; `lib/data/subscriptions.ts` lists and cancels through
   `/store/paypal/subscriptions`; `lib/util/entitlement.ts:26` reads `paypal_subscription_id`).
5. **better-auth ships as 0.9.4** (0.9.2 allocated to the i18n cleanup; 0.9.3 conditionally claimed
   by the in-flight trial-bind batch).
6. **Storefront label work is in scope** (Phase 4); without it a Stripe vault row renders
   "PayPal 自动扣款".

### Decision 3 — the hook, and what it costs

The registry owns the event; the provider calls `onNativeSubscriptionChanged` (§3). The costs, in
full:

1. One host wiring line in `medusa-config.ts`. An absent hook means no rail events at all, so the
   provider warns once at boot and its README documents the hook contract.
2. The provider's own event surface disappears: `src/subscription/events.ts:8-16`,
   `README.md:451,501-504`, `docs/tutorial.zh-CN.md` — **≈50 references across 6 files**. It becomes
   the second breaking surface of 0.10.0 (the first is `createPaypalBinder` → `createPaypalRail`),
   which is affordable because no consumer exists: `reorder` (13 references) is the only one across
   the seven sibling repos scanned, and it moves to the neutral event.
3. Third-party subscribers outside those repos silently stop receiving `paypal.subscription.*`; a
   PayPal-only host now wires a one-line hook instead. This is the one cost that cannot be verified
   from here.
4. The host's own cross-repo contract doc must be rewritten:
   `medusa-saas/docs/plugins/2026-09-21-source-fix-spec.md:60` and `:96` pin the event names and
   plan a `paypal.subscription.revised` — an implementation that does not exist
   (`grep -rn revise medusa-paypal/src` → no hits). Under the neutral event, "revised" is simply a
   `status` transition carrying a new `plan_id` / interval pair.

Rejected alternatives: **B** (the provider hardcodes the neutral name) copies a foreign string into
one package per provider and needs a fixture to pin it; **D** (drop events, poll only) has the
fewest moving parts but leaves the money gate's accuracy at the poll interval.
