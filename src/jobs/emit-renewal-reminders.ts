import { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import {
  ActivityLogActorType,
  ActivityLogEventType,
} from "../modules/activity-log/types"
import { normalizeActivityLogEvent } from "../modules/activity-log/utils/normalize-log-event"
import { SETTINGS_MODULE } from "../modules/settings"
import type SettingsModuleService from "../modules/settings/service"
import { SUBSCRIPTION_MODULE } from "../modules/subscription"
import type SubscriptionModuleService from "../modules/subscription/service"
import { SubscriptionStatus } from "../modules/subscription/types"
import { isNativeSubscriptionReference } from "../modules/subscription/utils/native-subscription"
import { RenewalCycleStatus } from "../modules/renewal/types"
import {
  classifyRenewalFailure,
  createRenewalCorrelationId,
  getRenewalErrorMessage,
  logRenewalEvent,
} from "../modules/renewal/utils/observability"
import { persistAndEmitSubscriptionLogEvent } from "../workflows/steps/create-subscription-log-event"

const JOB_NAME = "emit-renewal-reminders"
const DEFAULT_BATCH_SIZE = 100
/**
 * Safety net for the discovery loops, mirroring the other renewal jobs: this
 * job's writes go to the activity log, so the scanned rows themselves never
 * leave the window and plain offset pagination is what advances the scan. The
 * cap bounds one run to 20 passes x 100 rows per scan — far beyond any
 * realistic `renewal_reminder_lead_days` backlog — and anything left over
 * defers to the next hourly pass.
 */
const MAX_DISCOVERY_PASSES = 20

/**
 * The reminder is the charge scheduler's lookahead, not its echo, so the
 * subscription-level rules are deliberately different from the charge query:
 *
 * - manual-mode subscriptions ARE included. The charge scheduler skips them
 *   because nothing can charge them off-session; for a manual subscription the
 *   reminder IS the moment the customer must act.
 * - `paused` and `cancelled` subscriptions are excluded — `active` and
 *   `past_due` stay eligible, exactly the complement of the two statuses the
 *   plan names.
 * - native mirror rows are excluded explicitly by the `NATIVE-` reference
 *   prefix (the only allowed test — see `native-subscription.ts`; a
 *   `payment_context.mechanism` predicate would silently drop every
 *   pre-existing row to NULL comparison). Today the mirror writer happens to
 *   set `is_trial: false` and no `trial_ends_at`, which keeps provider-trial
 *   customers out of the trial scan by accident; the reference exclusion makes
 *   that a guarantee, so a future mirror change cannot start mailing
 *   provider-trial customers a reminder this plugin has no business sending.
 */
const REMINDER_ELIGIBLE_SUBSCRIPTION_STATUSES = [
  SubscriptionStatus.ACTIVE,
  SubscriptionStatus.PAST_DUE,
] as const

type ReminderRenewalCycleRecord = {
  id: string
  subscription_id: string
  scheduled_for: string
}

type ReminderSubscriptionRecord = {
  id: string
  reference: string
  status: SubscriptionStatus
  is_trial: boolean
  trial_ends_at: string | Date | null
  customer_id: string
  customer_snapshot: { full_name?: string | null } | null
  product_snapshot: {
    product_title?: string | null
    variant_title?: string | null
  } | null
}

type ReminderSubscriptionDisplay = {
  subscription_reference: string | null
  customer_name: string | null
  product_title: string | null
  variant_title: string | null
}

function getLogger(container: MedusaContainer) {
  return container.resolve("logger")
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

/**
 * The subscription-level half of the reminder rules. Kept in one predicate so
 * the cycle scan and the trial scan cannot drift apart on who is reminded.
 */
function isReminderEligibleSubscription(
  subscription: ReminderSubscriptionRecord
): boolean {
  if (
    !(REMINDER_ELIGIBLE_SUBSCRIPTION_STATUSES as readonly string[]).includes(
      subscription.status
    )
  ) {
    return false
  }

  if (isNativeSubscriptionReference(subscription.reference)) {
    return false
  }

  return true
}

function subscriptionDisplay(
  subscription: ReminderSubscriptionRecord
): ReminderSubscriptionDisplay {
  return {
    subscription_reference: subscription.reference,
    customer_name: subscription.customer_snapshot?.full_name ?? null,
    product_title: subscription.product_snapshot?.product_title ?? null,
    variant_title: subscription.product_snapshot?.variant_title ?? null,
  }
}

async function listScheduledCyclesWithinWindow(
  container: MedusaContainer,
  input: {
    horizon: Date
    limit: number
    offset: number
  }
): Promise<{ cycles: ReminderRenewalCycleRecord[]; count: number }> {
  const query = container.resolve(ContainerRegistrationKeys.QUERY)

  const {
    data,
    metadata: { count = 0 } = {},
  } = await query.graph({
    entity: "renewal_cycle",
    fields: ["id", "subscription_id", "scheduled_for"],
    filters: {
      status: [RenewalCycleStatus.SCHEDULED],
      // Forward scan: every cycle the lead window covers, including one that
      // is already overdue but still `scheduled` — it still needs the
      // customer's action, and the dedupe key keeps it to one reminder ever.
      scheduled_for: {
        $lte: input.horizon,
      },
    },
    pagination: {
      take: input.limit,
      skip: input.offset,
      order: {
        scheduled_for: "ASC",
      },
    },
  })

  return {
    cycles: data as ReminderRenewalCycleRecord[],
    count,
  }
}

async function listTrialSubscriptionsWithinWindow(
  container: MedusaContainer,
  input: {
    horizon: Date
    limit: number
    offset: number
  }
): Promise<{ subscriptions: ReminderSubscriptionRecord[]; count: number }> {
  const query = container.resolve(ContainerRegistrationKeys.QUERY)

  const {
    data,
    metadata: { count = 0 } = {},
  } = await query.graph({
    entity: "subscription",
    fields: [
      "id",
      "reference",
      "status",
      "is_trial",
      "trial_ends_at",
      "customer_id",
      "customer_snapshot",
      "product_snapshot",
    ],
    filters: {
      status: [...REMINDER_ELIGIBLE_SUBSCRIPTION_STATUSES],
      is_trial: true,
      // Forward scan, same window as the cycle scan (SQL `NULL <= x` is false,
      // so rows without a trial anchor never match).
      trial_ends_at: {
        $lte: input.horizon,
      },
    },
    pagination: {
      take: input.limit,
      skip: input.offset,
      order: {
        trial_ends_at: "ASC",
      },
    },
  })

  return {
    subscriptions: data as ReminderSubscriptionRecord[],
    count,
  }
}

async function emitUpcomingRenewalReminder(
  container: MedusaContainer,
  input: {
    cycle: ReminderRenewalCycleRecord
    subscription: ReminderSubscriptionRecord
    correlationId: string
  }
): Promise<void> {
  const scheduledFor = toIso(input.cycle.scheduled_for)

  const logEvent = normalizeActivityLogEvent({
    subscription_id: input.subscription.id,
    customer_id: input.subscription.customer_id,
    event_type: ActivityLogEventType.RENEWAL_UPCOMING,
    actor_type: ActivityLogActorType.SCHEDULER,
    display: subscriptionDisplay(input.subscription),
    reason: `Upcoming renewal scheduled for ${scheduledFor}`,
    metadata: {
      source: "scheduler",
      trigger_type: "scheduler",
      renewal_cycle_id: input.cycle.id,
      scheduled_for: scheduledFor,
    },
    correlation_id: input.correlationId,
    // Exactly-once comes from the unique `dedupe_key` on `subscription_log`:
    // one cycle yields at most one reminder no matter how many times the
    // hourly job replays. Deliberately no second idempotency mechanism.
    dedupe: {
      scope: "renewal",
      target_id: input.cycle.id,
      qualifier: null,
    },
  })

  await persistAndEmitSubscriptionLogEvent(container, logEvent)
}

async function emitTrialEndingReminder(
  container: MedusaContainer,
  input: {
    subscription: ReminderSubscriptionRecord
    correlationId: string
  }
): Promise<void> {
  const trialEndsAt = toIso(input.subscription.trial_ends_at as Date | string)

  const logEvent = normalizeActivityLogEvent({
    subscription_id: input.subscription.id,
    customer_id: input.subscription.customer_id,
    event_type: ActivityLogEventType.SUBSCRIPTION_TRIAL_ENDING,
    actor_type: ActivityLogActorType.SCHEDULER,
    display: subscriptionDisplay(input.subscription),
    reason: `Trial ends at ${trialEndsAt}`,
    new_state: {
      trial_ends_at: trialEndsAt,
    },
    metadata: {
      source: "scheduler",
      trigger_type: "scheduler",
      job_name: JOB_NAME,
    },
    correlation_id: input.correlationId,
    // Same exactly-once story, scoped to the subscription: one trial yields at
    // most one `subscription.trial_ending` ever.
    dedupe: {
      scope: "subscription",
      target_id: input.subscription.id,
      qualifier: null,
    },
  })

  await persistAndEmitSubscriptionLogEvent(container, logEvent)
}

/**
 * Upcoming-renewal lookahead (hardening plan Task 13). The charge scheduler
 * selects `scheduled_for <= now`; this hourly job looks forward instead —
 * `scheduled_for <= now + renewal_reminder_lead_days` for cycles still in
 * `scheduled`, plus trial subscriptions whose `trial_ends_at` falls in the same
 * window — and persists (and emits) `renewal.upcoming` /
 * `subscription.trial_ending` through the shared subscription-log funnel so
 * the host can tell the customer before the charge happens.
 *
 * `renewal_reminder_lead_days = 0` disables the job entirely.
 */
export default async function emitRenewalRemindersJob(
  container: MedusaContainer
) {
  const settingsModule = container.resolve<SettingsModuleService>(SETTINGS_MODULE)
  const { renewal_reminder_lead_days: leadDays } =
    await settingsModule.getSettings()

  if (leadDays <= 0) {
    // `renewal_reminder_lead_days = 0` is the documented off switch: the job
    // returns before scanning or logging anything, so a disabled lookahead is
    // an hourly no-op rather than a stream of "ran and did nothing" lines.
    return
  }

  const logger = getLogger(container)
  const startedAt = Date.now()
  const batchSize = DEFAULT_BATCH_SIZE
  const jobCorrelationId = createRenewalCorrelationId(JOB_NAME)
  const horizon = new Date(Date.now() + leadDays * 24 * 60 * 60 * 1000)

  logRenewalEvent(logger, "info", {
    event: "renewal.reminders.job",
    job_name: JOB_NAME,
    outcome: "started",
    correlation_id: jobCorrelationId,
    batch_size: batchSize,
    message: `Scanning ${leadDays} day(s) ahead for upcoming renewals and trial ends`,
    metadata: {
      lead_days: leadDays,
      horizon: horizon.toISOString(),
    },
  })

  let scannedCycles = 0
  let scannedTrials = 0
  let emitted = 0
  let failed = 0
  let hitPassCap = false

  try {
    const subscriptionModule =
      container.resolve<SubscriptionModuleService>(SUBSCRIPTION_MODULE)

    // Pass 1: renewal cycles still in `scheduled` inside the window. Emission
    // does not mutate the cycle, so each pass advances the offset instead of
    // re-reading a fixed page.
    let cycleOffset = 0
    let cycleCount = 0
    let passes = 0

    while (passes < MAX_DISCOVERY_PASSES) {
      passes += 1

      const { cycles, count } = await listScheduledCyclesWithinWindow(
        container,
        { horizon, limit: batchSize, offset: cycleOffset }
      )
      cycleCount = count

      if (!cycles.length) {
        break
      }

      if (passes === MAX_DISCOVERY_PASSES) {
        hitPassCap = true
      }

      const subscriptionRows =
        await subscriptionModule.listSubscriptions({
          id: Array.from(new Set(cycles.map((cycle) => cycle.subscription_id))),
        } as never)

      const subscriptionById = new Map(
        (subscriptionRows as unknown as ReminderSubscriptionRecord[]).map(
          (subscription) => [subscription.id, subscription]
        )
      )

      for (const cycle of cycles) {
        scannedCycles += 1

        const subscription = subscriptionById.get(cycle.subscription_id)

        // A cycle whose subscription row cannot be loaded has nobody to
        // remind; drop it rather than emit an event with no subject display.
        if (!subscription || !isReminderEligibleSubscription(subscription)) {
          continue
        }

        try {
          await emitUpcomingRenewalReminder(container, {
            cycle,
            subscription,
            correlationId: jobCorrelationId,
          })

          emitted += 1
        } catch (error) {
          failed += 1

          logRenewalEvent(logger, "error", {
            event: "renewal.reminders.job.cycle",
            job_name: JOB_NAME,
            outcome: "failed",
            correlation_id: jobCorrelationId,
            renewal_cycle_id: cycle.id,
            subscription_id: cycle.subscription_id,
            failure_kind: classifyRenewalFailure(error),
            alertable: true,
            message: getRenewalErrorMessage(error),
          })
        }
      }

      cycleOffset += cycles.length

      if (cycleOffset >= cycleCount) {
        break
      }
    }

    // Pass 2: trial subscriptions whose `trial_ends_at` falls in the same
    // window. The eligibility predicate (status, native exclusion) is the one
    // used above; the trial anchor itself was already pushed into the query.
    let trialOffset = 0
    let trialCount = 0
    let trialPasses = 0

    while (trialPasses < MAX_DISCOVERY_PASSES) {
      trialPasses += 1

      const { subscriptions, count } = await listTrialSubscriptionsWithinWindow(
        container,
        { horizon, limit: batchSize, offset: trialOffset }
      )
      trialCount = count

      if (!subscriptions.length) {
        break
      }

      if (trialPasses === MAX_DISCOVERY_PASSES) {
        hitPassCap = true
      }

      for (const subscription of subscriptions) {
        scannedTrials += 1

        // Defensive re-check beside the pushdown: `trial_ends_at` must exist,
        // and the NATIVE- exclusion is decided here and only here.
        if (
          subscription.trial_ends_at === null ||
          !isReminderEligibleSubscription(subscription)
        ) {
          continue
        }

        try {
          await emitTrialEndingReminder(container, {
            subscription,
            correlationId: jobCorrelationId,
          })

          emitted += 1
        } catch (error) {
          failed += 1

          logRenewalEvent(logger, "error", {
            event: "renewal.reminders.job.trial",
            job_name: JOB_NAME,
            outcome: "failed",
            correlation_id: jobCorrelationId,
            subscription_id: subscription.id,
            failure_kind: classifyRenewalFailure(error),
            alertable: true,
            message: getRenewalErrorMessage(error),
          })
        }
      }

      trialOffset += subscriptions.length

      if (trialOffset >= trialCount) {
        break
      }
    }

    if (hitPassCap) {
      logRenewalEvent(logger, "warn", {
        event: "renewal.reminders.job",
        job_name: JOB_NAME,
        outcome: "completed",
        correlation_id: jobCorrelationId,
        alertable: true,
        scanned_count: scannedCycles + scannedTrials,
        success_count: emitted,
        failure_count: failed,
        message:
          "Reminder discovery hit its pass cap; leftover rows are picked up on the next run",
      })
    }

    logRenewalEvent(logger, "info", {
      event: "renewal.reminders.job",
      job_name: JOB_NAME,
      outcome: "completed",
      correlation_id: jobCorrelationId,
      duration_ms: Date.now() - startedAt,
      batch_size: batchSize,
      scanned_count: scannedCycles + scannedTrials,
      success_count: emitted,
      failure_count: failed,
      message: "Upcoming-renewal reminder scan completed",
      metadata: {
        cycles_scanned: scannedCycles,
        trials_scanned: scannedTrials,
        cycles_matched: cycleCount,
        trials_matched: trialCount,
        pass_cap_reached: hitPassCap,
      },
    })
  } catch (error) {
    logRenewalEvent(logger, "error", {
      event: "renewal.reminders.job",
      job_name: JOB_NAME,
      outcome: "failed",
      correlation_id: jobCorrelationId,
      duration_ms: Date.now() - startedAt,
      batch_size: batchSize,
      scanned_count: scannedCycles + scannedTrials,
      success_count: emitted,
      failure_count: failed + 1,
      failure_kind: classifyRenewalFailure(error),
      alertable: true,
      message: getRenewalErrorMessage(error),
    })
  }
}

export const config = {
  name: JOB_NAME,
  // Hourly. The lead window is measured in days, so a one-hour granularity
  // keeps the reminder timely without any tighter cadence.
  schedule: "0 * * * *",
}
