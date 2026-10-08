# Spec: Fix the payment-method binding capability discriminator

## TLDR & Overview

`resolvePaymentMethodBindingCapability` decides whether the installed
`@mengyyy369/medusa-payment-methods` exposes the **container-first** binding
surface (shipped in 0.2.0) by testing the arity of the two methods:

```ts
candidate.startBinding.length < 2 ||
candidate.completeBinding.length < 2
```

**That test is always false on a real container.** Medusa resolves module
services through a wrapper whose methods report `length === 0`, so the guard
rejects *every* version, including the installed 0.3.0. The capability resolves
to `null`, `startTrialVaultApprovalStep` throws `NOT_ALLOWED`, and the trial
bind answers **400** — measured in production on 2026-10-08 with a temporary
diagnostic patch:

```
[diag-g0] resolving: paymentMethods | registrations? true
[diag-g0] candidate keys: bindRateLimiter_ | startBinding: function 0 | completeBinding: function 0
```

The feature has therefore **never worked in production**.

This spec replaces the arity discriminator with a **version** discriminator,
which does not depend on how the container wraps the service.

## Resolved Questions

- **Q1: what should happen when the installed version cannot be determined?**
  **Fail open** (user decision, 2026-10-08): accept the capability when both
  methods exist, even if the version lookup failed. A false negative here
  disables the entire binding surface with no signal — which is precisely how
  this bug reached production. A false positive surfaces as a runtime error at
  call time and creates nothing.

## Proposed Architecture & Data Model

No schema, module, workflow, or API changes. One utility function changes its
internal discriminator; its exported type and contract are untouched.

### Where

`src/workflows/utils/payment-method-binding.ts` — `resolvePaymentMethodBindingCapability`.

### How

1. Resolve the module (unchanged) and check that both methods exist (unchanged).
2. Replace the arity guard with a version guard:

   ```ts
   function installedBindingSupportsContainerArg(): boolean | null
   ```

   - Locate the plugin's `package.json` with
     `createRequire(<this file>)("@mengyyy369/medusa-payment-methods/package.json")`.
     Verified reachable from this file's own location in the production
     container: `version = 0.3.0`.
   - Parse `major.minor` and return `major > 0 || minor >= 2`.
   - Return `null` when the lookup or the parse fails, so the caller decides
     (see Q1).

3. Keep the `bind` calls that adapt the module methods to the capability type.

**Why not keep an arity check as a second signal**: the arity is `0` for *both*
the 0.2.0+ and the pre-0.2.0 signature once the service is wrapped, so it carries
no information. Keeping it would re-introduce the bug.

**Why not call the method and catch**: `startBinding` creates a provider-side
approval session. Probing it to detect a version would create real state.

## Step-by-Step Implementation Plan

### Phase 1: The discriminator

- [ ] Step 1: Add `installedBindingSupportsContainerArg()` to
      `src/workflows/utils/payment-method-binding.ts`.
- [ ] Step 2: Replace the two arity comparisons with the version guard, wiring
      the Q1 answer into the `null` case.
- [ ] Step 3: Rewrite the module doc comment — it currently documents the arity
      rule as *the* discriminator, which is the wrong lesson to leave behind.
      Record the measured evidence (`length === 0` on a wrapped service) so the
      next reader does not restore the arity check.

### Phase 2: Coverage

- [ ] Step 1: Unit-test `resolvePaymentMethodBindingCapability` with a fake
      container. The wrapped-service shape is the important case: an object whose
      `startBinding`/`completeBinding` report `length === 0`. Today that shape
      resolves to `null`; after this change it must resolve to a capability.
- [ ] Step 2: Cover the version boundary: `0.1.x` → `null`, `0.2.0` → capability,
      `0.3.0` → capability.
- [ ] Step 3: Cover "module not registered" (resolve throws) → `null`, unchanged.

### Phase 3: Documentation

- [ ] Step 1: Update `.agents/lessons.md` with the lesson: **do not use
      `Function.length` to detect a contract version on a container-resolved
      Medusa service** — the service is wrapped and every method reports `0`.
- [ ] Step 2: Update `docs/architecture/payments.md` if it restates the arity
      rule (check before editing).

## Verification & Testing

- `corepack yarn build`
- `corepack yarn test:integration:http` (the binding capability is consumed by
  the trial-bind and auto-renew-bind workflows; both have http coverage)
- The new unit tests, with a **mutation check**: restore the arity guard and the
  wrapped-service test must fail.

**End-to-end acceptance happens in the host app** (`medusa-saas`), not here: a
new plugin version must be published, the backend image rebuilt, and the trial
bind retried. Success is `POST /store/customers/me/trials/{id}/bind` answering
**200 with an `approvalUrl`** instead of 400.

## Out of Scope

- Publishing the package (separate approval; `prepublishOnly` gate exists).
- The host app's `medusa-saas` backend image rebuild.
- Any change to the plugin `@mengyyy369/medusa-payment-methods` itself. Note for
  the record: the plugin could export a capability marker so consumers never
  have to guess — worth a follow-up, but not needed once the version guard
  lands.
