import type { MedusaContainer } from "@medusajs/framework/types"
import {
  PAYMENT_METHODS_MODULE,
  type CustomerPaymentMethodsView,
} from "@mengyyy369/medusa-payment-methods/modules/payment-methods"

/** The plugin's module service, narrowed to the one reader reorder needs. */
type PaymentMethodsReader = {
  listCustomerMethods: (
    container: MedusaContainer,
    input: { customerId: string }
  ) => Promise<CustomerPaymentMethodsView>
}

/** The provider and method reference a charge runs against. */
export type RenewalPaymentContext = {
  providerId: string | null
  reference: string | null
}

/**
 * Whether the payment-methods plugin module is registered in this host.
 *
 * The package is a hard dependency, but the module is an optional runtime
 * registration: reorder must degrade to its own subscription row when the host
 * did not register it, never throw.
 */
export function isPaymentMethodsModuleRegistered(
  container: MedusaContainer
): boolean {
  const service = container.resolve<PaymentMethodsReader | undefined>(
    PAYMENT_METHODS_MODULE,
    { allowUnregistered: true }
  )

  return Boolean(service?.listCustomerMethods)
}

/**
 * The method a renewal charges with, in the plan's order (D10): the plugin's
 * preferred method for the subscription's product first, the subscription row's
 * own `payment_context` second.
 *
 * Fail-open by construction. A missing plugin module, a failing read or an unset
 * preference all fall back to the row — the behaviour renewals had before
 * preferences existed — so a payment-methods outage can never stop a renewal
 * from being attempted. Nothing is written and no event is emitted: reading a
 * preference must not change the subscription.
 *
 * The preferred read goes through the plugin's own customer-level list, which is
 * the only public surface for the preference table; it is deliberately the whole
 * list (the plugin resolves the per-scope preference itself) rather than a second
 * copy of the preference query living in reorder.
 */
export async function resolveRenewalPaymentContext(
  container: MedusaContainer,
  input: {
    customerId: string
    scope: string | null
    fallback: {
      payment_provider_id: string | null
      payment_method_reference: string | null
    }
  }
): Promise<RenewalPaymentContext> {
  const preferred = await readPreferredMethod(
    container,
    input.customerId,
    input.scope
  )

  if (preferred) {
    return preferred
  }

  return {
    providerId: readNonEmpty(input.fallback.payment_provider_id),
    reference: readNonEmpty(input.fallback.payment_method_reference),
  }
}

async function readPreferredMethod(
  container: MedusaContainer,
  customerId: string,
  scope: string | null
): Promise<RenewalPaymentContext | null> {
  const scopeId = readNonEmpty(scope)

  if (!scopeId) {
    return null
  }

  try {
    if (!isPaymentMethodsModuleRegistered(container)) {
      return null
    }

    const service = container.resolve<PaymentMethodsReader>(
      PAYMENT_METHODS_MODULE
    )
    const view = await service.listCustomerMethods(container, { customerId })
    const preferred = view?.preferredByScope?.[scopeId]
    const providerId = readNonEmpty(preferred?.provider_id)
    const reference = readNonEmpty(preferred?.payment_method_reference)

    if (!providerId || !reference) {
      return null
    }

    return { providerId, reference }
  } catch {
    return null
  }
}

function readNonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null
}
