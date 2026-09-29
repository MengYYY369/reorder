import { MiddlewareRoute, validateAndTransformQuery } from "@medusajs/framework/http"
import { GetAdminTrialClaimsSchema } from "./validators"

export const adminTrialClaimsMiddlewares: MiddlewareRoute[] = [
  {
    matcher: "/admin/trial-claims",
    method: "GET",
    middlewares: [
      validateAndTransformQuery(GetAdminTrialClaimsSchema, {
        defaults: [
          "id",
          "customer_id",
          "product_id",
          "variant_id",
          "claimed_at",
          "trial_ends_at",
          "source",
          "subscription_id",
          "binding_method",
        ],
        isList: true,
      }),
    ],
  },
]
