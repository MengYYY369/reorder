import {
  ContainerRegistrationKeys,
  MedusaError,
  Modules,
} from "@medusajs/framework/utils"
import type { MedusaRequest } from "@medusajs/framework/http"
import type { ICustomerModuleService } from "@medusajs/framework/types"
import { SAAS_BRIDGE_MODULE } from "../../../../modules/saas-bridge"
import type SaasBridgeModuleService from "../../../../modules/saas-bridge/service"
import { currentTenant } from "../../../../modules/saas-bridge/auth"
import {
  getTenantOwnership,
  isTenantVisible,
} from "../../../../modules/saas-bridge/tenant-ownership"
import type { StoreReadFailureCopy } from "../../../../modules/subscription/utils/store-read-failure"
import { classifyStoreReadFailure } from "../../../../modules/subscription/utils/store-read-failure"

/**
 * The single tenant-ownership touchpoint for `/store/saas/*` routes.
 *
 * Ownership itself is decided in `src/modules/saas-bridge/tenant-ownership.ts`;
 * this file only binds that decision to a request (resolved tenant, resolved
 * customer) and to the HTTP shape (404, never 403, so a foreign resource is
 * indistinguishable from a missing one). Which *text* a failed read may answer
 * with is decided in `src/modules/subscription/utils/store-read-failure.ts`;
 * `readTenantScoped` below is the only place that decision is applied, so no
 * route has to remember it.
 */

/**
 * Exactly what the read wrappers need from `ContainerRegistrationKeys.LOGGER` —
 * the same minimum `src/workflows/utils/store-step-failure.ts` declares for the
 * workflow failures, so one resolved logger serves both.
 */
export type ReadFailureLogger = {
  error: (message: string, error?: unknown) => void
}

/**
 * Resolve the request's logger for a read boundary.
 */
export function readFailureLogger(req: MedusaRequest): ReadFailureLogger {
  return req.scope.resolve<ReadFailureLogger>(ContainerRegistrationKeys.LOGGER)
}

/**
 * Run a read whose result answers a tenant-scoping question, and make its
 * failure indistinguishable from the absence the same read answers with.
 *
 * On success this is exactly `await read()`. On any throw the decision goes to
 * `classifyStoreReadFailure`, which consults nothing about the error and always
 * answers `not_found` with the caller's own copy — so a driver fault that the
 * DAL turned into an `invalid_data` naming a table and column cannot reach the
 * body, and the status stays the one this route already uses for "you cannot see
 * this". The raw error is logged here, by the caller that has a logger and a
 * request context, before the fresh `MedusaError` is thrown: the classifier
 * stays silent so that it cannot become the thing that swallows a cause.
 *
 * A refusal the domain authors is not a failure of the read and stays untouched:
 * this wraps the read only, so the 404s a caller throws for its own reasons (see
 * `assertCustomerTenantVisible`) are still its own.
 *
 * @param logger where the raw cause is recorded — never the response
 * @param context what the read was for, for the log line only
 * @param copy the fixed text this route answers with when the row is not there
 * @param read the read itself
 */
export async function readTenantScoped<T>(
  logger: ReadFailureLogger,
  context: string,
  copy: StoreReadFailureCopy,
  read: () => Promise<T>
): Promise<T> {
  try {
    return await read()
  } catch (error) {
    const failure = classifyStoreReadFailure(error, copy)

    logger.error(`[reorder] ${context}: tenant-scoped read failed`, error)

    throw new MedusaError(failure.type, failure.message)
  }
}

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
 *
 * Both 404s this function authors are its own, and the read boundary does not
 * absorb them: the missing-id refusal is thrown before anything is read, and the
 * foreign-metadata refusal is thrown after the read succeeded. What the boundary
 * covers is the read between them — `retrieveCustomer`, the only read in this
 * file — and its failure answers the same
 * `${resource} not found for this tenant` a foreign customer answers with, so a
 * fault cannot be told apart from a withheld customer, and the core wording
 * (`Customer with id '…' was not found`) no longer echoes an id into the body.
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
  const customer = await readTenantScoped(
    readFailureLogger(req),
    `${resource} tenant check`,
    { notFound: `${resource} not found for this tenant` },
    () => customerModule.retrieveCustomer(customerId)
  )

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
