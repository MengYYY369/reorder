/**
 * Kept as the registration path used by `src/api/middlewares.ts`, which appends
 * the gate as its own matcher on `/store/carts/:id/complete` and must keep
 * pointing here.
 *
 * The implementation lives with the module that owns the rule —
 * `src/modules/subscription/utils/checkout-gate.ts` — for the same reason the
 * saas-bridge auth middleware does: no jest `testMatch` ever runs anything under
 * `src/api/`, so a gate body written here could not be asserted from where it is
 * tested. Nothing else should grow in this file.
 */
export { rejectConflictingPurchase } from "../../../modules/subscription/utils/checkout-gate"
