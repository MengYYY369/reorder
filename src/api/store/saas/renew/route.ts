import { MedusaError } from "@medusajs/framework/utils"
import { Modules } from "@medusajs/framework/utils"
import type {
  MedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http"
import { currentTenant } from "../../../../modules/saas-bridge/auth"
import { createManualRenewalWorkflow } from "../../../../workflows/create-manual-renewal"

type CustomerModule = {
  retrieveCustomer: (
    id: string,
    config?: Record<string, unknown>
  ) => Promise<{ metadata?: Record<string, unknown> | null }>
}

/**
 * POST /store/saas/renew
 * Body: { subscription_id, triggered_by?, reason? }
 * → { order_id, redirect_url, total, currency_code, reused }
 *
 * Manual renewal entry: runs the create-manual-renewal workflow via direct
 * typed import and returns the cashier link. Payment completion is handled
 * by the reorder payment.captured subscriber; /renew itself never confirms
 * payment.
 *
 * TENANT ISOLATION: the subscription's customer metadata.tenant_id must
 * match the calling tenant, else 404.
 */
export async function POST(
  req: MedusaRequest,
  res: MedusaResponse
) {
  const tenant = currentTenant(req)

  const { subscription_id, triggered_by, reason } = (req.body ?? {}) as {
    subscription_id?: string
    triggered_by?: string | null
    reason?: string | null
  }

  // reorder mints subscription ids without a prefix — accept any non-empty
  // string; existence + tenant ownership are checked below.
  if (typeof subscription_id !== "string" || !subscription_id.trim()) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      "body.subscription_id must be a subscription id"
    )
  }

  // TENANT ISOLATION: subscription → customer → metadata.tenant_id must
  // match the calling tenant (404 — existence is not leaked).
  const customerModule = req.scope.resolve<CustomerModule>(Modules.CUSTOMER)
  const subscriptionModule = req.scope.resolve<{
    listSubscriptions: (f: Record<string, unknown>) => Promise<
      Array<{ id: string; customer_id: string }>
    >
  }>("subscription")

  const subscriptions = await subscriptionModule.listSubscriptions({
    id: [subscription_id],
  })
  const customerId = subscriptions[0]?.customer_id ?? null

  if (!customerId) {
    throw new MedusaError(
      MedusaError.Types.NOT_FOUND,
      "subscription not found"
    )
  }

  const customer = await customerModule.retrieveCustomer(customerId)
  const ownerTenant = (customer.metadata as Record<string, unknown> | null)
    ?.tenant_id

  if (ownerTenant !== tenant.tenant_id) {
    throw new MedusaError(
      MedusaError.Types.NOT_FOUND,
      "subscription not found for this tenant"
    )
  }

  const { result, errors } = await createManualRenewalWorkflow(
    req.scope
  ).run({
    input: {
      subscription_id,
      triggered_by: triggered_by ?? "saas-bridge",
      reason: reason ?? null,
    },
    throwOnError: false,
  })

  if (errors?.length) {
    const first = errors[0] as { error?: { message?: string } }
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      first?.error?.message ?? "manual renewal failed"
    )
  }

  const renewal = result as {
    renewal_order_id: string
    redirect_url: string | null
    total: number
    currency_code: string
    reused?: boolean
  }

  res.json({
    order_id: renewal.renewal_order_id,
    redirect_url: renewal.redirect_url,
    total: renewal.total,
    currency_code: renewal.currency_code,
    reused: renewal.reused ?? false,
  })
}
