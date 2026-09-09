import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http"
import { REDEMPTION_MODULE } from "../../../../../../modules/redemption"
import RedemptionModuleService from "../../../../../../modules/redemption/service"

function toRecordDto(record: {
  id: string
  batch_id: string
  code_id: string
  customer_id: string
  subscription_id: string
  outcome: string
  free_cycles_applied: number
  frequency_interval: string
  frequency_value: number
  metadata: Record<string, unknown> | null
  created_at: Date | string
}) {
  return {
    id: record.id,
    batch_id: record.batch_id,
    code_id: record.code_id,
    customer_id: record.customer_id,
    subscription_id: record.subscription_id,
    outcome: record.outcome,
    free_cycles_applied: record.free_cycles_applied,
    frequency_interval: record.frequency_interval,
    frequency_value: record.frequency_value,
    created_at: new Date(record.created_at).toISOString(),
  }
}

export const GET = async (
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) => {
  const redemptionModuleService = req.scope.resolve<RedemptionModuleService>(
    REDEMPTION_MODULE
  )
  const records = await redemptionModuleService.listBatchRecords(req.params.id)

  res.status(200).json({
    redemption_records: records.map(toRecordDto),
    count: records.length,
  })
}
