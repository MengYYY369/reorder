/**
 * Shared-secret SaaS integration surface (merged from the retired
 * medusa-saas-bridge plugin). All types live in this self-contained module —
 * nothing outside it (plus the route/subscriber files and the middleware
 * aggregation point) knows about the bridge.
 */

export interface SaasBridgeTenantConfig {
  /** Stable tenant id — stamped onto customers and required on every call when multiple tenants exist. */
  tenant_id: string
  /** Per-tenant shared secret (X-Bridge-Secret header). */
  shared_secret: string
}

/**
 * The nested plugin option: `{ resolve: "@mengyyy369/reorder", options: {
 * saas_bridge: { shared_secret, tenants?, subscriptions? } } }`.
 *
 * Absent → the bridge is OFF: every /store/saas/* route fails closed with a
 * 401-class rejection and no event is forwarded, exactly like a deployment
 * without the old bridge plugin.
 */
export type SaasBridgeOptions = {
  /**
   * Single-tenant shorthand: treated as tenant_id "default". Ignored when
   * `tenants` is present.
   */
  shared_secret?: string
  /**
   * Multi-tenant form: one entry per connected SaaS site, each with its own
   * secret and its own customer/entitlement scope.
   */
  tenants?: SaasBridgeTenantConfig[]
  /**
   * Event whitelist forwarded into the medusa-webhooks fan-out. Empty or
   * omitted → endpoints stay active but nothing is forwarded.
   */
  subscriptions?: string[]
}

/** Normalized runtime config carried by the saas_bridge module service. */
export type SaasBridgeConfig = {
  tenants: SaasBridgeTenantConfig[]
  subscriptions: string[]
}
