# External Follow-ups — Vault Binding, Host Storefront, PayPal Gates, and Release

> **Status (2026-09-29, revised after twin-subagent review + release execution).**
> The reorder-side hardening plan
> (`.agents/specs/2026-09-28-billing-engine-hardening-plan.md`, Tasks 1–25) is
> implemented, gate-green, and committed. **Workstream D executed the same
> day:** the owner authorized the release, reorder shipped as **1.7.0**
> (commit `8778416`, tag `v1.7.0`, published to GitHub Packages), the host
> bumped to `^1.7.0` with a regenerated `pnpm-lock.yaml` (commit `ca959e7`),
> and backend image `medusa-saas-backend:0.4.35` was built per
> `medusa-saas/docs/deploy.md` §1 (Method A) and deployed per §2 — see
> Workstream D for the record. What remains lives in `D:\Projects\medusa-paypal`
> (Workstream A), in `D:\Projects\medusa-saas` (Workstream B, owner's repo),
> in the owner's PayPal account (Workstream C), or in post-deploy observation.

**Deadline that ordered the work.** The earliest production renewal cycle is
**2026-10-18 08:28:48 UTC** and the scheduler runs every five minutes. The
money-safety core (hardening Tasks 1–12) went live on 2026-09-29 — three weeks
ahead of the deadline. The trial chain (Tasks 20–25) shipped in the same
release: 25 tasks share one linear commit history, so a partial release was
never possible.

**Production access stays read-only from here** (`ssh
ubuntu@170.106.132.210`, then
`sudo -n docker exec medusa-prod-db-1 psql -U medusa -d medusa_store`).
Deployment writes only through the documented runbook with the owner's
authorization, as with the money-basis switch — granted and used on
2026-09-29 for Workstream D.

## The four workstreams

| # | Workstream | Lives in | Depends on |
|---|------------|----------|------------|
| A | PayPal plugin: the vault-binding capability (P1 → P2 → P5) | `D:\Projects\medusa-paypal` (0.7.1 → **0.8.0**) | nothing |
| B | Host storefront and host config: trial CTA, vaulted-rail cancel button, event whitelist, dependency bumps | `D:\Projects\medusa-saas` | B4a done (with D); B's bound half needs A + C |
| C | PayPal LIVE account gates (pre-launch checklist) | owner's PayPal account | production access (owner) |
| D | Production release of the reorder plugin | deploy pipeline + prod | **done 2026-09-29** |

Dependency shape, in one paragraph: **D** was deadline-bound and needed only
its own authorization plus the host dependency bump (B4a) — the reorder plugin
reaches production solely inside the host backend image, so publishing the
package and bumping `medusa-saas` precede every deploy. That ordering was
followed on 2026-09-29 (publish → host bump `ca959e7` → image `0.4.35`). **A**
is independent and can start immediately. **B**'s card-free half works against
the live 1.7.0; B's bound half needs A published and C passed. **C** gates only
the bound (bind-a-card) path; a card-free trial makes no PayPal calls and is
unaffected by the account gates.

---

## Workstream A — medusa-paypal: the vault-binding capability

**Repo:** `D:\Projects\medusa-paypal` (0.7.1 → **0.8.0**). The 0.7.x line was
taken on 2026-09-29 by another workstream — 0.7.0 shipped the admin
configuration page (`paypal_settings` / `paypal_settings_audit` tables +
migration, `GET /store/paypal/config`, hot reload) and 0.7.1 the host i18n +
audit-log sub-page; both tags exist and the host already runs `^0.7.1`. The
vault-binding release is therefore the **next minor: 0.8.0**.
**Plan:** `.agents/specs/2026-09-28-paypal-vault-binding-plan.md` (committed in
the reorder repo; copy it into `medusa-paypal` when work starts — its version
line and line references were refreshed against 0.7.1 on 2026-10-01). The plan's
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
      treat `APPROVED` / `VAULTED` / `TOKENIZED` as exchangeable. The pinned
      `@paypal/paypal-server-sdk@1.0.0` exposes all three
      (`vaultController.d.ts`), so this is glue, not SDK work.
- [ ] **A2 — Task P2: `startVaultApproval` / `completeVaultApproval` on the
      module service**, with the client built from the module's own
      `getResolvedPaypalConfig()` (the plan's Task P2 Step 1; the module-local
      container cannot resolve `payment`, and the payment-module route
      `findPaypalProviderDeclaration` → `resolvePaypalClient` belongs to the
      HTTP routes). The original U5 argument — the host
      registers the plugin as a bare string in
      `apps/backend/medusa-config.ts`, so module options never arrive and the
      module's own client has empty credentials in production — predates
      0.7.0, which introduced a DB settings resolver described as "the only
      configuration source" with client hot-rebuild on change. Re-derived
      2026-10-01 against 0.7.1: the module service builds its client from
      `getResolvedPaypalConfig()` (db → providerOptions → pluginOptions), so
      the admin settings row is authoritative and the capability must use
      that resolver — not module options, and not the payment module (the
      module-local container cannot resolve `payment`). Export
      `PAYPAL_VAULT_BINDING_CAPABILITY` from the package root as documentation;
      the duck-type is the mechanism. `store_in_vault: ON_SUCCESS` stays
      exactly as it is.
- [ ] **A3 — Task P4, reduced: re-run the setup-token verification script**
      through the real client methods once A1/A2 exist. Optional stronger
      test: the Medusa-hosted charge in `D:\Projects\medusa-e2e` (a real
      payment session dispatching `authorizePayment` / `capturePayment`). If
      it disagrees with the client-level result, the disagreement is the
      finding.
- [ ] **A4 — Task P5: release 0.8.0** — version, CHANGELOG (naming the two
      methods and that `ON_SUCCESS` is unchanged), README (method signatures,
      the duck-type idiom, the sandbox `403 NOT_AUTHORIZED` failure signature,
      and a note that the four account gates are already documented at
      `README.md:189-196` and stay unverifiable until production access
      exists). Gates: `npm run build`, `npm test`, and the A3 re-run.
      **Publishing to GitHub Packages is a separate, explicit authorization.**

**Do not rebuild Task P3** (deleted): the native rail's trial length is part of
the PayPal plan's identity and stays in
`variant.metadata.paypal_subscription.trial_periods`. There is no cross-repo
trial-length channel and there must not be one.

---

## Workstream B — medusa-saas: host storefront and host config

**Repo:** `D:\Projects\medusa-saas` — the owner's repo. The dependency bump
the release needed (B4a) was authorized and made there on 2026-09-29; the
storefront work below is still the owner's to schedule.
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
      `apps/backend/medusa-config.ts` (currently 10 members) must gain
      `renewal.abandoned`, `renewal.awaiting_manual_resolution`,
      `renewal.upcoming`, `subscription.trial_ending` — otherwise the host
      never receives the new events. The two dead customer-email subscribers
      exist in the host — `saas-email-renewal-failed` listens on
      `renewal.failed` and `saas-email-expired` on `subscription.expired` —
      and neither has ever fired; after D they can. Whether the host adds
      email subscribers for `renewal.upcoming` / `subscription.trial_ending`
      (the reminder emails) is a host product decision, not a plugin gap —
      and the host also owes a disposition decision for the two operational
      events (see owner decision 5).
- [x] **B4a — the reorder dependency bump (done 2026-09-29, with D).** The
      host installs `@mengyyy369/reorder` from GitHub Packages, so publishing
      1.7.0 alone changes nothing until the host declares it:
      `apps/backend/package.json` now says `^1.7.0` and `pnpm-lock.yaml` pins
      1.7.0 (commit `ca959e7`). This bump is a **prerequisite of every
      backend image build**, not a follow-up.
- [ ] **B4b — the medusa-paypal dependency bump.** Bump
      `@mengyyy369/medusa-paypal` to 0.8.0 once A4 publishes and the vault
      path is wanted live. The current declaration is `^0.7.1`, and a 0.x
      caret does not accept 0.8.0, so this bump is mandatory, not cosmetic.
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

**Executed 2026-09-29**, three weeks before the deadline, following
`medusa-saas/docs/deploy.md` (§1 Method A build, §2 server upgrade). Record:

- [x] **D1 — authorize, version, and release.** Owner authorization given
      2026-09-29. Minor bump to **1.7.0**; CHANGELOG written from the
      v1.6.1..HEAD history; commit `8778416` `chore(release): v1.7.0`, tag
      `v1.7.0` pushed, and the package **published to GitHub Packages** with
      tag `latest`. The release carries all 25 hardening tasks — the 25 tasks
      are one linear commit history on `main`, so nothing could be split into
      a "next release" (an earlier draft of this plan claimed Tasks 13–19
      could follow separately; that was wrong on the numbering —
      reconciliation is Tasks 8–9 — and impossible on the history).
- [x] **D2 — host bump, image build, deploy.** Host bumped to `^1.7.0` with a
      regenerated `pnpm-lock.yaml` (commit `ca959e7`, pushed), then image
      `medusa-saas-backend:0.4.35` built locally with the `.npmrc` build
      secret (never copied anywhere), shipped by `docker save | gzip` + scp to
      `~/medusa-saas/`, loaded on the server, and switched in compose after a
      `compose.yaml.bak-0.4.34` backup. **Five reorder migrations** apply on
      upgrade via `docker compose run --rm store npx medusa db:migrate`
      (the runbook's `backend` service name is stale; the service is `store`):
      `renewal` cycle states + failure bookkeeping (20260928120000),
      `settings` two columns (20260928120001), two `activity-log` CHECK
      drop/re-add migrations (20260929120000/130000), and the new
      `trial-claim` module table (20260929140000).
- [ ] **D3 — post-deploy verification (read-only).**
      - The two dead emails actually send: `saas-email-renewal-failed`
        (on `renewal.failed`) and `saas-email-expired` (on
        `subscription.expired`). **Observation protocol:** production failure
        injection is off-limits, so this verifies on the first real
        occurrence — a standing observation item, not a same-day gate. Report
        missing host configuration as a finding; do not edit `medusa-saas`
        from here.
      - A failed renewal stops retrying after `renewal_max_attempts` instead
        of every five minutes forever.
      - A structurally failed period parks in `abandoned` /
        `awaiting_manual_resolution` and the corresponding events appear on
        the bus (requires B3's whitelist change to be observed host-side).
      - `POST /admin/renewals/:id/resolve-stuck` responds and settles a parked
        cycle.
      - The reminder job emits `renewal.upcoming` / `subscription.trial_ending`
        `renewal_reminder_lead_days` before a due date.
      - Schema spot-checks after migrate: `trial_claim` table exists with its
        unique index; `renewal_cycle` accepts the two new states;
        `subscription_settings` has the two new columns.
- [x] **D4 — standing constraints (in force throughout).** Production DB
      access is read-only via the ssh + psql command above; never start the
      app against the restored production copy (restored payment references
      plus live provider credentials can charge real money); never print
      credential values.

---

## Sequencing

1. ~~**D**~~ — **done 2026-09-29**: 1.7.0 published, host bumped, image
   `0.4.35` deployed. The money-safety core is live 20 days before the
   2026-10-18 deadline; D3's observation items continue.
2. **A** — medusa-paypal P1 → P2 → P5 (can start immediately, in parallel).
   Re-derive the A2 credential premise against 0.7.x first.
3. **C** — the owner checks the LIVE gates (any time before enabling the bound
   path).
4. **B1/B2/B3** — storefront trial CTA, vaulted-rail cancel button, event
   whitelist. The card-free trial works against the live 1.7.0 as soon as B1
   ships; the bound half additionally needs A published and C passed.
5. **B4b** — the medusa-paypal bump after A4 (B4a already done).

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

1. Authorization to publish `@mengyyy369/medusa-paypal` **0.8.0** to GitHub
   Packages (A4).
2. The LIVE PayPal account-gate check (Workstream C).
3. Whether to run the optional Medusa-hosted charge test in
   `D:\Projects\medusa-e2e` (A3).
4. Whether the host sends emails for `renewal.upcoming` /
   `subscription.trial_ending` (host product decision).
5. What the host does **to the customer's SaaS entitlement** when it receives
   `renewal.abandoned` / `renewal.awaiting_manual_resolution` — keep access,
   suspend, or notify-and-wait. These two events exist precisely so the host
   can decide; until it does, a parked cycle neither charges nor cancels
   anything (that is the plugin's never-cancel rule, R3).

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
- **Public Mintlify docs sync and the `sync-docs` skill**: removed 2026-09-29
  at owner decision — the sync-after-push rule was upstream template
  machinery, not this project's workflow. The `.agents/skills/sync-docs/`
  directory, its `AGENTS.md` bullet, and the `lessons.md` rule are gone.
- **Repo-internal leftover, not part of this plan:**
  `src/modules/settings/migrations/.snapshot-medusa-settings.json` is a stale
  pre-rename duplicate (the live snapshot is
  `.snapshot-medusa-subscription-settings.json`). Left untouched deliberately.
