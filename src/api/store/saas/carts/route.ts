import { MedusaError } from "@medusajs/framework/utils"
import { Modules } from "@medusajs/framework/utils"
import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { createCartWorkflow } from "@medusajs/medusa/core-flows"
import { assertTenantVisible } from "../lib/tenant-ownership"

type CustomerModule = {
  retrieveCustomer: (
    id: string,
    config?: Record<string, unknown>
  ) => Promise<{
    id: string
    email: string | null
    metadata?: Record<string, unknown> | null
  }>
}

type RemoteQueryFunction = ((query: {
  entity: string
  fields: string[]
  filters?: Record<string, unknown>
  pagination?: Record<string, unknown>
}) => Promise<{ data: Array<Record<string, unknown>> }>) & {
  graph: (query: {
    entity: string
    fields: string[]
    filters?: Record<string, unknown>
  }) => Promise<{ data: Array<Record<string, unknown>> }>
}

/**
 * POST /store/saas/carts — create a customer-attached subscription cart.
 *
 * Body: { customer_id, currency_code, variant_id, frequency_interval, frequency_value }
 * → { cart_id, currency_code, customer_id, email }
 *
 * WHY A BRIDGE ROUTE: the v2.20 store cart-create validator rejects
 * customer_id outright — carts created through /store/carts are always guest
 * carts, so the placed order would have no customer and the tenant-ownership
 * check in /store/saas/reconcile would 404. The SaaS is a privileged backend
 * (bridge secret), so it creates the cart AS the tenant customer here.
 *
 * Tenant isolation: the customer must carry metadata.tenant_id matching the
 * calling tenant (foreign customers answer 404). The line item carries the
 * subscription metadata (manual renewal mode).
 *
 * LOAD-BEARING: the placeholder shipping address (digital-delivery, postal
 * 00000, country cn) is contract, not cleanup material — the SaaS never sets
 * addresses itself and cart completion depends on it.
 */
export async function POST(
  req: MedusaRequest,
  res: MedusaResponse
) {
  const body = (req.body ?? {}) as {
    customer_id?: string
    currency_code?: string
    variant_id?: string
    frequency_interval?: string
    frequency_value?: number
  }

  const customerId = body.customer_id
  const currencyCode = body.currency_code?.toLowerCase()
  const variantId = body.variant_id
  const frequencyInterval = body.frequency_interval ?? "month"
  const frequencyValue = body.frequency_value ?? 1

  if (!customerId || !currencyCode || !variantId) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      "body requires customer_id, currency_code and variant_id"
    )
  }

  const customerModule = req.scope.resolve<CustomerModule>(Modules.CUSTOMER)
  const customer = await customerModule.retrieveCustomer(customerId)

  assertTenantVisible(req, customer?.metadata, "customer")

  const query = req.scope.resolve<RemoteQueryFunction>("query")
  const { data: regions } = await query.graph({
    entity: "region",
    fields: ["id", "currency_code"],
    filters: { currency_code: currencyCode },
  })
  const region = regions[0]
  if (!region) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      `No region configured for currency '${currencyCode}'`
    )
  }

  const { result: cart } = await createCartWorkflow(req.scope).run({
    input: {
      region_id: region.id as string,
      email: customer.email ?? undefined,
      customer_id: customerId,
      // Digital product: cart validation requires shipping addresses; the
      // SaaS stores a placeholder (no fulfillment follows).
      shipping_address: {
        first_name: "Digital",
        last_name: "Delivery",
        address_1: "N/A",
        city: "N/A",
        postal_code: "00000",
        country_code: "cn",
      },
      items: [
        {
          variant_id: variantId,
          quantity: 1,
          metadata: {
            is_subscription: true,
            payment_mode: "manual",
            frequency_interval: frequencyInterval,
            frequency_value: frequencyValue,
          },
        },
      ],
    } as never,
  })

  res.json({
    cart_id: cart.id,
    currency_code: (cart as unknown as { currency_code?: string }).currency_code ?? currencyCode,
    customer_id: customerId,
    email: customer.email,
  })
}
