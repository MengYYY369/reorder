import { MedusaError } from "@medusajs/framework/utils"
import { Modules } from "@medusajs/framework/utils"
import type {
  MedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http"
import { currentTenant } from "../../../../modules/saas-bridge/auth"
import { redeemRedemptionCodeWorkflow } from "../../../../workflows/redeem-redemption-code"

type CustomerModule = {
  retrieveCustomer: (
    id: string,
    config?: Record<string, unknown>
  ) => Promise<{ id: string; metadata?: Record<string, unknown> | null }>
}

/**
 * POST /store/saas/redeem
 * Body: { code, customer_id, subscription_id? }
 * → { subscription_id, subscription_reference, redemption_record_id,
 *     outcome, free_cycles_remaining, dunning_recovered }
 *
 * Redemption-code entry for the SaaS site (bridge-secret callers cannot hold
 * a Medusa customer session): runs the redeem-redemption-code workflow via
 * direct typed import — the same workflow the customer-scoped store route
 * uses, so the code lock, per-customer dedup and quota checks all apply
 * unchanged.
 *
 * Auto-resolving on the reorder side: extends the customer's matching
 * ACTIVE/PAST_DUE subscription (free cycles) or creates a payment-free
 * subscription that expires at the end of its free period. Entitlement
 * mirroring stays on the SaaS side, keyed by the returned subscription.
 *
 * TENANT ISOLATION: the customer's metadata.tenant_id must match the
 * calling tenant, else 404.
 */
export async function POST(
  req: MedusaRequest,
  res: MedusaResponse
) {
  const tenant = currentTenant(req)

  const { code, customer_id, subscription_id } = (req.body ?? {}) as {
    code?: string
    customer_id?: string
    subscription_id?: string | null
  }

  if (typeof code !== "string" || !code.trim()) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      "body.code must be a redemption code"
    )
  }
  if (typeof customer_id !== "string" || !customer_id.trim()) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      "body.customer_id must be a Medusa customer id"
    )
  }

  // TENANT ISOLATION: the customer must belong to the calling tenant —
  // redeeming for a foreign customer would be a cross-tenant write.
  const customerModule = req.scope.resolve<CustomerModule>(Modules.CUSTOMER)

  const customer = await customerModule.retrieveCustomer(customer_id)
  const ownerTenant = (customer.metadata as Record<string, unknown> | null)
    ?.tenant_id

  if (!customer || ownerTenant !== tenant.tenant_id) {
    throw new MedusaError(
      MedusaError.Types.NOT_FOUND,
      "customer not found for this tenant"
    )
  }

  const { result, errors } = await redeemRedemptionCodeWorkflow(
    req.scope
  ).run({
    input: {
      code,
      customer_id,
      subscription_id: subscription_id ?? null,
    },
    throwOnError: false,
  })

  if (errors?.length) {
    const first = errors[0] as { error?: { message?: string } }
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      first?.error?.message ?? "redemption failed"
    )
  }

  const redemption = (result ?? {}) as {
    subscription_id?: string
    subscription_reference?: string
    record_id?: string
    outcome?: string
    free_cycles_remaining?: number
    dunning_recovered?: boolean
  }

  if (!redemption.subscription_id) {
    throw new MedusaError(
      MedusaError.Types.UNEXPECTED_STATE,
      "redemption workflow returned no subscription"
    )
  }

  res.json({
    subscription_id: redemption.subscription_id,
    subscription_reference: redemption.subscription_reference ?? null,
    redemption_record_id: redemption.record_id ?? null,
    outcome: redemption.outcome ?? null,
    free_cycles_remaining: redemption.free_cycles_remaining ?? null,
    dunning_recovered: redemption.dunning_recovered ?? false,
  })
}
