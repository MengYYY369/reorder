import {
  MiddlewareRoute,
  validateAndTransformBody,
  validateAndTransformQuery,
} from "@medusajs/framework/http"
import {
  GetAdminRenewalSchema,
  GetAdminRenewalsSchema,
  PostAdminApproveRenewalChangesSchema,
  PostAdminDeleteRenewalAttemptSchema,
  PostAdminDeleteRenewalCycleSchema,
  PostAdminForceRenewalSchema,
  PostAdminRejectRenewalChangesSchema,
  PostAdminResolveStuckRenewalSchema,
} from "./validators"

export const adminRenewalsMiddlewares: MiddlewareRoute[] = [
  {
    matcher: "/admin/renewals",
    method: "GET",
    middlewares: [
      validateAndTransformQuery(GetAdminRenewalsSchema, {
        defaults: [
          "id",
          "subscription_id",
          "scheduled_for",
          "processed_at",
          "status",
          "approval_required",
          "approval_status",
          "approval_decided_at",
          "approval_decided_by",
          "approval_reason",
          "generated_order_id",
          "last_error",
          "attempt_count",
          "created_at",
          "updated_at",
        ],
        isList: true,
      }),
    ],
  },
  {
    matcher: "/admin/renewals/:id",
    method: "GET",
    middlewares: [
      validateAndTransformQuery(GetAdminRenewalSchema, {
        defaults: [
          "*",
        ],
        isList: false,
      }),
    ],
  },
  {
    matcher: "/admin/renewals/:id/force",
    method: "POST",
    middlewares: [validateAndTransformBody(PostAdminForceRenewalSchema)],
  },
  {
    matcher: "/admin/renewals/:id/approve-changes",
    method: "POST",
    middlewares: [validateAndTransformBody(PostAdminApproveRenewalChangesSchema)],
  },
  {
    matcher: "/admin/renewals/:id/reject-changes",
    method: "POST",
    middlewares: [validateAndTransformBody(PostAdminRejectRenewalChangesSchema)],
  },
  {
    matcher: "/admin/renewals/:id/resolve-stuck",
    method: "POST",
    middlewares: [validateAndTransformBody(PostAdminResolveStuckRenewalSchema)],
  },
  {
    matcher: "/admin/renewals/:id/delete",
    method: "POST",
    middlewares: [validateAndTransformBody(PostAdminDeleteRenewalCycleSchema)],
  },
  {
    matcher: "/admin/renewals/:id/attempts/:attempt_id/delete",
    method: "POST",
    middlewares: [
      validateAndTransformBody(PostAdminDeleteRenewalAttemptSchema),
    ],
  },
]
