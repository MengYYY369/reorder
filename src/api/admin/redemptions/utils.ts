import type { MedusaContainer } from "@medusajs/framework/types"
import { REDEMPTION_MODULE } from "../../../modules/redemption"
import RedemptionModuleService from "../../../modules/redemption/service"
import type { RedemptionBatchDTO } from "../../../modules/redemption/types"
import { redemptionErrors } from "../../../modules/redemption/utils/errors"

export type AdminRedemptionCodeSummary = {
  id: string
  batch_id: string
  code: string
  status: string
  max_redemptions: number
  redemption_count: number
  created_at: string
}

export type AdminRedemptionBatchSummary = {
  id: string
  name: string
  variant_id: string
  frequency_interval: string
  frequency_value: number
  free_cycles: number
  status: string
  code_prefix: string
  max_redemptions_per_code: number
  starts_at: string | null
  expires_at: string | null
  code_count: number
  total_redemptions: number
  created_at: string
  updated_at: string
}

function toBatchSummary(
  batch: RedemptionBatchDTO,
  codes: Array<{ redemption_count: number }>
): AdminRedemptionBatchSummary {
  return {
    id: batch.id,
    name: batch.name,
    variant_id: batch.variant_id,
    frequency_interval: batch.frequency_interval,
    frequency_value: batch.frequency_value,
    free_cycles: batch.free_cycles,
    status: batch.status,
    code_prefix: batch.code_prefix,
    max_redemptions_per_code: batch.max_redemptions_per_code,
    starts_at: batch.starts_at ? new Date(batch.starts_at).toISOString() : null,
    expires_at: batch.expires_at
      ? new Date(batch.expires_at).toISOString()
      : null,
    code_count: codes.length,
    total_redemptions: codes.reduce(
      (sum, code) => sum + (code.redemption_count ?? 0),
      0
    ),
    created_at: new Date(batch.created_at).toISOString(),
    updated_at: new Date(batch.updated_at).toISOString(),
  }
}

export async function listAdminRedemptionBatchesResponse(
  container: MedusaContainer,
  query: Record<string, unknown>,
  skip?: number,
  take?: number
): Promise<{
  redemption_batches: AdminRedemptionBatchSummary[]
  count: number
  offset: number
  limit: number
}> {
  const redemptionModuleService = container.resolve<RedemptionModuleService>(
    REDEMPTION_MODULE
  )

  const normalizedOffset = skip ?? (query.offset as number) ?? 0
  const normalizedLimit = take ?? (query.limit as number) ?? 20

  const filter: Record<string, unknown> = {}
  if (query.status) {
    filter.status = query.status
  }
  if (query.variant_id) {
    filter.variant_id = query.variant_id
  }

  const sortDirection =
    query.direction === "asc"
      ? "ASC"
      : query.direction === "desc"
        ? "DESC"
        : "DESC"

  const [batches, count] =
    await redemptionModuleService.listAndCountRedemptionBatches(filter, {
      order: { created_at: sortDirection },
      skip: normalizedOffset,
      take: normalizedLimit,
    })

  const summaries = await Promise.all(    batches.map(async (batch) => {
      const codes = await redemptionModuleService.listBatchCodes(batch.id)
      return toBatchSummary(batch, codes)
    })
  )

  return {
    redemption_batches: summaries,
    count,
    offset: normalizedOffset,
    limit: normalizedLimit,
  }
}

export async function getAdminRedemptionBatchDetailResponse(
  container: MedusaContainer,
  id: string
): Promise<{
  redemption_batch: AdminRedemptionBatchSummary
  codes: AdminRedemptionCodeSummary[]
}> {
  const redemptionModuleService = container.resolve<RedemptionModuleService>(
    REDEMPTION_MODULE
  )

  let batch: RedemptionBatchDTO
  try {
    batch = await redemptionModuleService.retrieveRedemptionBatch(id)
  } catch {
    throw redemptionErrors.batchNotFound(id)
  }

  const codes = await redemptionModuleService.listBatchCodes(id)

  return {
    redemption_batch: toBatchSummary(batch, codes),
    codes: codes.map((code) => ({
      id: code.id,
      batch_id: code.batch_id,
      code: code.code,
      status: code.status,
      max_redemptions: code.max_redemptions,
      redemption_count: code.redemption_count,
      created_at: new Date(code.created_at).toISOString(),
    })),
  }
}
