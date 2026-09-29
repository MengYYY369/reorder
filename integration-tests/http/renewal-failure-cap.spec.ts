import path from "path"
import { medusaIntegrationTestRunner } from "@medusajs/test-utils"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import type {
  ICartModuleService,
  IOrderModuleService,
  IPaymentModuleService,
  IRegionModuleService,
  ISalesChannelModuleService,
  MedusaContainer,
} from "@medusajs/framework/types"
import { listDueRenewalCyclesForProcessing } from "../../src/modules/renewal/utils/scheduler-query"
import { RENEWAL_MODULE } from "../../src/modules/renewal"
import type RenewalModuleService from "../../src/modules/renewal/service"
import { RenewalCycleStatus } from "../../src/modules/renewal/types"
import { DUNNING_MODULE } from "../../src/modules/dunning"
import type DunningModuleService from "../../src/modules/dunning/service"
import { DunningCaseStatus } from "../../src/modules/dunning/types"
import { SETTINGS_MODULE } from "../../src/modules/settings"
import type SettingsModuleService from "../../src/modules/settings/service"
import { SUBSCRIPTION_MODULE } from "../../src/modules/subscription"
import type SubscriptionModuleService from "../../src/modules/subscription/service"
import { SubscriptionStatus } from "../../src/modules/subscription/types"
import { processRenewalCycleWorkflow } from "../../src/workflows"
import {
  createDunningCaseSeed,
  createRenewalCycleSeed,
  createSubscriptionSeed,
} from "../helpers/dunning-fixtures"
import { createCustomer } from "../helpers/plan-offer-fixtures"

jest.setTimeout(120 * 1000)

type ProductModuleServiceLike = {
  createProducts: (input: Record<string, unknown>) => Promise<{
    id: string
    variants?: Array<{ id: string }>
  }>
}

type PricingModuleServiceLike = {
  createPriceSets: (input: {
    prices: Array<{ amount: number; currency_code: string }>
  }) => Promise<{ id: string }>
}

type CreatedCartBackedSeed = {
  subscription: Awaited<ReturnType<typeof createSubscriptionSeed>>
  customer: { id: string }
}

medusaIntegrationTestRunner({
  medusaConfigFile: path.resolve(process.cwd(), "integration-tests"),
  env: {
    JWT_SECRET: "supersecret",
    COOKIE_SECRET: "supersecret",
  },
  testSuite: ({ getContainer }) => {
    describe("renewal structural-failure cap and abandonment", () => {
      let runId: string
      let seedCounter: number

      beforeEach(() => {
        jest.restoreAllMocks()
        runId = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`
        seedCounter = 0
      })

      function pastDate(minutesAgo = 5) {
        return new Date(Date.now() - minutesAgo * 60_000)
      }

      /**
       * How many `renewal.abandoned` events the bus spy recorded (Task 12:
       * the abandonment is alertable on the bus exactly once per cycle, only
       * on the attempt that turns the cycle `abandoned`).
       */
      function abandonedEventCount(emitSpy: jest.SpyInstance): number {
        return emitSpy.mock.calls
          .flatMap((call) => {
            const payload = call[0] as unknown
            return Array.isArray(payload) ? payload : [payload]
          })
          .filter(
            (event) => (event as { name?: string })?.name === "renewal.abandoned"
          ).length
      }

      function spyOnEventBusEmit(container: MedusaContainer) {
        const eventBus = container.resolve("event_bus") as unknown as {
          emit: (data: unknown) => Promise<void>
        }

        return jest.spyOn(eventBus, "emit")
      }

      function nextSeedSuffix() {
        seedCounter += 1
        return `${runId}-${seedCounter}`
      }

      /**
       * The cap under test is the operator's setting, not the compiled
       * default: `renewal_max_attempts: 2` makes every abandonment below
       * prove the setting is actually consulted (a pinned default of 3 would
       * never abandon on the second failure).
       */
      async function setStructuralCap(container: MedusaContainer, value: number) {
        const settingsModule =
          container.resolve<SettingsModuleService>(SETTINGS_MODULE)

        await settingsModule.updateSettings({
          renewal_max_attempts: value,
          dunning_retry_intervals: [1440, 4320, 10080],
          max_dunning_attempts: 3,
        })
      }

      const AUTO_PAYMENT_CONTEXT = {
        payment_provider_id: "pp_system_default",
        payment_mode: "auto",
        source_payment_collection_id: null,
        source_payment_session_id: null,
        payment_method_reference: "pm_test_auto",
        customer_payment_reference: null,
      }

      const NO_PAYMENT_CONTEXT = {
        payment_provider_id: null,
        payment_mode: "manual",
        source_payment_collection_id: null,
        source_payment_session_id: null,
        payment_method_reference: null,
        customer_payment_reference: null,
      }

      /**
       * An auto-renewal subscription backed by a real cart whose single line
       * is priced, so the renewal order path gets past every pre-order
       * precondition and a payment-stage failure can be forced with a mock.
       */
      async function seedCartBackedSubscription(
        container: MedusaContainer,
        reference: string,
        paymentContext: Record<string, unknown>
      ): Promise<CreatedCartBackedSeed> {
        const customer = await createCustomer(container, {
          email: `${reference.toLowerCase()}-${Date.now()}@medusa.test`,
        })

        // A published product: renewal order line items validate their
        // variant_id against the product module.
        const productModule =
          container.resolve<ProductModuleServiceLike>(Modules.PRODUCT)
        const product = await productModule.createProducts({
          title: `Subscription Product ${Date.now()}`,
          status: "published",
          options: [
            {
              title: "Plan",
              values: ["Default"],
            },
          ],
          variants: [
            {
              title: "Default Variant",
              sku: `SUB-SKU-${Date.now()}`,
              manage_inventory: false,
              options: {
                Plan: "Default",
              },
            },
          ],
        })
        const variant = product.variants?.[0]

        if (!variant) {
          throw new Error("Failed to create product variant for test")
        }

        // Renewal order line items resolve their price through the variant's
        // price set, so seed one explicitly and link it to the variant.
        const pricingModule =
          container.resolve<PricingModuleServiceLike>(Modules.PRICING)
        const priceSet = await pricingModule.createPriceSets({
          prices: [
            {
              amount: 0.01,
              currency_code: "usd",
            },
          ],
        })

        const link = container.resolve(ContainerRegistrationKeys.LINK)
        await link.create({
          [Modules.PRODUCT]: {
            variant_id: variant.id,
          },
          [Modules.PRICING]: {
            price_set_id: priceSet.id,
          },
        })

        const regionModule = container.resolve<IRegionModuleService>(
          Modules.REGION
        )
        const region = await regionModule.createRegions({
          name: `US-${Date.now()}-${Math.random()}`,
          currency_code: "usd",
        } as never)

        // Module-level cart creation does not attach a default sales
        // channel, and the renewal order creation requires one.
        const salesChannelModule =
          container.resolve<ISalesChannelModuleService>(Modules.SALES_CHANNEL)
        const salesChannel = await salesChannelModule.createSalesChannels({
          name: `SC-${Date.now()}-${Math.random()}`,
        } as never)

        const cartModule = container.resolve<ICartModuleService>(Modules.CART)
        const cart = (await cartModule.createCarts({
          currency_code: "usd",
          email: customer.email,
          customer_id: customer.id,
          region_id: region.id,
          sales_channel_id: salesChannel.id,
          metadata: {},
          items: [
            {
              title: "Subscription renewal",
              subtitle: "Monthly plan",
              unit_price: 0.01,
              quantity: 1,
              requires_shipping: false,
              variant_id: variant.id,
            } as never,
          ],
          shipping_address: {
            first_name: "Auto",
            last_name: "Renewal",
            address_1: "1 Renewal Way",
            city: "Testville",
            postal_code: "00001",
            country_code: "us",
          },
        } as never)) as unknown as { id: string }

        const subscription = await createSubscriptionSeed(container, {
          reference,
          status: SubscriptionStatus.ACTIVE,
          customer_id: customer.id,
          cart_id: cart.id,
          product_id: product.id,
          variant_id: variant.id,
          next_renewal_at: new Date(),
          payment_context: paymentContext as never,
        })

        return { subscription, customer }
      }

      async function runCycle(container: MedusaContainer, cycleId: string) {
        return await processRenewalCycleWorkflow(container).run({
          input: {
            renewal_cycle_id: cycleId,
            trigger_type: "scheduler",
          },
        })
      }

      async function dueCycleIds(container: MedusaContainer) {
        const { cycles } = await listDueRenewalCyclesForProcessing(container, {
          limit: 200,
          offset: 0,
        })

        return new Set(cycles.map((cycle) => cycle.id))
      }

      async function orderCount(container: MedusaContainer, customerId: string) {
        const orderModule = container.resolve<IOrderModuleService>(Modules.ORDER)
        const [, count] = await orderModule.listAndCountOrders({
          customer_id: customerId,
        })

        return count
      }

      it("abandons a structurally failing cycle at renewal_max_attempts and stops selecting it", async () => {
        const container = getContainer()
        await setStructuralCap(container, 2)
        const renewalModule =
          container.resolve<RenewalModuleService>(RENEWAL_MODULE)
        const emitSpy = spyOnEventBusEmit(container)

        // No cart: the failure ("missing 'cart_id'") reproduces on every
        // scheduler pass, which is what makes it structural.
        const subscription = await createSubscriptionSeed(container, {
          reference: `SUB-RFC-CAP-${nextSeedSuffix()}`,
          cart_id: null,
          skip_next_cycle: false,
        })
        const cycle = await createRenewalCycleSeed(container, {
          subscription_id: subscription.id,
          status: RenewalCycleStatus.SCHEDULED,
          scheduled_for: pastDate(),
        })

        for (const attemptNo of [1, 2]) {
          await expect(runCycle(container, cycle.id)).rejects.toMatchObject({
            message: expect.stringContaining("cart_id"),
          })

          const stored = await renewalModule.retrieveRenewalCycle(cycle.id)

          expect(stored.last_failure_kind).toEqual("order_creation_failed")
          expect(stored.structural_attempt_count).toEqual(attemptNo)

          if (attemptNo < 2) {
            expect(stored.status).toEqual(RenewalCycleStatus.FAILED)
            // A failed-but-not-abandoned attempt is not the write-off: the
            // abandonment event waits for the cap.
            expect(abandonedEventCount(emitSpy)).toEqual(0)
          } else {
            expect(stored.status).toEqual(RenewalCycleStatus.ABANDONED)
            expect(stored.last_error).toContain("cart_id")
            // Task 12: one abandonment, persisted and emitted exactly where
            // the terminal write landed.
            expect(abandonedEventCount(emitSpy)).toEqual(1)
          }
        }

        // Abandoned is terminal: outside the due set, so the five-minute
        // loop stops touching the period.
        expect((await dueCycleIds(container)).has(cycle.id)).toBe(false)
      })

      it("does not count a payment failure toward the structural cap when dunning takes over", async () => {
        const container = getContainer()
        await setStructuralCap(container, 2)
        const renewalModule =
          container.resolve<RenewalModuleService>(RENEWAL_MODULE)
        const dunningModule =
          container.resolve<DunningModuleService>(DUNNING_MODULE)
        const paymentModule = container.resolve<IPaymentModuleService>(
          Modules.PAYMENT
        )

        const { subscription } = await seedCartBackedSubscription(
          container,
          `SUB-RFC-PAY-${nextSeedSuffix()}`,
          AUTO_PAYMENT_CONTEXT
        )
        const cycle = await createRenewalCycleSeed(container, {
          subscription_id: subscription.id,
          status: RenewalCycleStatus.SCHEDULED,
          scheduled_for: pastDate(),
        })

        jest
          .spyOn(paymentModule, "authorizePaymentSession")
          .mockRejectedValue(new Error("Card declined during renewal"))

        // Two payment failures, each handing off to dunning: the cap must
        // never fire, because dunning owns these retries.
        for (let pass = 0; pass < 2; pass += 1) {
          await expect(runCycle(container, cycle.id)).rejects.toMatchObject({
            message: expect.stringContaining("declined"),
          })
        }

        const stored = await renewalModule.retrieveRenewalCycle(cycle.id)

        expect(stored.status).toEqual(RenewalCycleStatus.FAILED)
        expect(stored.structural_attempt_count).toEqual(0)
        expect(stored.last_failure_kind).toEqual("unexpected_error")
        expect(stored.generated_order_id).toBeTruthy()

        const dunningCases = await dunningModule.listDunningCases({
          subscription_id: subscription.id,
        } as any)

        expect(dunningCases).toHaveLength(1)
        expect(dunningCases[0]).toMatchObject({
          renewal_cycle_id: cycle.id,
          status: expect.stringMatching(/retry_scheduled|retrying/),
        })
      })

      it("still abandons at the cap when the dunning handoff itself throws (R1)", async () => {
        const container = getContainer()
        await setStructuralCap(container, 2)
        const renewalModule =
          container.resolve<RenewalModuleService>(RENEWAL_MODULE)
        const dunningModule =
          container.resolve<DunningModuleService>(DUNNING_MODULE)
        const paymentModule = container.resolve<IPaymentModuleService>(
          Modules.PAYMENT
        )
        const emitSpy = spyOnEventBusEmit(container)

        const { subscription } = await seedCartBackedSubscription(
          container,
          `SUB-RFC-R1-${nextSeedSuffix()}`,
          AUTO_PAYMENT_CONTEXT
        )
        const cycle = await createRenewalCycleSeed(container, {
          subscription_id: subscription.id,
          status: RenewalCycleStatus.SCHEDULED,
          scheduled_for: pastDate(),
        })

        // Force the handoff to throw through real behaviour: an active dunning
        // case on a sibling cycle makes startDunningWorkflow refuse this one
        // ("Duplicate active dunning case blocked") — no case can ever exist
        // for the cycle under test, so the recovery machinery is genuinely
        // unreachable and the period must still terminate.
        const siblingCycle = await createRenewalCycleSeed(container, {
          subscription_id: subscription.id,
          status: RenewalCycleStatus.FAILED,
          scheduled_for: pastDate(30),
        })
        await createDunningCaseSeed(container, {
          subscription_id: subscription.id,
          renewal_cycle_id: siblingCycle.id,
          status: DunningCaseStatus.RETRY_SCHEDULED,
        })

        jest
          .spyOn(paymentModule, "authorizePaymentSession")
          .mockRejectedValue(new Error("Card declined during renewal"))

        for (const attemptNo of [1, 2]) {
          await expect(runCycle(container, cycle.id)).rejects.toMatchObject({
            message: expect.stringContaining("declined"),
          })

          const stored = await renewalModule.retrieveRenewalCycle(cycle.id)

          expect(stored.structural_attempt_count).toEqual(attemptNo)
          expect(stored.last_failure_kind).toEqual("unexpected_error")

          if (attemptNo < 2) {
            expect(stored.status).toEqual(RenewalCycleStatus.FAILED)
            expect(abandonedEventCount(emitSpy)).toEqual(0)
          } else {
            expect(stored.status).toEqual(RenewalCycleStatus.ABANDONED)
            // Task 12: the R1 abandonment emits exactly where its terminal
            // write lands, once.
            expect(abandonedEventCount(emitSpy)).toEqual(1)
          }
        }

        const cycleCases = await dunningModule.listDunningCases({
          renewal_cycle_id: cycle.id,
        } as any)

        expect(cycleCases).toHaveLength(0)
        expect((await dueCycleIds(container)).has(cycle.id)).toBe(false)
      })

      it("counts neither blocked outcome (already processing, duplicate execution)", async () => {
        const container = getContainer()
        const renewalModule =
          container.resolve<RenewalModuleService>(RENEWAL_MODULE)

        const subscription = await createSubscriptionSeed(container, {
          reference: `SUB-RFC-BLOCKED-${nextSeedSuffix()}`,
          cart_id: null,
          skip_next_cycle: false,
        })

        const processingCycle = await createRenewalCycleSeed(container, {
          subscription_id: subscription.id,
          status: RenewalCycleStatus.PROCESSING,
          attempt_count: 1,
          scheduled_for: pastDate(),
        })

        await expect(
          runCycle(container, processingCycle.id)
        ).rejects.toMatchObject({
          message: expect.stringContaining("already processing"),
        })

        const storedProcessing = await renewalModule.retrieveRenewalCycle(
          processingCycle.id
        )

        expect(storedProcessing.status).toEqual(RenewalCycleStatus.PROCESSING)
        expect(storedProcessing.attempt_count).toEqual(1)
        expect(storedProcessing.structural_attempt_count).toEqual(0)

        const succeededCycle = await createRenewalCycleSeed(container, {
          subscription_id: subscription.id,
          status: RenewalCycleStatus.SUCCEEDED,
          attempt_count: 1,
          scheduled_for: pastDate(),
        })

        await expect(
          runCycle(container, succeededCycle.id)
        ).rejects.toMatchObject({
          message: expect.stringContaining("Duplicate execution"),
        })

        const storedSucceeded = await renewalModule.retrieveRenewalCycle(
          succeededCycle.id
        )

        expect(storedSucceeded.status).toEqual(RenewalCycleStatus.SUCCEEDED)
        expect(storedSucceeded.attempt_count).toEqual(1)
        expect(storedSucceeded.structural_attempt_count).toEqual(0)
      })

      it("refuses a missing payment context before minting an order, mints nothing on retries, and abandons at the cap (T7)", async () => {
        const container = getContainer()
        await setStructuralCap(container, 2)
        const renewalModule =
          container.resolve<RenewalModuleService>(RENEWAL_MODULE)

        const { subscription, customer } = await seedCartBackedSubscription(
          container,
          `SUB-RFC-T7-${nextSeedSuffix()}`,
          NO_PAYMENT_CONTEXT
        )
        const cycle = await createRenewalCycleSeed(container, {
          subscription_id: subscription.id,
          status: RenewalCycleStatus.SCHEDULED,
          scheduled_for: pastDate(),
        })

        // The cart carries a priced line for the effective variant, so the
        // pre-order guard is the only thing standing between this attempt and
        // a minted order. Zero orders must stay zero across every attempt.
        for (const attemptNo of [1, 2]) {
          await expect(runCycle(container, cycle.id)).rejects.toMatchObject({
            message: expect.stringContaining("missing renewal payment context"),
          })

          const stored = await renewalModule.retrieveRenewalCycle(cycle.id)

          expect(stored.last_failure_kind).toEqual("unexpected_error")
          expect(stored.structural_attempt_count).toEqual(attemptNo)
          expect(stored.generated_order_id).toBeNull()
          expect(await orderCount(container, customer.id)).toEqual(0)
        }

        const stored = await renewalModule.retrieveRenewalCycle(cycle.id)

        expect(stored.status).toEqual(RenewalCycleStatus.ABANDONED)
        expect(stored.last_error).toContain("missing renewal payment context")
        expect((await dueCycleIds(container)).has(cycle.id)).toBe(false)
      })
    })
  },
})
