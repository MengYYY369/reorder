import { SubscriptionFrequencyInterval } from "../../subscription/types"

export enum RenewalCycleStatus {
  SCHEDULED = "scheduled",
  PROCESSING = "processing",
  SUCCEEDED = "succeeded",
  FAILED = "failed",
  ABANDONED = "abandoned",
  AWAITING_MANUAL_RESOLUTION = "awaiting_manual_resolution",
}

export enum RenewalAttemptStatus {
  PROCESSING = "processing",
  SUCCEEDED = "succeeded",
  FAILED = "failed",
}

export enum RenewalApprovalStatus {
  PENDING = "pending",
  APPROVED = "approved",
  REJECTED = "rejected",
}

/**
 * What a candidate renewal order's payment state was positively read as,
 * following the v2.20 derivation in `src/api/store/saas/reconcile/route.ts`:
 * the order entity carries no `payment_status` column, so state is read
 * through the order → payment collection link (`order_payment_collection`) and
 * the collection's own `status` + `payments[].status`.
 *
 * `ambiguous` is the answer for everything not positively readable — an
 * authorized-but-uncaptured payment, a refund, a query that failed. "We do not
 * know" must never be recorded as "there is no hope".
 */
export type OrderPaymentVerdict = "captured" | "not_captured" | "ambiguous"

export type RenewalApprovalSummary = {
  approval_required: boolean
  approval_status: RenewalApprovalStatus | null
  approval_decided_at: string | null
  approval_decided_by: string | null
  approval_reason: string | null
}

export type RenewalAppliedPendingUpdateData = {
  variant_id: string
  variant_title: string
  frequency_interval: SubscriptionFrequencyInterval
  frequency_value: number
  effective_at: string | null
}

export type RenewalCycleData = RenewalApprovalSummary & {
  id: string
  subscription_id: string
  scheduled_for: string
  processed_at: string | null
  status: RenewalCycleStatus
  generated_order_id: string | null
  applied_pending_update_data: RenewalAppliedPendingUpdateData | null
  last_error: string | null
  last_failure_kind: string | null
  attempt_count: number
  structural_attempt_count: number
  metadata: Record<string, unknown> | null
  created_at: string
  updated_at: string
  deleted_at: string | null
}

export type RenewalAttemptData = {
  id: string
  renewal_cycle_id: string
  attempt_no: number
  started_at: string
  finished_at: string | null
  status: RenewalAttemptStatus
  error_code: string | null
  error_message: string | null
  payment_reference: string | null
  order_id: string | null
  metadata: Record<string, unknown> | null
  created_at: string
  updated_at: string
  deleted_at: string | null
}
