import { MedusaError, Modules } from "@medusajs/framework/utils"
import type { MedusaRequest } from "@medusajs/framework/http"
import type { ICustomerModuleService } from "@medusajs/framework/types"
import { SAAS_BRIDGE_MODULE } from "../../../../modules/saas-bridge"
import type SaasBridgeModuleService from "../../../../modules/saas-bridge/service"
import { currentTenant } from "../../../../modules/saas-bridge/auth"
import {
  getTenantOwnership,
  isTenantVisible,
} from "../../../../modules/saas-bridge/tenant-ownership"

/**
 * The single tenant-ownership touchpoint for `/store/saas/*` routes.
 *
 * Ownership itself is decided in `src/modules/saas-bridge/tenant-ownership.ts`;
 * this file only binds that decision to a request (resolved tenant, resolved
 * customer) and to the HTTP shape (404, never 403, so a foreign resource is
 * indistinguishable from a missing one).
 */

type TenantScope = {
  tenant_id: string
  single_tenant: boolean
}

function resolveTenantScope(req: MedusaRequest): TenantScope {
  const tenant = currentTenant(req)
  const bridge = req.scope.resolve<SaasBridgeModuleService>(SAAS_BRIDGE_MODULE)

  return {
    tenant_id: tenant.tenant_id,
    single_tenant: (bridge.getConfig()?.tenants.length ?? 0) === 1,
  }
}

/**
 * @throws MedusaError NOT_FOUND when the resource is foreign, or unclaimed on a
 * multi-tenant host.
 */
export function assertTenantVisible(
  req: MedusaRequest,
  metadata: unknown,
  resource: string
): void {
  const scope = resolveTenantScope(req)

  if (isTenantVisible({ ...scope, metadata })) {
    return
  }

  // Deliberately 404 — do not leak the existence of foreign resources.
  throw new MedusaError(
    MedusaError.Types.NOT_FOUND,
    `${resource} not found for this tenant`
  )
}

/**
 * Load the customer behind a resource and assert it is this tenant's. A missing
 * id is reported as 404 for the *resource*, not 400: the caller asked about
 * something it cannot see.
 */
export async function assertCustomerTenantVisible(
  req: MedusaRequest,
  customerId: string | null | undefined,
  resource: string
): Promise<void> {
  if (!customerId) {
    throw new MedusaError(
      MedusaError.Types.NOT_FOUND,
      `${resource} has no customer`
    )
  }

  const customerModule = req.scope.resolve<ICustomerModuleService>(
    Modules.CUSTOMER
  )
  const customer = await customerModule.retrieveCustomer(customerId)

  assertTenantVisible(req, customer?.metadata, resource)
}

/**
 * Exactly this tenant's resource — stricter than `assertTenantVisible`, which
 * also admits unclaimed resources on a single-tenant host. `ensure-customer`
 * matches candidates with this, so an unclaimed customer is never returned
 * before it has been stamped.
 */
export function isOwnedByRequestTenant(
  req: MedusaRequest,
  metadata: unknown
): boolean {
  return getTenantOwnership(metadata, resolveTenantScope(req).tenant_id) === "self"
}
