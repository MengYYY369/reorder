import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import type { MedusaContainer } from "@medusajs/framework/types"
import { buildPayload, forwardEvent } from "../forward"
import type { FanOutResolver } from "../forward"
import type { SaasBridgeConfig } from "../types"

const CONFIG: SaasBridgeConfig = {
  tenants: [{ tenant_id: "default", shared_secret: "x" }],
  subscriptions: ["order.placed", "subscription.created"],
}

function makeLogger() {
  return {
    info: jest.fn(),
    error: jest.fn(),
  }
}

function makeContainer(order: Record<string, unknown> | null, cartId?: string) {
  const graph = jest.fn(async (input: { entity: string }) => {
    if (input.entity === "order") {
      return { data: order ? [order] : [] }
    }
    if (input.entity === "order_cart") {
      return { data: cartId ? [{ cart_id: cartId }] : [] }
    }
    return { data: [] }
  })
  const query: unknown = Object.assign(jest.fn(), { graph })
  const container = {
    resolve: jest.fn((key: string) => {
      if (key === ContainerRegistrationKeys.QUERY) {
        return query
      }
      throw new Error(`unregistered: ${key}`)
    }),
  }
  return { container: container as unknown as MedusaContainer, graph, query }
}

function makeFanOut() {
  const run = jest.fn(async (_input: unknown) => ({}))
  const resolver: FanOutResolver = () => ({
    fullWebhooksSubscriptionsWorkflow: () => ({ run }),
  })
  return { run, resolver }
}

describe("forwardEvent — whitelist filtering", () => {
  it("does not forward events outside the whitelist", async () => {
    const { run, resolver } = makeFanOut()
    const logger = makeLogger()

    await forwardEvent({
      container: {} as MedusaContainer,
      config: CONFIG,
      eventName: "product.created",
      eventData: {},
      logger,
      resolveFanOut: resolver,
    })

    expect(run).not.toHaveBeenCalled()
  })

  it("does not forward anything when saas_bridge is unconfigured", async () => {
    const { run, resolver } = makeFanOut()
    const logger = makeLogger()

    await forwardEvent({
      container: {} as MedusaContainer,
      config: null,
      eventName: "order.placed",
      eventData: {},
      logger,
      resolveFanOut: resolver,
    })

    expect(run).not.toHaveBeenCalled()
  })

  it("forwards whitelisted events through the fan-out workflow", async () => {
    const { run, resolver } = makeFanOut()
    const logger = makeLogger()
    const { container } = makeContainer(null)

    await forwardEvent({
      container,
      config: CONFIG,
      eventName: "subscription.created",
      eventData: { id: "sub_1", customer_id: "cus_1" },
      logger,
      resolveFanOut: resolver,
    })

    expect(run).toHaveBeenCalledTimes(1)
    const call = run.mock.calls[0][0] as {
      input: { eventName: string; eventData: Record<string, unknown> }
    }
    expect(call.input.eventName).toEqual("subscription.created")
    expect(call.input.eventData.customer_id).toEqual("cus_1")
  })
})

describe("forwardEvent — failure logging", () => {
  it("logs fan-out failures and does not throw into the event pipeline", async () => {
    const run = jest.fn(async (_input: unknown) => {
      throw new Error("fan-out exploded")
    })
    const resolver: FanOutResolver = () => ({
      fullWebhooksSubscriptionsWorkflow: () => ({ run }),
    })
    const logger = makeLogger()
    const { container } = makeContainer(null)

    await expect(
      forwardEvent({
        container,
        config: CONFIG,
        eventName: "order.placed",
        eventData: { id: "order_1" },
        logger,
        resolveFanOut: resolver,
      })
    ).resolves.toBeUndefined()

    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("fan-out exploded")
    )
  })

  it("logs the missing optional peer instead of throwing", async () => {
    const resolver: FanOutResolver = () => null
    const logger = makeLogger()
    const { container } = makeContainer(null)

    await expect(
      forwardEvent({
        container,
        config: CONFIG,
        eventName: "order.placed",
        eventData: { id: "order_1" },
        logger,
        resolveFanOut: resolver,
      })
    ).resolves.toBeUndefined()

    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("@mengyyy369/medusa-webhooks")
    )
  })
})

describe("buildPayload — enrichment", () => {
  it("enriches order-ish events with identity and amount fields", async () => {
    const { container } = makeContainer(
      {
        id: "order_1",
        display_id: 42,
        customer_id: "cus_1",
        email: "ada@medusa.test",
        payment_status: "captured",
        currency_code: "usd",
        total: 1800,
        metadata: { plan: "monthly" },
      },
      "cart_1"
    )

    const payload = await buildPayload(container, "order.placed", {
      id: "order_1",
    })

    expect(payload.event).toEqual("order.placed")
    expect(payload.order_id).toEqual("order_1")
    expect(payload.cart_id).toEqual("cart_1")
    expect(payload.customer_id).toEqual("cus_1")
    expect(payload.email).toEqual("ada@medusa.test")
    expect(payload.data.display_id).toEqual(42)
    expect(payload.data.payment_status).toEqual("captured")
    expect(payload.data.currency_code).toEqual("usd")
    expect(payload.data.total).toEqual(1800)
    expect(payload.data.metadata).toEqual({ plan: "monthly" })
  })

  it("falls back to identity-only fields for non-order events", async () => {
    const { container, graph } = makeContainer(null)

    const payload = await buildPayload(container, "subscription.paused", {
      id: "sub_9",
      customer_id: "cus_5",
    })

    expect(payload.order_id).toBeUndefined()
    expect(payload.customer_id).toEqual("cus_5")
    expect(payload.email).toEqual(null)
    expect(graph).not.toHaveBeenCalled()
  })

  it("returns the base payload when the order cannot be found", async () => {
    const { container, graph } = makeContainer(null)

    const payload = await buildPayload(container, "order.updated", {
      id: "order_missing",
    })

    expect(payload.order_id).toBeUndefined()
    expect(payload.cart_id).toBeUndefined()
    expect(graph).toHaveBeenCalled()
  })
})
