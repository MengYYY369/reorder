import type { MedusaContainer } from "@medusajs/framework/types"
import { REDEMPTION_MODULE } from "../../src/modules/redemption"
import type RedemptionModuleService from "../../src/modules/redemption/service"
import type {
  RedemptionBatchDTO,
  RedemptionCodeDTO,
} from "../../src/modules/redemption/types"
import { RedemptionFrequencyInterval } from "../../src/modules/redemption/types"

export type RedemptionBatchSeedInput = {
  name: string
  variant_id: string
  free_cycles?: number
  frequency_interval?: RedemptionFrequencyInterval
  frequency_value?: number
  max_redemptions_per_code?: number
  generated_code_count?: number
  custom_codes?: string[]
  starts_at?: Date
  expires_at?: Date
}

/**
 * Seeds a redemption batch with its codes via the module service, bypassing
 * the admin workflow's commerce validation (tests seed their own offers
 * separately when they need the full chain).
 */
export async function createRedemptionBatch(
  container: MedusaContainer,
  input: RedemptionBatchSeedInput
): Promise<{ batch: RedemptionBatchDTO; codes: RedemptionCodeDTO[] }> {
  const redemptionModule = container.resolve<RedemptionModuleService>(
    REDEMPTION_MODULE
  )

  return await redemptionModule.createBatchWithCodes({
    name: input.name,
    variant_id: input.variant_id,
    frequency_interval: input.frequency_interval ?? RedemptionFrequencyInterval.MONTH,
    frequency_value: input.frequency_value ?? 1,
    free_cycles: input.free_cycles ?? 1,
    max_redemptions_per_code: input.max_redemptions_per_code,
    generated_code_count: input.generated_code_count ?? 1,
    custom_codes: input.custom_codes,
    starts_at: input.starts_at,
    expires_at: input.expires_at,
  })
}
