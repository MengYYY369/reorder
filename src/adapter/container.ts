import type { MedusaContainer } from "@medusajs/framework/types"

/**
 * The container the subscription module service was built with.
 *
 * Medusa constructs every module service with that module's **own** container
 * (`@medusajs/modules-sdk` `load-internal.js`: `new moduleService(localContainer.cradle, …)`)
 * and `MedusaService` stores it on the instance as `this.__container__`. That
 * container is deliberately small — the module's declared dependencies plus the
 * services Medusa generates for its models (`subscriptionService`,
 * `subscriptionRepository`) — so it is a reader, not the application container.
 *
 * The site adapter needs it because the payment-methods plugin calls
 * `adapter.listScopes({ customerId })` without a container of its own. The
 * subscription module service captures the container here at boot and the
 * adapter resolves its subscription reader from it at request time.
 */
let siteAdapterContainer: MedusaContainer | null = null

/** Called once by the subscription module service, as the loader constructs it. */
export function setSiteAdapterContainer(container: MedusaContainer): void {
  siteAdapterContainer = container
}

/**
 * The captured container, or a throw when the subscription module has not been
 * initialized. Throwing is the honest answer: the adapter has no fallback way
 * to read subscriptions, and the plugin's destructive path (`isInUse`) already
 * treats a throwing adapter as fail-closed.
 */
export function getSiteAdapterContainer(): MedusaContainer {
  if (!siteAdapterContainer) {
    throw new Error(
      "The reorder subscription module service has not been initialized yet; the site adapter cannot read subscriptions"
    )
  }

  return siteAdapterContainer
}
