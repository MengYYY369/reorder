import type { MedusaContainer } from "@medusajs/framework/types"
import {
  findCustomerPaymentMethod,
  listCustomerAccountHolders as listVaultedAccountHolders,
  listCustomerPaymentMethods as listVaultedPaymentMethods,
  type VaultedPaymentMethod,
} from "@mengyyy369/medusa-payment-methods"

import type {
  SubscriptionAccountHolderRecord,
  SubscriptionPaymentMethodSummary,
} from "../types"
import { subscriptionErrors } from "./errors"

export type ResolvedSubscriptionPaymentMethod = {
  summary: SubscriptionPaymentMethodSummary
  account_holder: SubscriptionAccountHolderRecord
}

/**
 * reorder's payment-method reads, delegated to
 * `@mengyyy369/medusa-payment-methods`.
 *
 * The provider walk and the parse of provider-specific `data` used to live
 * here; both moved into the plugin so the site and the plugin cannot drift into
 * two list/parse implementations. What stays is reorder's own contract: the
 * flat summary shape its Store/Admin responses publish (including
 * `created_at`), and the ownership error a subscription raises when a method is
 * not the customer's.
 *
 * The package is a hard build-time dependency; the plugin's *module* is
 * optional at runtime, which only the preferred-method resolution has to care
 * about (see `./preferred-payment-method`).
 */

/** Maps the plugin's vaulted row onto the flat summary reorder publishes. */
function toSummary(
  method: VaultedPaymentMethod
): SubscriptionPaymentMethodSummary {
  return {
    id: method.id,
    provider_id: method.provider_id,
    type: method.summary.type,
    brand: method.summary.brand ?? null,
    last4: method.summary.last4 ?? null,
    exp_month: method.summary.exp_month ?? null,
    exp_year: method.summary.exp_year ?? null,
    created_at: method.created_at,
  }
}

/**
 * Lists the payment methods a customer has saved with the configured payment
 * providers, newest first.
 */
export async function listCustomerPaymentMethods(
  container: MedusaContainer,
  input: {
    customer_id: string
    provider_id?: string | null
  }
): Promise<SubscriptionPaymentMethodSummary[]> {
  const methods = await listVaultedPaymentMethods(container, {
    customer_id: input.customer_id,
    provider_id: input.provider_id ?? null,
  })

  return methods.map(toSummary)
}

/**
 * Resolves a single saved payment method and guarantees it belongs to the given
 * customer, so a subscription can never be pointed at another customer's card.
 */
export async function resolveCustomerPaymentMethod(
  container: MedusaContainer,
  input: {
    customer_id: string
    provider_id: string
    payment_method_id: string
  }
): Promise<ResolvedSubscriptionPaymentMethod> {
  const accountHolders = await listCustomerAccountHolders(
    container,
    input.customer_id,
    input.provider_id
  )

  if (!accountHolders.length) {
    throw subscriptionErrors.invalidData(
      `Customer '${input.customer_id}' has no saved payment account holder for provider '${input.provider_id}'`
    )
  }

  const method = await findCustomerPaymentMethod(container, {
    customer_id: input.customer_id,
    provider_id: input.provider_id,
    payment_method_id: input.payment_method_id,
  })

  if (!method) {
    throw subscriptionErrors.invalidData(
      `Payment method '${input.payment_method_id}' is not a saved payment method of customer '${input.customer_id}' for provider '${input.provider_id}'`
    )
  }

  // The plugin's lookup is provider-scoped, and a customer holds one account
  // holder per provider, so the first match is the holder the method came from.
  // It carries the provider-side customer reference the subscription stores.
  return {
    summary: toSummary(method),
    account_holder: accountHolders[0],
  }
}

/**
 * Resolves the most recently saved payment method of a customer for a provider.
 *
 * Used by subscription checkout when the payment session itself does not carry a
 * reusable payment method reference.
 */
export async function resolveLatestCustomerPaymentMethod(
  container: MedusaContainer,
  input: {
    customer_id: string
    provider_id: string
  }
): Promise<SubscriptionPaymentMethodSummary | null> {
  const summaries = await listCustomerPaymentMethods(container, input)

  return summaries[0] ?? null
}

export async function listCustomerAccountHolders(
  container: MedusaContainer,
  customerId: string,
  providerId: string | null
): Promise<SubscriptionAccountHolderRecord[]> {
  return listVaultedAccountHolders(container, customerId, providerId)
}
