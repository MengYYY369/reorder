import { ACTIVITY_LOG_MODULE } from ".."
import type ActivityLogModuleService from "../service"
import type { NormalizedActivityLogEvent } from "./normalize-log-event"

export type SubscriptionLogRecord = NormalizedActivityLogEvent & {
  id: string
  created_at: Date
  updated_at: Date
  deleted_at: Date | null
}

export type PersistSubscriptionLogResult = {
  record: SubscriptionLogRecord
  action: "created" | "existing"
}

type LogEventContainer = {
  resolve(key: string): unknown
}

/**
 * Single write path for `subscription_log`. Replays are collapsed by the unique
 * `dedupe_key`, so callers may fire the same event from a retried workflow, a
 * subscriber catch, or a scheduled job without duplicating audit rows.
 */
export async function persistSubscriptionLogEvent(
  container: LogEventContainer,
  logEvent: NormalizedActivityLogEvent
): Promise<PersistSubscriptionLogResult> {
  const activityLogModule =
    container.resolve(ACTIVITY_LOG_MODULE) as ActivityLogModuleService

  try {
    const created = (await activityLogModule.createSubscriptionLogs(
      logEvent as any
    )) as SubscriptionLogRecord

    return {
      record: created,
      action: "created",
    }
  } catch (error) {
    if (!isDuplicateDedupeKeyError(error)) {
      throw error
    }

    return {
      record: logEvent as SubscriptionLogRecord,
      action: "existing",
    }
  }
}

export function isDuplicateDedupeKeyError(error: unknown) {
  if (!error || typeof error !== "object") {
    return false
  }

  const code = "code" in error ? error.code : undefined
  const message = "message" in error ? error.message : undefined

  if (code === "23505") {
    return true
  }

  if (typeof message === "string" && message.includes("dedupe_key")) {
    return true
  }

  return false
}
