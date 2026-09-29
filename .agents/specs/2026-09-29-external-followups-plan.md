# External Follow-ups — Vault Binding, Host Storefront, PayPal Gates, and Release

> **Status (2026-09-29).** The reorder-side hardening plan
> (`.agents/specs/2026-09-28-billing-engine-hardening-plan.md`, Tasks 1–25) is
> implemented, gate-green, and committed. Everything *this* document lists
> cannot be done from `D:\Projects\reorder`: it lives in
> `D:\Projects\medusa-paypal`, in `D:\Projects\medusa-saas` (edit-forbidden
> here), in the owner's PayPal account, or in a production deployment that
> requires its own authorization.

**Deadline that orders the work.** The earliest production renewal cycle is
**2026-10-18 08:28:48 UTC** and the scheduler runs every five minutes. The
money-safety core (hardening Tasks 1–12) must be deployed before it. The trial
chain (Tasks 20–25) may slip further.

**Nothing in this document writes to production.** Production access is
read-only (`ssh ubuntu@170.106.132.210`, then
`sudo -n docker exec medusa-prod-db-1 psql -U medusa -d medusa_store`), and
deployment is a separate authorization, as with the money-basis switch.

## The four workstreams

| # | Workstream | Lives in | Depends on |
|---|------------|----------|------------|
| A | PayPal plugin: the vault-binding capability (P1 → P2 → P5) | `D:\Projects\medusa-paypal` (0.6.1 → 0.7.0) | nothing |
| B | Host storefront and host config: trial CTA, vaulted-rail cancel button, event whitelist, dependency bumps | `D:\Projects\medusa-saas` | A for the bound path; D for the endpoints |
| C | PayPal LIVE account gates (pre-launch checklist) | owner's PayPal account | production access (owner) |
| D | Production release of the reorder plugin | deploy pipeline + prod | its own authorization |

Dependency shape, in one paragraph: **D** is deadline-bound and independent of
A/B/C — the money-safety core needs none of them. **A** is independent and can
start immediately. **B**'s card-free half needs D live; B's bound half needs A
published and C passed. **C** gates only the bound (bind-a-card) path; a
card-free trial makes no PayPal calls and is unaffected by the account gates.

---

## Workstream A — medusa-paypal: the vault-binding capability

**Repo:** `D:\Projects\medusa-paypal` (0.6.1 → **0.7.0**).
**Plan:** `.agents/specs/2026-09-28-paypal-vault-binding-plan.md` (committed in
the reorder repo; copy it into `medusa-paypal` when work starts). The plan's
own Execution Handoff recommends subagent-driven execution; the sandbox
verification (its Task P4) **already passed on 2026-09-28**, so the sequence is
P1 → P2 → P5, with P4 reduced to a re-run.

The reorder side already consumes this capability and is waiting:
`src/workflows/utils/paypal-vault-binding.ts` probes the resolved
`paypalSubscription` service by duck-typing
(`typeof svc.startVaultApproval === "function"`), and the store offer DTO
reports `trial.binding.supported: false` until A2 ships. No reorder-side change
is needed when it lands — the probe flips on its own.

- [ ] **A1 — Task P1: the three Vault v3 calls on `PaypalService`**
      (`createVaultSetupToken` / `getVaultSetupToken` /
      `createVaultPaymentToken` in `src/providers/paypal/paypal-core/`).
      Two sandbox facts are settled and must not be re-litigated: `returnUrl`
      and `cancelUrl` are required and are parameters (never hard-coded), and
      after approval the setup token reads back **`VAULTED`**, not `APPROVED` —
      treat `APPROVED` / `VAULTED` / `TOKENIZED` as exchangeable.
- [ ] **A2 — Task P2: `startVaultApproval` / `completeVaultApproval` on the
      module service**, with the client built through
      `findPaypalProviderDeclaration(paymentModule)` — **not** the module's own
      client, which has empty credentials in the production host (the host
      registers the plugin as a bare string, so module options never arrive;
      this is uncertainty U5 and it only appears in production). Export
      `PAYPAL_VAULT_BINDING_CAPABILITY` from the package root as documentation;
      the duck-type is the mechanism. `store_in_vault: ON_SUCCESS` stays
      exactly as it is.
- [ ] **A3 — Task P4, reduced: re-run the setup-token verification script**
      through the real client methods once A1/A2 exist. Optional stronger
      test: the Medusa-hosted charge in `D:\Projects\medusa-e2e` (a real
      payment session dispatching `authorizePayment` / `capturePayment`). If
      it disagrees with the client-level result, the disagreement is the
      finding.
- [ ] **A4 — Task P5: release 0.7.0** — version, CHANGELOG (naming the two
      methods and that `ON_SUCCESS` is unchanged), README (method signatures,
      the duck-type idiom, and the pre-launch account-gate checklist from
      Workstream C). Gates: `npm run build` and `npm test`.
      **Publishing to GitHub Packages is a separate, explicit authorization.**

**Do not rebuild Task P3** (deleted): the native rail's trial length is part of
the PayPal plan's identity and stays in
`variant.metadata.paypal_subscription.trial_periods`. There is no cross-repo
trial-length channel and there must not be one.

---

## Workstream B — medusa-saas: host storefront and host config

**Repo:** `D:\Projects\medusa-saas` — **edit-forbidden for this repository's
tooling** (the owner's uncommitted work lives there). Someone authorized in
that repo must schedule these.
**Contract documentation:** `docs/api/store-customer-self-service-tutorial.md`
in the reorder repo — section 3 covers `POST .../cancellation/finalize` and the
whole "Trials: claiming and binding" contract, including every refusal text and
eligibility reason.

- [ ] **B1 — wire the trial CTA to the claim endpoint.** The offer DTO
      `GET /store/products/:id/subscription-offer` now returns
      `subscription_offer.trial = { is_enabled, days, requires_payment_method,
      bonus_days, eligible, reason, binding: { method: "vault", supported } }`.
      Render the trial CTA only when `eligible` is true; `reason` is one of
      `trial_not_offered`, `authentication_required`,
      `already_claimed_or_subscribed`, `eligibility_unavailable`. Claim with
      `POST /store/customers/me/trials` (`{ variant_id, region_id, binding? }`,
      customer auth). Bind with the two-phase
      `POST /store/customers/me/trials/:id/bind` (`start` → redirect to
      `approve_url` → `complete`). **Hide the bind-and-extend control while
      `binding.supported` is `false`** — it flips to `true` by itself once A2
      is deployed. The offer route now accepts optional customer auth and sets
      `Cache-Control: no-store`, so the storefront should send credentials
      when it wants per-customer eligibility.
- [ ] **B2 — the vaulted-rail cancel button.** The storefront renders a cancel
      action only for `rail === "native"`, so a vaulted customer has no button
      that reaches `POST /store/customers/me/subscriptions/:id/cancellation/finalize`
      (exposed by hardening Task 24). Wire it. Keep `POST .../cancellation`
      (which opens the retention case) exactly as it is — the retention flow is
      an option the customer may engage with, not a gate they must pass.
- [ ] **B3 — extend the host's event whitelist.** The host's
      `saas_bridge.subscriptions` list in
      `apps/backend/medusa-config.ts` must gain
      `renewal.abandoned`, `renewal.awaiting_manual_resolution`,
      `renewal.upcoming`, `subscription.trial_ending` — otherwise the host
      never receives the new events. The two `renewal.failed`-class emails
      (`saas-email-renewal-failed`, `saas-email-expired`) have subscribers in
      the host that have never fired; after D they can. Whether the host adds
      email subscribers for `renewal.upcoming` / `subscription.trial_ending`
      (the reminder emails) is a host product decision, not a plugin gap.
- [ ] **B4 — dependency bumps.** Bump the reorder plugin to the release from D
      and `@mengyyy369/medusa-paypal` to 0.7.0 once A4 publishes. Both are
      pinned in the host's backend `package.json`.
- [ ] **Note, not a task — RDA (uncertainty U3) stays open.** The host
      storefront passes no explicit risk data on any PayPal flow today (read
      2026-09-28). If PayPal turns out to enforce RDA on vault-without-purchase
      approvals, the setup-token approval must ride the official JS SDK's vault
      flow rather than a plain redirect — a storefront change, discovered only
      against the live account (Workstream C).

---

## Workstream C — PayPal LIVE account gates (pre-launch checklist)

Owner-only: the gates cannot be checked from this repository and the owner has
no production test access. They gate the **bound** path only.

- [ ] **C1 — check the four documented gates on the LIVE app:** the
      reference-transaction approval, the account eligibility review, the
      app's **"Save payment methods" toggle**, and RDA. The known failure
      signature is a bare **`403 NOT_AUTHORIZED`** on the direct vault calls
      (`POST /v3/vault/setup-tokens`, `GET /v3/vault/payment-tokens`) —
      observed on a sandbox app without the feature, while the plugin's own
      app runs the whole flow.
- [ ] **C2 — record the outcome**, including whether RDA applies (see B's
      note). If the gates are closed at launch, **the bound trial path simply
      does not enable**: `binding.supported` stays `false`, the storefront
      hides the bind button, and card-free trials are unaffected. That is a
      graceful degradation, not a release blocker.
- [ ] **C3 — the decision rule.** Do not let a closed gate become a code
      change on the reorder side. There is no fallback rail (the spec's Q11
      removed `provider_subscription` from the claim path); a gate failure is
      an owner decision about whether to pursue the JS-SDK approval flow, not
      something an implementer works around.

---

## Workstream D — production release of the reorder plugin

Separate authorization, as with the money-basis switch. Deadline:
**2026-10-18 08:28:48 UTC**.

- [ ] **D1 — authorize and schedule the release**, and pick the version. This
      is a minor bump (new endpoints, new event types): update `package.json`
      and `CHANGELOG.md`. The release carries the already-deployed i18n pin
      (`medusa-saas-backend:0.4.26`) forward.
- [ ] **D2 — build and deploy the backend image.** The money-safety core is
      hardening Tasks 1–12; Tasks 13–19 (reconciliation, reminders, docs, CI)
      may follow in the same release or the next one.
- [ ] **D3 — post-deploy verification (read-only).**
      - The two dead emails actually send: confirm from observation that the
        host's `saas-email-renewal-failed` and `saas-email-expired` subscribers
        fire. Do **not** edit `medusa-saas`; report missing configuration as a
        finding instead.
      - A failed renewal stops retrying after `renewal_max_attempts` instead
        of every five minutes forever.
      - A structurally failed period parks in `abandoned` /
        `awaiting_manual_resolution` and the corresponding events appear on the
        bus (requires B3's whitelist change to be observed host-side).
      - `POST /admin/renewals/:id/resolve-stuck` responds and settles a parked
        cycle.
      - The reminder job emits `renewal.upcoming` / `subscription.trial_ending`
        `renewal_reminder_lead_days` before a due date.
- [ ] **D4 — standing constraints.** Production DB access is read-only via the
      ssh + psql command above; never start the app against the restored
      production copy (restored payment references plus live provider
      credentials can charge real money); never print credential values.

---

## Sequencing

1. **D** — deploy the money-safety core before 2026-10-18 08:28 UTC (own
   authorization). Independent of everything else.
2. **A** — medusa-paypal P1 → P2 → P5 (can start immediately, in parallel).
3. **C** — the owner checks the LIVE gates (any time before enabling the bound
   path).
4. **B1/B2/B3** — storefront trial CTA, vaulted-rail cancel button, event
   whitelist. The card-free trial works as soon as D is live; the bound half
   additionally needs A published and C passed.
5. **B4** — dependency bumps after A4 and D.

## End-to-end acceptance — the trial feature is done when

- a customer with no prior subscription claims a card-free trial, is charged
  nothing, and the trial ends at `trial_ends_at` with no charge;
- a second claim for the same product is refused, as is a customer with any
  prior subscription of that product on any rail at any status;
- binding via PayPal (start → approve → complete) extends `trial_ends_at` by
  `trial_bonus_days` — anchored on the trial's start, so binding on day 5 gives
  the same end date as binding on day 1 — and the trial charges exactly once at
  the extended date through the vault rail;
- cancelling during a trial leaves no scheduled cycle, no charge, and no
  `renewal.failed`; the auto-renew toggle alone also prevents the charge;
- the storefront shows the bind control only when `binding.supported` is true
  and the customer is eligible.

## Owner decisions outstanding

1. Authorization and date for the reorder release (before 2026-10-18 08:28
   UTC).
2. Authorization to publish `@mengyyy369/medusa-paypal` 0.7.0 to GitHub
   Packages.
3. The LIVE PayPal account-gate check (Workstream C).
4. Whether to run the optional Medusa-hosted charge test in
   `D:\Projects\medusa-e2e`.
5. Whether the host sends emails for `renewal.upcoming` /
   `subscription.trial_ending` (host product decision).

## Closed — do not reopen

- **P3 / the cross-repo trial-length channel**: deleted. The native rail's
  trial length is part of the PayPal plan's identity and stays in variant
  metadata; making the offer the source would fork the plan on every edit.
- **The provider rail is a different product**, not a second binding method.
  Reorder never charges `NATIVE-` rows and there is no `provider_subscription`
  offer value.
- **`store_in_vault: ON_SUCCESS`** stays as it is; the setup-token flow is a
  second, independent way to obtain a vault id.
- **The money-basis switch** is done and recorded in the release docs.
- **Repo-internal leftover, not part of this plan:**
  `src/modules/settings/migrations/.snapshot-medusa-settings.json` is a stale
  pre-rename duplicate (the live snapshot is
  `.snapshot-medusa-subscription-settings.json`). Left untouched deliberately.
