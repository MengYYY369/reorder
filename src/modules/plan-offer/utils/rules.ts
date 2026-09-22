import {
  PLAN_OFFER_RULES_DEFAULTS,
  PlanOfferConsentSource,
  PlanOfferRowStackingPolicy,
  PlanOfferRules,
  PlanOfferRuntimeRules,
} from "../types"
import { planOfferErrors } from "./errors"

/**
 * Single place where the rules added in the v1.6.0 sequence are read.
 *
 * `rules` is a jsonb column, so rows persisted before these keys existed return
 * them as `undefined`. Every default here keeps the pre-v1.6.0 behavior, which
 * is what makes the fields opt-in per offer rather than a release-wide switch.
 */
export function resolvePlanOfferRules(
  rules?: PlanOfferRules | null
): PlanOfferRuntimeRules {
  return {
    consent_from_session:
      rules?.consent_from_session ?? PLAN_OFFER_RULES_DEFAULTS.consent_from_session,
    row_stacking_policy: normalizeRowStackingPolicy(
      rules?.row_stacking_policy
    ),
    max_stacking_cycles: normalizeMaxStackingCycles(
      rules?.max_stacking_cycles
    ),
  }
}

export function normalizeRowStackingPolicy(
  value: string | null | undefined
): PlanOfferRowStackingPolicy {
  switch (value) {
    case PlanOfferRowStackingPolicy.ALLOW_MULTIPLE:
      return PlanOfferRowStackingPolicy.ALLOW_MULTIPLE
    case PlanOfferRowStackingPolicy.EXTEND:
    case undefined:
    case null:
      return PlanOfferRowStackingPolicy.EXTEND
    default:
      throw planOfferErrors.invalidData(
        `'rules.row_stacking_policy' must be '${PlanOfferRowStackingPolicy.EXTEND}' or '${PlanOfferRowStackingPolicy.ALLOW_MULTIPLE}'`
      )
  }
}

/**
 * `null` means "no ceiling". A non-null ceiling must be a non-negative integer;
 * `0` is a legal (if useless) value meaning the row can never be extended.
 */
export function normalizeMaxStackingCycles(
  value: number | null | undefined
): number | null {
  if (value === null || value === undefined) {
    return null
  }

  if (!Number.isInteger(value) || value < 0) {
    throw planOfferErrors.invalidData(
      "'rules.max_stacking_cycles' must be a non-negative integer or null"
    )
  }

  return value
}

export function normalizeConsentFromSession(
  value: string | null | undefined
): PlanOfferConsentSource | null {
  if (value === null || value === undefined) {
    return null
  }

  if (value === "customer_id") {
    return value
  }

  throw planOfferErrors.invalidData(
    "'rules.consent_from_session' must be 'customer_id' or null"
  )
}
