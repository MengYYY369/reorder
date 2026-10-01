export enum RedemptionBatchStatus {
  ACTIVE = "active",
  DISABLED = "disabled",
}

export enum RedemptionCodeStatus {
  ACTIVE = "active",
  DISABLED = "disabled",
}

export enum RedemptionOutcome {
  SUBSCRIPTION_CREATED = "subscription_created",
  SUBSCRIPTION_EXTENDED = "subscription_extended",
}

export enum RedemptionFrequencyInterval {
  WEEK = "week",
  MONTH = "month",
  YEAR = "year",
}

export interface RedemptionFrequencyConfig {
  interval: RedemptionFrequencyInterval
  value: number
}

export interface CreateRedemptionBatchInput {
  name: string
  variant_id: string
  frequency_interval: RedemptionFrequencyInterval
  frequency_value: number
  free_cycles: number
  code_prefix?: string
  max_redemptions_per_code?: number
  starts_at?: Date | null
  expires_at?: Date | null
  generated_code_count?: number
  custom_codes?: string[]
  /**
   * The batch's own trial configuration (ticket 14 / D14). Defaults to off, so
   * a normal code batch on a trial-enabled variant keeps the create/extend
   * semantics; when on, the code grants a trial through the claim-shaped path.
   */
  trial_enabled?: boolean
  trial_days?: number | null
  trial_bonus_days?: number | null
  trial_requires_payment_method?: boolean
  metadata?: Record<string, unknown> | null
}

export interface RedemptionBatchDTO {
  id: string
  name: string
  variant_id: string
  frequency_interval: RedemptionFrequencyInterval
  frequency_value: number
  free_cycles: number
  status: RedemptionBatchStatus
  code_prefix: string
  max_redemptions_per_code: number
  trial_enabled: boolean
  trial_days: number | null
  trial_bonus_days: number | null
  trial_requires_payment_method: boolean
  starts_at: Date | null
  expires_at: Date | null
  metadata: Record<string, unknown> | null
  created_at: Date
  updated_at: Date
}

export interface RedemptionCodeDTO {
  id: string
  batch_id: string
  code: string
  status: RedemptionCodeStatus
  max_redemptions: number
  redemption_count: number
  created_at: Date
  updated_at: Date
}

export interface RedemptionRecordDTO {
  id: string
  batch_id: string
  code_id: string
  customer_id: string
  subscription_id: string
  outcome: RedemptionOutcome
  free_cycles_applied: number
  frequency_interval: RedemptionFrequencyInterval
  frequency_value: number
  metadata: Record<string, unknown> | null
  created_at: Date
  updated_at: Date
}
