import {
  getTenantOwnership,
  isTenantAdoptable,
  isTenantVisible,
  readOwnerTenantId,
} from "../tenant-ownership"

const metadataOf = (tenantId: unknown) => ({ tenant_id: tenantId })

describe("readOwnerTenantId", () => {
  it("treats missing, blank and non-string stamps as unclaimed", () => {
    expect(readOwnerTenantId(null)).toBeNull()
    expect(readOwnerTenantId(undefined)).toBeNull()
    expect(readOwnerTenantId({})).toBeNull()
    expect(readOwnerTenantId({ tenant_id: "  " })).toBeNull()
    expect(readOwnerTenantId({ tenant_id: 7 })).toBeNull()
    expect(readOwnerTenantId("not-an-object")).toBeNull()
  })

  it("trims a present stamp", () => {
    expect(readOwnerTenantId({ tenant_id: " acme " })).toBe("acme")
  })
})

describe("getTenantOwnership", () => {
  it("separates own, foreign and unclaimed", () => {
    expect(getTenantOwnership(metadataOf("acme"), "acme")).toBe("self")
    expect(getTenantOwnership(metadataOf("other"), "acme")).toBe("foreign")
    expect(getTenantOwnership(metadataOf(null), "acme")).toBe("unclaimed")
  })
})

describe("isTenantVisible", () => {
  it("claims unclaimed resources on a single-tenant host", () => {
    expect(
      isTenantVisible({
        metadata: metadataOf(null),
        tenant_id: "acme",
        single_tenant: true,
      })
    ).toBe(true)
  })

  it("hides unclaimed resources when several tenants share the host", () => {
    expect(
      isTenantVisible({
        metadata: metadataOf(null),
        tenant_id: "acme",
        single_tenant: false,
      })
    ).toBe(false)
  })

  it("always hides a foreign resource", () => {
    for (const singleTenant of [true, false]) {
      expect(
        isTenantVisible({
          metadata: metadataOf("other"),
          tenant_id: "acme",
          single_tenant: singleTenant,
        })
      ).toBe(false)
    }
  })

  it("always shows its own resource", () => {
    for (const singleTenant of [true, false]) {
      expect(
        isTenantVisible({
          metadata: metadataOf("acme"),
          tenant_id: "acme",
          single_tenant: singleTenant,
        })
      ).toBe(true)
    }
  })
})

describe("isTenantAdoptable", () => {
  it("adopts only unclaimed customers, on any deployment shape", () => {
    expect(isTenantAdoptable(metadataOf(null))).toBe(true)
    expect(isTenantAdoptable({})).toBe(true)
    expect(isTenantAdoptable(metadataOf("acme"))).toBe(false)
    expect(isTenantAdoptable(metadataOf("other"))).toBe(false)
    expect(isTenantAdoptable(null)).toBe(true)
  })
})
