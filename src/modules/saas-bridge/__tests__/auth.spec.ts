import {
  currentTenant,
  requireBridgeSecret,
  resolveRequestTenant,
  SAAS_BRIDGE_TENANT_KEY,
} from "../auth"
import {
  assertWebhooksPeerAvailable,
  resolveSaasBridgeConfig,
  default as SaasBridgeModuleService,
} from "../service"
import { SAAS_BRIDGE_MODULE } from "../index"
import type { SaasBridgeConfig } from "../types"

type AnyContainer = Record<string, unknown>

function makeService(config: SaasBridgeConfig | null) {
  return { getConfig: () => config }
}

function makeContainer(config: SaasBridgeConfig | null): AnyContainer {
  return {
    resolve: jest.fn((key: string) => {
      if (key === SAAS_BRIDGE_MODULE) {
        return makeService(config)
      }
      throw new Error(`unregistered: ${key}`)
    }),
  }
}

function makeReq(
  container: AnyContainer,
  headers: Record<string, string> = {},
  attachTenant: { tenant_id: string; shared_secret: string } | null = null
) {
  const scope = { ...container }
  if (attachTenant) {
    scope[SAAS_BRIDGE_TENANT_KEY] = attachTenant
  }
  return {
    scope,
    header: (name: string) => {
      const key = Object.keys(headers).find(
        (k) => k.toLowerCase() === name.toLowerCase()
      )
      return key ? headers[key] : undefined
    },
  }
}

function makeRes() {
  const res = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  }

  return res as unknown as {
    status: ReturnType<typeof jest.fn>
    json: ReturnType<typeof jest.fn>
  }
}

const SINGLE: SaasBridgeConfig = resolveSaasBridgeConfig({
  shared_secret: "s3cr3t-value",
  subscriptions: ["order.placed"],
})

const TENANT_A = { tenant_id: "saas-a", shared_secret: "secret-a" }
const TENANT_B = { tenant_id: "saas-b", shared_secret: "secret-b" }
const MULTI: SaasBridgeConfig = resolveSaasBridgeConfig({
  tenants: [TENANT_A, TENANT_B],
  subscriptions: ["order.placed"],
})

let container: AnyContainer
let res: ReturnType<typeof makeRes>
let next: ReturnType<typeof jest.fn>
const middleware = requireBridgeSecret()

beforeEach(() => {
  container = makeContainer(SINGLE)
  res = makeRes()
  next = jest.fn()
})

describe("single-tenant config (shared_secret shorthand)", () => {
  it("accepts the correct secret and calls next", async () => {
    await middleware(
      makeReq(container, { "X-Bridge-Secret": "s3cr3t-value" }) as never,
      res as never,
      next
    )

    expect(next).toHaveBeenCalled()
    expect(res.status).not.toHaveBeenCalled()
  })

  it("rejects a wrong secret with 401", async () => {
    await middleware(
      makeReq(container, { "X-Bridge-Secret": "wrong" }) as never,
      res as never,
      next
    )

    expect(next).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(401)
  })

  it("rejects a missing secret with 401", async () => {
    await middleware(makeReq(container) as never, res as never, next)

    expect(next).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(401)
  })

  it("resolves the implicit 'default' tenant", () => {
    const outcome = resolveRequestTenant(
      makeReq(container, { "X-Bridge-Secret": "s3cr3t-value" }) as never,
      SINGLE
    )

    expect(outcome).toEqual({
      tenant: { tenant_id: "default", shared_secret: "s3cr3t-value" },
    })
  })
})

describe("fail-closed without configuration", () => {
  it("401s like a bad secret when saas_bridge is unconfigured", async () => {
    await middleware(
      makeReq(makeContainer(null), { "X-Bridge-Secret": "s3cr3t-value" }) as never,
      res as never,
      next
    )

    expect(next).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(401)
    expect(res.json).toHaveBeenCalledWith({ error: "bad-secret" })
  })

  it("401s when the module service cannot be resolved at all", async () => {
    const broken = {
      resolve: () => {
        throw new Error("boom")
      },
    }

    await middleware(
      makeReq(broken, { "X-Bridge-Secret": "s3cr3t-value" }) as never,
      res as never,
      next
    )

    expect(next).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(401)
  })

  it("resolveRequestTenant reports bad-secret for a null config", () => {
    const outcome = resolveRequestTenant(
      makeReq(container, { "X-Bridge-Secret": "s3cr3t-value" }) as never,
      null
    )

    expect(outcome).toEqual({ error: "bad-secret" })
  })
})

describe("multi-tenant config", () => {
  it("resolves a tenant by X-Tenant-Id with its own secret", () => {
    const outcome = resolveRequestTenant(
      makeReq(
        makeContainer(MULTI),
        { "X-Tenant-Id": "saas-b", "X-Bridge-Secret": "secret-b" }
      ) as never,
      MULTI
    )

    expect(outcome).toEqual({ tenant: TENANT_B })
  })

  it("rejects a valid secret presented for another tenant", () => {
    const outcome = resolveRequestTenant(
      makeReq(
        makeContainer(MULTI),
        { "X-Tenant-Id": "saas-a", "X-Bridge-Secret": "secret-b" }
      ) as never,
      MULTI
    )

    expect(outcome).toEqual({ error: "bad-secret" })
  })

  it("rejects an unknown tenant id", () => {
    const outcome = resolveRequestTenant(
      makeReq(
        makeContainer(MULTI),
        { "X-Tenant-Id": "saas-z", "X-Bridge-Secret": "secret-b" }
      ) as never,
      MULTI
    )

    expect(outcome).toEqual({ error: "unknown-tenant" })
  })

  it("requires X-Tenant-Id when multiple tenants are configured", () => {
    const outcome = resolveRequestTenant(
      makeReq(makeContainer(MULTI), { "X-Bridge-Secret": "secret-a" }) as never,
      MULTI
    )

    expect(outcome).toEqual({ error: "tenant-required" })
  })

  it("middleware 401s multi-tenant calls without a tenant id", async () => {
    await middleware(
      makeReq(makeContainer(MULTI), { "X-Bridge-Secret": "secret-a" }) as never,
      res as never,
      next
    )

    expect(res.status).toHaveBeenCalledWith(401)
    expect(res.json).toHaveBeenCalledWith({ error: "tenant-required" })
  })
})

describe("currentTenant", () => {
  it("returns the tenant attached by the middleware", () => {
    const req = makeReq(
      container,
      {},
      { tenant_id: "saas-a", shared_secret: "secret-a" }
    )

    expect(currentTenant(req as never)).toEqual(TENANT_A)
  })

  it("throws when no tenant was resolved", () => {
    expect(() => currentTenant(makeReq(container) as never)).toThrow(
      /no tenant resolved/
    )
  })
})

describe("resolveSaasBridgeConfig", () => {
  it("normalizes the shared_secret shorthand to the default tenant", () => {
    const resolved = resolveSaasBridgeConfig({
      shared_secret: "s3cr3t-value",
    })

    expect(resolved.tenants).toEqual([
      { tenant_id: "default", shared_secret: "s3cr3t-value" },
    ])
    expect(resolved.subscriptions).toEqual([])
  })

  it("passes the tenant list through and defaults subscriptions to empty", () => {
    const resolved = resolveSaasBridgeConfig({ tenants: [TENANT_A, TENANT_B] })

    expect(resolved.tenants).toEqual([TENANT_A, TENANT_B])
    expect(resolved.subscriptions).toEqual([])
  })

  it("throws when configured without any secret", () => {
    expect(() => resolveSaasBridgeConfig({})).toThrow(/tenants\[\]|shared_secret/)
  })
})

describe("SaasBridgeModuleService option capture", () => {
  it("carries the normalized config when saas_bridge is configured", () => {
    const service = new SaasBridgeModuleService({}, { saas_bridge: { shared_secret: "x" } })

    expect(service.getConfig()).toEqual({
      tenants: [{ tenant_id: "default", shared_secret: "x" }],
      subscriptions: [],
    })
  })

  it("is unconfigured (null) when saas_bridge is absent", () => {
    const service = new SaasBridgeModuleService({}, {})

    expect(service.getConfig()).toBeNull()
  })

  it("fails fast at boot when the whitelist is set but the optional peer is missing", () => {
    expect(
      () =>
        new SaasBridgeModuleService(
          {},
          { saas_bridge: { shared_secret: "x", subscriptions: ["order.placed"] } }
        )
    ).toThrow(/medusa-webhooks/)
  })

  it("boots without the optional peer when no whitelist is configured", () => {
    const service = new SaasBridgeModuleService(
      {},
      { saas_bridge: { shared_secret: "x", subscriptions: [] } }
    )

    expect(service.getConfig()?.subscriptions).toEqual([])
  })
})

describe("assertWebhooksPeerAvailable", () => {
  it("passes when the peer resolves", () => {
    expect(() => assertWebhooksPeerAvailable(() => ({ ok: true }))).not.toThrow()
  })

  it("throws naming the missing package", () => {
    expect(() => assertWebhooksPeerAvailable(() => null)).toThrow(
      /@mengyyy369\/medusa-webhooks/
    )
  })
})
