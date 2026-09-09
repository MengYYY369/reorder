export enum RedemptionBatchStatus {
  ACTIVE = "active",
  DISABLED = "disabled",
}

export enum RedemptionCodeStatus {
  ACTIVE = "active",
  DISABLED = "disabled",
}

export enum RedemptionFrequencyInterval {
  WEEK = "week",
  MONTH = "month",
  YEAR = "year",
}

export type AdminRedemptionCodeSummary = {
  id: string
  batch_id: string
  code: string
  status: RedemptionCodeStatus
  max_redemptions: number
  redemption_count: number
  created_at: string
}

export type AdminRedemptionBatchSummary = {
  id: string
  name: string
  variant_id: string
  frequency_interval: RedemptionFrequencyInterval
  frequency_value: number
  free_cycles: number
  status: RedemptionBatchStatus
  code_prefix: string
  max_redemptions_per_code: number
  starts_at: string | null
  expires_at: string | null
  code_count: number
  total_redemptions: number
  created_at: string
  updated_at: string
}

export type AdminRedemptionBatchListResponse = {
  redemption_batches: AdminRedemptionBatchSummary[]
  count: number
  offset: number
  limit: number
}

export type AdminRedemptionBatchDetailResponse = {
  redemption_batch: AdminRedemptionBatchSummary
  codes: AdminRedemptionCodeSummary[]
}

export type CreateRedemptionBatchAdminRequest = {
  name: string
  variant_id: string
  frequency_interval: RedemptionFrequencyInterval
  frequency_value: number
  free_cycles: number
  code_prefix?: string
  max_redemptions_per_code?: number
  starts_at?: string | null
  expires_at?: string | null
  generated_code_count?: number
  custom_codes?: string[]
  metadata?: Record<string, unknown> | null
}
