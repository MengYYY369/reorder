import { medusaIntegrationTestRunner } from "@medusajs/test-utils"
import path from "path"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import type {
  ICartModuleService,
  IPaymentModuleService,
  IRegionModuleService,
  ISalesChannelModuleService,
  MedusaContainer,
} from "@medusajs/framework/types"
import {
  getAdminRenewalDetail,
  listAdminRenewals,
} from "../../src/modules/renewal/utils/admin-query"
import {
  approveRenewalChangesWorkflow,
  cancelSubscriptionWorkflow,
  ensureNextRenewalCycleWorkflow,
  forceRenewalCycleWorkflow,
  pauseSubscriptionWorkflow,
  processRenewalCycleWorkflow,
  rejectRenewalChangesWorkflow,
  resumeSubscriptionWorkflow,
  scheduleSubscriptionPlanChangeWorkflow,
} from "../../src/workflows"
import { createPlanOfferSeed } from "../helpers/plan-offer-fixtures"
import {
  RenewalApprovalStatus,
  RenewalAttemptStatus,
  RenewalCycleStatus,
} from "../../src/modules/renewal/types"
import { ACTIVITY_LOG_MODULE } from "../../src/modules/activity-log"
import type ActivityLogModuleService from "../../src/modules/activity-log/service"
import {
  ActivityLogActorType,
  ActivityLogEventType,
} from "../../src/modules/activity-log/types"
import { DUNNING_MODULE } from "../../src/modules/dunning"
import type DunningModuleService from "../../src/modules/dunning/service"
import { RENEWAL_MODULE } from "../../src/modules/renewal"
import type RenewalModuleService from "../../src/modules/renewal/service"
import { SUBSCRIPTION_MODULE } from "../../src/modules/subscription"
import type SubscriptionModuleService from "../../src/modules/subscription/service"
import {
  createRenewalAttemptSeed,
  createRenewalCycleSeed,
  createProductWithVariant,
  createSubscriptionSeed,
} from "../helpers/renewal-fixtures"
import { createCustomer } from "../helpers/plan-offer-fixtures"
import { SubscriptionFrequencyInterval, SubscriptionStatus } from "../../src/modules/subscription/types"
import { PlanOfferFrequencyInterval, PlanOfferScope } from "../../src/modules/plan-offer/types"

async function queryLinkedPaymentCollectionIds(
  container: MedusaContainer,
  orderId: string
): Promise<{ data: Array<{ payment_collection_id: string }> }> {
  const query = container.resolve(ContainerRegistrationKeys.QUERY)

  return (await query.graph({
    entity: "order_payment_collection",
    fields: ["payment_collection_id"],
    filters: { order_id: orderId },
  })) as { data: Array<{ payment_collection_id: string }> }
}

medusaIntegrationTestRunner({
  medusaConfigFile: path.resolve(process.cwd(), "integration-tests"),
  env: {
    JWT_SECRET: "supersecret",
    COOKIE_SECRET: "supersecret",
  },
  testSuite: ({ getContainer }) => {
    describe("renewals query and workflows", () => {
      beforeEach(() => {
        jest.restoreAllMocks()
      })

      const AUTO_PAYMENT_CONTEXT = {
        payment_provider_id: "pp_system_default",
        payment_mode: "auto",
        source_payment_collection_id: null,
        source_payment_session_id: null,
        payment_method_reference: "pm_test_auto",
        customer_payment_reference: null,
      }

      // Seeds a paid auto-renewal subscription backed by a real cart whose
      // order total lands exactly on the currency epsilon (0.01 USD). That is
      // the boundary where Medusa 2.20's read-time total decoration zeroes
      // pending_difference and the core create-or-update payment collection
      // workflow used to abort the charge.
      async function seedEpsilonAutoSubscription(
        container: MedusaContainer,
        reference: string
      ) {
        const customer = await createCustomer(container, {
          email: `${reference.toLowerCase()}-${Date.now()}@medusa.test`,
        })

        // A published product: renewal order line items validate their
        // variant_id against the product module.
        const productModule = container.resolve<any>(Modules.PRODUCT)
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
        const pricingModule = container.resolve<any>(Modules.PRICING)
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

        return await createSubscriptionSeed(container, {
          reference,
          status: SubscriptionStatus.ACTIVE,
          customer_id: customer.id,
          cart_id: cart.id,
          product_id: product.id,
          variant_id: variant.id,
          next_renewal_at: new Date(),
          payment_context: AUTO_PAYMENT_CONTEXT as never,
        })
      }

      it("charges a 0.01 renewal order end-to-end at the currency epsilon boundary", async () => {
        const container = getContainer()
        const renewalModule =
          container.resolve<RenewalModuleService>(RENEWAL_MODULE)
        const paymentModule =
          container.resolve<IPaymentModuleService>(Modules.PAYMENT)

        const subscription = await seedEpsilonAutoSubscription(
          container,
          "SUB-REN-EPSILON-001"
        )
        const cycle = await createRenewalCycleSeed(container, {
          subscription_id: subscription.id,
          status: RenewalCycleStatus.SCHEDULED,
        })

        const { result } = await processRenewalCycleWorkflow(container).run({
          input: {
            renewal_cycle_id: cycle.id,
            trigger_type: "scheduler",
          },
        })

        expect(result.renewal_cycle.status).toEqual(RenewalCycleStatus.SUCCEEDED)
        expect(result.generated_order_id).toBeTruthy()

        const updatedCycle = await renewalModule.retrieveRenewalCycle(cycle.id)
        expect(updatedCycle.generated_order_id).toEqual(result.generated_order_id)

        const orderId = result.generated_order_id as string

        const { data: links } = await queryLinkedPaymentCollectionIds(
          container,
          orderId
        )
        expect(links).toHaveLength(1)

        const collections = (await paymentModule.listPaymentCollections(
          { id: links.map((link) => link.payment_collection_id) },
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
      })

      it("opens a dunning case with source payment_session when collection resolution fails", async () => {
        const container = getContainer()
        const dunningModule =
          container.resolve<DunningModuleService>(DUNNING_MODULE)
        const renewalModule =
          container.resolve<RenewalModuleService>(RENEWAL_MODULE)
        const paymentModule =
          container.resolve<IPaymentModuleService>(Modules.PAYMENT)

        const subscription = await seedEpsilonAutoSubscription(
          container,
          "SUB-REN-EPSILON-002"
        )
        const cycle = await createRenewalCycleSeed(container, {
          subscription_id: subscription.id,
          status: RenewalCycleStatus.SCHEDULED,
        })

        jest
          .spyOn(paymentModule, "createPaymentCollections")
          .mockRejectedValue(new Error("Payment collection backend unavailable"))

        await expect(
          processRenewalCycleWorkflow(container).run({
            input: {
              renewal_cycle_id: cycle.id,
              trigger_type: "scheduler",
            },
          })
        ).rejects.toMatchObject({
          message: expect.stringContaining("Payment collection backend"),
        })

        const updatedCycle = await renewalModule.retrieveRenewalCycle(cycle.id)
        expect(updatedCycle.status).toEqual(RenewalCycleStatus.FAILED)
        expect(updatedCycle.generated_order_id).toBeTruthy()

        const dunningCases = await dunningModule.listDunningCases({
          subscription_id: subscription.id,
        } as any)
        expect(dunningCases).toHaveLength(1)
        expect(dunningCases[0]).toMatchObject({
          renewal_cycle_id: cycle.id,
          renewal_order_id: updatedCycle.generated_order_id,
          metadata: {
            payment_failure_source: "payment_session",
          },
          last_payment_error_message: expect.stringContaining(
            "Payment collection backend"
          ),
        })
      })

      it("opens a dunning case when the renewal charge authorization fails", async () => {
        const container = getContainer()
        const dunningModule =
          container.resolve<DunningModuleService>(DUNNING_MODULE)
        const renewalModule =
          container.resolve<RenewalModuleService>(RENEWAL_MODULE)
        const paymentModule =
          container.resolve<IPaymentModuleService>(Modules.PAYMENT)

        const subscription = await seedEpsilonAutoSubscription(
          container,
          "SUB-REN-EPSILON-003"
        )
        const cycle = await createRenewalCycleSeed(container, {
          subscription_id: subscription.id,
          status: RenewalCycleStatus.SCHEDULED,
        })

        jest
          .spyOn(paymentModule, "authorizePaymentSession")
          .mockRejectedValue(new Error("Card declined during renewal"))

        await expect(
          processRenewalCycleWorkflow(container).run({
            input: {
              renewal_cycle_id: cycle.id,
              trigger_type: "scheduler",
            },
          })
        ).rejects.toMatchObject({
          message: expect.stringContaining("declined"),
        })

        const updatedCycle = await renewalModule.retrieveRenewalCycle(cycle.id)
        expect(updatedCycle.status).toEqual(RenewalCycleStatus.FAILED)
        expect(updatedCycle.generated_order_id).toBeTruthy()

        const dunningCases = await dunningModule.listDunningCases({
          subscription_id: subscription.id,
        } as any)
        expect(dunningCases).toHaveLength(1)
        expect(dunningCases[0]).toMatchObject({
          renewal_cycle_id: cycle.id,
          renewal_order_id: updatedCycle.generated_order_id,
          metadata: {
            payment_failure_source: "payment_provider",
          },
          last_payment_error_message: expect.stringContaining("declined"),
        })
      })

      it("lists renewals with filters and latest attempt status", async () => {
        const container = getContainer()
        const activeSubscription = await createSubscriptionSeed(container, {
          reference: "SUB-REN-QUERY-001",
        })
        const pausedSubscription = await createSubscriptionSeed(container, {
          reference: "SUB-REN-QUERY-002",
        })

        const firstCycle = await createRenewalCycleSeed(container, {
          subscription_id: activeSubscription.id,
          status: RenewalCycleStatus.FAILED,
          approval_required: true,
          approval_status: RenewalApprovalStatus.PENDING,
        })
        const secondCycle = await createRenewalCycleSeed(container, {
          subscription_id: pausedSubscription.id,
          status: RenewalCycleStatus.SCHEDULED,
        })

        await createRenewalAttemptSeed(container, {
          renewal_cycle_id: firstCycle.id,
          attempt_no: 1,
          status: RenewalAttemptStatus.FAILED,
          finished_at: new Date(),
          error_code: "renewal_failed",
          error_message: "payment failed",
        })
        await createRenewalAttemptSeed(container, {
          renewal_cycle_id: secondCycle.id,
          attempt_no: 1,
          status: RenewalAttemptStatus.PROCESSING,
        })

        const response = await listAdminRenewals(container, {
          limit: 10,
          offset: 0,
          status: [RenewalCycleStatus.FAILED],
          approval_status: [RenewalApprovalStatus.PENDING],
          last_attempt_status: [RenewalAttemptStatus.FAILED],
        })

        expect(response.count).toEqual(1)
        expect(response.renewals).toHaveLength(1)
        expect(response.renewals[0]).toMatchObject({
          id: firstCycle.id,
          status: RenewalCycleStatus.FAILED,
          last_attempt_status: RenewalAttemptStatus.FAILED,
          approval: expect.objectContaining({
            required: true,
            status: RenewalApprovalStatus.PENDING,
          }),
          subscription: expect.objectContaining({
            reference: "SUB-REN-QUERY-001",
          }),
        })
      })

      it("returns renewal detail with attempts and pending changes", async () => {
        const container = getContainer()
        const subscription = await createSubscriptionSeed(container, {
          reference: "SUB-REN-DETAIL-001",
        })

        const cycle = await createRenewalCycleSeed(container, {
          subscription_id: subscription.id,
          status: RenewalCycleStatus.FAILED,
          approval_required: true,
          approval_status: RenewalApprovalStatus.PENDING,
          applied_pending_update_data: {
            variant_id: subscription.variant_id,
            variant_title: "Pending Variant",
            frequency_interval: "month",
            frequency_value: 2,
            effective_at: new Date("2026-03-31T10:00:00.000Z").toISOString(),
          },
          metadata: {
            source: "detail-test",
          },
        })

        await createRenewalAttemptSeed(container, {
          renewal_cycle_id: cycle.id,
          attempt_no: 1,
          status: RenewalAttemptStatus.FAILED,
          finished_at: new Date(),
          error_code: "renewal_failed",
          error_message: "failure message",
        })

        const response = await getAdminRenewalDetail(container, cycle.id)

        expect(response.renewal).toMatchObject({
          id: cycle.id,
          status: RenewalCycleStatus.FAILED,
          subscription: expect.objectContaining({
            reference: "SUB-REN-DETAIL-001",
          }),
          pending_changes: expect.objectContaining({
            variant_title: "Pending Variant",
            frequency_value: 2,
          }),
          metadata: {
            source: "detail-test",
          },
        })
        expect(response.renewal.attempts).toHaveLength(1)
        expect(response.renewal.attempts[0]).toMatchObject({
          attempt_no: 1,
          status: RenewalAttemptStatus.FAILED,
          error_message: "failure message",
        })
      })

      it("processes a renewal successfully when skip_next_cycle is enabled", async () => {
        const container = getContainer()
        const activityLogModule =
          container.resolve<ActivityLogModuleService>(ACTIVITY_LOG_MODULE)
        const subscriptionModule =
          container.resolve<SubscriptionModuleService>(SUBSCRIPTION_MODULE)
        const renewalModule =
          container.resolve<RenewalModuleService>(RENEWAL_MODULE)

        const subscription = await createSubscriptionSeed(container, {
          reference: "SUB-REN-WF-001",
          skip_next_cycle: true,
        })
        const cycle = await createRenewalCycleSeed(container, {
          subscription_id: subscription.id,
          scheduled_for: new Date("2026-03-30T12:00:00.000Z"),
          status: RenewalCycleStatus.SCHEDULED,
        })

        const { result } = await processRenewalCycleWorkflow(container).run({
          input: {
            renewal_cycle_id: cycle.id,
            trigger_type: "scheduler",
          },
        })

        const updatedCycle = await renewalModule.retrieveRenewalCycle(cycle.id)
        const updatedSubscription = await subscriptionModule.retrieveSubscription(
          subscription.id
        )
        const attempts = await renewalModule.listRenewalAttempts({
          renewal_cycle_id: cycle.id,
        } as any)

        expect(result.renewal_cycle.status).toEqual(RenewalCycleStatus.SUCCEEDED)
        expect(updatedCycle.status).toEqual(RenewalCycleStatus.SUCCEEDED)
        expect(updatedCycle.generated_order_id).toBeNull()
        expect(updatedSubscription.skip_next_cycle).toBe(false)
        expect(updatedSubscription.last_renewal_at).toBeTruthy()
        expect(attempts).toHaveLength(1)
        expect(attempts[0].status).toEqual(RenewalAttemptStatus.SUCCEEDED)

        const upcomingCycles = await renewalModule.listRenewalCycles({
          subscription_id: subscription.id,
        } as any)

        expect(upcomingCycles).toHaveLength(2)

        const nextCycle = upcomingCycles.find((record) => record.id !== cycle.id)

        expect(nextCycle).toBeDefined()
        expect(nextCycle?.status).toEqual(RenewalCycleStatus.SCHEDULED)
        expect(new Date(nextCycle!.scheduled_for).toISOString()).toEqual(
          updatedSubscription.next_renewal_at!.toISOString()
        )

        const activityLogs = await activityLogModule.listSubscriptionLogs({
          subscription_id: subscription.id,
          event_type: ActivityLogEventType.RENEWAL_SUCCEEDED,
        } as any)

        expect(activityLogs).toHaveLength(1)
        expect(activityLogs[0]).toMatchObject({
          subscription_id: subscription.id,
          event_type: ActivityLogEventType.RENEWAL_SUCCEEDED,
          actor_type: ActivityLogActorType.SCHEDULER,
        })
      })

      it("ensures a single upcoming renewal cycle idempotently", async () => {
        const container = getContainer()
        const renewalModule =
          container.resolve<RenewalModuleService>(RENEWAL_MODULE)

        const subscription = await createSubscriptionSeed(container, {
          reference: "SUB-REN-ENSURE-001",
          next_renewal_at: new Date("2026-04-10T10:00:00.000Z"),
        })

        await ensureNextRenewalCycleWorkflow(container).run({
          input: {
            subscription_id: subscription.id,
          },
        })

        await ensureNextRenewalCycleWorkflow(container).run({
          input: {
            subscription_id: subscription.id,
          },
        })

        const cycles = await renewalModule.listRenewalCycles({
          subscription_id: subscription.id,
        } as any)

        expect(cycles).toHaveLength(1)
        expect(cycles[0]).toMatchObject({
          subscription_id: subscription.id,
          status: RenewalCycleStatus.SCHEDULED,
          approval_required: false,
          approval_status: null,
        })
        expect(new Date(cycles[0].scheduled_for).toISOString()).toEqual(
          "2026-04-10T10:00:00.000Z"
        )
      })

      it("updates the upcoming cycle approval state after scheduling a plan change", async () => {
        const container = getContainer()
        const renewalModule =
          container.resolve<RenewalModuleService>(RENEWAL_MODULE)
        const { product, variant } = await createProductWithVariant(container)

        await createPlanOfferSeed(container, {
          name: "Plan Change Offer",
          scope: PlanOfferScope.VARIANT,
          product_id: product.id,
          variant_id: variant.id,
          allowed_frequencies: [
            {
              interval: PlanOfferFrequencyInterval.MONTH,
              value: 1,
            },
            {
              interval: PlanOfferFrequencyInterval.MONTH,
              value: 2,
            },
          ],
        })

        const subscription = await createSubscriptionSeed(container, {
          reference: "SUB-REN-ENSURE-PLAN-001",
          product_id: product.id,
          variant_id: variant.id,
          next_renewal_at: new Date("2026-04-12T10:00:00.000Z"),
        })

        await ensureNextRenewalCycleWorkflow(container).run({
          input: {
            subscription_id: subscription.id,
          },
        })

        await scheduleSubscriptionPlanChangeWorkflow(container).run({
          input: {
            id: subscription.id,
            variant_id: variant.id,
            frequency_interval: SubscriptionFrequencyInterval.MONTH,
            frequency_value: 2,
            effective_at: "2026-04-01T10:00:00.000Z",
            requested_by: "user_test",
          },
        })

        const cycles = await renewalModule.listRenewalCycles({
          subscription_id: subscription.id,
        } as any)

        expect(cycles).toHaveLength(1)
        expect(cycles[0]).toMatchObject({
          approval_required: true,
          approval_status: RenewalApprovalStatus.PENDING,
          approval_decided_at: null,
          approval_decided_by: null,
          approval_reason: null,
        })
      })

      it("recreates an upcoming cycle after resume when none exists", async () => {
        const container = getContainer()
        const renewalModule =
          container.resolve<RenewalModuleService>(RENEWAL_MODULE)

        const subscription = await createSubscriptionSeed(container, {
          reference: "SUB-REN-RESUME-001",
          status: "paused" as any,
          next_renewal_at: new Date("2026-04-20T10:00:00.000Z"),
        })

        await resumeSubscriptionWorkflow(container).run({
          input: {
            id: subscription.id,
            preserve_billing_anchor: true,
          },
        })

        const cycles = await renewalModule.listRenewalCycles({
          subscription_id: subscription.id,
        } as any)

        expect(cycles).toHaveLength(1)
        expect(cycles[0].status).toEqual(RenewalCycleStatus.SCHEDULED)
        expect(new Date(cycles[0].scheduled_for).toISOString()).toEqual(
          "2026-04-20T10:00:00.000Z"
        )
      })

      it("removes only scheduled upcoming cycles after pause", async () => {
        const container = getContainer()
        const renewalModule =
          container.resolve<RenewalModuleService>(RENEWAL_MODULE)

        const subscription = await createSubscriptionSeed(container, {
          reference: "SUB-REN-PAUSE-001",
          next_renewal_at: new Date("2026-04-21T10:00:00.000Z"),
        })

        const scheduledCycle = await createRenewalCycleSeed(container, {
          subscription_id: subscription.id,
          scheduled_for: new Date("2026-04-21T10:00:00.000Z"),
          status: RenewalCycleStatus.SCHEDULED,
        })

        await createRenewalCycleSeed(container, {
          subscription_id: subscription.id,
          scheduled_for: new Date("2026-03-21T10:00:00.000Z"),
          status: RenewalCycleStatus.FAILED,
        })

        await pauseSubscriptionWorkflow(container).run({
          input: {
            id: subscription.id,
            reason: "pause reconcile test",
          },
        })

        const cycles = await renewalModule.listRenewalCycles({
          subscription_id: subscription.id,
        } as any)

        expect(cycles.some((cycle) => cycle.id === scheduledCycle.id)).toBe(false)
        expect(cycles).toHaveLength(1)
        expect(cycles[0].status).toEqual(RenewalCycleStatus.FAILED)
      })

      it("removes only scheduled upcoming cycles after cancel", async () => {
        const container = getContainer()
        const renewalModule =
          container.resolve<RenewalModuleService>(RENEWAL_MODULE)

        const subscription = await createSubscriptionSeed(container, {
          reference: "SUB-REN-CANCEL-001",
          next_renewal_at: new Date("2026-04-22T10:00:00.000Z"),
        })

        const scheduledCycle = await createRenewalCycleSeed(container, {
          subscription_id: subscription.id,
          scheduled_for: new Date("2026-04-22T10:00:00.000Z"),
          status: RenewalCycleStatus.SCHEDULED,
        })

        await createRenewalCycleSeed(container, {
          subscription_id: subscription.id,
          scheduled_for: new Date("2026-03-22T10:00:00.000Z"),
          status: RenewalCycleStatus.PROCESSING,
          attempt_count: 1,
        })

        await cancelSubscriptionWorkflow(container).run({
          input: {
            id: subscription.id,
            reason: "cancel reconcile test",
            effective_at: "immediately",
          },
        })

        const cycles = await renewalModule.listRenewalCycles({
          subscription_id: subscription.id,
        } as any)

        expect(cycles.some((cycle) => cycle.id === scheduledCycle.id)).toBe(false)
        expect(cycles).toHaveLength(1)
        expect(cycles[0].status).toEqual(RenewalCycleStatus.PROCESSING)
      })

      it("marks a renewal as failed when order creation prerequisites are missing", async () => {
        const container = getContainer()
        const activityLogModule =
          container.resolve<ActivityLogModuleService>(ACTIVITY_LOG_MODULE)
        const renewalModule =
          container.resolve<RenewalModuleService>(RENEWAL_MODULE)

        const subscription = await createSubscriptionSeed(container, {
          reference: "SUB-REN-WF-FAIL-001",
          cart_id: null,
          skip_next_cycle: false,
        })
        const cycle = await createRenewalCycleSeed(container, {
          subscription_id: subscription.id,
          status: RenewalCycleStatus.SCHEDULED,
        })

        await expect(
          processRenewalCycleWorkflow(container).run({
            input: {
              renewal_cycle_id: cycle.id,
              trigger_type: "scheduler",
            },
          })
        ).rejects.toMatchObject({
          message: expect.stringContaining("cart_id"),
        })

        const updatedCycle = await renewalModule.retrieveRenewalCycle(cycle.id)
        const attempts = await renewalModule.listRenewalAttempts({
          renewal_cycle_id: cycle.id,
        } as any)

        expect(updatedCycle.status).toEqual(RenewalCycleStatus.FAILED)
        expect(updatedCycle.last_error).toContain("cart_id")
        expect(attempts).toHaveLength(1)
        expect(attempts[0].status).toEqual(RenewalAttemptStatus.FAILED)
        expect(attempts[0].error_message).toContain("cart_id")

        const activityLogs = await activityLogModule.listSubscriptionLogs({
          subscription_id: subscription.id,
          event_type: ActivityLogEventType.RENEWAL_FAILED,
        } as any)

        expect(activityLogs).toHaveLength(1)
        expect(activityLogs[0]).toMatchObject({
          subscription_id: subscription.id,
          event_type: ActivityLogEventType.RENEWAL_FAILED,
          actor_type: ActivityLogActorType.SCHEDULER,
        })
      })

      it("supports retry after a failed renewal once the subscription becomes eligible", async () => {
        const container = getContainer()
        const activityLogModule =
          container.resolve<ActivityLogModuleService>(ACTIVITY_LOG_MODULE)
        const subscriptionModule =
          container.resolve<SubscriptionModuleService>(SUBSCRIPTION_MODULE)
        const renewalModule =
          container.resolve<RenewalModuleService>(RENEWAL_MODULE)

        const subscription = await createSubscriptionSeed(container, {
          reference: "SUB-REN-RETRY-001",
          cart_id: null,
          skip_next_cycle: false,
        })
        const cycle = await createRenewalCycleSeed(container, {
          subscription_id: subscription.id,
          status: RenewalCycleStatus.SCHEDULED,
        })

        await expect(
          processRenewalCycleWorkflow(container).run({
            input: {
              renewal_cycle_id: cycle.id,
              trigger_type: "scheduler",
            },
          })
        ).rejects.toBeTruthy()

        await subscriptionModule.updateSubscriptions({
          id: subscription.id,
          skip_next_cycle: true,
        } as any)

        const { result } = await forceRenewalCycleWorkflow(container).run({
          input: {
            renewal_cycle_id: cycle.id,
            triggered_by: "admin_retry",
            reason: "retry after fixing subscription",
          },
        })

        const updatedCycle = await renewalModule.retrieveRenewalCycle(cycle.id)
        const attempts = await renewalModule.listRenewalAttempts({
          renewal_cycle_id: cycle.id,
        } as any)

        expect(result).toEqual(cycle.id)
        expect(updatedCycle.status).toEqual(RenewalCycleStatus.SUCCEEDED)
        expect(updatedCycle.attempt_count).toEqual(2)
        expect(attempts).toHaveLength(2)
        expect(attempts[0].status).toEqual(RenewalAttemptStatus.FAILED)
        expect(attempts[1].status).toEqual(RenewalAttemptStatus.SUCCEEDED)

        const forceLogs = await activityLogModule.listSubscriptionLogs({
          subscription_id: subscription.id,
          event_type: ActivityLogEventType.RENEWAL_FORCE_REQUESTED,
        } as any)

        expect(forceLogs).toHaveLength(1)
        expect(forceLogs[0]).toMatchObject({
          subscription_id: subscription.id,
          event_type: ActivityLogEventType.RENEWAL_FORCE_REQUESTED,
          actor_type: ActivityLogActorType.USER,
          actor_id: "admin_retry",
        })
      })

      it("blocks duplicate execution after a successful renewal", async () => {
        const container = getContainer()

        const subscription = await createSubscriptionSeed(container, {
          reference: "SUB-REN-IDEMP-001",
          skip_next_cycle: true,
        })
        const cycle = await createRenewalCycleSeed(container, {
          subscription_id: subscription.id,
        })

        await processRenewalCycleWorkflow(container).run({
          input: {
            renewal_cycle_id: cycle.id,
            trigger_type: "scheduler",
          },
        })

        await expect(
          processRenewalCycleWorkflow(container).run({
            input: {
              renewal_cycle_id: cycle.id,
              trigger_type: "scheduler",
            },
          })
        ).rejects.toMatchObject({
          message: expect.stringContaining("Duplicate execution"),
        })
      })

      it("blocks processing and force-run while renewal is already processing", async () => {
        const container = getContainer()
        const activityLogModule =
          container.resolve<ActivityLogModuleService>(ACTIVITY_LOG_MODULE)
        const subscription = await createSubscriptionSeed(container, {
          reference: "SUB-REN-LOCK-001",
          skip_next_cycle: true,
        })
        const cycle = await createRenewalCycleSeed(container, {
          subscription_id: subscription.id,
          status: RenewalCycleStatus.PROCESSING,
          attempt_count: 1,
        })

        await expect(
          processRenewalCycleWorkflow(container).run({
            input: {
              renewal_cycle_id: cycle.id,
              trigger_type: "scheduler",
            },
          })
        ).rejects.toMatchObject({
          message: expect.stringContaining("already processing"),
        })

        await expect(
          forceRenewalCycleWorkflow(container).run({
            input: {
              renewal_cycle_id: cycle.id,
            },
          })
        ).rejects.toMatchObject({
          message: expect.stringContaining("already processing"),
        })

        const forceLogs = await activityLogModule.listSubscriptionLogs({
          subscription_id: subscription.id,
          event_type: ActivityLogEventType.RENEWAL_FORCE_REQUESTED,
        } as any)

        expect(forceLogs).toHaveLength(0)
      })

      it("handles approval required, approved, and rejected transitions", async () => {
        const container = getContainer()
        const activityLogModule =
          container.resolve<ActivityLogModuleService>(ACTIVITY_LOG_MODULE)
        const renewalModule =
          container.resolve<RenewalModuleService>(RENEWAL_MODULE)
        const subscriptionModule =
          container.resolve<SubscriptionModuleService>(SUBSCRIPTION_MODULE)

        const approvedSubscription = await createSubscriptionSeed(container, {
          reference: "SUB-REN-APPROVAL-001",
          skip_next_cycle: true,
        })
        await createPlanOfferSeed(container, {
          name: "PLAN-REN-APPROVAL-001",
          scope: "variant" as any,
          product_id: approvedSubscription.product_id,
          variant_id: approvedSubscription.variant_id,
          is_enabled: true,
          allowed_frequencies: [
            {
              interval: "month" as any,
              value: 2,
            },
          ],
        })
        await subscriptionModule.updateSubscriptions({
          id: approvedSubscription.id,
          pending_update_data: {
            variant_id: approvedSubscription.variant_id,
            variant_title: "Approved Variant",
            sku: "APPROVED-SKU",
            frequency_interval: "month",
            frequency_value: 2,
            effective_at: null,
          },
        } as any)

        const approvedCycle = await createRenewalCycleSeed(container, {
          subscription_id: approvedSubscription.id,
          approval_required: true,
          approval_status: RenewalApprovalStatus.PENDING,
        })

        await expect(
          processRenewalCycleWorkflow(container).run({
            input: {
              renewal_cycle_id: approvedCycle.id,
              trigger_type: "scheduler",
            },
          })
        ).rejects.toMatchObject({
          message: expect.stringContaining("requires approval"),
        })

        await approveRenewalChangesWorkflow(container).run({
          input: {
            renewal_cycle_id: approvedCycle.id,
            decided_by: "admin_approved",
            reason: "approved for processing",
          },
        })

        await forceRenewalCycleWorkflow(container).run({
          input: {
            renewal_cycle_id: approvedCycle.id,
            triggered_by: "admin_approved",
          },
        })

        const processedApprovedCycle = await renewalModule.retrieveRenewalCycle(
          approvedCycle.id
        )
        expect(processedApprovedCycle.status).toEqual(RenewalCycleStatus.SUCCEEDED)
        expect(processedApprovedCycle.approval_status).toEqual(
          RenewalApprovalStatus.APPROVED
        )

        const approvedLogs = await activityLogModule.listSubscriptionLogs({
          subscription_id: approvedSubscription.id,
          event_type: ActivityLogEventType.RENEWAL_APPROVAL_APPROVED,
        } as any)

        expect(approvedLogs).toHaveLength(1)
        expect(approvedLogs[0]).toMatchObject({
          subscription_id: approvedSubscription.id,
          event_type: ActivityLogEventType.RENEWAL_APPROVAL_APPROVED,
          actor_type: ActivityLogActorType.USER,
          actor_id: "admin_approved",
        })

        const rejectedSubscription = await createSubscriptionSeed(container, {
          reference: "SUB-REN-APPROVAL-002",
          skip_next_cycle: true,
        })
        const rejectedCycle = await createRenewalCycleSeed(container, {
          subscription_id: rejectedSubscription.id,
          approval_required: true,
          approval_status: RenewalApprovalStatus.PENDING,
        })

        await rejectRenewalChangesWorkflow(container).run({
          input: {
            renewal_cycle_id: rejectedCycle.id,
            decided_by: "admin_rejected",
            reason: "rejected in test",
          },
        })

        const processedRejectedCycle = await renewalModule.retrieveRenewalCycle(
          rejectedCycle.id
        )
        expect(processedRejectedCycle.approval_status).toEqual(
          RenewalApprovalStatus.REJECTED
        )

        const rejectedLogs = await activityLogModule.listSubscriptionLogs({
          subscription_id: rejectedSubscription.id,
          event_type: ActivityLogEventType.RENEWAL_APPROVAL_REJECTED,
        } as any)

        expect(rejectedLogs).toHaveLength(1)
        expect(rejectedLogs[0]).toMatchObject({
          subscription_id: rejectedSubscription.id,
          event_type: ActivityLogEventType.RENEWAL_APPROVAL_REJECTED,
          actor_type: ActivityLogActorType.USER,
          actor_id: "admin_rejected",
        })

        await expect(
          forceRenewalCycleWorkflow(container).run({
            input: {
              renewal_cycle_id: rejectedCycle.id,
            },
          })
        ).rejects.toMatchObject({
          message: expect.stringContaining("requires approved changes"),
        })
      })
    })
  },
})

jest.setTimeout(60 * 1000)
