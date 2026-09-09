import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import type { AuthenticatedMedusaRequest } from "@medusajs/framework/http"
import { MedusaError } from "@medusajs/framework/utils"
import { REDEMPTION_MODULE } from "../../../../../modules/redemption"
import RedemptionModuleService from "../../../../../modules/redemption/service"
import type { RedemptionRecordDTO } from "../../../../../modules/redemption/types"

export async function requireStoreCustomer(
  req: AuthenticatedMedusaRequest
): Promise<string> {
  const customerId = req.auth_context?.actor_id

  if (!customerId) {
    throw new MedusaError(
      MedusaError.Types.UNAUTHORIZED,
      "Customer authentication is required."
    )
  }

  return customerId
}

export type StoreRedemptionRecord = {
  id: string
  batch_id: string
  code_id: string
  outcome: string
  free_cycles_applied: number
  frequency_interval: string
  frequency_value: number
  subscription_id: string
  created_at: string
}

export async function listStoreCustomerRedemptions(
  container: MedusaContainer,
  customerId: string,
  offset = 0,
  limit = 20
): Promise<{
  redemptions: StoreRedemptionRecord[]
  count: number
  offset: number
  limit: number
}> {
  const redemptionModuleService = container.resolve<RedemptionModuleService>(
    REDEMPTION_MODULE
  )

  const [records, count] =
    await redemptionModuleService.listAndCountRedemptionRecords(
      { customer_id: customerId },
      {
        order: { created_at: "DESC" },
        skip: offset,
        take: limit,
      }
    )

  return {
    redemptions: records.map((record: RedemptionRecordDTO) => ({
      id: record.id,
      batch_id: record.batch_id,
      code_id: record.code_id,
      outcome: record.outcome,
      free_cycles_applied: record.free_cycles_applied,
      frequency_interval: record.frequency_interval,
      frequency_value: record.frequency_value,
      subscription_id: record.subscription_id,
      created_at: new Date(record.created_at).toISOString(),
    })),
    count,
    offset,
    limit,
  }
}

export function mapRedemptionRouteError(error: unknown): {
  status: number
  message: string
} {
  const message =
    error instanceof Error ? error.message : "Unexpected redemption error"
  const status =
    typeof (error as { status?: number })?.status === "number"
      ? (error as { status?: number }).status!
      : 500

  return { status, message }
}

export function resolveQueryConfigOffsetLimit(req: AuthenticatedMedusaRequest): {
  offset: number
  limit: number
} {
  const query = req.scope.resolve<any>(ContainerRegistrationKeys.QUERY)
  void query
  const pagination = (req as any).queryConfig?.pagination
  return {
    offset: pagination?.skip ?? 0,
    limit: pagination?.take ?? 20,
  }
}
