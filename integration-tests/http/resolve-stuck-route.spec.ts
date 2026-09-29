import path from "path"
import jwt from "jsonwebtoken"
import { medusaIntegrationTestRunner } from "@medusajs/test-utils"
import type { MedusaContainer } from "@medusajs/framework/types"
import { RENEWAL_MODULE } from "../../src/modules/renewal"
import type RenewalModuleService from "../../src/modules/renewal/service"
import {
  RenewalAttemptStatus,
  RenewalCycleStatus,
} from "../../src/modules/renewal/types"
import { SUBSCRIPTION_MODULE } from "../../src/modules/subscription"
import type SubscriptionModuleService from "../../src/modules/subscription/service"
import { SubscriptionStatus } from "../../src/modules/subscription/types"
import { ACTIVITY_LOG_MODULE } from "../../src/modules/activity-log"
import type ActivityLogModuleService from "../../src/modules/activity-log/service"
import {
  ActivityLogActorType,
  ActivityLogEventType,
} from "../../src/modules/activity-log/types"
import {
  createAdminAuthHeaders,
  createRenewalAttemptSeed,
  createRenewalCycleSeed,
  createSubscriptionSeed,
} from "../helpers/renewal-fixtures"

jest.setTimeout(180 * 1000)

/**
 * `POST /admin/renewals/:id/resolve-stuck` (hardening plan Task 9, Step 3).
 *
 * Route-level coverage of the operator entry point: each of the three outcome
 * overrides on a stuck `processing` cycle, un-parking a cycle that sits in
 * `awaiting_manual_resolution`, the actor id + reason recorded on the
 * persisted `renewal.succeeded` activity-log event, the zod request
 * validation (400), and the repo's admin route error conventions (401
 * unauthenticated, 404 unknown cycle id). Fixtures are self-contained and
 * unique per run.
 */
medusaIntegrationTestRunner({
  medusaConfigFile: path.resolve(process.cwd(), "integration-tests"),
  env: {
    JWT_SECRET: "supersecret",
    COOKIE_SECRET: "supersecret",
  },
  testSuite: ({ api, getContainer }) => {
    describe("admin resolve-stuck route", () => {
      let runId: string
      let seedCounter: number

      beforeEach(() => {
        runId = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`
        seedCounter = 0
      })

      function nextSeedSuffix() {
        seedCounter += 1
        return `${runId}-${seedCounter}`
      }

      type AdminAuthHeaders = { authorization: string }

      type ResolveStuckBody = {
        outcome?: string
        reason?: string
      }

      type CycleRow = {
        id: string
        status: RenewalCycleStatus
        generated_order_id: string | null
        last_error: string | null
        processed_at: Date | null
      }

      type AttemptRow = {
        id: string
        status: RenewalAttemptStatus
        error_code: string | null
        error_message: string | null
        order_id: string | null
      }

      type SubscriptionRow = {
        id: string
        status: SubscriptionStatus
        cancelled_at: Date | null
        next_renewal_at: Date | null
        last_renewal_at: Date | null
      }

      type SubscriptionLogFilterInput = {
        subscription_id: string
        event_type: ActivityLogEventType
      }

      type SubscriptionLogRow = {
        subscription_id: string | null
        event_type: ActivityLogEventType
        actor_type: ActivityLogActorType
        actor_id: string | null
        reason: string | null
        dedupe_key: string
        metadata: Record<string, unknown> | null
      }

      function resolveStuck(
        cycleId: string,
        body: ResolveStuckBody,
        headers?: AdminAuthHeaders
      ) {
        return api.post(
          `/admin/renewals/${cycleId}/resolve-stuck`,
          body,
          headers ? { headers } : undefined
        )
      }

      /**
       * Seeds what the route consumes: a cycle in one of the two stuck
       * statuses (the workflow's accepted set), optionally carrying the
       * processing attempt a crashed run would have left behind.
       */
      async function seedStuckCycle(
        container: MedusaContainer,
        options: {
          status?: RenewalCycleStatus
          withAttempt?: boolean
        } = {}
      ) {
        const subscription = await createSubscriptionSeed(container, {
          reference: `SUB-RSR-${nextSeedSuffix()}`,
        })

        const cycle = await createRenewalCycleSeed(container, {
          subscription_id: subscription.id,
          status: options.status ?? RenewalCycleStatus.PROCESSING,
          scheduled_for: new Date(Date.now() - 5 * 60_000),
          attempt_count: options.withAttempt === false ? 0 : 1,
        })

        if (options.withAttempt !== false) {
          await createRenewalAttemptSeed(container, {
            renewal_cycle_id: cycle.id,
            attempt_no: 1,
            status: RenewalAttemptStatus.PROCESSING,
          })
        }

        return { subscription, cycle }
      }

      async function getStoredCycle(
        container: MedusaContainer,
        cycleId: string
      ): Promise<CycleRow> {
        const renewalModule =
          container.resolve<RenewalModuleService>(RENEWAL_MODULE)

        return (await renewalModule.retrieveRenewalCycle(
          cycleId
        )) as unknown as CycleRow
      }

      async function getStoredAttempts(
        container: MedusaContainer,
        cycleId: string
      ): Promise<AttemptRow[]> {
        const renewalModule =
          container.resolve<RenewalModuleService>(RENEWAL_MODULE)

        return (await renewalModule.listRenewalAttempts({
          renewal_cycle_id: cycleId,
        })) as unknown as AttemptRow[]
      }

      async function getStoredSubscription(
        container: MedusaContainer,
        subscriptionId: string
      ): Promise<SubscriptionRow> {
        const subscriptionModule =
          container.resolve<SubscriptionModuleService>(SUBSCRIPTION_MODULE)

        return (await subscriptionModule.retrieveSubscription(
          subscriptionId
        )) as unknown as SubscriptionRow
      }

      /**
       * Reads the persisted `subscription_log` rows through the activity-log
       * module. The generated service types the filter loosely, so the filter
       * and the rows are narrowed to the shapes this suite asserts on.
       */
      async function listSubscriptionLogRows(
        container: MedusaContainer,
        filters: SubscriptionLogFilterInput
      ): Promise<SubscriptionLogRow[]> {
        const activityLogModule =
          container.resolve<ActivityLogModuleService>(ACTIVITY_LOG_MODULE)

        const records = await activityLogModule.listSubscriptionLogs(
          filters as unknown as Parameters<
            ActivityLogModuleService["listSubscriptionLogs"]
          >[0]
        )

        return records as unknown as SubscriptionLogRow[]
      }

      type AdminTokenPayload = { actor_id?: string }

      /**
       * The route forwards `req.auth_context.actor_id` as the workflow's
       * `triggered_by`, so the expected actor id is the one inside the JWT
       * the auth fixture minted.
       */
      function extractAdminActorId(headers: AdminAuthHeaders): string {
        const token = headers.authorization.replace(/^Bearer\s+/, "")
        const decoded = jwt.decode(token)

        if (
          typeof decoded !== "object" ||
          decoded === null ||
          !("actor_id" in decoded)
        ) {
          throw new Error("Fixture broken: admin token carries no actor_id")
        }

        return (decoded as AdminTokenPayload).actor_id ?? ""
      }

      it("resolves a stuck processing cycle to succeeded through the shared finalization", async () => {
        const container = getContainer()
        const headers = await createAdminAuthHeaders(container)

        const { subscription, cycle } = await seedStuckCycle(container)

        const response = await resolveStuck(
          cycle.id,
          {
            outcome: "succeeded",
            reason: "operator confirmed the charge landed in the provider",
          },
          headers
        )

        expect(response.status).toEqual(200)
        expect(response.data.renewal).toMatchObject({
          id: cycle.id,
          status: RenewalCycleStatus.SUCCEEDED,
        })

        const stored = await getStoredCycle(container, cycle.id)
        expect(stored.status).toEqual(RenewalCycleStatus.SUCCEEDED)
        expect(stored.last_error).toBeNull()
        expect(stored.processed_at).not.toBeNull()

        const attempts = await getStoredAttempts(container, cycle.id)
        expect(attempts).toHaveLength(1)
        expect(attempts[0].status).toEqual(RenewalAttemptStatus.SUCCEEDED)

        // The shared finalization recovered the subscription and advanced
        // the cadence anchored on the cycle's scheduled_for.
        const after = await getStoredSubscription(container, subscription.id)
        expect(after.status).toEqual(SubscriptionStatus.ACTIVE)
        expect(after.last_renewal_at).not.toBeNull()

        const renewalModule =
          container.resolve<RenewalModuleService>(RENEWAL_MODULE)
        const cyclesAfter = (await renewalModule.listRenewalCycles({
          subscription_id: subscription.id,
        })) as unknown as Array<{ status: RenewalCycleStatus }>
        expect(
          cyclesAfter.some(
            (entry) => entry.status === RenewalCycleStatus.SCHEDULED
          )
        ).toBe(true)
      })

      it("resolves a stuck processing cycle to failed with the operator's reason as last_error", async () => {
        const container = getContainer()
        const headers = await createAdminAuthHeaders(container)

        const { cycle } = await seedStuckCycle(container)

        const response = await resolveStuck(
          cycle.id,
          {
            outcome: "failed",
            reason: "provider shows no charge for this attempt",
          },
          headers
        )

        expect(response.status).toEqual(200)
        expect(response.data.renewal).toMatchObject({
          id: cycle.id,
          status: RenewalCycleStatus.FAILED,
        })

        const stored = await getStoredCycle(container, cycle.id)
        expect(stored.status).toEqual(RenewalCycleStatus.FAILED)
        expect(stored.last_error).toContain(
          "provider shows no charge for this attempt"
        )
        expect(stored.processed_at).toBeNull()

        const attempts = await getStoredAttempts(container, cycle.id)
        expect(attempts).toHaveLength(1)
        expect(attempts[0].status).toEqual(RenewalAttemptStatus.FAILED)
        expect(attempts[0].error_code).toEqual("renewal_reconciled")
        expect(attempts[0].error_message).toContain(
          "provider shows no charge for this attempt"
        )
      })

      it("resolves a stuck processing cycle to abandoned without touching the subscription", async () => {
        const container = getContainer()
        const headers = await createAdminAuthHeaders(container)

        const { subscription, cycle } = await seedStuckCycle(container)
        const before = await getStoredSubscription(
          container,
          subscription.id
        )

        const response = await resolveStuck(
          cycle.id,
          {
            outcome: "abandoned",
            reason: "merchant wrote the period off",
          },
          headers
        )

        expect(response.status).toEqual(200)
        expect(response.data.renewal).toMatchObject({
          id: cycle.id,
          status: RenewalCycleStatus.ABANDONED,
        })

        const stored = await getStoredCycle(container, cycle.id)
        expect(stored.status).toEqual(RenewalCycleStatus.ABANDONED)
        expect(stored.last_error).toContain("merchant wrote the period off")

        // R3: the abandonment write never cancels the subscription.
        const after = await getStoredSubscription(container, subscription.id)
        expect(after.status).toEqual(before.status)
        expect(after.cancelled_at).toEqual(before.cancelled_at)

        const attempts = await getStoredAttempts(container, cycle.id)
        expect(attempts[0].status).toEqual(RenewalAttemptStatus.FAILED)
      })

      it("un-parks a cycle parked in awaiting_manual_resolution through the route", async () => {
        const container = getContainer()
        const headers = await createAdminAuthHeaders(container)

        const { cycle } = await seedStuckCycle(container, {
          status: RenewalCycleStatus.AWAITING_MANUAL_RESOLUTION,
          withAttempt: false,
        })

        const response = await resolveStuck(
          cycle.id,
          {
            outcome: "failed",
            reason: "merchant confirmed nothing was charged",
          },
          headers
        )

        expect(response.status).toEqual(200)
        expect(response.data.renewal).toMatchObject({
          id: cycle.id,
          status: RenewalCycleStatus.FAILED,
        })

        const stored = await getStoredCycle(container, cycle.id)
        expect(stored.status).not.toEqual(
          RenewalCycleStatus.AWAITING_MANUAL_RESOLUTION
        )
        expect(stored.status).toEqual(RenewalCycleStatus.FAILED)
        expect(stored.last_error).toContain(
          "merchant confirmed nothing was charged"
        )
      })

      it("records the operator's actor id and reason on the renewal.succeeded activity log event", async () => {
        const container = getContainer()
        const headers = await createAdminAuthHeaders(container)
        const actorId = extractAdminActorId(headers)

        const { subscription, cycle } = await seedStuckCycle(container)

        const response = await resolveStuck(
          cycle.id,
          {
            outcome: "succeeded",
            reason:
              "operator verified the captured payment in the provider dashboard",
          },
          headers
        )
        expect(response.status).toEqual(200)

        const succeededLogs = await listSubscriptionLogRows(container, {
          subscription_id: subscription.id,
          event_type: ActivityLogEventType.RENEWAL_SUCCEEDED,
        })

        expect(succeededLogs).toHaveLength(1)
        expect(succeededLogs[0]).toMatchObject({
          subscription_id: subscription.id,
          event_type: ActivityLogEventType.RENEWAL_SUCCEEDED,
          actor_type: ActivityLogActorType.USER,
          actor_id: actorId,
          reason:
            "operator verified the captured payment in the provider dashboard",
          metadata: expect.objectContaining({
            source: "admin",
            trigger_type: "manual",
            renewal_cycle_id: cycle.id,
          }),
        })
        expect(succeededLogs[0].dedupe_key).toContain(
          ActivityLogEventType.RENEWAL_SUCCEEDED
        )
      })

      it("rejects a missing or empty reason with 400 and leaves the cycle stuck", async () => {
        const container = getContainer()
        const headers = await createAdminAuthHeaders(container)

        const { cycle } = await seedStuckCycle(container)

        await expect(
          resolveStuck(cycle.id, { outcome: "failed" }, headers)
        ).rejects.toMatchObject({
          response: { status: 400 },
        })

        await expect(
          resolveStuck(
            cycle.id,
            { outcome: "failed", reason: "   " },
            headers
          )
        ).rejects.toMatchObject({
          response: { status: 400 },
        })

        const stored = await getStoredCycle(container, cycle.id)
        expect(stored.status).toEqual(RenewalCycleStatus.PROCESSING)
      })

      it("rejects an outcome outside the three allowed values with 400 and leaves the cycle stuck", async () => {
        const container = getContainer()
        const headers = await createAdminAuthHeaders(container)

        const { cycle } = await seedStuckCycle(container)

        await expect(
          resolveStuck(
            cycle.id,
            { outcome: "retry", reason: "operator wants a retry" },
            headers
          )
        ).rejects.toMatchObject({
          response: { status: 400 },
        })

        const stored = await getStoredCycle(container, cycle.id)
        expect(stored.status).toEqual(RenewalCycleStatus.PROCESSING)
      })

      it("returns 404 for an unknown cycle id", async () => {
        const container = getContainer()
        const headers = await createAdminAuthHeaders(container)

        await expect(
          resolveStuck(
            `ren_missing_${nextSeedSuffix()}`,
            { outcome: "failed", reason: "unknown cycle" },
            headers
          )
        ).rejects.toMatchObject({
          response: {
            status: 404,
            data: {
              type: "not_found",
              message: expect.stringContaining("was not found"),
            },
          },
        })
      })

      it("requires admin authentication", async () => {
        const container = getContainer()

        const { cycle } = await seedStuckCycle(container)

        await expect(
          resolveStuck(cycle.id, {
            outcome: "failed",
            reason: "no credentials attached",
          })
        ).rejects.toMatchObject({
          response: { status: 401 },
        })
      })
    })
  },
})
