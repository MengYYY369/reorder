import type {
  MedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http"
import type { GetStoreProductSubscriptionOfferSchemaType } from "../../validators"
import {
  getStoreProductSubscriptionOfferResponse,
  sendStoreJson,
} from "../../../customers/me/subscriptions/utils"

export const GET = async (
  req: MedusaRequest<unknown, GetStoreProductSubscriptionOfferSchemaType>,
  res: MedusaResponse
) => {
  // The trial payload's eligibility half is per-customer. The repo sets no
  // cache headers anywhere; without this header a shared cache would serve
  // one customer's eligibility to another.
  res.setHeader("Cache-Control", "no-store")

  const response = await getStoreProductSubscriptionOfferResponse(req)

  return sendStoreJson(res, response)
}
