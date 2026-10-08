# Spec: Manual-renewal attempt numbering + trial-bind reuse

## TLDR & Overview

Three production failures, all measured on 2026-10-08 against the live store
(`pbo.dayzcloud.com`), share one theme: **the host app assumes state that a
card-free trial never has, and never recovers when the assumption is wrong.**

1. **`/renew-now` returns 500 forever.** `createManualRenewalStep` hardcodes
   `attempt_no: 1`. `renewal_attempt` carries
   `IDX_renewal_attempt_renewal_cycle_id_attempt_no_unique UNIQUE (renewal_cycle_id, attempt_no) WHERE deleted_at IS NULL`,
   so the second `/renew` on the same cycle collides. Because a failed workflow
   step **does not roll back its own committed writes**, the first attempt and
   its order survive the failure — so the collision is permanent and the
   subscription can never be renewed again. Measured inner error:

   ```
   Renewal attempt with renewal_cycle_id: 01M47SSSV4WSSZE7PBHCXFW4WR, attempt_no: 1, already exists.
   ```

2. **The first `/renew-now` already failed**, on
   `if (!paymentContext?.payment_provider_id) throw renewalErrors.renewalOrderCreationFailed(...)`.
   A claimed trial is created with `payment_provider_id: null` **on purpose**
   (`create-trial-subscription.ts`: "a claimed trial without a bound method is
   unchargeable by design"). Manual renewal therefore has to resolve a provider
   at renewal time, and currently does not.

3. **The trial "Claim" button answers 409 and the UI shows nothing.**
   `startTrialVaultApprovalStep` calls the plugin's `startBinding`, which
   refuses when the customer already owns a method for that provider —
   `provider_id` only, `scope` is ignored. That dedup is a documented,
   deliberate plugin contract ("the dedup contract is one method per provider,
   so the caller is told to use the existing one or unbind it first"), so the
   fix belongs here: the host must reuse the method it already has instead of
   asking for a second approval.

## Resolved Questions

- **Q1: should `attempt_no` be "max + 1" or "the first free slot"?**
  **Max + 1.** Gaps carry no meaning; a monotonically increasing number keeps
  the retry history readable in the DB. The unique index only needs uniqueness,
  not density.

- **Q2: which provider should a manual renewal charge through when the
  subscription has none?** **The subscription's cart region, minus
  `pp_system_default`.** The region is the same authority the storefront uses
  at checkout, and it already carries the provider the subscription was sold
  under. Sorted lexicographically so the same region always yields the same
  provider — silently switching rails would change what the customer is charged
  by.

- **Q3: should the resolved provider be written back to
  `subscription.payment_context`?** **No.** `payment_context.payment_provider_id`
  is the signal `renewNowWorkflow` uses to pick the engine (auto-charge) path.
  Stamping a provider onto a card-free trial would make `hasUsableMethod`
  true, route the next renewal through the billing engine, and fail at charge
  time — with no card behind it. The provider is used for this order only.

- **Q4: when the customer already has a vaulted method, should the trial bind
  still run the provider approval?** **No — reuse.** The point of the trial
  bind is "give me a payment method on this subscription for the bonus days".
  If a usable method already exists, minting a second identical wallet is
  exactly what the plugin's dedup exists to prevent.

- **Q5: what if the customer's only vaulted method is on a provider the
  subscription's region does not enable?** **Fall through to the normal
  approval flow.** Reusing an unusable rail would produce a subscription that
  cannot be charged, which is worse than the 409 it replaces.

## Proposed Architecture & Data Model

No schema changes. No new modules. Two new pure utilities, two step changes.

### `src/workflows/utils/attempt-number.ts` (new)

```ts
export function nextAttemptNumber(
  existing: { attempt_no?: number | null }[]
): number
```

Returns `max(attempt_no) + 1`, or `1` for an empty list. Non-numeric and
missing values are treated as absent. Pure — the caller does the query.

### `src/workflows/utils/region-payment-provider.ts` (new)

```ts
export function pickChargeableProvider(providerIds: string[]): string | null
export async function listEnabledProviderIds(
  container: MedusaContainer,
  regionId: string | null | undefined
): Promise<string[]>
```

- `pickChargeableProvider` filters out `pp_system_default` (Medusa's
  placeholder, never chargeable), sorts, and returns the first — or `null`.
- `listEnabledProviderIds` queries the region's `payment_providers` relation
  and returns the ids. Returns `[]` for a null/undefined region.

### `createManualRenewalStep` (`src/workflows/steps/create-manual-renewal.ts`)

- Replace `attempt_no: 1` with a query + `nextAttemptNumber(...)`.
- Replace the `!paymentContext?.payment_provider_id` throw with a resolve-then-
  throw: try the stored provider, fall back to
  `listEnabledProviderIds(container, subscription.cart?.region_id)`, and only
  throw when both are empty.
- Use the resolved id for `createPaymentSessionsWorkflow`'s `provider_id` and
  for the step output. **Do not persist it.**

### `bindTrialPaymentMethodWorkflow` (`src/workflows/bind-trial-payment-method.ts`)

- New step `resolveReusableTrialMethodStep` after `resolveTrialBindContextStep`,
  running only for the `start` action:
  - list the customer's vaulted methods (`listCustomerPaymentMethods`);
  - if none, return `{ reused: null }`;
  - resolve the subscription region's enabled providers;
  - return the first method whose provider is enabled, as
    `{ reused: { vault_id, provider_id } }`, else `{ reused: null }`.
- When `reused` is non-null, the workflow **skips**
  `startTrialVaultApprovalStep` and `completeTrialVaultApprovalStep` and feeds
  `{ vault_id, provider_id }` straight into `bindTrialPaymentMethodStep`, which
  is unchanged.

The reuse path must still apply the bonus days and the `next_renewal_at`
re-point: from the customer's point of view they claimed the offer, and the
offer's consideration is "a payment method is on file", not "you completed an
approval".

### `renew-now` route

`src/api/store/customers/me/subscriptions/[id]/renew-now/route.ts` must call
`logUnquotedStepFailure` before rethrowing. `src/workflows/utils/store-step-failure.ts`
already exports it and `trials/[id]/bind` already uses it — its absence here is
the only reason the 500 above took a container patch to diagnose.

## Step-by-Step Implementation Plan

### Phase 1: attempt numbering

- [ ] Step 1: Add `src/workflows/utils/attempt-number.ts`.
- [ ] Step 2: Unit-test it in `src/workflows/utils/__tests__/attempt-number.spec.ts`
      (empty → 1, `[1]` → 2, `[1, 3]` → 4, `[null, 2]` → 3).
- [ ] Step 3: Wire it into `createManualRenewalStep`. Confirm the list method
      name the module exposes before writing the query
      (`grep -n "RenewalAttempt" src/modules/renewal/index.ts`).

### Phase 2: provider fallback

- [ ] Step 1: Add `src/workflows/utils/region-payment-provider.ts`.
- [ ] Step 2: Unit-test `pickChargeableProvider` (system default skipped, only
      system default → null, empty → null, several real providers → the
      lexicographically first).
- [ ] Step 3: Wire the fallback into `createManualRenewalStep`. Add a comment
      recording Q3 so nobody "helpfully" persists the id later.

### Phase 3: trial-bind reuse

- [ ] Step 1: Add `resolveReusableTrialMethodStep` to
      `src/workflows/steps/bind-trial-payment-method.ts`.
- [ ] Step 2: Branch the workflow on its output.
- [ ] Step 3: Integration coverage: reuse path skips the capability entirely
      (assert `startBinding` is never called); unusable-provider path still
      calls it.

### Phase 4: observability

- [ ] Step 1: Call `logUnquotedStepFailure` in the renew-now route.
- [ ] Step 2: Assert in the route's http test that an unlisted failure logs.

### Phase 5: lessons

- [ ] Step 1: `.agents/lessons.md` — record the two generalisable findings:
      **a failed Medusa v2 workflow step does not roll back its own committed
      writes**, and **do not call a plugin entry point before checking whether
      its preconditions already hold** (the 409 was a documented contract, not
      a bug).

## Verification & Testing

- `corepack yarn build`
- `corepack yarn test:unit` (the two new pure specs)
- `corepack yarn test:integration:http` (trial bind + renew-now routes)
- `corepack yarn verify:package`
- **Mutation checks**: restore `attempt_no: 1` → the collision test must fail;
  drop the region fallback → the provider test must fail; drop the reuse branch
  → the reuse test must fail.

**End-to-end acceptance happens in the host app** (`medusa-saas`): rebuild the
backend image, deploy, then a Playwright run that presses "Claim" and
"Renew now" on the live store. Success is `POST /store/customers/me/trials/{id}/bind`
answering 200 (not 409) and `POST .../renew-now` answering 200 with a
`redirectUrl` (not 500).

**Production data**: the 2026-10-06 orphan (`renewal_attempt
01M48GXS7XH40FYVF1B68QNTR4` stuck at `processing`, order
`order_01M48GXS9EX8FEC768HG6CNEXH` left `pending` with no payment collection)
is cleaned by the host-app runbook, not by this change. With Phase 1 in place a
new attempt is minted as `2`, so the orphan no longer blocks anything; the
cleanup is for hygiene only.

## Out of Scope

- Publishing `@mengyyy369/medusa-payment-methods` or changing its dedup
  contract.
- The storefront's `scope`-less binding call (`startPaymentMethodBinding(null, ...)`),
  which is why `customer_payment_preference` is empty. Tracked in the host app.
- The storefront's swallowed trial-bind error and the post-binding refresh
  race. Both host-app.
- A general region→provider helper for other callers; this adds only what the
  renewal path needs.
