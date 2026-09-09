import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http"
import type { PostStorePreviewRedeemCodeSchemaType } from "../validators"
import { requireStoreCustomer } from "../utils"
import { previewRedemptionCodeWorkflow } from "../../../../../../workflows/preview-redemption-code"

export const POST = async (
  req: AuthenticatedMedusaRequest<PostStorePreviewRedeemCodeSchemaType>,
  res: MedusaResponse
) => {
  const customerId = await requireStoreCustomer(req)

  const { result: resolution } = await previewRedemptionCodeWorkflow(
    req.scope
  ).run({
    input: {
      code: req.validatedBody.code,
      customer_id: customerId,
      subscription_id: req.validatedBody.subscription_id ?? null,
    },
  })

  res.status(200).json({
    kind: resolution.kind,
    grant: {
      product_id: resolution.grant.product_id,
      product_title: resolution.grant.product_title,
      variant_id: resolution.grant.variant_id,
      variant_title: resolution.grant.variant_title,
      frequency_interval: resolution.grant.frequency_interval,
      frequency_value: resolution.grant.frequency_value,
      free_cycles: resolution.grant.free_cycles,
    },
    target_subscription_id: resolution.target_subscription_id,
  })
}
