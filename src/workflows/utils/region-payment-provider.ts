import { ContainerRegistrationKeys } from "@medusajs/framework/utils"

/**
 * Medusa's placeholder provider. It is always enabled on every region and can
 * never charge anything, so it must never be selected for a real renewal.
 */
export const SYSTEM_DEFAULT_PROVIDER_ID = "pp_system_default"

/**
 * The provider a manual renewal should charge through, given the ids enabled on
 * the subscription's region.
 *
 * A claimed trial is created with `payment_provider_id: null` **on purpose**
 * (`create-trial-subscription.ts`: "a claimed trial without a bound method is
 * unchargeable by design"), so the manual renewal path has to resolve one at
 * renewal time. The region is the authority: it is the same list the storefront
 * offers at checkout, and it already carries the provider the subscription was
 * sold under.
 *
 * Sorted so the same region always yields the same provider — silently
 * switching rails would change what the customer is charged by, so that has to
 * be an explicit data change, not an accident of array order.
 *
 * Returns `null` when nothing chargeable is enabled; the caller decides what to
 * tell the customer.
 */
export function pickChargeableProvider(providerIds: string[]): string | null {
  const usable = providerIds
    .filter(
      (id) =>
        typeof id === "string" && id.length > 0 && id !== SYSTEM_DEFAULT_PROVIDER_ID
    )
    .sort()

  return usable[0] ?? null
}

/**
 * The payment provider ids enabled on a region.
 *
 * Returns `[]` for a missing region id — "no region" and "region with nothing
 * enabled" lead to the same decision, and the caller only needs the list.
 */
export async function listEnabledProviderIds(
  container: { resolve(key: string): unknown },
  regionId: string | null | undefined
): Promise<string[]> {
  if (!regionId) {
    return []
  }

  const query = container.resolve(ContainerRegistrationKeys.QUERY) as {
    graph: (config: Record<string, unknown>) => Promise<{
      data: Array<{ payment_providers?: Array<{ id?: string | null }> | null }>
    }>
  }

  const { data } = await query.graph({
    entity: "region",
    fields: ["id", "payment_providers.id"],
    filters: { id: regionId },
  })

  const providers = data[0]?.payment_providers ?? []

  return providers
    .map((provider) => provider?.id)
    .filter((id): id is string => typeof id === "string" && id.length > 0)
}
