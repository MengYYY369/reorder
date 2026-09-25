# Testing: Subscriptions

This document describes the current testing strategy for the `Subscriptions` area in the `Reorder` plugin.

It covers:
- test layers
- test files
- commands
- fixture strategy
- coverage scope
- known non-goals

## Purpose

The testing setup for `Subscriptions` is designed to protect the plugin at the layers officially supported by Medusa's testing tooling.

The project currently relies on:
- module integration tests
- HTTP integration tests
- Playwright E2E browser tests (for Admin UI)
## 1. Testing Strategy

The `Subscriptions` area is tested in three main layers:

1. module/service layer
2. Medusa application integration layer
3. Playwright E2E browser testing layer
This gives coverage for:
- data model behavior
- service behavior
- query helpers
- workflows
- custom Admin API routes
- end-to-end backend flow used by the Admin UI
- browser-rendered Admin UI behavior and interactions

## 2. Test Tooling

The current setup uses Medusa-supported testing tools alongside Playwright:
- `Jest`
- `@medusajs/test-utils`
- `moduleIntegrationTestRunner`
- `medusaIntegrationTestRunner`
- `@playwright/test`

Repository files involved in the setup:
- [package.json](../../package.json)
- [jest.config.js](../../jest.config.js)
- [playwright.config.ts](../../playwright.config.ts)
- [integration-tests/setup.js](../../integration-tests/setup.js)
- [integration-tests/medusa-config.ts](../../integration-tests/medusa-config.ts)
- [e2e/auth.setup.ts](../../e2e/auth.setup.ts)
- [e2e/seed.setup.ts](../../e2e/seed.setup.ts)
- [e2e/subscriptions-list.spec.ts](../../e2e/subscriptions-list.spec.ts)
## 3. Test Layers

### 3.1 Module Integration Tests

Purpose:
- verify the `subscription` module service in isolation from full Admin flows

Current files:
- [service.spec.ts](../../src/modules/subscription/__tests__/service.spec.ts)
- [payment-methods.spec.ts](../../src/modules/subscription/__tests__/payment-methods.spec.ts)
- [consent-flip.spec.ts](../../src/modules/subscription/__tests__/consent-flip.spec.ts)
- [checkout-gate.spec.ts](../../src/modules/subscription/__tests__/checkout-gate.spec.ts)
- [stacking.spec.ts](../../src/modules/subscription/__tests__/stacking.spec.ts)
- [native-subscription.spec.ts](../../src/modules/subscription/__tests__/native-subscription.spec.ts)
- [native-mirror.spec.ts](../../src/modules/subscription/__tests__/native-mirror.spec.ts)
- [shipping-address.spec.ts](../../src/modules/subscription/__tests__/shipping-address.spec.ts)
- [store-list-serialization.spec.ts](../../src/modules/subscription/__tests__/store-list-serialization.spec.ts)

This layer is the right place for:
- service creation/update behavior
- module-level persistence behavior
- model-adjacent logic
- pure decision units the HTTP runners cannot reach cheaply: the consent-flip
  outcome table, the checkout-completion gate's decision, the repeat-purchase
  stacking decision, mirror-row field mapping, address completeness, and the store
  list serialization

Why the decision units live here rather than beside the code that calls them: only
`src/modules/*/__tests__/**/*.spec` and `integration-tests/http/*.spec` are executed
by any runner, and nothing under `src/api/` matches a `testMatch`. A rule written
inline in a route or middleware file can therefore never be asserted — not even by a
test placed beside it.

### 3.2 HTTP Integration Tests

Purpose:
- run a full Medusa application in test mode
- call the real custom Admin routes
- verify workflows and API behavior as used by the Admin UI

Current files:
- [subscriptions-routes.spec.ts](../../integration-tests/http/subscriptions-routes.spec.ts)
- [subscriptions-workflows.spec.ts](../../integration-tests/http/subscriptions-workflows.spec.ts)
- [subscriptions-admin-flow.spec.ts](../../integration-tests/http/subscriptions-admin-flow.spec.ts)
- [subscription-payment-methods.spec.ts](../../integration-tests/http/subscription-payment-methods.spec.ts)
- [subscription-from-order.spec.ts](../../integration-tests/http/subscription-from-order.spec.ts) — order-driven creation, stacking/extend purchases, idempotency and the creation-failure log
- [consent-to-auto-flip.spec.ts](../../integration-tests/http/consent-to-auto-flip.spec.ts) — the `payment.captured` consent path end to end
- [native-checkout-exclusivity.spec.ts](../../integration-tests/http/native-checkout-exclusivity.spec.ts) — the subscription track's refusal of a provider recurrence
- [native-checkout-gate.spec.ts](../../integration-tests/http/native-checkout-gate.spec.ts) — the completion-gate middleware on the core `POST /store/carts/:id/complete`, including that a refusal happens before the core handler runs
- [native-subscription-mirror.spec.ts](../../integration-tests/http/native-subscription-mirror.spec.ts) — mirror rows: event upsert, scheduler exclusion, and both write-side refusals through the real routes
This layer is the main protection for the implemented Admin behavior.

The middleware-level cases above are the only place the route wiring is exercised: a
decision unit proves the rule, an HTTP case proves the rule is installed on the path
that needs it.

Store checkout now emits the initial `subscription.created` activity-log entry through the subscription checkout workflow. When changing that flow, extend the workflow or HTTP integration layer to protect the emitted event.

### 3.3 E2E Browser Tests (Playwright)

Purpose:
- run browser automation against a live Medusa Admin dashboard
- authenticate as admin via session-based auth (`storageState` cached in `e2e/.auth/admin.json`)
- seed or verify subscription test data via PostgreSQL / Admin API setup (`e2e/seed.setup.ts`)
- verify table rendering, column headers, status badges, search filtering, and row action menus
- verify navigation from the list view to the subscription detail page
- verify detail-page status transitions (pause and resume) including API response assertions and UI feedback

Current files:
- [auth.setup.ts](../../e2e/auth.setup.ts)
- [seed.setup.ts](../../e2e/seed.setup.ts)
- [subscriptions-list.spec.ts](../../e2e/subscriptions-list.spec.ts)
- [subscription-status.spec.ts](../../e2e/subscription-status.spec.ts)

This layer protects the actual operator experience in the browser, complementing backend integration flows.

## 4. Fixture Strategy

Test data helpers are defined in:
- [subscription-fixtures.ts](../../integration-tests/helpers/subscription-fixtures.ts)

Current helpers include:
- admin auth header creation
- store customer auth header creation
- product and variant creation
- subscription seed creation
These helpers are used to:
- reduce duplication across integration tests
- keep admin route tests focused on behavior
- provide realistic seed data for lifecycle and mutation flows

## 5. Current Coverage

### Module Coverage

Covered at the module/service layer:
- subscription creation
- subscription retrieval
- subscription updates through the module service
- customer payment method resolution and listing
- consent-to-auto decisions, one case per outcome the pure function can answer
  (`consent_from_session_disabled`, `consent_field_missing`, `native_reference`,
  `already_auto`, `reference_undecidable`)
- the checkout-completion gate's decision unit: each pass-through case, the
  structured refusal, and the ordering that keeps a cosmetic title read behind the
  verdict
- the repeat-purchase stacking decision: which row is folded into, the
  accumulated-cycle ceiling, and the reference handed to the consent flip
- provider-mirror recognition by `reference` prefix and the statuses that occupy the
  billing track
- shipping-address completeness and store list serialization

### Query and Workflow Coverage

Covered through integration tests:
- list query behavior
- detail query behavior
- live customer and product enrichment with snapshot fallback for Admin reads
- pause workflow
- resume workflow
- cancel workflow
- schedule plan change workflow
- update shipping address workflow
- update payment method workflow and payment provider isolation
- invalid state transitions

### Admin API Coverage

Covered through HTTP integration tests:
- `GET /admin/subscriptions`
- `GET /admin/subscriptions/:id`
- `POST /admin/subscriptions/:id/pause`
- `POST /admin/subscriptions/:id/resume`
- `POST /admin/subscriptions/:id/cancel`
- `POST /admin/subscriptions/:id/schedule-plan-change`
- `POST /admin/subscriptions/:id/update-shipping-address`

Store checkout follow-up:
- `POST /store/carts/:id/subscribe` now exists as the dedicated subscription purchase route
- the route expects subscription metadata on the cart line item
- one-time checkout remains on standard Medusa cart completion

### Admin Flow Coverage

The file [subscriptions-admin-flow.spec.ts](../../integration-tests/http/subscriptions-admin-flow.spec.ts) covers the main end-to-end backend flow used by the Admin UI:
- list subscriptions
- open subscription detail
- pause
- resume
- schedule plan change
- edit shipping address
- cancel

This is not a browser test.

It is an integration-level flow test using Medusa-supported tooling and the same custom Admin endpoints used by the UI.

### E2E Browser Coverage

Covered through Playwright browser tests:
- list page heading and description visibility
- table column header presence (`Reference`, `Product`, `Status`, `Frequency`, `Next renewal`)
- subscription data row display
- search filtering by reference prefix
- status badge visibility on subscription rows
- navigation to subscription detail on row click
- row action menu visibility and status-appropriate options
- subscription detail page pause and resume flows: StatusBadge transitions, toast messages, API response payload (`status` field), menu item presence/absence per state

Page Object Models:
- `PlanFormPage` (`e2e/pages/PlanFormPage.ts`) — plan offer creation form
- `SubscriptionDetailPage` (`e2e/pages/SubscriptionDetailPage.ts`) — detail page navigation, status assertions, action menu interactions, prompt confirmation

## 6. Commands

Run all HTTP integration tests:

```bash
yarn test:integration:http
```

Run all module integration tests:

```bash
yarn test:integration:modules
```

Run a single HTTP test file:

```bash
TEST_TYPE=integration:http NODE_OPTIONS=--experimental-vm-modules yarn jest --runInBand integration-tests/http/subscriptions-admin-flow.spec.ts
```

Run a single module test file:

```bash
TEST_TYPE=integration:modules NODE_OPTIONS=--experimental-vm-modules yarn jest --runInBand src/modules/subscription/__tests__/service.spec.ts
```

Run Playwright E2E tests (requires running backend):

```bash
yarn test:e2e
```

## 7. What Is Intentionally Not Covered

The current test strategy does not include:
- visual regression testing / screenshot diffing
- full drawer mutation flows in Playwright (scheduled for subsequent iterations)
- storefront browser testing (managed in the storefront workspace)

Reason:
- the initial Playwright PoC focuses on the Subscriptions list page to validate infrastructure and session handling before expanding to complex drawer mutation flows

Two coverage boundaries are facts of the runner configuration rather than choices
about scope, and they are easy to write a test against by accident:

- `jest.config.js` defines `testMatch` only for `integration-tests/http/*.spec.[jt]s`
  and `src/modules/*/__tests__/**/*.spec.[jt]s` (plus the i18n suite), so the three
  specs under `src/workflows/__tests__/` are executed by no runner. Behavior that has
  to be asserted stays in one of the two executed locations, which is why the gate
  and consent decisions are pure units under `src/modules/`
- module runners build their schema from the entity models and never apply plugin
  migrations, so nothing asserted at that layer can depend on a migration's output

One wording case is knowingly unpinned: the checkout-completion gate renders an empty
stored product title as `for ''`, and no spec asserts either that rendering or the
reachability of an empty title. See *Known limitation* under *Checkout completion
gate* in `docs/architecture/subscriptions.md`.

## 8. How to Add New Tests

Use this rule of thumb:

- add a module test when the behavior belongs to the module service itself
- add an HTTP integration test when the behavior depends on real routes, workflows, auth, or request validation
- add a scenario test when you want to protect a full operational flow across multiple endpoints

For new `Subscriptions` functionality:
- prefer extending the existing `subscriptions-*` test files if the change matches their scope
- create a new focused test file only when the flow becomes large enough to deserve its own scenario

## 9. Practical Guidance for Future Contributors

When changing the `Subscriptions` area:
1. update or add a module test if the service behavior changes
2. update or add an HTTP integration test if route behavior, validators, or workflows change
3. update the scenario test if the main Admin operator flow changes

If a feature changes the contract of:
- list filtering
- sorting
- mutation rules
- returned detail payload

then the corresponding integration tests should be updated in the same change set.

## 10. Summary

The `Subscriptions` area is tested through Medusa-supported integration layers alongside Playwright browser automation for the Admin UI.

This provides strong protection for:
- domain behavior
- workflow behavior
- Admin API contract
- the main Admin operational flow
- browser-rendered Admin UI interactions and navigation
