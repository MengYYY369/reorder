import { ACTIVITY_LOG_MODULE } from ".."
import type ActivityLogModuleService from "../service"
import type { ActivityLogChangedField } from "../types"
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

/**
 * What the module service accepts, read straight off the generated DTO so every
 * column this writer sends keeps being checked against `subscription_log`.
 */
type CreateSubscriptionLogInput =
  Parameters<ActivityLogModuleService["createSubscriptionLogs"]>[0][number]

/**
 * The same payload in domain types. `changed_fields` is the one column whose
 * stored JSON does not match what the DML inference produces: `model.json()`
 * types every JSON column as `Record<string, unknown>`, while this column holds
 * an array of `{ field, before, after }` entries. The array form is kept here so
 * callers pass `NormalizedActivityLogEvent` values unchecked.
 */
export type CreateSubscriptionLogData = Omit<
  CreateSubscriptionLogInput,
  "changed_fields"
> & {
  changed_fields?: ActivityLogChangedField[] | null
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

  const data: CreateSubscriptionLogData = logEvent

  try {
    const created = (await activityLogModule.createSubscriptionLogs(
      toCreateSubscriptionLogInput(data)
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

function toCreateSubscriptionLogInput(
  data: CreateSubscriptionLogData
): CreateSubscriptionLogInput {
  const { changed_fields: changedFields, ...columns } = data

  return {
    ...columns,
    // Narrow cast for the one column the DML inference mis-types: the JSON
    // column holds an array, the generated DTO declares an object. Nothing else
    // in the payload is cast, so every other column stays compile-checked.
    changed_fields:
      changedFields === undefined
        ? undefined
        : (changedFields as CreateSubscriptionLogInput["changed_fields"]),
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
