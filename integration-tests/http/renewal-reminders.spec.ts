import path from "path"
import { medusaIntegrationTestRunner } from "@medusajs/test-utils"
import type { MedusaContainer } from "@medusajs/framework/types"
import { ACTIVITY_LOG_MODULE } from "../../src/modules/activity-log"
import type ActivityLogModuleService from "../../src/modules/activity-log/service"
import { ActivityLogEventType } from "../../src/modules/activity-log/types"
import { SETTINGS_MODULE } from "../../src/modules/settings"
import type SettingsModuleService from "../../src/modules/settings/service"
import { SUBSCRIPTION_MODULE } from "../../src/modules/subscription"
import type SubscriptionModuleService from "../../src/modules/subscription/service"
import {
  SubscriptionPaymentContext,
  SubscriptionStatus,
} from "../../src/modules/subscription/types"
import { RenewalCycleStatus } from "../../src/modules/renewal/types"
import emitRenewalRemindersJob from "../../src/jobs/emit-renewal-reminders"
import { config as forwardSaasEventsConfig } from "../../src/subscribers/forward-saas-events"
import { createRenewalCycleSeed } from "../helpers/renewal-fixtures"
import { createSubscriptionSeed } from "../helpers/subscription-fixtures"

jest.setTimeout(180 * 1000)

type EmittedBusEvent = { name?: string; data?: Record<string, unknown> }

function busEventsWithName(
  emitSpy: jest.SpyInstance,
  eventName: string
): EmittedBusEvent[] {
  return emitSpy.mock.calls
    .flatMap((call) => {
      const first = call[0] as EmittedBusEvent | EmittedBusEvent[] | undefined

      return Array.isArray(first) ? first : first ? [first] : []
    })
    .filter((event) => event?.name === eventName)
}

function hoursFromNow(hours: number) {
  return new Date(Date.now() + hours * 60 * 60 * 1000)
}

function manualPaymentContext(reference: string): SubscriptionPaymentContext {
  return {
    payment_provider_id: "pp_system_default",
    payment_mode: "manual",
    source_payment_collection_id: `paycol_${reference}`,
    source_payment_session_id: `payses_${reference}`,
    payment_method_reference: null,
    customer_payment_reference: null,
  }
}

medusaIntegrationTestRunner({
  medusaConfigFile: path.resolve(process.cwd(), "integration-tests"),
  env: {
    JWT_SECRET: "supersecret",
    COOKIE_SECRET: "supersecret",
  },
  testSuite: ({ getContainer }) => {
    describe("upcoming-renewal reminder lookahead (emit-renewal-reminders)", () => {
      let runId: string
      let seedCounter: number

      beforeEach(() => {
        jest.restoreAllMocks()
        runId = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`
        seedCounter = 0
      })

      function nextSeedSuffix() {
        seedCounter += 1
        return `${runId}-${seedCounter}`
      }

      function resolveEventBusSpy(container: MedusaContainer) {
        const eventBus = container.resolve("event_bus") as unknown as {
          emit: (data: unknown) => Promise<void>
        }

        return jest.spyOn(eventBus, "emit")
      }

      async function seedSubscriptionWithCycle(
        container: MedusaContainer,
        input: {
          status?: SubscriptionStatus
          isTrial?: boolean
          trialEndsAt?: Date
          manualMode?: boolean
          nativeReference?: boolean
          cycleInHours?: number
        } = {}
      ) {
        const suffix = nextSeedSuffix()
        const subscription = await createSubscriptionSeed(container, {
          reference: input.nativeReference
            ? `NATIVE-REM-${suffix}`
            : `SUB-REM-${suffix}`,
          status: input.status ?? SubscriptionStatus.ACTIVE,
          is_trial: input.isTrial ?? false,
          payment_context: input.manualMode
            ? manualPaymentContext(suffix)
            : undefined,
        })

        if (input.trialEndsAt) {
          // The seed fixture keeps trial_ends_at null; the anchor is written
          // the way the trial-conversion specs write theirs.
          const subscriptionModule =
            container.resolve<SubscriptionModuleService>(SUBSCRIPTION_MODULE)

          await subscriptionModule.updateSubscriptions({
            id: subscription.id,
            is_trial: true,
            trial_ends_at: input.trialEndsAt,
          } as never)
        }

        const cycle = await createRenewalCycleSeed(container, {
          subscription_id: subscription.id,
          status: RenewalCycleStatus.SCHEDULED,
          scheduled_for: hoursFromNow(input.cycleInHours ?? 24),
        })

        return { subscription, cycle }
      }

      async function listLogs(
        container: MedusaContainer,
        subscriptionId: string,
        eventType: ActivityLogEventType
      ) {
        const activityLogModule =
          container.resolve<ActivityLogModuleService>(ACTIVITY_LOG_MODULE)

        return (await activityLogModule.listSubscriptionLogs({
          subscription_id: subscriptionId,
          event_type: eventType,
        } as never)) as unknown as Array<{
          id: string
          dedupe_key: string
          metadata: Record<string, unknown> | null
        }>
      }

      it("emits renewal.upcoming exactly once per cycle across two runs", async () => {
        const container = getContainer()
        const emitSpy = resolveEventBusSpy(container)

        const { subscription, cycle } = await seedSubscriptionWithCycle(
          container,
          { cycleInHours: 24 }
        )

        await emitRenewalRemindersJob(container)
        await emitRenewalRemindersJob(container)

        const events = busEventsWithName(emitSpy, "renewal.upcoming")

        expect(events).toHaveLength(1)
        expect(events[0].data).toMatchObject({
          subscription_id: subscription.id,
          event_type: "renewal.upcoming",
        })

        // Exactly-once lives in the unique `dedupe_key` on subscription_log —
        // one cycle, one persisted row, one bus emission (a deduped persist
        // never re-emits).
        const logs = await listLogs(
          container,
          subscription.id,
          ActivityLogEventType.RENEWAL_UPCOMING
        )

        expect(logs).toHaveLength(1)
        expect(logs[0].dedupe_key).toEqual(`renewal.upcoming:renewal:${cycle.id}`)
        expect(logs[0].metadata).toMatchObject({
          renewal_cycle_id: cycle.id,
        })
      })

      it("emits subscription.trial_ending exactly once per trial across two runs", async () => {
        const container = getContainer()
        const emitSpy = resolveEventBusSpy(container)

        const { subscription } = await seedSubscriptionWithCycle(container, {
          isTrial: true,
          trialEndsAt: hoursFromNow(48),
        })

        await emitRenewalRemindersJob(container)
        await emitRenewalRemindersJob(container)

        const events = busEventsWithName(emitSpy, "subscription.trial_ending")

        expect(events).toHaveLength(1)
        expect(events[0].data).toMatchObject({
          subscription_id: subscription.id,
          event_type: "subscription.trial_ending",
        })

        const logs = await listLogs(
          container,
          subscription.id,
          ActivityLogEventType.SUBSCRIPTION_TRIAL_ENDING
        )

        expect(logs).toHaveLength(1)
        expect(logs[0].dedupe_key).toEqual(
          `subscription.trial_ending:subscription:${subscription.id}`
        )
      })

      it("includes manual subscriptions — the reminder is the moment the customer must act", async () => {
        const container = getContainer()
        const emitSpy = resolveEventBusSpy(container)

        const { subscription } = await seedSubscriptionWithCycle(container, {
          manualMode: true,
          cycleInHours: 24,
        })

        await emitRenewalRemindersJob(container)

        const events = busEventsWithName(emitSpy, "renewal.upcoming")

        expect(events).toHaveLength(1)
        expect(events[0].data).toMatchObject({
          subscription_id: subscription.id,
        })

        const logs = await listLogs(
          container,
          subscription.id,
          ActivityLogEventType.RENEWAL_UPCOMING
        )

        expect(logs).toHaveLength(1)
      })

      it("excludes paused and cancelled subscriptions", async () => {
        const container = getContainer()
        const emitSpy = resolveEventBusSpy(container)

        const paused = await seedSubscriptionWithCycle(container, {
          status: SubscriptionStatus.PAUSED,
          cycleInHours: 24,
        })
        const cancelled = await seedSubscriptionWithCycle(container, {
          status: SubscriptionStatus.CANCELLED,
          cycleInHours: 24,
        })
        const control = await seedSubscriptionWithCycle(container, {
          cycleInHours: 24,
        })

        await emitRenewalRemindersJob(container)

        const events = busEventsWithName(emitSpy, "renewal.upcoming")

        expect(events).toHaveLength(1)
        expect(events[0].data).toMatchObject({
          subscription_id: control.subscription.id,
        })
        expect(
          await listLogs(
            container,
            paused.subscription.id,
            ActivityLogEventType.RENEWAL_UPCOMING
          )
        ).toHaveLength(0)
        expect(
          await listLogs(
            container,
            cancelled.subscription.id,
            ActivityLogEventType.RENEWAL_UPCOMING
          )
        ).toHaveLength(0)
      })

      it("excludes native mirror rows, including provider-trial-shaped rows", async () => {
        const container = getContainer()
        const emitSpy = resolveEventBusSpy(container)

        // The mirror writer happens to set is_trial:false and no
        // trial_ends_at — the first row reproduces today's accidental shape.
        // The second row is the deliberate pin: even if a future mirror change
        // starts writing trial fields, the NATIVE- reference exclusion (not the
        // mirror writer's accident) is what keeps provider-trial customers from
        // being reminded.
        const nativeCycleRow = await seedSubscriptionWithCycle(container, {
          nativeReference: true,
          cycleInHours: 24,
        })
        const nativeTrialRow = await seedSubscriptionWithCycle(container, {
          nativeReference: true,
          isTrial: true,
          trialEndsAt: hoursFromNow(48),
        })
        const control = await seedSubscriptionWithCycle(container, {
          isTrial: true,
          trialEndsAt: hoursFromNow(48),
        })

        await emitRenewalRemindersJob(container)

        // The control is a plain reorder-rail trial: its in-window cycle earns
        // renewal.upcoming, its trial anchor earns subscription.trial_ending.
        // The native rows earn neither, whatever fields the mirror writer sets.
        const cycleEvents = busEventsWithName(emitSpy, "renewal.upcoming")

        expect(cycleEvents).toHaveLength(1)
        expect(cycleEvents[0].data).toMatchObject({
          subscription_id: control.subscription.id,
        })
        expect(
          await listLogs(
            container,
            nativeCycleRow.subscription.id,
            ActivityLogEventType.RENEWAL_UPCOMING
          )
        ).toHaveLength(0)

        const trialEvents = busEventsWithName(
          emitSpy,
          "subscription.trial_ending"
        )

        expect(trialEvents).toHaveLength(1)
        expect(trialEvents[0].data).toMatchObject({
          subscription_id: control.subscription.id,
        })
        expect(
          await listLogs(
            container,
            nativeTrialRow.subscription.id,
            ActivityLogEventType.SUBSCRIPTION_TRIAL_ENDING
          )
        ).toHaveLength(0)
      })

      it("skips cycles outside the lead window", async () => {
        const container = getContainer()
        const emitSpy = resolveEventBusSpy(container)

        await seedSubscriptionWithCycle(container, { cycleInHours: 10 * 24 })

        await emitRenewalRemindersJob(container)

        expect(busEventsWithName(emitSpy, "renewal.upcoming")).toHaveLength(0)
      })

      it("renewal_reminder_lead_days = 0 disables the job", async () => {
        const container = getContainer()
        const settingsModule = container.resolve<SettingsModuleService>(
          SETTINGS_MODULE
        )
        const emitSpy = resolveEventBusSpy(container)

        await settingsModule.updateSettings({
          renewal_reminder_lead_days: 0,
        })

        try {
          const { subscription } = await seedSubscriptionWithCycle(container, {
            cycleInHours: 24,
          })

          await emitRenewalRemindersJob(container)

          expect(busEventsWithName(emitSpy, "renewal.upcoming")).toHaveLength(0)
          expect(
            await listLogs(
              container,
              subscription.id,
              ActivityLogEventType.RENEWAL_UPCOMING
            )
          ).toHaveLength(0)
        } finally {
          // The settings row is global to the suite database; restore the
          // default so the other cases scan with lead days 3.
          await settingsModule.resetSettings()
        }
      })

      it("registers both reminder events for saas-bridge forwarding", async () => {
        // The bus emission only reaches the medusa-webhooks fan-out when the
        // subscriber is statically registered on the event name; an event type
        // missing from that list is the same "written but never delivered" gap
        // `renewal.failed` had for years.
        expect(forwardSaasEventsConfig.event).toContain("renewal.upcoming")
        expect(forwardSaasEventsConfig.event).toContain(
          "subscription.trial_ending"
        )
      })
    })
  },
})
