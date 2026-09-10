# Spec: PayPal Auto-Renewal Support (medusa-paypal vault + reorder contract)

## TLDR & Overview

The reorder plugin implements subscription renewals, dunning, and payment-method
management fully provider-agnostic: the auto-renewal scheduler charges off-session
through the Medusa Payment Module using `subscription.payment_context`
(`payment_provider_id` + `payment_method_reference`). It ships no provider code of
its own. The user's PayPal provider fork (`D:\Projects\medusa-paypal`, based on
`@alphabite/medusa-paypal` 0.2.6) implements one-shot capture only — no vault, no
off-session charging, no saved methods, no PayPal recurring capability of any kind.

This feature adds PayPal as a fully supported auto-renewal rail:

1. At checkout the buyer approves PayPal once; the provider vaults the payment
   method (PayPal Vault API v3, "save with purchase") and exposes the vault token
   id in the payment session data under the `payment_method` key reorder already
   reads — so reorder's subscription minting needs **zero code changes**.
2. Every renewal cycle, reorder's existing scheduler charges off-session
   (merchant-initiated) through the provider using the stored vault token.
3. Manual (redirect) renewals use PayPal's approval link, which reorder's manual
   flow already consumes as `redirect_url`.

Billing Agreements (deprecated by PayPal) and the PayPal Subscriptions API (PayPal
would own the billing schedule and bypass reorder's scheduler/dunning entirely)
were evaluated and rejected during design review.

## Settled decisions (design review, 2026-09-10)

| Decision | Choice |
|---|---|
| Recurring model | B — vault token + merchant-owned schedule (reorder scheduler drives) |
| PayPal mechanism | Vault API v3 + Orders v2 `payment_source.paypal.vault_id` |
| SDK | `@paypal/paypal-server-sdk` 1.0.0 already in the fork; its `vaultController` and Orders wallet model cover everything needed (verified against the 1.0.0 tarball). No new dependencies. |
| Provider code location | `medusa-paypal` fork (package renamed to `@mengyyy369/medusa-paypal`, repo links pointed at the fork) |
| reorder code changes | Near zero: PayPal decline-code mapping in dunning classification, defensive PayPal label in payment-method summary, storefront contract docs |
| Scope v1 | Checkout vault save (CIT), auto off-session renewal (MIT), manual redirect renewal, saved-methods listing/swap, dunning decline-code mapping, `PAYMENT.CAPTURE.DECLINED` webhook |
| Deferred | Dispute/chargeback sync, buyer-side subscription self-service, refund granularity (fork currently refunds full captures only) |
| Storefront | Contract documentation + minimal example only; the user integrates the storefront |
| Testing | Sandbox-first: mocked PayPal HTTP for automated tests; real sandbox smoke via user-supplied credentials (env only, never committed) |
| Amount units | Medusa v2 provider amounts are MAJOR-unit decimals, never smallest-unit integers (lesson from epay/gmpay 100x overcharge fixes) |

## Proposed Architecture

### Two-repo split

- **medusa-paypal** (`D:\Projects\medusa-paypal`) — all PayPal-facing capability:
  vault save, off-session charge, approval redirect, saved-method listing, webhooks.
- **reorder** (`D:\Projects\reorder`) — the integration seam is data, not code:
  reorder keeps reading `session.data.payment_method` as
  `payment_context.payment_method_reference`. reorder changes are limited to the
  dunning decline-code mapping, the payment-method summary label, and docs.

### Session data contract (the seam)

**Checkout — save with purchase (customer-initiated):**

1. Storefront creates a Medusa payment session on the cart against the PayPal
   provider. `initiatePayment` creates a PayPal order (intent `CAPTURE`) with
   `payment_source.paypal.attributes.vault`:
   `{ store_in_vault: "ON_SUCCESS", usage_type: "MERCHANT", customer: { id } }`.
2. Buyer approves via PayPal JS SDK buttons and the session is authorized/captured.
3. After approval, the provider retrieves the order and reads
   `payment_source.paypal.attributes.vault.id` (the v3 payment-token id, status
   `VAULTED`), then writes it into session data as
   `data.payment_method = <vault_id>` (plus `data.vault_id` for provider-internal
   bookkeeping).
4. reorder's `validate-subscription-cart` picks up `data.payment_method` into
   `payment_context` exactly as it does for Stripe — no reorder change.

**Auto renewal — off-session charge (merchant-initiated):**

1. reorder's scheduler creates a session with
   `data: { payment_method: <vault_id>, off_session: true, confirm: true, capture_method: "automatic" }`.
2. The provider detects `off_session` + `payment_method` and, inside
   `authorizePayment`, creates a PayPal order with
   `payment_source.paypal.vault_id` (intent `CAPTURE`) and captures it
   immediately. No buyer interaction occurs; `PAYER_ACTION_REQUIRED` on an MIT
   order is treated as a hard failure (decline) so dunning classifies it.
3. Existing reorder dunning/retry semantics apply unchanged; the provider's
   decline payloads carry PayPal reason codes.

**Manual renewal — redirect:**

1. reorder's manual flow creates an unconfirmed session with `data: {}`.
2. `initiatePayment` already creates the PayPal order and returns an approval
   link; the provider exposes it as `data.redirect_url`. reorder's
   `create-manual-renewal` reads `redirect_url` today — no reorder change.
3. Completion flows through the existing `payment.captured` subscriber.

### Saved methods and swaps

- `listPaymentMethods` on the provider resolves Medusa account holders and maps
  `GET /v3/vault/payment-tokens` (SDK `vaultController`) to the normalized method
  shape reorder's `listCustomerPaymentMethods` already consumes. PayPal entries
  carry the payer email; brand/last4 stay `null`.
- `VAULT.PAYMENT-TOKEN.DELETED` webhook → provider surfaces a "method deleted"
  action; reorder's swap flow (re-reading context at retry time) already recovers.

### Dunning decline-code mapping (reorder)

`classifyPaymentRetryFailure` / `readPaymentErrorCode` in
`src/workflows/steps/run-dunning-retry.ts` gain PayPal reason codes alongside the
existing Stripe-shaped ones. `INSTRUMENT_DECLINED` (buyer action required —
recovery via manual renewal or method swap) and similar buyer-action codes map to
permanent failure; `INTERNAL_SERVICE_ERROR`, `UNPROCESSABLE_ENTITY` style
transient codes map to temporary. Exact list finalized during implementation
against PayPal's captured-payment error responses.

## Step-by-Step Implementation Plan

### Phase 1 — medusa-paypal foundation

- [x] Rename package to `@mengyyy369/medusa-paypal`; point `repository`,
      `bugs`, `homepage` at `MengYYY369/medusa-paypal`; drop Alphabite branding
      from `description`/`keywords` and type names; fix the store
      client-token route that imported the provider by package name (latent
      upstream bug, fatal after the rename).
- [x] Upgrade `@medusajs/*` dev + peer deps 2.13.6 → 2.20.0 (match reorder),
      `@medusajs/ui` → 4.2.2; `yarn install`; `yarn build` green.
- [x] Add a test harness (jest + @swc/jest) and lock current provider
      behavior with unit tests (12 baseline tests) before extending it.

### Phase 2 — checkout vault save (CIT)

- [x] `initiatePayment` accepts vault hints (`customer_id` in session data)
      and creates the order with `attributes.vault` (`ON_SUCCESS`, `MERCHANT`,
      `merchant_customer_id`).
- [x] After authorization/capture, stash the vault token id into session data
      as `payment_method` (in both `authorizePayment` and `capturePayment`).
- [x] Unit tests: order payload carries vault attributes; vaulted capture
      yields `data.payment_method`; non-vaulted orders behave as before.

### Phase 3 — off-session renewal charge (MIT)

- [x] `initiatePayment` skips order creation for off-session session data;
      `authorizePayment` creates the order against
      `payment_source.paypal.vault_id` and captures it.
- [x] Outcomes: `COMPLETED` → authorized (capture short-circuits); decline or
      create/capture error → MedusaError with the PayPal reason attached as
      `decline_code`; non-completed capture status → unauthorized error.
- [x] Unit tests: MIT happy path, decline reason surfaced, order-create
      failure, missing amount/currency guard.

### Phase 4 — manual redirect + saved methods

- [x] `initiatePayment` exposes the PayPal `approve` link as
      `data.redirect_url` (consumed by reorder's manual renewal flow).
- [x] `createAccountHolder` keys the Medusa account holder to the Medusa
      customer id (used as `merchant_customer_id`); `listPaymentMethods` maps
      `GET /v3/vault/payment-tokens` for that id to normalized method records
      (`type: "paypal"`, payer email). New store route
      `POST /store/paypal/account-holder` creates the holder.
- [x] Unit tests for both.

### Phase 5 — webhooks + reorder glue

- [x] Provider webhooks: `PAYMENT.CAPTURE.DECLINED` → `failed` action
      (Medusa's subscriber ignores failed actions, so this is contract only);
      signature-verification failures now return `not_supported` instead of
      the previous unsafe `failed` mapping; `VAULT.PAYMENT-TOKEN.DELETED`
      intentionally `not_supported`.
- [x] reorder dunning: **no code change needed** — `readPaymentErrorCode`
      already reads `decline_code`, `readNestedErrorCode` lowercases (so
      PayPal's `INSUFFICIENT_FUNDS` hits the temporary bucket) and the
      decline-message rule already catches `INSTRUMENT_DECLINED` as permanent.
      Pinned by the provider's decline_code contract and the mapping docs.
- [x] reorder unit test: `toPaymentMethodSummary` renders a PayPal-shaped
      method (`type: "paypal"`, null card fields) — payment-methods.spec.ts.
- [x] reorder integration regression: 29 suites / 152 tests green; plugin
      build green. No behavioral change for non-PayPal providers.

### Phase 6 — docs + release

- [x] reorder `docs/architecture/payments.md`: PayPal storefront contract
      (vault attributes, RDA requirement, account gates) and the dunning
      decline-mapping paragraph.
- [x] medusa-paypal README: fork rebranding, version table, dedup, and the
      "Vaulted Auto-Renewals" section (checkout contract, renewal contract,
      PayPal account requirements).
- [ ] Version bump, CHANGELOG, publish `@mengyyy369/medusa-paypal` (user-approved
      commit messages before any push, per standing convention).

## Verification & Testing

- medusa-paypal: `yarn build` green on 2.20; jest unit suite covering every new
  provider behavior with mocked PayPal HTTP; no live network in CI.
- Optional env-gated sandbox smoke script (`PAYPAL_SANDBOX_*` env vars) the user
  can run against real sandbox credentials.
- reorder: unit tests for the dunning mapping additions; existing 29-suite
  integration regression green; docs updated for behavior that shipped.

## Risks & flagged unknowns

1. Exact PayPal JS SDK button props for save-with-purchase could not be confirmed
   from docs (page body unfetchable); the storefront contract documents the
   confirmed server-side fields and links the official JS guide.
2. Whether PayPal's reference-transaction approval gates only saving or also the
   later MIT charge is inference; production enablement is the user's parallel
   action item (three gates: reference-transaction approval, account eligibility
   review, per-app dashboard toggle — sandbox included for testing vault).
3. RDA (risk data) is mandatory on customer-initiated transactions using a PayPal
   token; missing RDA is likely declined. Storefront contract must call this out;
   sandbox tolerance unverified.
4. Vault availability is region-limited (~35 countries).
5. The fork's `updatePayment`/`retrievePayment` throw "Not implemented"; out of
   scope unless the renewal paths need them.
