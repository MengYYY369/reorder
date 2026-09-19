# Spec: Merge medusa-saas-bridge into reorder

**Date:** 2026-09-19 · **Status:** ready-for-agent · **Tickets:** `.scratch/merge-saas-bridge/issues/`

## TLDR & Overview

The subscription stack currently runs as three plugins wired together in the host config: `@mengyyy369/reorder` (the subscription engine), `@mengyyy369/medusa-webhooks` (signed webhook fan-out), and `@mengyyy369/medusa-saas-bridge` (a thin glue plugin exposing six `/store/saas/*` shared-secret endpoints and forwarding subscription lifecycle events into the webhooks fan-out). The bridge exists only to serve the SaaS entitlement application; it invokes reorder workflows by string name, carries a self-healing options workaround because Medusa does not pass plugin options to subscribers, and every change requires a cross-repo release dance between three versioned packages.

This spec merges the bridge into reorder as an optional, self-contained module. After the merge, one plugin provides subscriptions plus the full SaaS integration surface; the SaaS application requires zero changes (the wire contract is byte-identical); medusa-webhooks becomes an optional peer dependency with startup fail-fast; the bridge package receives a final deprecation release and its repository is archived.

## Problem Statement

Operating the SaaS-connected store means installing and version-pinning three plugins that only work as a set. The glue plugin adds no seam anyone asked for: it is ~1.4k lines whose entire job is to call reorder internals (by fragile string-name workflow invocation that fails silently on renames), re-expose reorder state over an authenticated API, and re-publish reorder events. Its options must be smuggled into subscribers through a container workaround. Compatibility must be coordinated manually across `@medusajs` peer ranges, a minimum reorder version, and the medusa-webhooks API. A single repo drift (an upstream sync renaming a workflow, a peer bump) breaks the SaaS silently at runtime rather than at compile or boot time.

## Solution

- reorder gains an optional `saas_bridge` option namespace: `{ shared_secret, tenants?, subscriptions? }`. When absent, behavior is exactly today's reorder: the `/store/saas/*` routes exist but the auth middleware fails closed (every request rejected) and no event is forwarded. No new dependency is installed in this case.
- The six endpoints (ensure-customer, reconcile, renew, auto-renew, carts, redeem), the event-forwarding subscriber, and the shared machinery (option registry, shared-secret auth middleware, tenant resolution, snapshot building) move into reorder. Multi-tenant support is ported verbatim, including the implicit-default-tenant fallback that the SaaS webhook receiver relies on.
- Workflow invocations (create-manual-renewal, redeem-redemption-code) become direct typed imports.
- medusa-webhooks becomes an optional peer dependency: booting with `saas_bridge` configured but the package missing fails fast with an error naming the missing package.
- The wire contract is byte-identical — route paths, auth headers, request/response bodies — so the SaaS app is untouched.
- The deployment harness gains coverage for the three previously-uncovered endpoints; the bridge package is deprecated and archived after production acceptance.

## User Stories

### SaaS application (machine caller, authenticated by shared secret)

1. As the SaaS entitlement app, I want `POST /store/saas/ensure-customer` with `{ email, display_name? }` to idempotently create or find a Medusa customer and return `{ customer: { id, email } }`, so that I can map my users to Medusa customers without holding a customer session.
2. As the SaaS app, I want repeated ensure-customer calls with the same email to return the same customer id, so that retries and concurrent signups never duplicate customers.
3. As the SaaS app, I want `POST /store/saas/carts` to return `{ cart_id, currency_code, customer_id, email }` with the subscription line metadata and a valid shipping address already attached, so that I can drive checkout end-to-end without ever setting addresses myself.
4. As the SaaS app, I want `POST /store/saas/renew` with `{ subscription_id }` to return `{ order_id, redirect_url, total, currency_code, reused }`, so that my subscribers can pay a manual renewal through the cashier link.
5. As the SaaS app, I want `POST /store/saas/auto-renew` with `{ subscription_id, enabled }` to strictly return `{ subscription_id, payment_mode }`, so that my billing toggle can reject unexpected shapes instead of guessing.
6. As the SaaS app, I want `POST /store/saas/redeem` with `{ code, customer_id, subscription_id? }` to run the full redemption path — code lock, per-customer dedup, quota — and return `{ subscription_id, subscription_reference, redemption_record_id, outcome, free_cycles_remaining, dunning_recovered }`, so that secret callers without a customer session can still redeem codes safely.
7. As the SaaS app, I want `POST /store/saas/reconcile` to accept snake_case requests and return authoritative camelCase order/subscription snapshots, so that I can recover from lost or out-of-order webhooks against one source of truth.
8. As the SaaS app, I want wrong or missing secrets to yield 401-class rejections on every `/store/saas/*` route, so that a misconfigured deployment fails loudly instead of leaking data.
9. As the SaaS app, I want signed webhook deliveries for the whitelisted events — enriched with order_id, cart_id, customer_id, email, display_id, payment_status, currency_code, total, and metadata — so that my entitlement mirror converges without polling.
10. As the SaaS webhook receiver, I want reconcile to work without `X-Tenant-Id` when only one tenant is configured, so that my event handler needs no tenant plumbing.

### Store operator

11. As the store operator, I want the whole stack configured as one plugin entry with a nested `saas_bridge` option, so that my medusa-config has one less plugin to wire and version-pin.
12. As the store operator, I want an absent `saas_bridge` option to mean exactly today's reorder behavior, so that adopting the merge is zero-risk for existing deployments.
13. As the store operator, I want a boot-time error naming the missing optional dependency when `saas_bridge` is configured but medusa-webhooks is not installed, so that misconfiguration fails at startup instead of at the first event.
14. As a single-tenant operator, I want per-tenant secrets and tenant-scoped 404s (existence never leaked) when I later add tenants, so that growth does not require a redesign.
15. As the store operator, I want the publishable-key requirement on `/store/*` to keep working unchanged for bridge calls, so that server-to-server callers authenticate exactly as before.

### Plugin maintainer

16. As the maintainer, I want workflow invocations as direct typed imports, so that upstream renames fail at compile time instead of silently at runtime.
17. As the maintainer, I want the merged code isolated in a self-contained module with only two touchpoints into upstream-shared files (the middleware aggregation point and package.json), so that future upstream syncs from reorder-js stay low-conflict.
18. As the maintainer, I want the old bridge repo archived behind a final deprecation release, so that npm consumers are pointed at the merge instead of left on a drifting package.
19. As the maintainer, I want the carts placeholder shipping address documented as a load-bearing contract, so that nobody "cleans it up" and silently breaks SaaS checkout.
20. As the maintainer, I want the deployment harness to cover carts, redeem, and auto-renew, so that the three previously-uncovered endpoints — exactly where the contract surface is densest — regress loudly.
21. As the maintainer, I want the bridge's option/tenant unit matrix ported to the plugin's jest suite, so that multi-tenant rejection logic keeps its cheap, fast regression net.

### Reorder users without a SaaS

22. As a reorder user who does not connect a SaaS, I want no new dependencies, routes that reject, and no event forwarding when `saas_bridge` is not configured, so that the merge costs me nothing.

## Implementation Decisions

- **Option namespace.** reorder's plugin options gain a nested `saas_bridge: { shared_secret, tenants?, subscriptions? }`. The bridge's legacy top-level option names (`bridge_shared_secret` etc.) do not carry over; the host config is rewritten as part of the switch, so there is no legacy-config compat path to maintain.
- **Unconfigured = off.** Without `saas_bridge`, the auth middleware fails closed on all `/store/saas/*` routes (401-class for every caller) and the forwarding whitelist is empty. No optional dependency is required at boot. Configuring `saas_bridge` without a `subscriptions` whitelist keeps the endpoints active but forwards nothing (the bridge's empty-default semantics); the host always passes the whitelist explicitly.
- **Auth and multi-tenancy, verbatim.** Shared-secret header authentication with timing-safe comparison; per-tenant secrets; `X-Tenant-Id` required when multiple tenants are configured; implicit default tenant when exactly one is configured. ensure-customer stamps the tenant on creation and looks up per tenant; reconcile/renew resolve the owning customer and answer 404 (existence not leaked) on tenant mismatch.
- **Byte-identical wire contract.** Route paths, auth headers (`X-Bridge-Secret`, optional `X-Tenant-Id`, plus the publishable key required by all `/store/*` routes), reconcile's snake_case request / camelCase response split, and every response field the SaaS reads, pinned: ensure-customer `customer.id` (required) and `customer.email`; reconcile `order.orderId/paymentStatus/customerId`, `order.metadata.plan/.email/.frequency_interval`, `order.cart.currency_code`, `order.cart.items[].unit_price/.quantity`, `total`, `currencyCode`, `cartId`, `subscriptionId`, subscription snapshot `id/status/frequencyInterval/frequencyValue/nextRenewalAt/cancelEffectiveAt/paymentMode/hasPaymentMethod/orderId`, top-level `subscriptions[]`; renew `order_id` (required) and `redirect_url` (nullable), plus `total/currency_code/reused` which the SaaS ignores today; auto-renew `subscription_id` and `payment_mode` (both required, any deviation is an error); redeem `subscription_id` (required), `subscription_reference`, `redemption_record_id`, `outcome` (`subscription_created` | `subscription_extended` | null), `free_cycles_remaining`, `dunning_recovered` (default false); carts `cart_id` (required downstream), `currency_code`, `customer_id`, `email`.
- **The carts placeholder address is load-bearing.** The SaaS never sets email, shipping, or billing addresses itself; reorder cart validation requires shipping address data; cart completion depends on the placeholder the bridge attaches (digital-delivery placeholder, postal `00000`, country `cn`). It is ported unchanged and documented as contract, not cleanup material.
- **Direct workflow imports.** renew and redeem invoke the reorder workflows directly instead of through the by-name workflow engine, converting a class of silent runtime failures into compile-time errors. Payment confirmation for manual renewals remains the payment.captured subscriber's job — never the bridge's.
- **medusa-webhooks as optional peer, resolved lazily.** Declared as an optional peer dependency. Module discovery loads subscriber files even when `saas_bridge` is unconfigured, so the optional peer must never be imported at the top level of a boot-loaded file: the forwarding handler resolves the fan-out workflow dynamically at runtime, and the fail-fast check at plugin init uses the same dynamic resolution — booting with `saas_bridge` configured and the package unresolvable fails fast with an error naming the missing package, while installing or booting without it never touches the module. Forwarding behavior is unchanged: static registration on the ten lifecycle events, runtime whitelist filtering, order-ish event enrichment (order_id, cart_id, customer_id, email, display_id, payment_status, currency_code, total, metadata).
- **Options reach subscribers via the plugin entry.** The plugin boot registers `saas_bridge` options into the container; the bridge's self-heal-from-configModule workaround is dropped.
- **Placement for upstream-sync friendliness.** Shared machinery (option registry, auth middleware, tenant resolution, snapshot building, subscriber body, unit tests) lives in a self-contained saas-bridge module inside the plugin source. Route handlers sit at the framework's conventional API route paths and the forwarding subscriber at the conventional subscribers path, both thin. Exactly two shared files are touched: the middleware aggregation point and package.json. Everything else is new files upstream will never conflict with.
- **Documentation.** A dedicated doc covers the six endpoints' protocol, the pinned contract fields, multi-tenancy, the load-bearing placeholder-address warning, a host-config migration example, and the cross-repo coupling notes (cart validation and the two imported workflows are the things an upstream sync can break).
- **Harness addition.** The deployment harness gains a zero-dependency script covering carts, redeem, and auto-renew — the three endpoints with no automated checks — modeled on the existing verify scripts. Because the contract is byte-identical, the script validates against the pre-merge deployment first and doubles as post-switch acceptance.
- **Versioning and deprecation.** reorder ships the module as a minor release (1.5.0 — purely additive). The bridge receives a final release (1.4.0) that logs a deprecation warning at boot and whose README states it is merged into reorder ≥ 1.5.0; its repository is archived after production acceptance. Registry-level `npm deprecate` is not available — the bridge publishes to GitHub Packages, which does not support it.

## Testing Decisions

- **What makes a good test here:** assert external behavior only — HTTP status codes, request/response bodies, idempotency, tenant isolation, fail-closed auth — never internal call graphs or module wiring.
- **Three existing seams, zero new ones:**
  1. **HTTP seam (primary).** The plugin's existing integration:http suite boots a real server; contract tests hit `/store/saas/*` with a configured `saas_bridge` and assert the pinned bodies, plus fail-closed negative auth without configuration. Prior art: the existing integration:http suites.
  2. **Deployment acceptance seam.** The host repo's zero-dependency harness scripts run against a live store. Existing `verify-subscription-bridge` (reconcile, ensure-customer, renew, negative auth) and `verify-webhooks` (signed delivery for order.placed / payment.captured) are prior art; the new script for carts/redeem/auto-renew follows their pattern.
  3. **Unit seam (ported).** The bridge's option/tenant resolution test matrix — fail-closed without options, per-tenant secret rejection, implicit default fallback — ports as-is to jest. Exercising the full tenant matrix over HTTP would need expensive fixture data; the unit seam is the cheap home for it.
- **Contract pinning.** Integration and harness assertions pin the exact fields the SaaS reads (enumerated above), so a byte-drift breaks a test rather than production.
- **Local-run gotcha.** Harness env loading is first-file-wins and the remote config wins by default; local verification must override the base URL explicitly.

## Out of Scope

- Any behavior change to reorder's subscription engine, cart validation, or redemption semantics.
- Protocol evolution: no new endpoints, fields, or auth modes beyond the byte-identical port.
- Any SaaS-side code change (explicitly zero, verified by acceptance).
- An admin UI surface for the bridge.
- Harness automation for subscription lifecycle event deliveries (`subscription.paused/resumed/canceled`, `plan_change_scheduled`, `renewal.succeeded/failed`) — a known pre-existing gap, unchanged by this merge.
- Contributing the saas-bridge module upstream to reorder-js.
- Simplifying or removing multi-tenancy.

## Further Notes

- The SaaS webhook receiver's reconcile call intentionally omits `X-Tenant-Id` and relies on the implicit-default-tenant fallback; that fallback is therefore part of the contract, not an accident.
- The deployment harness targets the production store by default (its env loading prefers the remote config despite a stale "latter wins" comment); local runs need an explicit base-URL override.
- Cross-repo coupling to watch after the merge: an upstream sync touching cart validation or renaming the two imported workflows can break the SaaS; the doc must call this out so future syncs check those areas.
- The `renew` response fields `total`, `currency_code`, and `reused` are unread by the SaaS today but are part of the byte-identical body and stay.
- The SaaS application currently defines the renew client method without a production caller (only its client tests reference it); production coverage for renew comes from the deployment harness. The endpoint is part of the byte-identical contract regardless — the merge neither wires it into a SaaS flow nor drops it.
