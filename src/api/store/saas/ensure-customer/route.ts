import { MedusaError } from "@medusajs/framework/utils"
import { Modules } from "@medusajs/framework/utils"
import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { currentTenant } from "../../../../modules/saas-bridge/auth"
import { isTenantAdoptable } from "../../../../modules/saas-bridge/tenant-ownership"
import { isOwnedByRequestTenant } from "../lib/tenant-ownership"

type CustomerModule = {
  listCustomers: (
    filters: Record<string, unknown>,
    config?: Record<string, unknown>
  ) => Promise<
    Array<{
      id: string
      email: string | null
      metadata?: Record<string, unknown> | null
    }>
  >
  createCustomers: (input: {
    email?: string | null
    first_name?: string | null
    metadata?: Record<string, unknown>
  }) => Promise<{ id: string; email: string | null }>
  updateCustomers: (
    id: string,
    data: { metadata?: Record<string, unknown> }
  ) => Promise<{ id: string; email: string | null }>
}

/**
 * POST /store/saas/ensure-customer
 * Body: { external_id, email?, display_name? } → { customer: { id, email } }
 *
 * Maps a SaaS-side user identity onto a Medusa customer. Idempotent PER
 * TENANT: the customer record is stamped with metadata.tenant_id and
 * metadata.external_id, so two SaaS sites sharing this Medusa keep fully
 * separate customer pools even when an identity exists on both.
 *
 * Lookup priority: metadata.external_id (tenant-scoped) → email
 * (tenant-scoped). external_id is the stable key (SaaS session subject);
 * email is optional (Medusa v2 customers allow null email).
 */
export async function POST(
  req: MedusaRequest,
  res: MedusaResponse
) {
  const tenant = currentTenant(req)

  const { external_id, email, display_name } = (req.body ?? {}) as {
    external_id?: string
    email?: string | null
    display_name?: string | null
  }

  if (
    (typeof external_id !== "string" || external_id.trim().length === 0) &&
    !(typeof email === "string" && email.includes("@"))
  ) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      "body requires external_id or a valid email"
    )
  }

  const normalizedEmail =
    typeof email === "string" && email.includes("@")
      ? email.trim().toLowerCase()
      : null

  const customerModule = req.scope.resolve<CustomerModule>(Modules.CUSTOMER)

  // Lookup 1: by external_id within this tenant.
  if (typeof external_id === "string" && external_id.trim()) {
    const candidates = await customerModule.listCustomers(
      { metadata: { external_id: external_id.trim() } },
      { take: 20 }
    )

    const owned = candidates.find((candidate) =>
      isOwnedByRequestTenant(req, candidate.metadata)
    )

    if (owned) {
      res.json({ customer: { id: owned.id, email: owned.email } })
      return
    }
  }

  // Lookup 2: by email within this tenant. A customer matched by email that
  // carries NO tenant stamp is ADOPTED (stamped tenant_id + external_id):
  // that is the customer another flow (e.g. the logto auth plugin) created
  // for the same person. Without adoption the site login and the bridge
  // checkout would split one human into two customers.
  if (normalizedEmail) {
    const candidates = await customerModule.listCustomers(
      { email: normalizedEmail },
      { take: 20 }
    )

    const owned = candidates.find((candidate) =>
      isOwnedByRequestTenant(req, candidate.metadata)
    )

    if (owned) {
      res.json({ customer: { id: owned.id, email: owned.email } })
      return
    }

    const unclaimed = candidates.find((customer) =>
      isTenantAdoptable(customer.metadata)
    )
    if (unclaimed) {
      const adopted = await customerModule.updateCustomers(unclaimed.id, {
        metadata: {
          ...(unclaimed.metadata ?? {}),
          tenant_id: tenant.tenant_id,
          external_id:
            typeof external_id === "string" && external_id.trim()
              ? external_id.trim()
              : (unclaimed.metadata as Record<string, unknown> | null)
                  ?.external_id ?? null,
        },
      })
      res.json({
        customer: { id: adopted?.id ?? unclaimed.id, email: adopted?.email ?? unclaimed.email },
      })
      return
    }
  }

  const [firstName] = (display_name ?? "").split(" ")

  const created = await customerModule.createCustomers({
    email: normalizedEmail,
    first_name: firstName || null,
    metadata: {
      tenant_id: tenant.tenant_id,
      external_id:
        typeof external_id === "string" && external_id.trim()
          ? external_id.trim()
          : null,
    },
  })

  res.json({ customer: { id: created.id, email: created.email } })
}
