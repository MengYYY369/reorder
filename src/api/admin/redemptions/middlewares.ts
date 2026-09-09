import {
  MiddlewareRoute,
  validateAndTransformBody,
  validateAndTransformQuery,
} from "@medusajs/framework/http"
import {
  GetAdminRedemptionBatchSchema,
  GetAdminRedemptionBatchesSchema,
  PostAdminCreateRedemptionBatchSchema,
  PostAdminDisableRedemptionBatchSchema,
  PostAdminDisableRedemptionCodeSchema,
} from "./batches/validators"

export const adminRedemptionsMiddlewares: MiddlewareRoute[] = [
  {
    matcher: "/admin/redemptions/batches",
    method: "GET",
    middlewares: [
      validateAndTransformQuery(GetAdminRedemptionBatchesSchema, {
        defaults: ["id", "name", "status", "created_at"],
        isList: true,
      }),
    ],
  },
  {
    matcher: "/admin/redemptions/batches",
    method: "POST",
    middlewares: [
      validateAndTransformBody(PostAdminCreateRedemptionBatchSchema),
    ],
  },
  {
    matcher: "/admin/redemptions/batches/:id",
    method: "GET",
    middlewares: [
      validateAndTransformQuery(GetAdminRedemptionBatchSchema, {
        defaults: ["*"],
        isList: false,
      }),
    ],
  },
  {
    matcher: "/admin/redemptions/batches/:id/disable",
    method: "POST",
    middlewares: [
      validateAndTransformBody(PostAdminDisableRedemptionBatchSchema),
    ],
  },
  {
    matcher: "/admin/redemptions/batches/:id/records",
    method: "GET",
    middlewares: [
      validateAndTransformQuery(GetAdminRedemptionBatchSchema, {
        defaults: ["*"],
        isList: false,
      }),
    ],
  },
  {
    matcher: "/admin/redemptions/codes/:id/disable",
    method: "POST",
    middlewares: [
      validateAndTransformBody(PostAdminDisableRedemptionCodeSchema),
    ],
  },
]
