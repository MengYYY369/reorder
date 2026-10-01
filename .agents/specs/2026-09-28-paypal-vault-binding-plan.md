# PayPal Vault Binding — Implementation Plan (medusa-paypal)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Applies to:** `D:\Projects\medusa-paypal` (currently **0.7.1**; this capability ships as **0.8.0**), not to `D:\Projects\reorder`. This document lives in the reorder repo only because that is where the master plan is; copy it into `medusa-paypal` when work starts, or work from this path.

**Goal:** Add a **no-charge payment-method binding** to the PayPal plugin — the customer approves a PayPal setup token, the plugin exchanges it for a vault id, and nothing is charged at any point. This is what makes "bind a payment method and get extra trial days" possible: the reorder plugin creates the trial now and charges it later, and until this capability exists the only way to obtain a vault id is to capture a real payment.

**Architecture:** Three PayPal Vault v3 calls (`createSetupToken` → payer approval → `createPaymentToken`) wrapped behind two methods on the plugin's existing `paypalSubscription` module service. That module is chosen deliberately over the payment provider class: the provider class is **not reachable through the package's export map** (`"./providers/*"` shadows `"./*"`, so `providers/paypal/service` fails to resolve), the module is already container-resolvable by key, and it already owns a `PaypalService` client — a new module would need a third copy of the PayPal credentials in a plugin that already duplicates them twice.

**Tech Stack:** TypeScript, Medusa v2 module conventions, `@paypal/paypal-server-sdk` **1.0.0** (pinned), jest, standalone sandbox scripts in `.scratch/`.

**Spec:** `.agents/specs/2026-09-28-billing-engine-hardening-and-trial-conversion.md` §12 and Phase 14, findings T4 and T7. Where this plan and that spec disagree, the spec wins and the disagreement is a finding.

## Why this cannot be done from the reorder side

Recorded so nobody re-opens it:

- `D:\Projects\reorder` has **zero** PayPal dependency — no SDK, no client, no credentials, not in `package.json`.
- `medusa-paypal`'s provider class is not importable by subpath; only `providers/paypal` (the `ModuleProvider`) and `providers/paypal/paypal-core` (the `PaypalService` client class) resolve.
- The only programmatic surface another plugin can reach is `container.resolve("paypalSubscription")`, the same way medusa-paypal's own routes and jobs reach it.
- There is **no capability or version advertisement** anywhere in the plugin today.

## Uncertainties to settle before designing around this

Each of these is a fact this plan does not establish, and each one can invalidate a task. Task P4 exists to settle them; do not skip it and do not reason from plausibility.

| # | Uncertainty | Why it matters | How to settle |
|---|-------------|----------------|---------------|
| U1 | **Does a vault id obtained through a setup token work with the plugin's existing off-session charge path?** That path builds an order against `payment_source.paypal.vault_id` (`src/providers/paypal/service.ts:1267-1294`) and short-circuits `initiatePayment` when `off_session` is set and `data.payment_method` is present (`:783-790`; the same guard sits in `authorizePayment`, `:554-555`). | This is the money path. If a setup-token token is a different kind of id, the whole design fails and **there is no fallback rail** — the reorder spec's Q11 removed `provider_subscription` from the claim path. | **Answered 2026-09-28 — see Verification results below: yes.** Sandbox: create a setup token, approve, exchange, then charge a real renewal order with the resulting id. |
| U2 | **Do the four documented account gates apply to the setup-token flow?** `README.md:189-196` lists reference-transaction approval, the account eligibility review, the app's "Save payment methods" toggle, and RDA — without distinguishing the two vault flows. | Determines whether the capability works on the production account. | **Not a blocker.** The production account gates cannot be tested by the owner, so they stay a **pre-launch checklist item**: record them, build on sandbox evidence, and if they turn out to be closed at deployment the feature simply does not enable. **Sandbox signature observed 2026-09-28 — see Verification results below:** the direct vault calls probed (`POST /v3/vault/setup-tokens`, `GET /v3/vault/payment-tokens`) answered a bare `403 NOT_AUTHORIZED` on an app without the feature, while the plugin's own app — feature on — runs the whole flow. |
| U3 | **Is RDA required, and does the current storefront PayPal integration supply it?** `README.md:195` says RDA is mandatory on customer-approved flows and must be collected through the official PayPal JS SDK. A setup-token approval is a customer-approved flow. | If RDA is required and the storefront does not collect it, the host repository needs a change — an external dependency, like the storefront's missing cancel button. | Read the host storefront's PayPal integration; if it uses the JS SDK, confirm whether RDA is passed. Otherwise ask PayPal. |
| U4 | **Does a `TRIAL` cycle at `price: 0` with no `setup_fee` charge nothing at approval?** The engine attaches `setup_fee` to the TRIAL cycle when a trial exists (`engine.ts:431-438`) and it is charged at approval (`README.md:226`); the README's own trial example carries `setup_fee: 100`. The price-0 case is not what the existing sandbox harness verifies. | If a plan with a zero-price trial still charges something, "free trial" is false and the `provider_subscription` rail cannot deliver the promise. | **Answered 2026-09-28 — see Verification results below: nothing is charged.** Sandbox: create a plan with a 0-price trial and no setup fee, subscribe, and read the actual charge from `PAYMENT.SALE.COMPLETED`. |
| U5 | **How does the module service get credentialed, and can it reach the payment module?** In 0.7.x the module service no longer builds a client from module options: `resolveEngine()` resolves `getResolvedPaypalConfig()` — a per-field **db → providerOptions → pluginOptions** merge (`src/modules/paypal-subscription/service.ts:239-278`) — and constructs `new PaypalService(config)` (`:143-160`), refusing an unconfigured config through `assertPaypalConfigured` (`src/modules/paypal-subscription/lib/config-resolver.ts:187-194`). What it *cannot* do is reach the payment module: its module-local container registers only declared `dependencies`, and the definition is `Module("paypalSubscription", { service })` — no `dependencies`, no `__passSharedContainer` (`src/modules/paypal-subscription/index.ts:10-13`). | The capability must resolve credentials through the module's own resolver; the production host's provider-declaration options are **not** the authoritative layer (0.7.0's admin settings row is — the production DB carries one, version 3). | Settled in code — see Task P2 Step 1, which builds the client from the module's own `getResolvedPaypalConfig()`. |
| U6 | **Is there a working channel for the trial length to reach the provider rail?** There is not: `detectSubscriptionSession` never reads item metadata, `initiateSubscriptionSession` takes no items, and the host's session payload carries none. | It would have decided whether the offer could configure the provider rail's trial. | **Resolved — no channel is needed.** The reorder spec's Q14 concluded that each rail keeps its own trial length: the provider rail's stays in `variant.metadata.paypal_subscription.trial_periods`, because it is part of the PayPal plan's identity and a plan is immutable. Task P3 is deleted. Listed here so the next reader knows the question was asked and answered rather than missed. |

### Verification results (2026-09-28)

Run from this machine against the PayPal sandbox; scripts in `.scratch/paypal-subscriptions/` (`vault-binding-verification.cjs`, `probe-vault-permission.cjs`, `probe-vault-capture.cjs`, `probe-offsession-reuse.cjs`, `probe-credential-sources.cjs`). Full record appended to `.scratch/paypal-subscriptions/issues/07-sandbox-verification-and-docs.md`.

**U4 — answered: the 0-price trial is free.** A plan with a `TRIAL` cycle at `0.00 USD` and no `setup_fee`, created through the plugin's own client, was approved by a sandbox buyer: the subscription went `ACTIVE`, PayPal's own approval page showed a `$0.00 USD` cart, and the subscription's transactions list is empty. The `setup_fee` hazard (`engine.ts:431-438`) is configuration, and the configuration the reorder offer form sends is the safe one.

**U1 — proven end-to-end.**

- *Charge half, proven.* An `ON_SUCCESS` vault (an order with `store_in_vault: ON_SUCCESS`, approved by the sandbox buyer and captured) returned `payment_source.paypal.attributes.vault = { id: "3g796306jh8324420", status: "VAULTED" }` — a **v3 payment token**, the same namespace `POST /v3/vault/payment-tokens` returns (its own `self` link is `/v3/vault/payment-tokens/3g796306jh8324420`). `paypal-core.createOrder({ amount, currency, fractionDigits, sessionId, vaultId })` — the exact call `authorizeOffSessionPayment` makes (`src/providers/paypal/service.ts:1285-1294`) — charged it **twice** (captures `2E553114LP5630405` and `69V89180YU509222K`, 1.00 USD COMPLETED each) with no payer present. The returned order is already `COMPLETED`, and `provider.capturePayment` short-circuits on that status (`:501-509`) rather than calling `captureOrder`, which fails `ORDER_ALREADY_CAPTURED` (422, reproduced) — the comment above the off-session order creation (`:1300-1308`) describes exactly this, and the code handles it.
- *Setup-token half — proven later the same day, after the owner restored real credentials.* The full chain ran against the plugin's own sandbox app: `POST /v3/vault/setup-tokens` → `6S3005987E8102221` (`PAYER_ACTION_REQUIRED`, no order, no amount, no charge) → buyer approval on PayPal's own page ("Set up once. Pay faster next time. We'll save your choice for future payments to …") → the status reads back **`VAULTED`** → `POST /v3/vault/payment-tokens` → vault id **`64y0144389050682n`** → `paypal-core.createOrder({ …, vaultId })` → order `30U1251149992340U` **COMPLETED**, capture `54T943881F833092B`, 1.00 USD, with no payer present; a rerun charged again (order `0H074036AR3262346`, capture `5KR07836HJ7095947`).
- **Two things that run did *not* prove — closed the same day.** (i) The id was **not freshly minted**: the sandbox webhook history carries a `VAULT.PAYMENT-TOKEN.CREATED` for `64y0144389050682n` dated **2026-09-18** for the same payer, and with `permit_multiple_payment_tokens: false` PayPal returns the payer's existing token — so same-id-on-rerun is payer-level reuse, **not** request idempotency. (ii) Token *creation* was therefore never exercised. A follow-up probe (`probe-fresh-token.cjs`) set `permit_multiple_payment_tokens: true`, minted a **new** id (`31b973135p8542309`) and charged it (order `3RW70510R9341673Y`, capture `1ST85315M5738200A`) — creation works, and the reuse seen with the production setting is the documented behaviour.
- **Sandbox finding for the implementation:** the post-approval status is **`VAULTED`, not `APPROVED`** — the setup token's own links still point at `POST /v3/vault/payment-tokens` as the next step. `completeVaultApproval` must treat `APPROVED`, `VAULTED` and `TOKENIZED` as exchangeable; see the corrected Task P1 Step 3.

**U1 is settled: the design is viable.** The only thing the sandbox changed about it is the status set above.

**U2 — the gate has a failure signature.** A sandbox app without the vault feature fails the direct vault calls probed (`POST /v3/vault/setup-tokens`, `GET /v3/vault/payment-tokens`) with a bare `403 NOT_AUTHORIZED`; that was observed on a second sandbox app on this machine (a different account whose order-based `ON_SUCCESS` vaulting still worked, so the two vault paths are gated separately — whether the toggle is the exact switch that moves the 403 is not proven by that observation). The plugin's own app has "Save payment methods" and "Subscriptions" on, and the whole flow succeeds — so this is a **pre-launch checklist item with a known signature**, not an open question. The production account gates remain unverifiable without production access, as planned.

**U3 — read, and ambiguous by nature.** The host storefront's only PayPal JS SDK usage is the checkout button (`PayPalScriptProvider` + `PayPalButtons`, `intent: "capture"`, a server-created order id; `apps/storefront/src/modules/checkout/components/payment-button/providers/paypal.tsx`). No risk data is passed explicitly anywhere in `src/` (no `data-page-type`, no `clientMetadataId`, nothing RDA-shaped), and the provider/native subscription approval is a redirect-form flow rather than a JS SDK flow (`lib/data/subscriptions.ts:97-103`). `@paypal/react-paypal-js` 8.9.2 is installed. So the existing checkout supplies risk data only implicitly, through the SDK; a redirect-based setup-token approval would supply none. Whether PayPal enforces RDA on vault-without-purchase approvals is **not settled by this reading** — record the ambiguity, and if it turns out to be required, the approval must ride the JS SDK's vault flow rather than a plain redirect.

## Global Constraints

- **English for every artifact** — code, comments, docs, commit messages.
- **Never use `any` in new code.** The existing `as never` casts in the mirror writers are pre-existing and out of scope.
- **The pinned SDK is `@paypal/paypal-server-sdk` 1.0.0.** Do not upgrade it as part of this work; the Vault v3 surface this plan needs already exists at that version.
- **Nothing in this plan writes to production. Sandbox only.** The production account gates (U2) are not checked here at all — the owner has no production test access, so they are a pre-launch checklist item recorded in `README.md`.
- **Never log a setup token, a vault id or an approval URL.** They are payment credentials in transit: no `logger.info` of a request or response body, and error messages must not embed them.
- **The reorder repository is not edited.** It consumes this capability over a runtime contract; if the contract needs to change, change it here and update the reorder plan, do not reach across.
- **This is a minor version bump: 0.7.1 → 0.8.0.** New capability, no breaking change. (0.7.0/0.7.1 are already released — see `CHANGELOG.md`; the host pins `^0.7.1` and must be bumped separately.)
- **Do not delete or "fix" the `trial_requires_payment_method` comment** in the reorder repo from here (`src/modules/plan-offer/types/index.ts:56-68`). It is a reorder-side edit, and it has **already been rewritten** (the file now carries the 2026-09-28 sandbox conclusion and the pre-launch note). Do not edit the other repository.
- **Gates:** `npm run build` (which runs `medusa plugin:build` and `tsc --project tsconfig.types.json`), `npm test`. The build is the gate that matters most: it is what produces `.medusa/server`, and a type that does not survive `tsconfig.types.json`'s `include: ["src/index.ts"]` will not be visible to a consumer.
- **Conventional Commits, approval first.** Propose the message and wait before committing or pushing. Publishing to GitHub Packages is a separate, explicit authorization.

---

### Task P1: The three Vault v3 calls, on the client

**Files:**
- Modify: `src/providers/paypal/paypal-core/paypal-core.ts`
- Create: `src/providers/paypal/paypal-core/__tests__/vault-setup.spec.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `PaypalService.createVaultSetupToken(...)`, `.getVaultSetupToken(id)`, `.createVaultPaymentToken(setupTokenId)` — consumed by Task P2.

- [ ] **Step 1: Confirm the SDK surface before writing against it**

`VaultController` is already instantiated in the client but used only for `listCustomerPaymentTokens` (`paypal-core.ts:363-370`). The three methods to call are:

```ts
vaultController.createSetupToken({ body: SetupTokenRequest })
vaultController.getSetupToken(id)
vaultController.createPaymentToken({ body: PaymentTokenRequest })
```

`SetupTokenRequest` and `PaymentTokenRequest` each carry only `customer?` and `paymentSource` — **no order id and no amount**. `PaymentTokenRequest.paymentSource.token` takes `{ id, type: "SETUP_TOKEN" }`. Verify each of these against the installed SDK types before writing; do not transcribe from this document.

- [ ] **Step 2: Create the setup token**

`paymentSource.paypal` carries `usageType: PaypalPaymentTokenUsageType.Merchant` and `experienceContext.vaultInstruction: VaultInstructionAction.OnPayerApproval` — use the SDK enums, not the `"MERCHANT"` / `"ON_PAYER_APPROVAL"` string literals: these are string enums and a literal does not typecheck. `returnUrl` and `cancelUrl` are **required** for wallet contingencies (`vaultExperienceContext.d.ts:16,18`; the SDK types mark them optional, the doc comment and PayPal's contingency flows do not). Take both as parameters and **validate them before sending** — http/https plus a configurable host allowlist: the reorder-side validator only checks `z.string().url()`, so without this an authenticated customer could hand PayPal an arbitrary post-approval redirect. Return the setup token id and the payer-approval link from `links`.

Keep `permit_multiple_payment_tokens` at its default (`false`): PayPal then returns the payer's existing token on a repeat bind, so the same PayPal account bound by two Medusa customers resolves to one vault id — that is the sandbox-observed behaviour and must not be changed without an explicit decision.

The caller's `customer_id` is a **merchant-side** id (reorder passes the Medusa customer id) and must be sent as `customer: { merchantCustomerId: customer_id }` — **not** `customer.id`, which the SDK documents as the PayPal-generated id. This is the convention the existing checkout vault path already uses (`src/providers/paypal/paypal-core/paypal-core.ts:266`), and `listVaultedPaymentMethods` reads it back by that merchant id (`:363-370`); dropping it silently disassociates the wallet from the customer.

Do **not** hard-code the return/cancel URLs: take them as parameters. The caller knows the storefront's routes; the client does not.

- [ ] **Step 3: Retrieve the setup token**

Straight wrapper over `getSetupToken`. The status enum to care about is `PaymentTokenStatus`: `Created`, `PayerActionRequired`, `Approved`, `Vaulted`, `Tokenized`. **Sandbox fact (2026-09-28): after the payer approves, the token reads back `VAULTED`, not `APPROVED`** — and its own links still point at `POST /v3/vault/payment-tokens` as the next step. Treat `APPROVED`, `VAULTED` and `TOKENIZED` as exchangeable; waiting for `APPROVED` alone stalls after every real approval.

**Registered spec disagreement** (per this document's own rule — the spec wins unless the disagreement is recorded): the master spec's Phase 14 says to poll `getSetupToken` until `APPROVED`. The sandbox evidence above makes that wrong, so this plan deliberately treats the three statuses as exchangeable; the disagreement is recorded here, not silently taken.

- [ ] **Step 4: Exchange it for a vault id**

`createPaymentToken({ body: { paymentSource: { token: { id: setupTokenId, type: VaultTokenRequestType.SetupToken } } } })`. The returned payment-token id is the value the reorder side will store as `payment_method_reference` — the same slot the existing `ON_SUCCESS` path fills with `vault_id` (`src/providers/paypal/service.ts:1321-1334`: `withVaultReference` writes both `vault_id` and `payment_method`).

- [ ] **Step 5: Tests**

Unit tests over a mocked `VaultController`: the setup-token body carries `ON_PAYER_APPROVAL`, both URLs and `customer.merchantCustomerId` (Step 2); a status outside `APPROVED` / `VAULTED` / `TOKENIZED` is surfaced rather than exchanged (sandbox returns `VAULTED` after approval — see Step 3); the exchange sends `type: "SETUP_TOKEN"`; a PayPal/SDK failure propagates as a `MedusaError` whose type is **outside the reorder-side refusal set** (`not_found` / `invalid_data` / `not_allowed` / `conflict` / `duplicate_error` / `payment_authorization_error`) — use `UNEXPECTED_STATE` for upstream/technical failures so the customer sees a 500, never a fabricated 400 refusal. `paypal-core.ts` throws raw `Error` for API failures today; the two vault methods must not inherit that silently — pin the type and say why in a comment.

### Task P2: Two methods on the module service

**Files:**
- Modify: `src/modules/paypal-subscription/service.ts`
- Create: `src/vault/index.ts` (the flow logic, so the service stays thin)
- Modify: `src/index.ts` (export the capability constant)

**Interfaces:**
- Consumes: Task P1's three client methods.
- Produces, on the container-resolvable `paypalSubscription` service:
  - `startVaultApproval({ customer_id, return_url, cancel_url })` → `{ setup_token_id, approve_url }`
  - `completeVaultApproval({ setup_token_id })` → `{ status, vault_id?, customer_id? }`
  - and the exported constant `PAYPAL_VAULT_BINDING_CAPABILITY`.
  Consumed by the reorder-side binding task.

- [ ] **Step 1: Put it on the module service — and resolve the client the 0.7.x way**

Not on the provider class: the provider class is unreachable by import (see "Why this cannot be done from the reorder side"), and its methods are dispatched by Medusa's payment module rather than called by consumers. The module service is the plugin's established programmatic surface — its own admin routes, store routes and job all reach it via `container.resolve("paypalSubscription")` / `scope.resolve(...)`.

**Credentials come from the module's own resolver — not from module options, and not from the payment module.** Since 0.7.0 the module service stores `pluginOptions` as the last fallback layer only (`src/modules/paypal-subscription/service.ts:126-133`) and builds its client from `getResolvedPaypalConfig()`, a per-field **db → providerOptions → pluginOptions** merge (`:239-278`), via `resolveEngine()` → `new PaypalService(config)` (`:143-160`); `assertPaypalConfigured` refuses an unconfigured config (`src/modules/paypal-subscription/lib/config-resolver.ts:187-194`). The production host registers this plugin as a bare string (`medusa-saas/apps/backend/medusa-config.ts:150`) but resolves credentials from the admin settings row, so the DB layer is authoritative — a client built from anything else (for example the provider declaration's env options) would silently ignore an admin edit, which is exactly what 0.7.0's "single configuration source" contract forbids.

**Do not resolve the payment module from here.** The module-local container registers only the module's declared `dependencies`; `Module("paypalSubscription", { service })` declares none and does not pass the shared container (`src/modules/paypal-subscription/index.ts:10-13`), so `resolve("payment")` throws. The payment-module route (`findPaypalProviderDeclaration` → `resolvePaypalClient`, `src/api/lib/paypal.ts:37-59,88-110`) belongs to the HTTP routes that hold the request scope; the module service cannot borrow it, and this task's Files list does not add module dependencies.

So: `const { config } = await this.getResolvedPaypalConfig()` and construct the client from it. The method already accepts an optional `{ providerOptions }` layer for callers that have one; the capability methods take none (the reorder caller has none), which is exactly why the DB layer must stay in the chain. Write the reason in a comment — a future reader will otherwise "simplify" it back to `options.clientId` and break production only. Expose the client acquisition as an overridable protected method (for example `protected async getVaultClient()`): the existing unit-test pattern only stubs `MedusaService` CRUD, and a client constructed inside `resolveEngine()` cannot be replaced from a test.

Not a new module, for the same reason plus one more: a new module would need a **third** copy of `clientId`/`clientSecret` in a plugin that already has the provider options, the module options and the 0.7.0 settings row.

- [ ] **Step 2: Two calls, not three**

Expose `startVaultApproval` and `completeVaultApproval` rather than the three raw calls. The caller should not have to know that approval is a separate polling step, and hiding it means the SDK's status vocabulary stays inside this repo.

`completeVaultApproval` returns `status` alongside `vault_id` so the caller can distinguish "not approved yet" from "approved and exchanged" from "failed" without catching exceptions for the normal pending case.

- [ ] **Step 3: Name the capability, and make it detectable**

Export a constant from the package root so a human reading the other repo knows what to look for:

```ts
export const PAYPAL_VAULT_BINDING_CAPABILITY = "vault-binding"
```

The reorder side detects it by duck-typing the resolved service (`typeof svc.startVaultApproval === "function"`), because reorder has no dependency on this package and cannot import the constant. Say that in the comment — the constant is documentation, the duck-type is the mechanism. Both matter: the constant tells a reader what "supported" means, the duck-type is what actually gates the feature.

- [ ] **Step 4: Do not touch the provider's own vault path**

`store_in_vault: ON_SUCCESS` on checkout orders stays exactly as it is. This task adds a second, independent way to obtain a vault id; it does not replace the first. A future reader will be tempted to unify them — note in the comment why they are separate: `ON_SUCCESS` requires a capture, which is precisely what a free trial cannot do.

- [ ] **Step 5: Tests**

`startVaultApproval` returns an approval URL and persists nothing; `completeVaultApproval` on a `PAYER_ACTION_REQUIRED` token returns that status and no vault id; on `APPROVED` / `VAULTED` / `TOKENIZED` it exchanges and returns the vault id; a service whose client throws surfaces a `MedusaError` with `UNEXPECTED_STATE` (upstream failure → 500), never a refusal-typed error (→ 400).

### Task P3: DELETED — the provider rail's trial length stays where it is

**This task no longer exists.** It specified a cross-repo channel for the trial length so the reorder offer could configure the provider rail's trial. The reorder spec's **Q14** concluded that channel is neither needed nor wanted: the provider rail's trial length is part of the **PayPal billing plan's identity**, and it stays in `variant.metadata.paypal_subscription.trial_periods` where it already is.

Why the channel was abandoned, recorded so nobody rebuilds it:

- **The two candidate channels are both dead.** The engine is in this repository and cannot read reorder's `plan_offer` table; and the cart-line-item metadata is never read here (`detectSubscriptionSession` reads only `variant_id` and `quantity`; `initiateSubscriptionSession` takes no items; `ensurePlan` builds from `variant.metadata`) while also being client-settable through the store cart API, so it would have made the trial length **customer-controlled**.
- **And unifying them was structurally wrong anyway.** The plan cache hash includes `trial_periods` (`metadata.ts:102-113`) and a PayPal plan is immutable. Making the offer the source would mean every edit to the offer mints a new plan and strands existing subscribers on the old one — an "edit the trial length" button that silently forks the product.

**No work remains here.** The provider rail needs nothing from this repository that it does not already have. The two properties that were worth protecting are already true and need only a test to stay true:

- **The plan cache hash uses the variant's resolved config**, and now has exactly one source, so the "two sources, one hash" hazard does not arise. If a second source is ever introduced, this is where the note belongs.
- **`setup_fee` is absent for a trial plan.** The engine attaches it to the TRIAL cycle when declared (`engine.ts:431-438`) and it is charged at approval (`README.md:225`) — the README's own example charges the customer at signup. A native-rail trial that must be free has to omit it. This is configuration, not code, and the reorder-side offer form does not send one.


### Task P4: Settle the uncertainties sandbox can settle

**Status (2026-09-28): executed — see "Verification results" above.** U1 is proven end-to-end (including token creation, via the follow-up probe), U4 is answered, U3 is read, U2's sandbox signature is recorded. Steps 1–2 ran **without Tasks P1–P2**, because those client methods do not exist yet: the setup-token calls are raw REST against the same base URL with the exact body Task P1 specifies, and the charge uses the existing compiled client — the same `createOrder({ vaultId })` the provider calls.

**Files:**
- Create / later modify: `.scratch/paypal-subscriptions/vault-binding-verification.cjs` (modes `start` / `finish` / `u1-start` / `u1-finish`; the re-run must call the real `startVaultApproval` / `completeVaultApproval` methods instead of the raw-REST setup-token calls it uses today)
- Create: `.scratch/paypal-subscriptions/probe-vault-permission.cjs`, `probe-vault-capture.cjs`, `probe-offsession-reuse.cjs`, `probe-fresh-token.cjs`, `probe-credential-sources.cjs`
- Modify: `.scratch/paypal-subscriptions/issues/07-sandbox-verification-and-docs.md` (append the result)

**Interfaces:**
- Consumes: Tasks P1–P2. **Not P3** — that task is deleted.
- Produces: a written answer to **U1, U3 and U4**, and — if U1 fails — a stop-and-report. U2 is deferred to launch; U5 is settled by Task P2 Step 1; U6 is settled by the reorder spec's Q14.

- [ ] **Step 1: Follow the existing harness's shape**

Credentials load from `~/.paypal-sandbox-credentials.json` (`clientId`, `clientSecret`, `webhookId`, `subscriptionWebhookId`, `environment`) — never print a value. `sandbox-contract-test.cjs` is the closest model. The existing scripts build against the compiled client in `.medusa/server/`, so build first.

- [ ] **Step 2: U1 — the money path**

This is the one that decides whether the feature ships. Create a setup token, approve it (the script prints the link, as `sandbox-contract-test.cjs` does), exchange it for a vault id, then use that id to charge a renewal order through the plugin's **existing** off-session path — not a bespoke charge. A bespoke charge proves the token is valid; only the real path proves the feature works.

**What the `.cjs` harness can and cannot do — as actually run.** Those scripts construct `PaypalService` and call the PayPal API directly, so they *can* exercise the plugin's own `createOrder({ vaultId })` + `captureOrder` — the exact calls the provider makes — which is how U1's charge half was proven on 2026-09-28. What they do **not** exercise is Medusa's own plumbing: a running host, a payment session, the provider's `authorizePayment` / `capturePayment` dispatch, the `COMPLETED` short-circuit inside a real capture step, and a subscription row with a due cycle. `D:\Projects\medusa-e2e` exists for exactly that and already depends on this plugin by `file:`. **That Medusa-hosted run is now the optional stronger test, not the go/no-go** — if it is run and disagrees with the client-level result, the disagreement is the finding.

- [ ] **Step 3: U4 — the free trial really is free**

Create a plan with a `price: 0` TRIAL cycle and no `setup_fee`, subscribe with the sandbox buyer, and read the actual amount from `PAYMENT.SALE.COMPLETED`. Do not infer it from the plan definition — the existing ticket 07 record shows sandbox behaviour that did not match the declared setup fee.

- [ ] **Step 4: U3 — the RDA question, answerable without production**

Read the host storefront's PayPal integration for the official JS SDK and for risk data (RDA) on customer-approved flows — do not edit that repo. That answers whether the *existing* checkout flow supplies RDA; it does not prove the setup-token flow requires the same, so if the reading is ambiguous, record the ambiguity rather than resolving it by assumption.

**U2 is not this step's work.** The four account gates cannot be checked without production access, which the owner does not have, so they are a **pre-launch checklist item** recorded in `README.md` — not a verification to run now and not a gate on this plan.

- [ ] **Step 5: Report, and stop if U1 fails**

If U1 fails, the vault-binding design is not viable and **there is no fallback rail to retreat to** — the reorder spec's Q11 removed `provider_subscription` from the claim path, because that rail is a different product rather than an alternative mechanism. So a U1 failure means the "bind and get more days" feature does not ship, and that is an owner decision about what to do instead, not something an implementer should work around. Write the outcome into ticket 07 either way, so the next reader does not have to re-run this.

### Task P5: Release

**Files:**
- Modify: `package.json` (version)
- Modify: `CHANGELOG.md`
- Modify: `README.md` (the new capability, the pre-launch account-gate checklist)

- [ ] **Step 1: Version and changelog**

0.7.1 → **0.8.0**. The changelog entry names the new capability, the two service methods, and — explicitly — that `store_in_vault: ON_SUCCESS` is unchanged.

- [ ] **Step 2: Document the capability where a consumer will look**

`README.md` gets the two method signatures, the duck-type detection idiom, and a sentence saying the caller must already have a customer — the merchant-side id that becomes `merchantCustomerId`; no PayPal customer needs to be created first. The four account gates are **already documented** (`README.md:189-196`): do not re-add them. Add the sandbox failure signature (a bare `403 NOT_AUTHORIZED` on the direct vault calls when the app lacks the feature) and mark them unverifiable until production access exists.

- [ ] **Step 3: Build, test, and stop**

`npm run build` and `npm test` must pass, **and Task P4's re-run through the real client methods must have passed** — it is the only evidence that the SDK serialization path (snake_case mapping, enums, error shapes) works, since the unit tests only assert the body this repo writes. **Publishing to GitHub Packages is a separate authorization** — propose it, do not perform it. The host's dependency bump is a third repository and is out of scope here.

## Self-Review

**Coverage:** the reorder spec's Phase 14 needs exactly two things from this repository — the setup-token flow (Tasks P1–P2) and the verification that a setup-token vault id works with the existing off-session charge path (Task P4). The release (Task P5) is this repository's own obligation because it has its own version number. **There is nothing else**: the trial-length contract this plan once specified is deleted (Task P3), because the reorder spec's Q11 and Q14 concluded the provider rail is a different product rather than a second binding method, and its trial length belongs in the variant metadata where it already is.

**What this plan does not do:** it does not change the checkout vault path, the native subscription engine's billing-cycle logic, or any reorder-side code. It adds a second way to obtain a vault id and leaves the existing one intact. **Task P3 is deleted, not stubbed** — it is kept in place, marked as deleted, so a reader who saw it in an earlier revision learns why it went rather than assuming it was forgotten.

**Type consistency:** `startVaultApproval`, `completeVaultApproval`, `PAYPAL_VAULT_BINDING_CAPABILITY`, `setup_token_id`, `vault_id`, `approve_url` — each introduced once and reused verbatim. There is no cross-repo metadata key anywhere, because no cross-repo trial-length contract exists.

**The risk this plan does not remove:** U5 (the module service's client credentials in a bare-string host) is a code-level gap that Task P2 Step 1 routes around, and U2's **production** account gates remain a launch-time item. U1 is no longer on this list: it was settled in sandbox on 2026-09-28 (setup token → approval → `VAULTED` → exchange → charged twice, plus a fresh-token run proving creation), so Task P4 Step 2's stop-and-report was not needed. What remains untested is the *Medusa-hosted* path — a real payment session dispatching `authorizePayment` / `capturePayment` — which the client-level run does not cover; see Task P4 Step 2.

## Execution Handoff

**The sandbox verification has already run (2026-09-28) and U1 passed** — see Verification results. It ran before P1/P2 because the question did not depend on them: the setup-token calls were raw REST and the charge used the existing compiled client. So the sequence is now **P1 → P2 → P5**, with P4 reduced to re-running the same script through the real client methods once they exist (the optional Medusa-hosted charge test stays available in `D:\Projects\medusa-e2e`). **P3 is deleted** — it appears in the sequence nowhere. P5 ships whatever survived.

**Before P1: adopt this plan.** Workstream A requires copying this document into `medusa-paypal` and refreshing its stale facts against the installed version — the version line (0.7.1 → 0.8.0), the line references, and U5, which 0.7.x invalidated. Do that first; do not implement from this copy unchanged.

U3's read of the host storefront is done too (Verification results): the storefront passes no explicit risk data and approves the native rail through a redirect, so the RDA question stays open only if PayPal enforces it on vault-without-purchase approvals.

Two execution options:

**1. Subagent-Driven (recommended)** — a fresh subagent per task, review between tasks.
**2. Inline Execution** — execute in this session with checkpoints.

Which approach?
