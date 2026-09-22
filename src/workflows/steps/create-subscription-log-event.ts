import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import {
  ContainerRegistrationKeys,
  Modules,
} from "@medusajs/framework/utils"
import type { IEventBusModuleService } from "@medusajs/framework/types"
import {
  ACTIVITY_LOG_MODULE,
} from "../../modules/activity-log"
import ActivityLogModuleService from "../../modules/activity-log/service"
import { NormalizedActivityLogEvent } from "../../modules/activity-log/utils/normalize-log-event"
import {
  persistSubscriptionLogEvent,
  type SubscriptionLogRecord,
} from "../../modules/activity-log/utils/persist-log-event"

/**
 * Reorder lifecycle events are emitted from the same point that persists the
 * activity log (the single authoritative funnel for subscription state
 * changes). Payload = the normalized log event; receivers get
 * subscription_id, customer_id, event_type and state snapshots. Emission
 * failures never block the subscription flow (webhooks are best-effort;
 * reconciliation is provided by the saas-bridge endpoints).
 */
export async function emitSubscriptionBusEvent(
  container: { resolve<T>(key: string): T },
  logEvent: NormalizedActivityLogEvent
): Promise<void> {
  try {
    const eventBus = container.resolve<IEventBusModuleService>(
      Modules.EVENT_BUS
    )

    await eventBus.emit({
      name: logEvent.event_type,
      data: {
        subscription_id: logEvent.subscription_id,
        customer_id: logEvent.customer_id,
        event_type: logEvent.event_type,
        previous_state: logEvent.previous_state ?? null,
        new_state: logEvent.new_state ?? null,
        metadata: logEvent.metadata ?? null,
      },
    })
  } catch {
    // Swallow: the authoritative activity-log record has already been
    // persisted by the time this runs.
  }
}

export type CreateSubscriptionLogEventStepInput = {
  log_event: NormalizedActivityLogEvent
}

type CreateSubscriptionLogEventCompensation =
  | {
      action: "created"
      subscription_log_id: string
    }
  | {
      action: "existing"
    }

export async function createSubscriptionLogEventStepHandler(
  input: CreateSubscriptionLogEventStepInput,
  { container }: { container: { resolve<T>(key: string): T } }
) {
  const result = await persistSubscriptionLogEvent(container, input.log_event)

  if (result.action === "created") {
    await emitSubscriptionBusEvent(container, input.log_event)
  }

  return new StepResponse<
    SubscriptionLogRecord,
    CreateSubscriptionLogEventCompensation
  >(
    result.record,
    result.action === "created"
      ? {
          action: "created",
          subscription_log_id: result.record.id,
        }
      : {
          action: "existing",
        }
  )
}

export async function compensateCreateSubscriptionLogEventStep(
  compensation: CreateSubscriptionLogEventCompensation,
  { container }: { container: { resolve<T>(key: string): T } }
) {
  if (!compensation || compensation.action !== "created") {
    return
  }

  const activityLogModule =
    container.resolve(ACTIVITY_LOG_MODULE) as ActivityLogModuleService

  await activityLogModule.deleteSubscriptionLogs(compensation.subscription_log_id)
}

export const createSubscriptionLogEventStep = createStep(
  "create-subscription-log-event",
  createSubscriptionLogEventStepHandler,
  compensateCreateSubscriptionLogEventStep
)
