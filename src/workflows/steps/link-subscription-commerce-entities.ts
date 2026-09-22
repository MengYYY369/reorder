import type { LinkDefinition, RemoteQueryFunction } from "@medusajs/framework/types"
import {
  ContainerRegistrationKeys,
  Modules,
} from "@medusajs/framework/utils"
import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { SUBSCRIPTION_MODULE } from "../../modules/subscription"

export type LinkSubscriptionCommerceEntitiesStepInput = {
  subscription_id: string
  customer_id: string
  cart_id: string
  order_id: string
}

/**
 * Links a subscription to the commerce entities of one purchase.
 *
 * Every pair is one-to-one, so a purchase that folded into an existing
 * subscription (extend-in-place) must not re-link the customer or the cart:
 * the row deliberately keeps its original source cart, because the manual
 * renewal flow builds its order from that cart. Creating the link again is also
 * a hard error from the link module, so only missing links are written — which
 * additionally makes a replayed order harmless.
 */
export const linkSubscriptionCommerceEntitiesStep = createStep(
  "link-subscription-commerce-entities",
  async function (
    input: LinkSubscriptionCommerceEntitiesStepInput,
    { container }
  ) {
    const link = container.resolve(ContainerRegistrationKeys.LINK)
    const query = container.resolve<RemoteQueryFunction>(
      ContainerRegistrationKeys.QUERY
    )

    const candidates: Array<{
      entity: string
      filters: Record<string, unknown>
      definition: LinkDefinition
    }> = [
      {
        entity: "subscription_customer",
        filters: { subscription_id: [input.subscription_id] },
        definition: {
          [SUBSCRIPTION_MODULE]: { subscription_id: input.subscription_id },
          [Modules.CUSTOMER]: { customer_id: input.customer_id },
        },
      },
      {
        // The row deliberately keeps its original source cart: the manual
        // renewal flow builds renewal orders from that cart, and the link is
        // one-to-one on the subscription side.
        entity: "subscription_cart",
        filters: { subscription_id: [input.subscription_id] },
        definition: {
          [SUBSCRIPTION_MODULE]: { subscription_id: input.subscription_id },
          [Modules.CART]: { cart_id: input.cart_id },
        },
      },
      {
        // Every purchase that folded into this row has to stay attributable,
        // otherwise replaying the second order finds no link and re-stacks the
        // row instead of short-circuiting.
        entity: "subscription_order",
        filters: {
          subscription_id: [input.subscription_id],
          order_id: [input.order_id],
        },
        definition: {
          [SUBSCRIPTION_MODULE]: { subscription_id: input.subscription_id },
          [Modules.ORDER]: { order_id: input.order_id },
        },
      },
    ]

    const missing: LinkDefinition[] = []

    for (const candidate of candidates) {
      const exists = await hasSubscriptionLink(query, candidate)

      if (!exists) {
        missing.push(candidate.definition)
      }
    }

    if (!missing.length) {
      return new StepResponse<LinkDefinition[], LinkDefinition[]>([], [])
    }

    await link.create(missing)

    return new StepResponse<LinkDefinition[], LinkDefinition[]>(missing, missing)
  },
  async function (links: LinkDefinition[], { container }) {
    if (!links?.length) {
      return
    }

    const link = container.resolve(ContainerRegistrationKeys.LINK)

    await link.dismiss(links)
  }
)

async function hasSubscriptionLink(
  query: RemoteQueryFunction,
  candidate: { entity: string; filters: Record<string, unknown> }
): Promise<boolean> {
  const { data } = await query.graph({
    entity: candidate.entity,
    fields: ["id"],
    filters: candidate.filters,
    pagination: { take: 1, skip: 0 },
  })

  return (data as unknown[]).length > 0
}
