import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http"
import type { PostStoreRedeemCodeSchemaType } from "./validators"
import {
  listStoreCustomerRedemptions,
  requireStoreCustomer,
  resolveQueryConfigOffsetLimit,
} from "./utils"
import { redeemRedemptionCodeWorkflow } from "../../../../../workflows/redeem-redemption-code"

export const GET = async (
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) => {
  const customerId = await requireStoreCustomer(req)
  const { offset, limit } = resolveQueryConfigOffsetLimit(req)

  const response = await listStoreCustomerRedemptions(
    req.scope,
    customerId,
    offset,
    limit
  )

  res.status(200).json(response)
}

export const POST = async (
  req: AuthenticatedMedusaRequest<PostStoreRedeemCodeSchemaType>,
  res: MedusaResponse
) => {
  const customerId = await requireStoreCustomer(req)

  const { result } = await redeemRedemptionCodeWorkflow(req.scope).run({
    input: {
      code: req.validatedBody.code,
      customer_id: customerId,
      subscription_id: req.validatedBody.subscription_id ?? null,
    },
  })

  res.status(200).json({
    subscription_id: result.subscription_id,
    subscription_reference: result.subscription_reference,
    redemption_record_id: result.record_id,
    outcome: (result as { outcome?: string }).outcome,
    free_cycles_remaining: (result as { free_cycles_remaining?: number })
      .free_cycles_remaining,
    dunning_recovered: (result as { dunning_recovered?: boolean })
      .dunning_recovered,
  })
}
