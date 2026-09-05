import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import type { RemoteQueryFunction } from "@medusajs/framework/types"

export type LoadSubscriptionOrderStepInput = {
  order_id: string
}

type SubscriptionOrderRecord = {
  id: string
  display_id: string | number | null
  created_at: string | Date
}

export const loadSubscriptionOrderStep = createStep(
  "load-subscription-order",
  async function (
    input: LoadSubscriptionOrderStepInput,
    { container }
  ) {
    const query = container.resolve<RemoteQueryFunction>(
      ContainerRegistrationKeys.QUERY
    )

    const result = (await query.graph({
      entity: "order",
      fields: ["id", "display_id", "created_at"],
      filters: { id: input.order_id },
    })) as unknown as {
      data: SubscriptionOrderRecord[]
    }
    const order = result.data?.[0]

    if (!order) {
      throw new Error(
        `Order '${input.order_id}' was not found for subscription creation`
      )
    }

    return new StepResponse<SubscriptionOrderRecord>(order)
  }
)
