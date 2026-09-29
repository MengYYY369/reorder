import path from "path"
import { medusaIntegrationTestRunner } from "@medusajs/test-utils"
import type { MedusaContainer } from "@medusajs/framework/types"
import { listDueRenewalCyclesForProcessing } from "../../src/modules/renewal/utils/scheduler-query"
import { RENEWAL_MODULE } from "../../src/modules/renewal"
import type RenewalModuleService from "../../src/modules/renewal/service"
import { SUBSCRIPTION_MODULE } from "../../src/modules/subscription"
import type SubscriptionModuleService from "../../src/modules/subscription/service"
import { DunningCaseStatus } from "../../src/modules/dunning/types"
import { RenewalCycleStatus } from "../../src/modules/renewal/types"
import { SubscriptionStatus } from "../../src/modules/subscription/types"
import {
  createDunningCaseSeed,
  createRenewalCycleSeed,
  createSubscriptionSeed,
} from "../helpers/dunning-fixtures"

jest.setTimeout(120 * 1000)

/**
 * Who owns a due renewal cycle's next move: the scheduler, dunning, the manual
 * flow, or nobody. The exclusions under test all live in
 * `excludeNonChargeableCycles` and are decided by the one disposition
 * predicate (`resolveCycleDisposition`) that the process step also consumes.
 */
medusaIntegrationTestRunner({
  medusaConfigFile: path.resolve(process.cwd(), "integration-tests"),
  env: {
    JWT_SECRET: "supersecret",
    COOKIE_SECRET: "supersecret",
  },
  testSuite: ({ getContainer }) => {
    describe("renewal retry ownership in the scheduler due query", () => {
      let runId: string
      let seedCounter: number

      beforeEach(() => {
        runId = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`
        seedCounter = 0
      })

      function pastDate(minutesAgo = 5) {
        return new Date(Date.now() - minutesAgo * 60_000)
      }

      function nextSeedSuffix() {
        seedCounter += 1
        return `${runId}-${seedCounter}`
      }

      async function seedSubscription(
        container: MedusaContainer,
        input: Parameters<typeof createSubscriptionSeed>[1] = {}
      ) {
        return await createSubscriptionSeed(container, {
          reference: `SUB-RRO-${nextSeedSuffix()}`,
          ...input,
        })
      }

      async function dueCycleIds(container: MedusaContainer) {
        const { cycles } = await listDueRenewalCyclesForProcessing(container, {
          limit: 200,
          offset: 0,
        })

        return new Set(cycles.map((cycle) => cycle.id))
      }

      it("does not return a paused subscription's due cycle", async () => {
        const container = getContainer()
        const subscriptionModule =
          container.resolve<SubscriptionModuleService>(SUBSCRIPTION_MODULE)

        const subscription = await seedSubscription(container, {
          status: SubscriptionStatus.ACTIVE,
        })
        await subscriptionModule.updateSubscriptions({
          id: subscription.id,
          status: SubscriptionStatus.PAUSED,
          paused_at: pastDate(10),
        })

        const cycle = await createRenewalCycleSeed(container, {
          subscription_id: subscription.id,
          status: RenewalCycleStatus.SCHEDULED,
          scheduled_for: pastDate(),
        })

        expect((await dueCycleIds(container)).has(cycle.id)).toBe(false)
      })

      it("does not return a cancelled subscription's due cycle", async () => {
        const container = getContainer()
        const subscriptionModule =
          container.resolve<SubscriptionModuleService>(SUBSCRIPTION_MODULE)

        const subscription = await seedSubscription(container, {
          status: SubscriptionStatus.ACTIVE,
        })
        await subscriptionModule.updateSubscriptions({
          id: subscription.id,
          status: SubscriptionStatus.CANCELLED,
          cancelled_at: pastDate(10),
          cancel_effective_at: pastDate(10),
        })

        const cycle = await createRenewalCycleSeed(container, {
          subscription_id: subscription.id,
          status: RenewalCycleStatus.SCHEDULED,
          scheduled_for: pastDate(),
        })

        expect((await dueCycleIds(container)).has(cycle.id)).toBe(false)
      })

      it("does not return a cycle whose cancellation is already effective, but keeps one whose cancellation is still in the future", async () => {
        const container = getContainer()
        const subscriptionModule =
          container.resolve<SubscriptionModuleService>(SUBSCRIPTION_MODULE)

        const effectiveSubscription = await seedSubscription(container, {
          status: SubscriptionStatus.ACTIVE,
        })
        const futureSubscription = await seedSubscription(container, {
          status: SubscriptionStatus.ACTIVE,
        })

        // Boundary: "at or before scheduled_for" excludes; strictly after keeps.
        const effectiveAt = pastDate()
        const afterCycleDate = new Date(Date.now() + 60_000)

        await subscriptionModule.updateSubscriptions({
          id: effectiveSubscription.id,
          cancel_effective_at: effectiveAt,
        })
        await subscriptionModule.updateSubscriptions({
          id: futureSubscription.id,
          cancel_effective_at: afterCycleDate,
        })

        const excludedCycle = await createRenewalCycleSeed(container, {
          subscription_id: effectiveSubscription.id,
          status: RenewalCycleStatus.SCHEDULED,
          scheduled_for: effectiveAt,
        })
        const keptCycle = await createRenewalCycleSeed(container, {
          subscription_id: futureSubscription.id,
          status: RenewalCycleStatus.SCHEDULED,
          scheduled_for: pastDate(),
        })

        const due = await dueCycleIds(container)

        expect(due.has(excludedCycle.id)).toBe(false)
        expect(due.has(keptCycle.id)).toBe(true)
      })

      it.each([
        "open",
        "retry_scheduled",
        "retrying",
        "awaiting_manual_resolution",
      ] as DunningCaseStatus[])(
        "does not return a cycle owned by a %s dunning case",
        async (caseStatus) => {
          const container = getContainer()

          // past_due is the realistic state under dunning and is still a
          // chargeable subscription status — only the open case excludes here.
          const subscription = await seedSubscription(container, {
            status: SubscriptionStatus.PAST_DUE,
          })
          const cycle = await createRenewalCycleSeed(container, {
            subscription_id: subscription.id,
            status: RenewalCycleStatus.FAILED,
            scheduled_for: pastDate(),
          })
          await createDunningCaseSeed(container, {
            subscription_id: subscription.id,
            renewal_cycle_id: cycle.id,
            status: caseStatus,
          })

          expect((await dueCycleIds(container)).has(cycle.id)).toBe(false)
        }
      )

      it.each([
        "recovered",
        "unrecovered",
      ] as DunningCaseStatus[])(
        "returns a failed cycle whose dunning case is %s",
        async (caseStatus) => {
          const container = getContainer()

          const subscription = await seedSubscription(container, {
            status: SubscriptionStatus.PAST_DUE,
          })
          const cycle = await createRenewalCycleSeed(container, {
            subscription_id: subscription.id,
            status: RenewalCycleStatus.FAILED,
            scheduled_for: pastDate(),
          })
          await createDunningCaseSeed(container, {
            subscription_id: subscription.id,
            renewal_cycle_id: cycle.id,
            status: caseStatus,
            closed_at: pastDate(),
          })

          expect((await dueCycleIds(container)).has(cycle.id)).toBe(true)
        }
      )

      it("does not return an abandoned cycle (R3: dunning exhaustion writes the period off)", async () => {
    const container = getContainer()

    // `abandoned` is terminal (Task 1): once a dunning case exhausts and the
    // cycle is written off, the due query must never re-arm it — same as the
    // structural-cap abandonment pinned in renewal-failure-cap.spec.ts.
    const subscription = await seedSubscription(container, {
      status: SubscriptionStatus.PAST_DUE,
    })
    const cycle = await createRenewalCycleSeed(container, {
      subscription_id: subscription.id,
      status: RenewalCycleStatus.ABANDONED,
      scheduled_for: pastDate(),
    })

    expect((await dueCycleIds(container)).has(cycle.id)).toBe(false)
  })

  it("returns a manual trial's trial-end cycle", async () => {
        const container = getContainer()
        const subscriptionModule =
          container.resolve<SubscriptionModuleService>(SUBSCRIPTION_MODULE)

        const trialEndsAt = pastDate(10)
        const subscription = await seedSubscription(container, {
          status: SubscriptionStatus.ACTIVE,
          is_trial: true,
          payment_context: {
            payment_provider_id: null,
            payment_mode: "manual",
            source_payment_collection_id: null,
            source_payment_session_id: null,
            payment_method_reference: null,
            customer_payment_reference: null,
          },
        })
        await subscriptionModule.updateSubscriptions({
          id: subscription.id,
          trial_ends_at: trialEndsAt,
        })

        // At (not strictly after) trial_ends_at the cycle must already be
        // processable, so the trial-end branch runs on time.
        const cycle = await createRenewalCycleSeed(container, {
          subscription_id: subscription.id,
          status: RenewalCycleStatus.SCHEDULED,
          scheduled_for: trialEndsAt,
        })

        expect((await dueCycleIds(container)).has(cycle.id)).toBe(true)
      })

      it("does not return a manual trial's cycle that is still inside the trial", async () => {
        const container = getContainer()
        const subscriptionModule =
          container.resolve<SubscriptionModuleService>(SUBSCRIPTION_MODULE)

        const subscription = await seedSubscription(container, {
          status: SubscriptionStatus.ACTIVE,
          is_trial: true,
          payment_context: {
            payment_provider_id: null,
            payment_mode: "manual",
            source_payment_collection_id: null,
            source_payment_session_id: null,
            payment_method_reference: null,
            customer_payment_reference: null,
          },
        })
        await subscriptionModule.updateSubscriptions({
          id: subscription.id,
          trial_ends_at: new Date(Date.now() + 60_000),
        })

        const cycle = await createRenewalCycleSeed(container, {
          subscription_id: subscription.id,
          status: RenewalCycleStatus.SCHEDULED,
          scheduled_for: pastDate(),
        })

        expect((await dueCycleIds(container)).has(cycle.id)).toBe(false)
      })

      it("does not return a manual non-trial cycle", async () => {
        const container = getContainer()

        const subscription = await seedSubscription(container, {
          status: SubscriptionStatus.ACTIVE,
          payment_context: {
            payment_provider_id: null,
            payment_mode: "manual",
            source_payment_collection_id: null,
            source_payment_session_id: null,
            payment_method_reference: null,
            customer_payment_reference: null,
          },
        })

        const cycle = await createRenewalCycleSeed(container, {
          subscription_id: subscription.id,
          status: RenewalCycleStatus.SCHEDULED,
          scheduled_for: pastDate(),
        })

        expect((await dueCycleIds(container)).has(cycle.id)).toBe(false)
      })

      it("keeps returning a plain auto-mode cycle so the charge path stays reachable", async () => {
        const container = getContainer()
        const renewalModule =
          container.resolve<RenewalModuleService>(RENEWAL_MODULE)

        const subscription = await seedSubscription(container, {
          status: SubscriptionStatus.ACTIVE,
        })

        const cycle = await createRenewalCycleSeed(container, {
          subscription_id: subscription.id,
          status: RenewalCycleStatus.SCHEDULED,
          scheduled_for: pastDate(),
        })

        const due = await dueCycleIds(container)

        expect(due.has(cycle.id)).toBe(true)

        // The seed really is what the scheduler would work on.
        const stored = await renewalModule.retrieveRenewalCycle(cycle.id)
        expect(stored.status).toEqual(RenewalCycleStatus.SCHEDULED)
      })
    })
  },
})
