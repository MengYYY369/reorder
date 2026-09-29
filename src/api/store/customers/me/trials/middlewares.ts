import {
  MiddlewareRoute,
  authenticate,
  validateAndTransformBody,
} from "@medusajs/framework/http"
import {
  PostStoreTrialBindSchema,
  PostStoreTrialClaimSchema,
} from "./validators"

const customerAuth = authenticate("customer", ["session", "bearer"])

export const storeCustomerTrialsMiddlewares: MiddlewareRoute[] = [
  {
    // The trailing glob is what makes the nested [id]/bind action share the
    // claim endpoint's customer authentication: Express compiles the matcher
    // as a prefix, so /store/customers/me/trials/:id/bind falls under it.
    matcher: "/store/customers/me/trials*",
    middlewares: [customerAuth],
  },
  {
    matcher: "/store/customers/me/trials",
    method: "POST",
    middlewares: [validateAndTransformBody(PostStoreTrialClaimSchema)],
  },
  {
    matcher: "/store/customers/me/trials/:id/bind",
    method: "POST",
    middlewares: [validateAndTransformBody(PostStoreTrialBindSchema)],
  },
]
