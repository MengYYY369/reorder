import {
  MiddlewareRoute,
  authenticate,
  validateAndTransformQuery,
} from "@medusajs/framework/http"
import { GetStoreProductSubscriptionOfferSchema } from "./validators"

export const storeProductMiddlewares: MiddlewareRoute[] = [
  {
    matcher: "/store/products/:id/subscription-offer",
    method: "GET",
    middlewares: [
      // Optional authentication: the eligibility half of the trial payload is
      // per-customer, and a guest request simply has no actor to read.
      authenticate("customer", ["session", "bearer"], {
        allowUnauthenticated: true,
      }),
      validateAndTransformQuery(GetStoreProductSubscriptionOfferSchema, {
        defaults: [],
        isList: false,
      }),
    ],
  },
]
