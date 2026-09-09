# Testing: Redemption Codes

This document describes the current testing strategy for the `Redemption Codes` area in the `Reorder` plugin.

It covers:
- test layers
- test files
- commands
- fixture strategy
- coverage scope
- known non-goals

## 1. Testing Strategy

The `Redemption Codes` area is tested in three layers:

1. pure unit tests for the code generator
2. module integration tests for the domain service
3. HTTP integration tests for the admin and store surfaces

## 2. Test Files

- `src/modules/redemption/__tests__/code-generator.spec.ts` — generator unit tests
- `src/modules/redemption/__tests__/service.spec.ts` — module integration tests
- `integration-tests/http/redemptions-admin-routes.spec.ts` — admin API contract
- `integration-tests/http/redemptions-store-flow.spec.ts` — full store redemption flow

## 3. Commands

```bash
yarn test:integration:modules   # module + generator tests
yarn test:integration:http      # admin + store HTTP suites
```

HTTP suites are self-contained: they seed products, plan offers, customers, and batches through module services or API calls in each test.

## 4. Coverage Scope

Module layer:
- batch creation with mixed generated/custom codes
- code normalization (uppercase, case-insensitive uniqueness)
- custom-code validation and collision rejection
- grant-config validation (free cycles, frequency, window ordering)
- batch/code disable
- schema-level unique index on (`code_id`, `customer_id`)

Admin HTTP layer:
- batch create (grant-target validation: variant exists, enabled plan offer, allowed frequency)
- listing and detail (aggregated code/redemption counts)
- batch disable and code disable
- admin authentication requirement

Store HTTP layer:
- preview/redeem parity for the create resolution
- redemption-created subscription shape (`SUB-RDM-` reference, origin marker, `free_cycles_remaining`, immediate first cycle, preset `cancel_effective_at`)
- free cycles consumed by the renewal engine: N SUCCEEDED cycles, no orders, no payments, counter to zero, no cycle beyond the boundary
- validation failures: window, disabled batch, per-customer limit, exhausted code
- extension of an ACTIVE subscription (no duplicate; history shows both outcomes)
- PAST_DUE extension: dunning case recovered with `redemption_free_cycles_applied`, subscription reactivated
- expiry job: cancels expired redemption subscriptions, logs `subscription.expired`
- customer authentication requirement

## 5. Fixtures

- `integration-tests/helpers/redemption-fixtures.ts` — batch/code seeding via the module service (bypasses admin commerce validation; offers are seeded separately when the full chain is under test)
- `integration-tests/helpers/subscription-fixtures.ts` — admin/customer auth headers, product/variant, subscription seeds
- `integration-tests/helpers/plan-offer-fixtures.ts` — plan offer seeds
- `integration-tests/helpers/renewal-fixtures.ts` — renewal cycle seeds

## 6. Known Non-Goals

- No unit tests for workflow wiring; behavior is asserted through HTTP
- No Playwright E2E for the store surface (plugin ships APIs only)
- Analytics for redemptions is out of scope in v1
