import path from "path"
import { medusaIntegrationTestRunner } from "@medusajs/test-utils"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import type {
  ICartModuleService,
  IPaymentModuleService,
  IRegionModuleService,
  ISalesChannelModuleService,
  MedusaContainer,
} from "@medusajs/framework/types"
import { ACTIVITY_LOG_MODULE } from "../../src/modules/activity-log"
import type ActivityLogModuleService from "../../src/modules/activity-log/service"
import { ActivityLogEventType } from "../../src/modules/activity-log/types"
import { SUBSCRIPTION_MODULE } from "../../src/modules/subscription"
import type SubscriptionModuleService from "../../src/modules/subscription/service"
import {
  SubscriptionPaymentContext,
  SubscriptionStatus,
} from "../../src/modules/subscription/types"
import { RENEWAL_MODULE } from "../../src/modules/renewal"
import type RenewalModuleService from "../../src/modules/renewal/service"
import {
  RenewalAttemptStatus,
  RenewalCycleStatus,
} from "../../src/modules/renewal/types"
import { DUNNING_MODULE } from "../../src/modules/dunning"
import type DunningModuleService from "../../src/modules/dunning/service"
import { listDueRenewalCyclesForProcessing } from "../../src/modules/renewal/utils/scheduler-query"
import { processRenewalCycleWorkflow } from "../../src/workflows"
import {
  createRenewalCycleSeed,
  createSubscriptionSeed,
} from "../helpers/renewal-fixtures"
import { createCustomer } from "../helpers/plan-offer-fixtures"

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

function expectEmittedOnce(
  emitSpy: jest.SpyInstance,
  eventName: string
): EmittedBusEvent[] {
  const events = busEventsWithName(emitSpy, eventName)

  expect(events).toHaveLength(1)

  return events
}

async function queryLinkedPaymentCollectionIds(
  container: MedusaContainer,
  orderId: string
): Promise<string[]> {
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const { data } = await query.graph({
    entity: "order_payment_collection",
    fields: ["payment_collection_id"],
    filters: { order_id: orderId },
  })

  return (data as Array<{ payment_collection_id: string }>).map(
    (entry) => entry.payment_collection_id
  )
}

async function queryLinkedSubscriptionOrderIds(
  container: MedusaContainer,
  subscriptionId: string
): Promise<string[]> {
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const { data } = await query.graph({
    entity: "subscription_order",
    fields: ["order_id"],
    filters: { subscription_id: [subscriptionId] },
  })

  return (data as Array<{ order_id: string }>).map((entry) => entry.order_id)
}

medusaIntegrationTestRunner({
  medusaConfigFile: path.resolve(process.cwd(), "integration-tests"),
  env: {
    JWT_SECRET: "supersecret",
    COOKIE_SECRET: "supersecret",
  },
  testSuite: ({ getContainer }) => {
    describe("trial conversion at the trial-end cycle (three-way decision)", () => {
      let runId: string

      beforeEach(() => {
        jest.restoreAllMocks()
        runId = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`
      })

      // An auto-mode trial whose context holds both a provider id and a
      // stored method reference: the same test the hoisted pre-order guard
      // applies, so this context is chargeable off-session.
      const AUTO_TRIAL_PAYMENT_CONTEXT: SubscriptionPaymentContext = {
        payment_provider_id: "pp_system_default",
        payment_mode: "auto",
        source_payment_collection_id: null,
        source_payment_session_id: null,
        payment_method_reference: `pm_trial_${Date.now()}`,
        customer_payment_reference: null,
      }

      // The shape a trial keeps when no method was ever captured: auto mode
      // without a usable reference.
      const AUTO_NO_METHOD_PAYMENT_CONTEXT: SubscriptionPaymentContext = {
        ...AUTO_TRIAL_PAYMENT_CONTEXT,
        payment_method_reference: null,
      }

      // The shape the manual rail and the native mirror rows carry.
      const MANUAL_PAYMENT_CONTEXT: SubscriptionPaymentContext = {
        payment_provider_id: null,
        payment_mode: "manual",
        source_payment_collection_id: null,
        source_payment_session_id: null,
        payment_method_reference: null,
        customer_payment_reference: null,
      }

      function resolveEventBusSpy(container: MedusaContainer) {
        const eventBus = container.resolve("event_bus") as unknown as {
          emit: (data: unknown) => Promise<void>
        }

        return jest.spyOn(eventBus, "emit")
      }

      /**
       * Seeds a trial subscription backed by a real, chargeable cart: a
       * published product whose variant resolves a price, a region, a sales
       * channel, and one priced line. Modeled on the epsilon seeder in
       * renewals-workflows.spec.ts so the system-default provider completes
       * the off-session charge end-to-end.
       */
      async function seedChargeableCartTrial(
        container: MedusaContainer,
        input: {
          reference: string
          trialEndsAt: Date
          payment_context: SubscriptionPaymentContext
        }
      ) {
        const customer = await createCustomer(container, {
          email: `${input.reference.toLowerCase()}-${runId}@medusa.test`,
        })

        const productModule = container.resolve(
          Modules.PRODUCT
        ) as unknown as {
          createProducts: (
            data: Record<string, unknown>
          ) => Promise<{
            id: string
            variants?: Array<{ id: string }>
          }>
        }
        const product = await productModule.createProducts({
          title: `Trial Conversion Product ${runId}`,
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
              sku: `TRIAL-SKU-${runId}`,
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

        const pricingModule = container.resolve(Modules.PRICING) as {
          createPriceSets: (data: {
            prices: Array<{ amount: number; currency_code: string }>
          }) => Promise<{ id: string }>
        }
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
        // A single-object input returns a single region, not an array.
        const region = (await regionModule.createRegions({
          name: `trial-conv-${runId}`,
          currency_code: "usd",
        } as never)) as unknown as { id: string }

        const salesChannelModule =
          container.resolve<ISalesChannelModuleService>(Modules.SALES_CHANNEL)
        const salesChannel = (await salesChannelModule.createSalesChannels({
          name: `trial-conv-sc-${runId}`,
        } as never)) as unknown as { id: string }

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
              title: "Trial conversion renewal",
              subtitle: "Monthly plan",
              unit_price: 0.01,
              quantity: 1,
              requires_shipping: false,
            } as never,
          ],
          shipping_address: {
            first_name: "Trial",
            last_name: "Conversion",
            address_1: "1 Trial Way",
            city: "Testville",
            postal_code: "00001",
            country_code: "us",
          },
        } as never)) as unknown as { id: string }

        const subscriptionModule =
          container.resolve<SubscriptionModuleService>(SUBSCRIPTION_MODULE)
        const subscription = await createSubscriptionSeed(container, {
          reference: input.reference,
          status: SubscriptionStatus.ACTIVE,
          customer_id: customer.id,
          cart_id: cart.id,
          product_id: product.id,
          variant_id: variant.id,
          next_renewal_at: input.trialEndsAt,
          is_trial: true,
          payment_context: input.payment_context,
        })

        // The seed fixture keeps trial_ends_at null, so the anchor is written
        // the way the retry-ownership specs write theirs.
        await subscriptionModule.updateSubscriptions({
          id: subscription.id,
          trial_ends_at: input.trialEndsAt,
        })

        return subscription
      }

      /**
       * Seeds a trial subscription without a chargeable cart. The default
       * fixture cart id is fine for the end paths: no order is ever minted
       * from it.
       */
      async function seedEndingTrial(
        container: MedusaContainer,
        input: {
          reference: string
          trialEndsAt: Date
          payment_context: SubscriptionPaymentContext
          cart_id?: string | null
        }
      ) {
        const subscriptionModule =
          container.resolve<SubscriptionModuleService>(SUBSCRIPTION_MODULE)
        const subscription = await createSubscriptionSeed(container, {
          reference: input.reference,
          status: SubscriptionStatus.ACTIVE,
          is_trial: true,
          cart_id: input.cart_id,
          payment_context: input.payment_context,
        })

        await subscriptionModule.updateSubscriptions({
          id: subscription.id,
          trial_ends_at: input.trialEndsAt,
        })

        return subscription
      }

      it("converts an auto trial with a usable method: charges exactly once with the anchor at trial_ends_at", async () => {
        const container = getContainer()
        const renewalModule =
          container.resolve<RenewalModuleService>(RENEWAL_MODULE)
        const subscriptionModule =
          container.resolve<SubscriptionModuleService>(SUBSCRIPTION_MODULE)
        const paymentModule = container.resolve<IPaymentModuleService>(
          Modules.PAYMENT
        )
        const dunningModule =
          container.resolve<DunningModuleService>(DUNNING_MODULE)
        const emitSpy = resolveEventBusSpy(container)

        // The trial ended five minutes ago; the trial-end cycle sits exactly
        // at the anchor (the same on-time boundary the Task 3 carve-out pins).
        const trialEndsAt = new Date(Date.now() - 5 * 60_000)
        const subscription = await seedChargeableCartTrial(container, {
          reference: `SUB-TC-CONVERT-${runId}`,
          trialEndsAt,
          payment_context: AUTO_TRIAL_PAYMENT_CONTEXT,
        })
        const cycle = await createRenewalCycleSeed(container, {
          subscription_id: subscription.id,
          status: RenewalCycleStatus.SCHEDULED,
          scheduled_for: trialEndsAt,
        })

        const { result } = await processRenewalCycleWorkflow(container).run({
          input: { renewal_cycle_id: cycle.id, trigger_type: "scheduler" },
        })

        expect(result.renewal_cycle.status).toEqual(RenewalCycleStatus.SUCCEEDED)
        expect(result.generated_order_id).toBeTruthy()

        // Exactly one charge: the single renewal order carries exactly one
        // payment collection holding exactly one captured payment.
        const orderId = result.generated_order_id as string
        const collectionIds = await queryLinkedPaymentCollectionIds(
          container,
          orderId
        )
        expect(collectionIds).toHaveLength(1)

        const collections = (await paymentModule.listPaymentCollections(
          { id: collectionIds },
          { relations: ["payments"] }
        )) as unknown as Array<{
          id: string
          amount: number
          payments: Array<{ id: string; captured_at: string | null }>
        }>
        expect(collections).toHaveLength(1)
        expect(collections[0].amount).toEqual(0.01)
        expect(collections[0].payments).toHaveLength(1)
        expect(collections[0].payments[0].captured_at).toBeTruthy()

        // And exactly one order behind the subscription.
        const linkedOrderIds = await queryLinkedSubscriptionOrderIds(
          container,
          subscription.id
        )
        expect(linkedOrderIds).toHaveLength(1)

        // The converted period anchors on the trial end (the cycle's own
        // scheduled_for), never on the processing time.
        const expectedNextRenewalAt = new Date(trialEndsAt)
        expectedNextRenewalAt.setUTCMonth(expectedNextRenewalAt.getUTCMonth() + 1)

        const updatedSubscription =
          await subscriptionModule.retrieveSubscription(subscription.id)
        expect(updatedSubscription.status).toEqual(SubscriptionStatus.ACTIVE)
        expect(updatedSubscription.last_renewal_at).toBeTruthy()
        expect(updatedSubscription.next_renewal_at!.toISOString()).toEqual(
          expectedNextRenewalAt.toISOString()
        )

        // The ensured next cycle sits on the same anchor.
        const cycles = await renewalModule.listRenewalCycles({
          subscription_id: subscription.id,
        } as any)
        const nextCycle = cycles.find((record) => record.id !== cycle.id)
        expect(nextCycle).toBeDefined()
        expect(nextCycle?.status).toEqual(RenewalCycleStatus.SCHEDULED)
        expect(new Date(nextCycle!.scheduled_for).toISOString()).toEqual(
          expectedNextRenewalAt.toISOString()
        )

        // A conversion is a renewal, not an expiry: no expiration event may
        // leak, and a paid period opens no dunning case.
        expect(busEventsWithName(emitSpy, "subscription.expired")).toHaveLength(
          0
        )
        const activityLogModule =
          container.resolve<ActivityLogModuleService>(ACTIVITY_LOG_MODULE)
        const expiredLogs = await activityLogModule.listSubscriptionLogs({
          subscription_id: subscription.id,
          event_type: ActivityLogEventType.SUBSCRIPTION_EXPIRED,
        } as any)
        expect(expiredLogs).toHaveLength(0)

        const dunningCases = await dunningModule.listDunningCases({
          subscription_id: subscription.id,
        } as any)
        expect(dunningCases).toHaveLength(0)
      })

      it("ends an auto trial without a usable payment method with an alertable reason", async () => {
        const container = getContainer()
        const renewalModule =
          container.resolve<RenewalModuleService>(RENEWAL_MODULE)
        const subscriptionModule =
          container.resolve<SubscriptionModuleService>(SUBSCRIPTION_MODULE)
        const dunningModule =
          container.resolve<DunningModuleService>(DUNNING_MODULE)
        const emitSpy = resolveEventBusSpy(container)

        const trialEndsAt = new Date(Date.now() - 5 * 60_000)
        const subscription = await seedEndingTrial(container, {
          reference: `SUB-TC-NOMETHOD-${runId}`,
          trialEndsAt,
          payment_context: AUTO_NO_METHOD_PAYMENT_CONTEXT,
        })
        const cycle = await createRenewalCycleSeed(container, {
          subscription_id: subscription.id,
          status: RenewalCycleStatus.SCHEDULED,
          scheduled_for: trialEndsAt,
        })

        const { result } = await processRenewalCycleWorkflow(container).run({
          input: { renewal_cycle_id: cycle.id, trigger_type: "scheduler" },
        })

        // Deterministic end: cycle succeeded with no order, attempt succeeded.
        expect(result.renewal_cycle.status).toEqual(RenewalCycleStatus.SUCCEEDED)
        expect(result.generated_order_id).toBeNull()

        const updatedCycle = await renewalModule.retrieveRenewalCycle(cycle.id)
        expect(updatedCycle.status).toEqual(RenewalCycleStatus.SUCCEEDED)
        expect(updatedCycle.generated_order_id).toBeNull()

        const attempts = await renewalModule.listRenewalAttempts({
          renewal_cycle_id: cycle.id,
        } as any)
        expect(attempts).toHaveLength(1)
        expect(attempts[0].status).toEqual(RenewalAttemptStatus.SUCCEEDED)
        expect(attempts[0].order_id).toBeNull()

        // Cancelled at the trial end anchor.
        const updatedSubscription =
          await subscriptionModule.retrieveSubscription(subscription.id)
        expect(updatedSubscription.status).toEqual(SubscriptionStatus.CANCELLED)
        expect(updatedSubscription.cancelled_at).toBeTruthy()
        expect(updatedSubscription.cancel_effective_at!.toISOString()).toEqual(
          trialEndsAt.toISOString()
        )
        expect(updatedSubscription.next_renewal_at!.toISOString()).toEqual(
          trialEndsAt.toISOString()
        )

        // No order was ever minted.
        const linkedOrderIds = await queryLinkedSubscriptionOrderIds(
          container,
          subscription.id
        )
        expect(linkedOrderIds).toHaveLength(0)

        // The expiration is persisted and emitted exactly once, carrying the
        // alertable reason code an operator can alert on.
        const expiredEvents = expectEmittedOnce(
          emitSpy,
          "subscription.expired"
        )
        expect(expiredEvents[0].data).toMatchObject({
          subscription_id: subscription.id,
          event_type: "subscription.expired",
        })

        const activityLogModule =
          container.resolve<ActivityLogModuleService>(ACTIVITY_LOG_MODULE)
        const expiredLogs = await activityLogModule.listSubscriptionLogs({
          subscription_id: subscription.id,
          event_type: ActivityLogEventType.SUBSCRIPTION_EXPIRED,
        } as any)
        expect(expiredLogs).toHaveLength(1)
        expect(expiredLogs[0].metadata).toMatchObject({
          reason_code: "trial_without_payment_method",
          renewal_cycle_id: cycle.id,
        })
        expect(expiredLogs[0].reason).toContain("payment method reference")

        // The end is clean on both sides: no renewal outcome events, and no
        // dunning case for a period that was never charged.
        expect(busEventsWithName(emitSpy, "renewal.succeeded")).toHaveLength(0)
        expect(busEventsWithName(emitSpy, "renewal.failed")).toHaveLength(0)
        const dunningCases = await dunningModule.listDunningCases({
          subscription_id: subscription.id,
        } as any)
        expect(dunningCases).toHaveLength(0)
      })

      it("ends a manual trial deterministically and emits subscription.expired exactly once", async () => {
        const container = getContainer()
        const renewalModule =
          container.resolve<RenewalModuleService>(RENEWAL_MODULE)
        const subscriptionModule =
          container.resolve<SubscriptionModuleService>(SUBSCRIPTION_MODULE)
        const dunningModule =
          container.resolve<DunningModuleService>(DUNNING_MODULE)
        const emitSpy = resolveEventBusSpy(container)

        const trialEndsAt = new Date(Date.now() - 5 * 60_000)
        const subscription = await seedEndingTrial(container, {
          reference: `SUB-TC-MANUAL-${runId}`,
          trialEndsAt,
          payment_context: MANUAL_PAYMENT_CONTEXT,
        })
        const cycle = await createRenewalCycleSeed(container, {
          subscription_id: subscription.id,
          status: RenewalCycleStatus.SCHEDULED,
          scheduled_for: trialEndsAt,
        })

        const { result } = await processRenewalCycleWorkflow(container).run({
          input: { renewal_cycle_id: cycle.id, trigger_type: "scheduler" },
        })

        expect(result.renewal_cycle.status).toEqual(RenewalCycleStatus.SUCCEEDED)
        expect(result.generated_order_id).toBeNull()

        const updatedSubscription =
          await subscriptionModule.retrieveSubscription(subscription.id)
        expect(updatedSubscription.status).toEqual(SubscriptionStatus.CANCELLED)
        expect(updatedSubscription.cancel_effective_at!.toISOString()).toEqual(
          trialEndsAt.toISOString()
        )

        const linkedOrderIds = await queryLinkedSubscriptionOrderIds(
          container,
          subscription.id
        )
        expect(linkedOrderIds).toHaveLength(0)

        const expiredEvents = expectEmittedOnce(
          emitSpy,
          "subscription.expired"
        )
        expect(expiredEvents[0].data).toMatchObject({
          subscription_id: subscription.id,
          event_type: "subscription.expired",
        })

        const activityLogModule =
          container.resolve<ActivityLogModuleService>(ACTIVITY_LOG_MODULE)
        const expiredLogs = await activityLogModule.listSubscriptionLogs({
          subscription_id: subscription.id,
          event_type: ActivityLogEventType.SUBSCRIPTION_EXPIRED,
        } as any)
        expect(expiredLogs).toHaveLength(1)
        expect(expiredLogs[0].metadata).toMatchObject({
          reason_code: "manual_mode_trial_ended",
          renewal_cycle_id: cycle.id,
        })
        expect(expiredLogs[0].reason).toContain("manual")

        expect(busEventsWithName(emitSpy, "renewal.succeeded")).toHaveLength(0)
        expect(busEventsWithName(emitSpy, "renewal.failed")).toHaveLength(0)
        const dunningCases = await dunningModule.listDunningCases({
          subscription_id: subscription.id,
        } as any)
        expect(dunningCases).toHaveLength(0)

        // Exactly once also means a settled cycle cannot be re-run: the
        // duplicate execution is refused before anything is written again.
        await expect(
          processRenewalCycleWorkflow(container).run({
            input: { renewal_cycle_id: cycle.id, trigger_type: "scheduler" },
          })
        ).rejects.toMatchObject({
          message: expect.stringContaining("Duplicate execution"),
        })
        expect(busEventsWithName(emitSpy, "subscription.expired")).toHaveLength(
          1
        )
        const expiredLogsAfterReplay =
          await activityLogModule.listSubscriptionLogs({
            subscription_id: subscription.id,
            event_type: ActivityLogEventType.SUBSCRIPTION_EXPIRED,
          } as any)
        expect(expiredLogsAfterReplay).toHaveLength(1)
      })

      it("refuses an auto trial with a method but no cart before anything is created or charged (T6)", async () => {
        const container = getContainer()
        const renewalModule =
          container.resolve<RenewalModuleService>(RENEWAL_MODULE)
        const subscriptionModule =
          container.resolve<SubscriptionModuleService>(SUBSCRIPTION_MODULE)
        const dunningModule =
          container.resolve<DunningModuleService>(DUNNING_MODULE)
        const emitSpy = resolveEventBusSpy(container)

        const trialEndsAt = new Date(Date.now() - 5 * 60_000)
        const subscription = await seedEndingTrial(container, {
          reference: `SUB-TC-NOCART-${runId}`,
          trialEndsAt,
          payment_context: AUTO_TRIAL_PAYMENT_CONTEXT,
          cart_id: null,
        })
        const cycle = await createRenewalCycleSeed(container, {
          subscription_id: subscription.id,
          status: RenewalCycleStatus.SCHEDULED,
          scheduled_for: trialEndsAt,
        })

        // The cart is a hard prerequisite of the conversion path: the run
        // throws before minting an order or charging.
        await expect(
          processRenewalCycleWorkflow(container).run({
            input: { renewal_cycle_id: cycle.id, trigger_type: "scheduler" },
          })
        ).rejects.toMatchObject({
          message: expect.stringContaining("cart_id"),
        })

        const updatedCycle = await renewalModule.retrieveRenewalCycle(cycle.id)
        expect(updatedCycle.generated_order_id).toBeNull()

        const linkedOrderIds = await queryLinkedSubscriptionOrderIds(
          container,
          subscription.id
        )
        expect(linkedOrderIds).toHaveLength(0)

        // The subscription is not ended by the failed conversion: the trial
        // stays active until the row is repaired (the template cart Task 21
        // builds supplies it) or the structural cap abandons the cycle.
        const updatedSubscription =
          await subscriptionModule.retrieveSubscription(subscription.id)
        expect(updatedSubscription.status).toEqual(SubscriptionStatus.ACTIVE)

        // A structural refusal is not a payment failure: no dunning case.
        const dunningCases = await dunningModule.listDunningCases({
          subscription_id: subscription.id,
        } as any)
        expect(dunningCases).toHaveLength(0)
        expect(busEventsWithName(emitSpy, "subscription.expired")).toHaveLength(
          0
        )
      })

      it("hands a payment-qualified conversion failure to dunning", async () => {
        const container = getContainer()
        const dunningModule =
          container.resolve<DunningModuleService>(DUNNING_MODULE)
        const renewalModule =
          container.resolve<RenewalModuleService>(RENEWAL_MODULE)
        const paymentModule = container.resolve<IPaymentModuleService>(
          Modules.PAYMENT
        )

        const trialEndsAt = new Date(Date.now() - 5 * 60_000)
        const subscription = await seedChargeableCartTrial(container, {
          reference: `SUB-TC-DUNNING-${runId}`,
          trialEndsAt,
          payment_context: AUTO_TRIAL_PAYMENT_CONTEXT,
        })
        const cycle = await createRenewalCycleSeed(container, {
          subscription_id: subscription.id,
          status: RenewalCycleStatus.SCHEDULED,
          scheduled_for: trialEndsAt,
        })

        jest
          .spyOn(paymentModule, "authorizePaymentSession")
          .mockRejectedValue(new Error("Card declined during trial conversion"))

        await expect(
          processRenewalCycleWorkflow(container).run({
            input: { renewal_cycle_id: cycle.id, trigger_type: "scheduler" },
          })
        ).rejects.toMatchObject({
          message: expect.stringContaining("declined"),
        })

        // The conversion reuses the normal charge path, so its payment
        // failure hands the period to dunning for the customer to repair.
        const dunningCases = await dunningModule.listDunningCases({
          subscription_id: subscription.id,
        } as any)
        expect(dunningCases).toHaveLength(1)
        expect(dunningCases[0]).toMatchObject({
          renewal_cycle_id: cycle.id,
          metadata: {
            payment_failure_source: "payment_provider",
          },
          last_payment_error_message: expect.stringContaining("declined"),
        })

        const updatedCycle = await renewalModule.retrieveRenewalCycle(cycle.id)
        expect(updatedCycle.status).toEqual(RenewalCycleStatus.FAILED)
        expect(updatedCycle.generated_order_id).toBeTruthy()
      })

      it("never charges a NATIVE- subscription: the scheduler excludes it and the path mints nothing", async () => {
        const container = getContainer()
        const renewalModule =
          container.resolve<RenewalModuleService>(RENEWAL_MODULE)
        const emitSpy = resolveEventBusSpy(container)

        // The realistic mirror shape (native-mirror-sync): NATIVE- reference,
        // manual mode, no stored method, no cart, is_trial false — PayPal
        // bills the recurrence itself, trials included.
        const subscription = await createSubscriptionSeed(container, {
          reference: `NATIVE-${runId}`,
          status: SubscriptionStatus.ACTIVE,
          cart_id: null,
          payment_context: MANUAL_PAYMENT_CONTEXT,
        })
        const cycle = await createRenewalCycleSeed(container, {
          subscription_id: subscription.id,
          status: RenewalCycleStatus.SCHEDULED,
          scheduled_for: new Date(Date.now() - 5 * 60_000),
        })

        // The scheduler must never pick the row up: if a future change gave
        // native rows the manual-trial carve-out treatment, this is where the
        // double charge would start.
        const { cycles: dueCycles } =
          await listDueRenewalCyclesForProcessing(container, {
            limit: 200,
            offset: 0,
          })
        expect(dueCycles.map((record) => record.id)).not.toContain(cycle.id)

        // Defense in depth: even driven directly at the processing step, no
        // order is minted and nothing is charged.
        await expect(
          processRenewalCycleWorkflow(container).run({
            input: { renewal_cycle_id: cycle.id, trigger_type: "scheduler" },
          })
        ).rejects.toBeTruthy()

        const updatedCycle = await renewalModule.retrieveRenewalCycle(cycle.id)
        expect(updatedCycle.generated_order_id).toBeNull()

        const linkedOrderIds = await queryLinkedSubscriptionOrderIds(
          container,
          subscription.id
        )
        expect(linkedOrderIds).toHaveLength(0)

        // No renewal outcome that could mirror an extension into the SaaS
        // entitlement store.
        expect(busEventsWithName(emitSpy, "renewal.succeeded")).toHaveLength(0)
        expect(busEventsWithName(emitSpy, "subscription.expired")).toHaveLength(
          0
        )
      })
    })
  },
})

jest.setTimeout(120 * 1000)
