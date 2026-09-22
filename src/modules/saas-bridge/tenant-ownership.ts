/**
 * Tenant ownership for bridge resources.
 *
 * The stamp lives in `customer.metadata.tenant_id`, written by
 * `POST /store/saas/ensure-customer` (and by the site's auth plugin). A customer
 * created before the bridge existed — or by a flow that does not stamp — carries
 * no tenant, and the two rules below decide what that means. They live here
 * rather than inline in each route because the bug this replaces was a drifted
 * inline copy: five routes each re-typed the comparison and `reconcile` answered
 * a mismatch with an empty list instead of a rejection.
 */
export type TenantOwnership = "self" | "unclaimed" | "foreign"

export function readOwnerTenantId(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== "object") {
    return null
  }

  const owner = (metadata as Record<string, unknown>).tenant_id

  return typeof owner === "string" && owner.trim() ? owner.trim() : null
}

/**
 * Who the resource's own metadata says it belongs to. Independent of how many
 * tenants the deployment configures.
 */
export function getTenantOwnership(
  metadata: unknown,
  tenantId: string
): TenantOwnership {
  const owner = readOwnerTenantId(metadata)

  if (owner === null) {
    return "unclaimed"
  }

  return owner === tenantId ? "self" : "foreign"
}

/**
 * Visibility rule used by every read/write that must not cross tenants.
 *
 * An unclaimed resource is this tenant's on a single-tenant deployment — that is
 * the contract the implicit-default tenant resolution in `auth.ts` relies on, and
 * without it every pre-bridge customer would vanish from the bridge. On a
 * multi-tenant deployment the same resource belongs to nobody yet, so it stays
 * invisible; claiming it is `ensure-customer`'s job.
 */
export function isTenantVisible(input: {
  metadata: unknown
  tenant_id: string
  single_tenant: boolean
}): boolean {
  const ownership = getTenantOwnership(input.metadata, input.tenant_id)

  if (ownership === "self") {
    return true
  }

  return ownership === "unclaimed" && input.single_tenant
}

/**
 * Adoption rule: `ensure-customer` may stamp a customer it matched by email but
 * that carries no tenant. Foreign-stamped customers are never adoptable, and an
 * unclaimed customer stays adoptable even on a multi-tenant deployment — that is
 * how one human logging in from the site and from the bridge ends up as one
 * customer instead of two.
 */
export function isTenantAdoptable(metadata: unknown): boolean {
  return readOwnerTenantId(metadata) === null
}
