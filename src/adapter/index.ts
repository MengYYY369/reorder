import type {
  ExtraPaymentMethodRow,
  PaymentScope,
  SiteAdapter,
} from "@mengyyy369/medusa-payment-methods/modules/payment-methods"

import { SubscriptionStatus } from "../modules/subscription/types"
import { isNativeSubscriptionReference } from "../modules/subscription/utils/native-subscription"
import { getSiteAdapterContainer } from "./container"

/**
 * reorder's `SiteAdapter` for `@mengyyy369/medusa-payment-methods`.
 *
 * The plugin knows nothing about subscriptions; this object is how it learns
 * what reorder owns. It is registered in the host's plugin options
 * (`adapter: reorderSiteAdapter`) and every method is called by the plugin
 * without a container, so it reads subscriptions through the container the
 * subscription module service captured at boot (`./container`).
 *
 * Three answers, one source of truth — the `subscription` table:
 * - `listScopes`: the products this customer holds a live subscription for.
 *   The plugin treats a scope as opaque, so reorder's scope key is the product
 *   id and the label is the product title from the subscription snapshot.
 * - `listExtraRows`: the `native` rail — subscriptions PayPal itself charges.
 *   The plugin only mirrors them into its list; it never unbinds or prefers
 *   them (`canUnbind: false`, forced again by the plugin).
 * - `isInUse`: whether a provider-side method is still referenced by a live
 *   subscription. This gates the plugin's only irreversible operation (deleting
 *   the wallet at the provider), so it is answered from the same live status set
 *   the renewal path charges.
 */

/**
 * Subscription statuses that can still be charged, on either rail.
 *
 * `cancelled` is excluded: the scheduler never renews a cancelled row and PayPal
 * has already stopped its own recurrence, so a method only a cancelled
 * subscription points at is genuinely free to unbind.
 */
const LIVE_SUBSCRIPTION_STATUSES = [
  SubscriptionStatus.ACTIVE,
  SubscriptionStatus.PAUSED,
  SubscriptionStatus.PAST_DUE,
] as const

/** The row shape the adapter needs out of the subscription table. */
type SubscriptionAdapterRow = {
  id: string
  reference: string
  status: string
  customer_id: string
  product_id: string
  product_snapshot?: { product_title?: string | null } | null
  payment_context?: {
    payment_provider_id?: string | null
    payment_method_reference?: string | null
  } | null
}

/**
 * The reader Medusa registers on the subscription module's container.
 *
 * `MedusaService` derives the registration from the model name
 * (`lowerCaseFirst("Subscription") + "Service"`) and every generated method on
 * the module service reaches it through `this.__container__[name]` — the
 * adapter uses the same reader because it is the only subscription access the
 * module's own container exposes (it carries no query graph).
 */
type SubscriptionReadService = {
  list: (
    filters: Record<string, unknown>,
    config?: Record<string, unknown>
  ) => Promise<SubscriptionAdapterRow[]>
}

type AdapterContainer = {
  subscriptionService?: SubscriptionReadService
}

function readSubscriptionService(): SubscriptionReadService {
  const container = getSiteAdapterContainer()
  const service = (container as unknown as AdapterContainer).subscriptionService

  if (!service || typeof service.list !== "function") {
    throw new Error(
      "The subscription module's reader is not available on the module container"
    )
  }

  return service
}

async function listLiveSubscriptions(
  customerId: string
): Promise<SubscriptionAdapterRow[]> {
  const service = readSubscriptionService()

  const rows = await service.list({
    customer_id: customerId,
    status: [...LIVE_SUBSCRIPTION_STATUSES],
  })

  return rows ?? []
}

export const reorderSiteAdapter: SiteAdapter = {
  async listScopes({ customerId }): Promise<PaymentScope[]> {
    const rows = await listLiveSubscriptions(customerId)
    const scopes = new Map<string, string>()

    for (const row of rows) {
      const id = readNonEmpty(row.product_id)

      if (!id || scopes.has(id)) {
        continue
      }

      scopes.set(id, readNonEmpty(row.product_snapshot?.product_title) ?? id)
    }

    return [...scopes].map(([id, label]) => ({ id, label }))
  },

  async listExtraRows({ customerId }): Promise<ExtraPaymentMethodRow[]> {
    const rows = await listLiveSubscriptions(customerId)
    const extraRows: ExtraPaymentMethodRow[] = []

    for (const row of rows) {
      if (!isNativeSubscriptionReference(row.reference)) {
        continue
      }

      const providerId = readNonEmpty(row.payment_context?.payment_provider_id)

      // The plugin drops rows without a provider id; skip them here so the
      // contract is answered with rows it can actually use.
      if (!providerId) {
        continue
      }

      extraRows.push({
        id: row.id,
        provider_id: providerId,
        rail: "native",
        summary: { type: "paypal" },
        canUnbind: false,
        scope: readNonEmpty(row.product_id),
        subscription_id: row.id,
      })
    }

    return extraRows
  },

  async isInUse({ customerId, paymentMethodReference }) {
    const reference = readNonEmpty(paymentMethodReference)

    if (!reference) {
      return { inUse: false }
    }

    const rows = await listLiveSubscriptions(customerId)
    const inUse = rows.some(
      (row) =>
        readNonEmpty(row.payment_context?.payment_method_reference) === reference
    )

    return {
      inUse,
      reason: inUse ? "active_subscription" : undefined,
    }
  },
}

function readNonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null
}

export default reorderSiteAdapter
