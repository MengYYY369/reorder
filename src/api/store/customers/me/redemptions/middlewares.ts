import {
  MiddlewareRoute,
  authenticate,
  validateAndTransformBody,
  validateAndTransformQuery,
} from "@medusajs/framework/http"
import { createFindParams } from "@medusajs/medusa/api/utils/validators"
import {
  GetStoreRedemptionsSchema,
  PostStorePreviewRedeemCodeSchema,
  PostStoreRedeemCodeSchema,
} from "./validators"

const storeGetRedemptionsSchema = createFindParams({
  offset: 0,
  limit: 20,
})

const customerAuth = authenticate("customer", ["session", "bearer"])

export const storeCustomerRedemptionsMiddlewares: MiddlewareRoute[] = [
  {
    matcher: "/store/customers/me/redemptions*",
    middlewares: [customerAuth],
  },
  {
    matcher: "/store/customers/me/redemptions",
    method: "GET",
    middlewares: [
      validateAndTransformQuery(storeGetRedemptionsSchema, {
        defaults: ["id", "outcome", "free_cycles_applied", "created_at"],
        isList: true,
      }),
    ],
  },
  {
    matcher: "/store/customers/me/redemptions/preview",
    method: "POST",
    middlewares: [validateAndTransformBody(PostStorePreviewRedeemCodeSchema)],
  },
  {
    matcher: "/store/customers/me/redemptions",
    method: "POST",
    middlewares: [validateAndTransformBody(PostStoreRedeemCodeSchema)],
  },
]
