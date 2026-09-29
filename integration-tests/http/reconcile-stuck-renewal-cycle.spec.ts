import path from "path"
import { medusaIntegrationTestRunner } from "@medusajs/test-utils"
import type {
  IPaymentModuleService,
  IWorkflowEngineService,
  MedusaContainer,
} from "@medusajs/framework/types"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { RENEWAL_MODULE } from "../../src/modules/renewal"
import type RenewalModuleService from "../../src/modules/renewal/service"
import {
  RenewalAttemptStatus,
  RenewalCycleStatus,
} from "../../src/modules/renewal/types"
import { SUBSCRIPTION_MODULE } from "../../src/modules/subscription"
import type SubscriptionModuleService from "../../src/modules/subscription/service"
import { SubscriptionStatus } from "../../src/modules/subscription/types"
import { listStuckProcessingRenewalCycles } from "../../src/modules/renewal/utils/scheduler-query"
import recoverStuckRenewalCyclesJob from "../../src/jobs/recover-stuck-renewal-cycles"
import {
  createRenewalAttemptSeed,
  createRenewalCycleSeed,
  createSubscriptionSeed,
} from "../helpers/renewal-fixtures"
import { createCustomer, createProductWithVariant } from "../helpers/subscription-fixtures"

jest.setTimeout(180 * 1000)

/**
 * Stuck-`processing` renewal cycle reconciliation (hardening plan Task 8).
 *
 * One case per row of the decision table, plus: the job is idempotent across
 * two runs, a parked cycle is not re-processed, and the operator override.
 * Fixtures are self-contained: a crashed attempt is simulated by seeding a
 * `processing` cycle whose `updated_at` is backdated past the 30-minute stale
 * threshold, plus whatever the crashed run left behind (a renewal attempt
 * stuck in `processing`, an order, a payment collection).
 */
medusaIntegrationTestRunner({
  medusaConfigFile: path.resolve(process.cwd(), "integration-tests"),
  env: {
    JWT_SECRET: "supersecret",
    COOKIE_SECRET: "supersecret",
  },
  testSuite: ({ getContainer }) => {
    describe("stuck processing renewal cycle reconciliation", () => {
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

      function pastDate(minutesAgo = 5) {
        return new Date(Date.now() - minutesAgo * 60_000)
      }

      type PgConnectionHandle = {
        raw(sql: string, bindings?: unknown[]): Promise<unknown>
      }

      function getConnection(container: MedusaContainer) {
        return container.resolve<PgConnectionHandle>(
          ContainerRegistrationKeys.PG_CONNECTION
        )
      }

      // The module service manages updated_at itself, so staleness is staged
      // through the suite's own connection.
      async function backdateCycleUpdatedAt(
        container: MedusaContainer,
        cycleId: string,
        minutesAgo: number
      ) {
        await getConnection(container).raw(
          `update "renewal_cycle" set updated_at = ? where id = ?`,
          [pastDate(minutesAgo), cycleId]
        )
      }

      async function seedStuckCycle(
        container: MedusaContainer,
        options: {
          status?: RenewalCycleStatus
          staleMinutes?: number
          withAttempt?: boolean
        } = {}
      ) {
        const subscription = await createSubscriptionSeed(container, {
          reference: `SUB-RSC-${nextSeedSuffix()}`,
        })

        const cycle = await createRenewalCycleSeed(container, {
          subscription_id: subscription.id,
          status: options.status ?? RenewalCycleStatus.PROCESSING,
          scheduled_for: pastDate(),
          attempt_count: options.withAttempt === false ? 0 : 1,
        })

        if (options.withAttempt !== false) {
          await createRenewalAttemptSeed(container, {
            renewal_cycle_id: cycle.id,
            attempt_no: 1,
            status: RenewalAttemptStatus.PROCESSING,
          })
        }

        await backdateCycleUpdatedAt(
          container,
          cycle.id,
          options.staleMinutes ?? 45
        )

        return { subscription, cycle }
      }

      type CrashedOrderOptions = {
        capture?: boolean
        /** Leave the collection session-less (never authorized). */
        sessionless?: boolean
        /** Link the cycle to the order the way the charge path does. */
        linkCycle?: boolean
        /** Stamp the order metadata instead of linking (crash-window orphan). */
        orphanForCycle?: string
      }

      /**
       * Builds what a crashed charge attempt leaves behind: an order plus a
       * payment collection, authorized (and optionally captured) through the
       * system provider, linked to the cycle exactly like
       * `process-renewal-cycle`'s charge path does — or deliberately unlinked
       * but discoverable through the order metadata, for the crash window
       * between capture and the link write.
       */
      async function seedCrashedOrder(
        container: MedusaContainer,
        cycleId: string,
        options: CrashedOrderOptions = {}
      ): Promise<{ orderId: string }> {
        const customer = await createCustomer(container, {
          email: `rsc-${nextSeedSuffix()}@medusa.test`,
        })
        const { variant } = await createProductWithVariant(container)

        const orderModule = container.resolve(Modules.ORDER) as {
          createOrders: (input: Record<string, unknown>) => Promise<{
            id: string
          }>
        }
        const paymentModule = container.resolve<IPaymentModuleService>(
          Modules.PAYMENT
        )
        const link = container.resolve(ContainerRegistrationKeys.LINK) as {
          create: (input: unknown) => Promise<unknown>
        }

        const paymentCollection = await paymentModule.createPaymentCollections({
          currency_code: "usd",
          amount: 1800,
        })

        if (!options.sessionless) {
          const session = await paymentModule.createPaymentSession(
            paymentCollection.id,
            {
              provider_id: "pp_system_default",
              currency_code: "usd",
              amount: 1800,
              data: {},
            } as never
          )

          if (options.capture) {
            // Authorize then capture explicitly: this Medusa version does not
            // auto-capture on authorize, so the explicit call is what leaves
            // the captured money the row-1 world expects.
            const payment = await paymentModule.authorizePaymentSession(
              session.id,
              {}
            )

            if (!payment) {
              throw new Error(
                "Fixture broken: authorize produced no payment record"
              )
            }

            await paymentModule.capturePayment({
              payment_id: payment.id,
              amount: payment.amount,
            })
          } else {
            // Authorized-but-not-captured must be staged directly: the system
            // provider can only produce the captured state. A payment record
            // with no captured_at IS the authorized state (payment status is
            // derived from captured_at/canceled_at), matching what a real
            // off-session provider leaves behind when the run dies between
            // authorize and capture.
            const connection = getConnection(container)
            await connection.raw(
              `insert into payment (id, amount, raw_amount, currency_code, provider_id, payment_collection_id, payment_session_id)
               values (?, ?, ?, 'usd', 'pp_system_default', ?, ?)`,
              [
                `pay_rsc_${nextSeedSuffix()}`,
                1800,
                JSON.stringify({ value: "18", precision: 2 }),
                paymentCollection.id,
                session.id,
              ]
            )
            await connection.raw(
              `update payment_session set status = 'authorized', authorized_at = now() where id = ?`,
              [session.id]
            )
            await connection.raw(
              `update payment_collection set status = 'authorized' where id = ?`,
              [paymentCollection.id]
            )
          }
        }

        const order = await orderModule.createOrders({
          customer_id: customer.id,
          email: customer.email,
          currency_code: "usd",
          status: "completed",
          items: [
            {
              title: "Renewal item",
              subtitle: "Subscription Product",
              quantity: 1,
              unit_price: 1800,
              variant_id: variant.id,
            },
          ],
          metadata: options.orphanForCycle
            ? {
                renewal_cycle_id: options.orphanForCycle,
                subscription_id: `simulated`,
                renewal_trigger: "automatic",
              }
            : {},
          shipping_address: {
            first_name: "Reconciliation",
            last_name: "Fixture",
            address_1: "1 Test Way",
            city: "Testville",
            postal_code: "00001",
            country_code: "us",
          },
        } as never)

        await link.create([
          {
            [Modules.ORDER]: { order_id: order.id },
            [Modules.PAYMENT]: {
              payment_collection_id: paymentCollection.id,
            },
          },
        ])

        if (options.linkCycle) {
          await link.create({
            [RENEWAL_MODULE]: { renewal_cycle_id: cycleId },
            [Modules.ORDER]: { order_id: order.id },
          })
        }

        return { orderId: order.id }
      }

      async function runReconcile(
        container: MedusaContainer,
        input: Record<string, unknown>
      ) {
        const engine = container.resolve<IWorkflowEngineService>(
          Modules.WORKFLOW_ENGINE
        )

        return await engine.run("reconcile-stuck-renewal-cycle", {
          input,
          throwOnError: true,
        })
      }

      function spyOnEventBus(container: MedusaContainer) {
        const eventBus = container.resolve("event_bus") as unknown as {
          emit: (data: unknown) => Promise<void>
        }

        // Re-spying the same method across tests shares the underlying mock;
        // clear it so every test only reads its own emissions.
        const emitSpy = jest.spyOn(eventBus, "emit")
        emitSpy.mockClear()
        return emitSpy
      }

      // The event bus receives both bulk emits (an array of event objects)
      // and single emits (one event object or a bare event name), depending
      // on which core module produced them.
      function emittedEventNames(emitSpy: jest.SpyInstance): string[] {
        const names: string[] = []

        for (const call of emitSpy.mock.calls) {
          const payload = call[0] as unknown

          const entries = Array.isArray(payload)
            ? payload
            : [payload]

          for (const entry of entries as Array<
            { name?: string; eventName?: string } | string | undefined
          >) {
            if (typeof entry === "string") {
              names.push(entry)
            } else if (typeof entry?.name === "string") {
              names.push(entry.name)
            } else if (typeof entry?.eventName === "string") {
              names.push(entry.eventName)
            }
          }
        }

        return names
      }

      async function getStoredCycle(
        container: MedusaContainer,
        cycleId: string
      ) {
        const renewalModule =
          container.resolve<RenewalModuleService>(RENEWAL_MODULE)

        return await renewalModule.retrieveRenewalCycle(cycleId)
      }

      async function getStoredAttempts(
        container: MedusaContainer,
        cycleId: string
      ) {
        const renewalModule =
          container.resolve<RenewalModuleService>(RENEWAL_MODULE)

        return (await renewalModule.listRenewalAttempts({
          renewal_cycle_id: cycleId,
        })) as unknown as Array<{
          id: string
          status: RenewalAttemptStatus
          order_id: string | null
          error_message: string | null
        }>
      }

      it("finalizes the period when the linked order's payment is confirmed captured (row 1)", async () => {
        const container = getContainer()
        const subscriptionModule =
          container.resolve<SubscriptionModuleService>(SUBSCRIPTION_MODULE)
        const emitSpy = spyOnEventBus(container)

        const { subscription, cycle } = await seedStuckCycle(container)
        const { orderId } = await seedCrashedOrder(container, cycle.id, {
          capture: true,
          linkCycle: true,
        })

        await runReconcile(container, {
          renewal_cycle_id: cycle.id,
          trigger_type: "scheduler",
        })

        const stored = await getStoredCycle(container, cycle.id)
        expect(stored.status).toEqual(RenewalCycleStatus.SUCCEEDED)
        expect(stored.generated_order_id).toEqual(orderId)
        expect(stored.last_error).toBeNull()

        const attempts = await getStoredAttempts(container, cycle.id)
        expect(attempts).toHaveLength(1)
        expect(attempts[0].status).toEqual(RenewalAttemptStatus.SUCCEEDED)
        expect(attempts[0].order_id).toEqual(orderId)

        // The shared finalization step advanced the subscription cadence
        // anchored on the cycle's own scheduled_for and ensured the next
        // cycle.
        const refreshedSubscription = await subscriptionModule.retrieveSubscription(
          subscription.id
        )
        expect(refreshedSubscription.status).toEqual(SubscriptionStatus.ACTIVE)
        const lastRenewalAt = refreshedSubscription.last_renewal_at
          ? new Date(refreshedSubscription.last_renewal_at)
          : null
        expect(lastRenewalAt).not.toBeNull()

        const renewalModule =
          container.resolve<RenewalModuleService>(RENEWAL_MODULE)
        const cyclesAfter = (await renewalModule.listRenewalCycles({
          subscription_id: subscription.id,
        })) as unknown as Array<{ status: RenewalCycleStatus }>
        expect(
          cyclesAfter.some((entry) => entry.status === RenewalCycleStatus.SCHEDULED)
        ).toBe(true)

        expect(emittedEventNames(emitSpy)).toContain("renewal.succeeded")
      })

      it("returns the cycle to failed when no order was created by the crashed attempt (row 2)", async () => {
        const container = getContainer()
        const subscriptionModule =
          container.resolve<SubscriptionModuleService>(SUBSCRIPTION_MODULE)

        const { subscription, cycle } = await seedStuckCycle(container)
        const before = await subscriptionModule.retrieveSubscription(
          subscription.id
        )

        await runReconcile(container, {
          renewal_cycle_id: cycle.id,
          trigger_type: "scheduler",
        })

        const stored = await getStoredCycle(container, cycle.id)
        expect(stored.status).toEqual(RenewalCycleStatus.FAILED)
        expect(stored.last_error).toContain("no renewal order was found")

        const attempts = await getStoredAttempts(container, cycle.id)
        expect(attempts[0].status).toEqual(RenewalAttemptStatus.FAILED)

        // Row 2 never touches the subscription: retry ownership does.
        const after = await subscriptionModule.retrieveSubscription(
          subscription.id
        )
        expect(after.status).toEqual(before.status)
        expect(after.next_renewal_at).toEqual(before.next_renewal_at)
      })

      it("returns the cycle to failed when the linked order's payment is confirmed not captured (row 2)", async () => {
        const container = getContainer()

        const { cycle } = await seedStuckCycle(container)
        await seedCrashedOrder(container, cycle.id, {
          // A collection exists but nothing was ever authorized on it.
          sessionless: true,
          linkCycle: true,
        })

        await runReconcile(container, {
          renewal_cycle_id: cycle.id,
          trigger_type: "scheduler",
        })

        const stored = await getStoredCycle(container, cycle.id)
        expect(stored.status).toEqual(RenewalCycleStatus.FAILED)
        expect(stored.last_error).toContain("confirmed not captured")

        const attempts = await getStoredAttempts(container, cycle.id)
        expect(attempts[0].status).toEqual(RenewalAttemptStatus.FAILED)
      })

      it("parks the cycle as awaiting_manual_resolution when the payment is authorized but not captured (row 3)", async () => {
        const container = getContainer()
        const subscriptionModule =
          container.resolve<SubscriptionModuleService>(SUBSCRIPTION_MODULE)
        const emitSpy = spyOnEventBus(container)

        const { subscription, cycle } = await seedStuckCycle(container)
        await seedCrashedOrder(container, cycle.id, {
          capture: false,
          linkCycle: true,
        })
        const before = await subscriptionModule.retrieveSubscription(
          subscription.id
        )

        await runReconcile(container, {
          renewal_cycle_id: cycle.id,
          trigger_type: "scheduler",
        })

        const stored = await getStoredCycle(container, cycle.id)
        expect(stored.status).toEqual(
          RenewalCycleStatus.AWAITING_MANUAL_RESOLUTION
        )
        expect(stored.last_error).toContain("parked the cycle")

        // R5: "we do not know" is not "there is no hope" — no failed verdict,
        // and the subscription is left untouched.
        const after = await subscriptionModule.retrieveSubscription(
          subscription.id
        )
        expect(after.status).toEqual(before.status)
        expect(after.next_renewal_at).toEqual(before.next_renewal_at)

        const attempts = await getStoredAttempts(container, cycle.id)
        expect(attempts[0].status).toEqual(RenewalAttemptStatus.FAILED)

        expect(emittedEventNames(emitSpy)).not.toContain("renewal.succeeded")

        // Task 12: the park is alertable on the bus, exactly once per cycle —
        // one reconciliation, one renewal.awaiting_manual_resolution.
        const parkEvents = emittedEventNames(emitSpy).filter(
          (name) => name === "renewal.awaiting_manual_resolution"
        )
        expect(parkEvents).toHaveLength(1)
      })

      it("finalizes through the order metadata when the crash window left captured money unlinked", async () => {
        const container = getContainer()

        const { cycle } = await seedStuckCycle(container)
        // Capture happens BEFORE the cycle ↔ order link write in
        // process-renewal-cycle, so a run killed exactly there leaves captured
        // money with no link row. The metadata fallback must not let this
        // window be answered "no linked order" and re-charged.
        const { orderId } = await seedCrashedOrder(container, cycle.id, {
          capture: true,
          linkCycle: false,
          orphanForCycle: cycle.id,
        })

        await runReconcile(container, {
          renewal_cycle_id: cycle.id,
          trigger_type: "scheduler",
        })

        const stored = await getStoredCycle(container, cycle.id)
        expect(stored.status).toEqual(RenewalCycleStatus.SUCCEEDED)
        expect(stored.generated_order_id).toEqual(orderId)
      })

      it("recovers every stuck cycle exactly once across two job runs", async () => {
        const container = getContainer()
        const emitSpy = spyOnEventBus(container)

        const captured = await seedStuckCycle(container)
        await seedCrashedOrder(container, captured.cycle.id, {
          capture: true,
          linkCycle: true,
        })

        const uncharged = await seedStuckCycle(container)

        const ambiguous = await seedStuckCycle(container)
        await seedCrashedOrder(container, ambiguous.cycle.id, {
          capture: false,
          linkCycle: true,
        })

        await recoverStuckRenewalCyclesJob(container)

        const capturedCycle = await getStoredCycle(
          container,
          captured.cycle.id
        )
        expect(capturedCycle.status).toEqual(RenewalCycleStatus.SUCCEEDED)

        const unchargedCycle = await getStoredCycle(
          container,
          uncharged.cycle.id
        )
        expect(unchargedCycle.status).toEqual(RenewalCycleStatus.FAILED)

        const ambiguousCycle = await getStoredCycle(
          container,
          ambiguous.cycle.id
        )
        expect(ambiguousCycle.status).toEqual(
          RenewalCycleStatus.AWAITING_MANUAL_RESOLUTION
        )

        expect(emittedEventNames(emitSpy).filter((name) => name === "renewal.succeeded"))
          .toHaveLength(1)

        // Second run: nothing is stuck anymore, and nothing changes.
        const scanAfterFirstRun = await listStuckProcessingRenewalCycles(
          container,
          { limit: 100, offset: 0 }
        )
        expect(scanAfterFirstRun.count).toEqual(0)

        const statusesBeforeSecondRun = {
          captured: capturedCycle.status,
          uncharged: unchargedCycle.status,
          ambiguous: ambiguousCycle.status,
        }

        await recoverStuckRenewalCyclesJob(container)

        expect(
          (await getStoredCycle(container, captured.cycle.id)).status
        ).toEqual(statusesBeforeSecondRun.captured)
        expect(
          (await getStoredCycle(container, uncharged.cycle.id)).status
        ).toEqual(statusesBeforeSecondRun.uncharged)
        expect(
          (await getStoredCycle(container, ambiguous.cycle.id)).status
        ).toEqual(statusesBeforeSecondRun.ambiguous)

        expect(emittedEventNames(emitSpy).filter((name) => name === "renewal.succeeded"))
          .toHaveLength(1)
      })

      it("does not re-process a cycle parked in awaiting_manual_resolution", async () => {
        const container = getContainer()

        const parked = await seedStuckCycle(container, {
          status: RenewalCycleStatus.AWAITING_MANUAL_RESOLUTION,
          withAttempt: false,
        })

        await recoverStuckRenewalCyclesJob(container)

        const stored = await getStoredCycle(container, parked.cycle.id)
        expect(stored.status).toEqual(
          RenewalCycleStatus.AWAITING_MANUAL_RESOLUTION
        )

        const scan = await listStuckProcessingRenewalCycles(container, {
          limit: 100,
          offset: 0,
        })
        expect(scan.cycles.map((cycle) => cycle.id)).not.toContain(
          parked.cycle.id
        )
      })

      it("applies the operator override to succeeded on a stuck cycle", async () => {
        const container = getContainer()
        const emitSpy = spyOnEventBus(container)

        const { cycle } = await seedStuckCycle(container)

        await runReconcile(container, {
          renewal_cycle_id: cycle.id,
          outcome_override: "succeeded",
          reason: "operator confirmed the charge landed in the provider",
          trigger_type: "manual",
          triggered_by: "user_01",
        })

        const stored = await getStoredCycle(container, cycle.id)
        expect(stored.status).toEqual(RenewalCycleStatus.SUCCEEDED)
        expect(stored.generated_order_id).toBeNull()

        expect(emittedEventNames(emitSpy)).toContain("renewal.succeeded")
      })

      it("applies the operator override to failed with the operator's reason", async () => {
        const container = getContainer()

        const { cycle } = await seedStuckCycle(container)

        await runReconcile(container, {
          renewal_cycle_id: cycle.id,
          outcome_override: "failed",
          reason: "provider shows no charge for this attempt",
          trigger_type: "manual",
          triggered_by: "user_01",
        })

        const stored = await getStoredCycle(container, cycle.id)
        expect(stored.status).toEqual(RenewalCycleStatus.FAILED)
        expect(stored.last_error).toContain(
          "provider shows no charge for this attempt"
        )
      })

      it("applies the operator override to abandoned without cancelling the subscription", async () => {
        const container = getContainer()
        const subscriptionModule =
          container.resolve<SubscriptionModuleService>(SUBSCRIPTION_MODULE)
        const emitSpy = spyOnEventBus(container)

        const { subscription, cycle } = await seedStuckCycle(container)
        const before = await subscriptionModule.retrieveSubscription(
          subscription.id
        )

        await runReconcile(container, {
          renewal_cycle_id: cycle.id,
          outcome_override: "abandoned",
          reason: "merchant wrote the period off",
          trigger_type: "manual",
          triggered_by: "user_01",
        })

        const stored = await getStoredCycle(container, cycle.id)
        expect(stored.status).toEqual(RenewalCycleStatus.ABANDONED)
        expect(stored.last_error).toContain("merchant wrote the period off")

        // Task 12: the operator write-off is alertable on the bus, exactly
        // once per cycle — one override, one renewal.abandoned.
        const abandonedEvents = emittedEventNames(emitSpy).filter(
          (name) => name === "renewal.abandoned"
        )
        expect(abandonedEvents).toHaveLength(1)

        // R3: no background write ever cancels a subscription.
        const after = await subscriptionModule.retrieveSubscription(
          subscription.id
        )
        expect(after.status).toEqual(before.status)
        expect(after.cancelled_at).toEqual(before.cancelled_at)

        // An abandoned cycle is outside the due set and outside the stale scan.
        const scan = await listStuckProcessingRenewalCycles(container, {
          limit: 100,
          offset: 0,
        })
        expect(scan.cycles.map((cycle) => cycle.id)).not.toContain(cycle.id)
      })

      it("returns only cycles past the 30-minute staleness threshold", async () => {
        const container = getContainer()

        const stale = await seedStuckCycle(container, { staleMinutes: 45 })
        const fresh = await seedStuckCycle(container, { staleMinutes: 2 })

        const scan = await listStuckProcessingRenewalCycles(container, {
          limit: 100,
          offset: 0,
        })

        expect(scan.cycles.map((cycle) => cycle.id)).toContain(stale.cycle.id)
        expect(scan.cycles.map((cycle) => cycle.id)).not.toContain(fresh.cycle.id)

        // Cleanup: the stale leftover must not be swept by a later job test.
        const renewalModule =
          container.resolve<RenewalModuleService>(RENEWAL_MODULE)
        await renewalModule.updateRenewalCycles({
          id: stale.cycle.id,
          status: RenewalCycleStatus.FAILED,
        })
      })
    })
  },
})
