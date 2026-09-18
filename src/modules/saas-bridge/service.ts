import { MedusaError } from "@medusajs/framework/utils"
import type { SaasBridgeConfig, SaasBridgeOptions } from "./types"

/**
 * The webhooks fan-out factory of the optional peer dependency, as a loose
 * type — the peer may be absent and its module is never imported at the top
 * level of a boot-loaded file (module discovery loads subscriber files even
 * when saas_bridge is unconfigured).
 */
export type WebhooksFanOutFactory = (container: unknown) => {
  run: (args: { input: { eventName: string; eventData: Record<string, unknown> } }) => Promise<unknown>
}

/**
 * Resolve the optional peer synchronously. Only called when a `subscriptions`
 * whitelist is configured, and never at the top level of a boot-loaded file.
 * Returns null when the package is not installed.
 */
export function tryRequireWebhooksWorkflows():
  | { fullWebhooksSubscriptionsWorkflow: WebhooksFanOutFactory }
  | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require("@mengyyy369/medusa-webhooks/workflows")
  } catch {
    return null
  }
}

/**
 * Boot-time fail-fast: the fan-out workflow cannot be imported lazily from a
 * whitelisted event handler if the package is missing, so say so at init
 * with the package name instead of failing on the first event.
 */
export function assertWebhooksPeerAvailable(
  resolve: () => unknown = tryRequireWebhooksWorkflows
): void {
  if (!resolve()) {
    throw new MedusaError(
      MedusaError.Types.INVALID_ARGUMENT,
      "saas_bridge: @mengyyy369/medusa-webhooks is not installed. It fans out signed event deliveries for the subscriptions whitelist — install it (and register it as a plugin in medusa-config), or drop the subscriptions whitelist from the saas_bridge option."
    )
  }
}

/**
 * Normalize the nested `saas_bridge` plugin option into the runtime config.
 * Throws at boot when configured without any secret — that is a host
 * misconfiguration, not an absent integration.
 */
export function resolveSaasBridgeConfig(
  bridge: SaasBridgeOptions
): SaasBridgeConfig {
  const tenants = bridge.tenants?.length
    ? bridge.tenants
    : bridge.shared_secret
      ? [{ tenant_id: "default", shared_secret: bridge.shared_secret }]
      : null

  if (!tenants) {
    throw new MedusaError(
      MedusaError.Types.INVALID_ARGUMENT,
      "saas_bridge requires either tenants[] or shared_secret"
    )
  }

  return {
    tenants,
    subscriptions: bridge.subscriptions ?? [],
  }
}

/**
 * The plugin's options reach the module layer (not the plugin default export
 * — Medusa v2 never invokes it, and subscribers receive no options either),
 * so this service is the single registration point: its constructor captures
 * the normalized saas_bridge config and routes/subscribers resolve the
 * service from the shared container.
 */
export default class SaasBridgeModuleService {
  private readonly config: SaasBridgeConfig | null

  constructor(
    // module cradle — unused, the service holds no dependencies
    _container: unknown,
    options?: { saas_bridge?: SaasBridgeOptions }
  ) {
    const bridge = options?.saas_bridge
    this.config = bridge ? resolveSaasBridgeConfig(bridge) : null

    if (this.config?.subscriptions.length) {
      assertWebhooksPeerAvailable()
    }
  }

  /**
   * null when saas_bridge is unconfigured — the auth middleware treats that
   * exactly like a wrong secret (fail closed, nothing leaks).
   */
  getConfig(): SaasBridgeConfig | null {
    return this.config
  }
}
