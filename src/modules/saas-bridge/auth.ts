import type {
  MedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http"
import { MedusaError } from "@medusajs/framework/utils"
import type {
  SaasBridgeConfig,
  SaasBridgeTenantConfig,
} from "./types"
import type SaasBridgeModuleService from "./service"
import { SAAS_BRIDGE_MODULE } from "./index"

/** Per-request key holding the tenant resolved by the auth middleware. */
export const SAAS_BRIDGE_TENANT_KEY = "saasBridgeTenant"

export type TenantResolution =
  | { tenant: SaasBridgeTenantConfig }
  | { error: "unknown-tenant" | "bad-secret" | "tenant-required" }

/**
 * Resolve the tenant for an incoming request:
 *   - `X-Tenant-Id` provided → must match a configured tenant AND the secret
 *   - header omitted → allowed only when exactly one tenant is configured
 *     (single-tenant hosts); with multiple tenants the id is REQUIRED
 *
 * The implicit-default fallback is contract, not convenience: the SaaS
 * webhook receiver calls reconcile without X-Tenant-Id and relies on it.
 */
export function resolveRequestTenant(
  req: Pick<MedusaRequest, "header">,
  config: SaasBridgeConfig | null
): TenantResolution {
  if (!config) {
    // saas_bridge unconfigured — fail closed exactly like a wrong secret so
    // the existence of the routes (and of the option) leaks nothing.
    return { error: "bad-secret" }
  }

  const tenantId = req.header("x-tenant-id")
  const provided = req.header("x-bridge-secret")

  let tenant: SaasBridgeTenantConfig | undefined

  if (tenantId) {
    tenant = config.tenants.find((t) => t.tenant_id === tenantId)
  } else if (config.tenants.length === 1) {
    tenant = config.tenants[0]
  } else {
    return { error: "tenant-required" }
  }

  if (!tenant) {
    return { error: "unknown-tenant" }
  }

  if (
    typeof provided !== "string" ||
    provided.length !== tenant.shared_secret.length ||
    !timingSafeEqual(provided, tenant.shared_secret)
  ) {
    return { error: "bad-secret" }
  }

  return { tenant }
}

/**
 * Shared-secret auth for every /store/saas/* route. On success the resolved
 * tenant is attached to the request scope for the route handlers.
 */
export const requireBridgeSecret =
  () =>
  (req: MedusaRequest, res: MedusaResponse, next: () => void): void => {
    try {
      const service = req.scope.resolve<SaasBridgeModuleService>(
        SAAS_BRIDGE_MODULE
      )
      const outcome = resolveRequestTenant(req, service.getConfig())

      if ("error" in outcome) {
        res.status(401).json({ error: outcome.error })
        return
      }

      ;(req.scope as unknown as Record<string, unknown>)[
        SAAS_BRIDGE_TENANT_KEY
      ] = outcome.tenant

      next()
    } catch {
      // service unresolvable — same fail-closed posture as unconfigured
      res.status(401).json({ error: "bad-secret" })
    }
  }

/** Route handlers read the tenant resolved by the auth middleware. */
export function currentTenant(req: MedusaRequest): SaasBridgeTenantConfig {
  const tenant = (req.scope as unknown as Record<string, unknown>)[
    SAAS_BRIDGE_TENANT_KEY
  ] as SaasBridgeTenantConfig | undefined

  if (!tenant) {
    throw new MedusaError(
      MedusaError.Types.UNAUTHORIZED,
      "no tenant resolved for request"
    )
  }

  return tenant
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false
  }

  let mismatch = 0

  for (let i = 0; i < a.length; i += 1) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }

  return mismatch === 0
}

/**
 * The single touchpoint into the plugin's middleware aggregation: every
 * /store/saas/* route sits behind the shared-secret check.
 */
export const saasBridgeMiddlewares = [
  {
    matcher: "/store/saas/*",
    middlewares: [requireBridgeSecret()],
  },
]
