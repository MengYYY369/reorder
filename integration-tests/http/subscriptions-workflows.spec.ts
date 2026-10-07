import { medusaIntegrationTestRunner } from "@medusajs/test-utils"
import { asValue } from "awilix"
import path from "path"
import {
  getAdminSubscriptionDetail,
  listAdminSubscriptions,
} from "../../src/modules/subscription/utils/admin-query"
import {
  cancelSubscriptionWorkflow,
  pauseSubscriptionWorkflow,
  resumeSubscriptionWorkflow,
  scheduleSubscriptionPlanChangeWorkflow,
  updateSubscriptionShippingAddressWorkflow,
} from "../../src/workflows"
import {
  createPlanOfferSeed,
  createCustomer,
  createProductWithVariant,
  createSubscriptionSeed,
  updateCustomer,
} from "../helpers/plan-offer-fixtures"
import { Modules } from "@medusajs/framework/utils"
import {
  PlanOfferFrequencyInterval,
  PlanOfferScope,
} from "../../src/modules/plan-offer/types"
import {
  SubscriptionFrequencyInterval,
  SubscriptionStatus,
} from "../../src/modules/subscription/types"
import { SUBSCRIPTION_MODULE } from "../../src/modules/subscription"
import type SubscriptionModuleService from "../../src/modules/subscription/service"
import { ACTIVITY_LOG_MODULE } from "../../src/modules/activity-log"
import type ActivityLogModuleService from "../../src/modules/activity-log/service"
import {
  ActivityLogActorType,
  ActivityLogEventType,
} from "../../src/modules/activity-log/types"

type ProductModuleService = {
  updateProducts(
    id: string,
    data: Record<string, unknown>
  ): Promise<Record<string, unknown>>
}

/**
 * The fake `paymentMethods` service a host with the payment-methods plugin
 * presents: the cancel path goes through the capability view
 * (`getProviderCapabilities`), never through a provider module by name
 * (2026-10-06 rail decoupling). The returned `cancel` is the provider's own
 * callable, so a test can assert it was reached and what it was handed.
 */
function registerFakeProviderCapability(container: any, cancel: jest.Mock) {
  const getProviderCapabilities = jest.fn(async () => [
    {
      provider_id: "pp_paypal_paypal",
      kind: "paypal",
      display_name: "PayPal",
      display_name_i18n: null,
      binding: { supported: true },
      native: {
        supported: true,
        readVariantDeclaration: () => null,
        listRecords: async () => [],
        cancel,
      },
    },
  ])

  container.register({
    paymentMethods: asValue({ getProviderCapabilities }),
  })

  return { cancel, getProviderCapabilities }
}

/** The `payment_context` of a native mirror row pointing at one provider id. */
function nativeMirrorPaymentContext(providerSubscriptionId: string) {
  return {
    payment_provider_id: "pp_paypal_paypal",
    payment_mode: "manual",
    mechanism: "native",
    source_payment_collection_id: null,
    source_payment_session_id: null,
    payment_method_reference: null,
    customer_payment_reference: providerSubscriptionId,
  }
}

medusaIntegrationTestRunner({
  medusaConfigFile: path.resolve(process.cwd(), "integration-tests"),
  env: {
    JWT_SECRET: "supersecret",
    COOKIE_SECRET: "supersecret",
  },
  testSuite: ({ getContainer }) => {
    describe("subscriptions query and workflows", () => {
      it("lists subscriptions with pagination and filters", async () => {
        const container = getContainer()

        await createSubscriptionSeed(container, {
          reference: "SUB-QUERY-001",
          status: SubscriptionStatus.ACTIVE,
        })
        await createSubscriptionSeed(container, {
          reference: "SUB-QUERY-002",
          status: SubscriptionStatus.PAUSED,
        })

        const response = await listAdminSubscriptions(container, {
          limit: 10,
          offset: 0,
          status: ["active"],
        })

        expect(response.count).toEqual(1)
        expect(response.subscriptions).toHaveLength(1)
        expect(response.subscriptions[0].reference).toEqual("SUB-QUERY-001")
      })

      it("returns subscription detail", async () => {
        const container = getContainer()
        const subscription = await createSubscriptionSeed(container, {
          reference: "SUB-DETAIL-001",
        })

        const response = await getAdminSubscriptionDetail(
          container,
          subscription.id
        )

        expect(response.subscription.id).toEqual(subscription.id)
        expect(response.subscription.shipping_address.city).toEqual("Warszawa")
        expect(response.subscription.customer.full_name).toEqual("Customer Test")
        expect(response.subscription.product.product_title).toEqual(
          "Subscription Product"
        )
      })

      it("uses live customer and product data with snapshot fallback", async () => {
        const container = getContainer()
        const productModule =
          container.resolve<ProductModuleService>(Modules.PRODUCT)
        const customer = await createCustomer(container, {
          email: "before-live@example.com",
          first_name: "Before",
          last_name: "Live",
        })
        const { product, variant } = await createProductWithVariant(container)
        const subscription = await createSubscriptionSeed(container, {
          reference: "SUB-LIVE-DETAIL-001",
          customer_id: customer.id,
          product_id: product.id,
          variant_id: variant.id,
        })

        await updateCustomer(container, customer.id, {
          email: "after-live@example.com",
          first_name: "After",
          last_name: "Live",
        })
        await productModule.updateProducts(product.id, {
          title: "Live Product Title",
        })

        const detailResponse = await getAdminSubscriptionDetail(
          container,
          subscription.id
        )
        const listResponse = await listAdminSubscriptions(container, {
          limit: 10,
          offset: 0,
          q: "after-live@example.com",
        })

        expect(detailResponse.subscription.customer.full_name).toEqual(
          "After Live"
        )
        expect(detailResponse.subscription.customer.email).toEqual(
          "after-live@example.com"
        )
        expect(detailResponse.subscription.product.product_title).toEqual(
          "Live Product Title"
        )
        expect(detailResponse.subscription.product.variant_title).toEqual(
          variant.title
        )
        expect(detailResponse.subscription.product.sku).toEqual(variant.sku)

        expect(listResponse.subscriptions).toHaveLength(1)
        expect(listResponse.subscriptions[0].id).toEqual(subscription.id)
        expect(listResponse.subscriptions[0].customer.full_name).toEqual(
          "After Live"
        )
        expect(listResponse.subscriptions[0].product.product_title).toEqual(
          "Live Product Title"
        )
      })

      it("pauses and resumes a subscription", async () => {
        const container = getContainer()
        const activityLogModule =
          container.resolve<ActivityLogModuleService>(ACTIVITY_LOG_MODULE)
        const subscription = await createSubscriptionSeed(container, {
          reference: "SUB-WF-001",
          status: SubscriptionStatus.ACTIVE,
        })

        const { result: pausedResult } = await pauseSubscriptionWorkflow(
          container
        ).run({
          input: {
            id: subscription.id,
            reason: "manual test",
          },
        })

        expect(pausedResult.subscription.status).toEqual(
          SubscriptionStatus.PAUSED
        )

        const pausedLogs = await activityLogModule.listSubscriptionLogs({
          subscription_id: subscription.id,
          event_type: ActivityLogEventType.SUBSCRIPTION_PAUSED,
        } as any)

        expect(pausedLogs).toHaveLength(1)
        expect(pausedLogs[0]).toMatchObject({
          subscription_id: subscription.id,
          event_type: ActivityLogEventType.SUBSCRIPTION_PAUSED,
          actor_type: ActivityLogActorType.USER,
          actor_id: null,
          reason: "manual test",
          metadata: expect.objectContaining({
            source: "admin",
          }),
        })
        expect(pausedLogs[0].dedupe_key).toContain(
          ActivityLogEventType.SUBSCRIPTION_PAUSED
        )
        expect(pausedLogs[0].changed_fields).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              field: "status",
              before: SubscriptionStatus.ACTIVE,
              after: SubscriptionStatus.PAUSED,
            }),
          ])
        )

        const { result: resumedResult } = await resumeSubscriptionWorkflow(
          container
        ).run({
          input: {
            id: subscription.id,
            preserve_billing_anchor: true,
          },
        })

        expect(resumedResult.subscription.status).toEqual(
          SubscriptionStatus.ACTIVE
        )

        const resumedLogs = await activityLogModule.listSubscriptionLogs({
          subscription_id: subscription.id,
          event_type: ActivityLogEventType.SUBSCRIPTION_RESUMED,
        } as any)

        expect(resumedLogs).toHaveLength(1)
        expect(resumedLogs[0]).toMatchObject({
          subscription_id: subscription.id,
          event_type: ActivityLogEventType.SUBSCRIPTION_RESUMED,
          actor_type: ActivityLogActorType.USER,
          actor_id: null,
          metadata: expect.objectContaining({
            source: "admin",
          }),
        })
        expect(resumedLogs[0].changed_fields).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              field: "status",
              before: SubscriptionStatus.PAUSED,
              after: SubscriptionStatus.ACTIVE,
            }),
          ])
        )
      })

      it("throws conflict when pausing a paused subscription", async () => {
        const container = getContainer()
        const subscription = await createSubscriptionSeed(container, {
          reference: "SUB-WF-002",
          status: SubscriptionStatus.PAUSED,
        })

        await expect(
          pauseSubscriptionWorkflow(container).run({
            input: {
              id: subscription.id,
            },
          })
        ).rejects.toMatchObject({
          message: expect.stringContaining("can't be paused"),
        })
      })

      it("cancels a subscription", async () => {
        const container = getContainer()
        const activityLogModule =
          container.resolve<ActivityLogModuleService>(ACTIVITY_LOG_MODULE)
        const subscription = await createSubscriptionSeed(container, {
          reference: "SUB-WF-003",
          status: SubscriptionStatus.ACTIVE,
        })

        const { result } = await cancelSubscriptionWorkflow(container).run({
          input: {
            id: subscription.id,
            effective_at: "immediately",
          },
        })

        expect(result.subscription.status).toEqual(
          SubscriptionStatus.CANCELLED
        )
        expect(result.subscription.cancelled_at).toBeTruthy()

        const logs = await activityLogModule.listSubscriptionLogs({
          subscription_id: subscription.id,
          event_type: ActivityLogEventType.SUBSCRIPTION_CANCELED,
        } as any)

        expect(logs).toHaveLength(1)
        expect(logs[0]).toMatchObject({
          subscription_id: subscription.id,
          event_type: ActivityLogEventType.SUBSCRIPTION_CANCELED,
          actor_type: ActivityLogActorType.USER,
          metadata: expect.objectContaining({
            source: "admin",
          }),
        })
        expect(logs[0].new_state).toEqual(
          expect.objectContaining({
            status: SubscriptionStatus.CANCELLED,
          })
        )
      })

      it("cancels the provider-side subscription for a native mirror row", async () => {
        const container = getContainer()
        const subscriptionModule =
          container.resolve<SubscriptionModuleService>(SUBSCRIPTION_MODULE)
        const cancel = jest.fn().mockResolvedValue({
          status: "cancelled",
          provider_subscription_id: "I-NATIVE-1",
          provider_row_id: "prow_native_1",
        })

        registerFakeProviderCapability(container, cancel)

        try {
          const subscription = await createSubscriptionSeed(container, {
            reference: "NATIVE-I-NATIVE-1",
            status: SubscriptionStatus.ACTIVE,
            payment_context: nativeMirrorPaymentContext("I-NATIVE-1"),
          })

          const { result } = await cancelSubscriptionWorkflow(container).run({
            input: { id: subscription.id, effective_at: "immediately" },
          })

          expect(result.subscription.status).toEqual(
            SubscriptionStatus.CANCELLED
          )
          expect(cancel).toHaveBeenCalledWith(
            expect.anything(),
            "I-NATIVE-1"
          )

          const stored = await subscriptionModule.retrieveSubscription(
            subscription.id
          )
          expect(stored.metadata?.cancel_context).toMatchObject({
            provider_cancel: {
              status: "cancelled",
              provider_subscription_id: "I-NATIVE-1",
              provider_row_id: "prow_native_1",
            },
          })
        } finally {
          container.register({ paymentMethods: asValue(null) })
        }
      })

      it("still cancels locally and records the failure when the provider cancel fails", async () => {
        const container = getContainer()
        const subscriptionModule =
          container.resolve<SubscriptionModuleService>(SUBSCRIPTION_MODULE)
        const cancel = jest
          .fn()
          .mockRejectedValue(new Error("paypal rejected cancel: HTTP 500"))

        registerFakeProviderCapability(container, cancel)

        try {
          const subscription = await createSubscriptionSeed(container, {
            reference: "NATIVE-I-NATIVE-2",
            status: SubscriptionStatus.ACTIVE,
            payment_context: nativeMirrorPaymentContext("I-NATIVE-2"),
          })

          const { result } = await cancelSubscriptionWorkflow(container).run({
            input: { id: subscription.id, effective_at: "immediately" },
          })

          expect(result.subscription.status).toEqual(
            SubscriptionStatus.CANCELLED
          )

          const stored = await subscriptionModule.retrieveSubscription(
            subscription.id
          )
          expect(stored.metadata?.cancel_context).toMatchObject({
            provider_cancel: {
              status: "failed",
              error: expect.stringContaining("HTTP 500"),
            },
          })
        } finally {
          container.register({ paymentMethods: asValue(null) })
        }
      })

      it("skips the provider cancel for non-native rows", async () => {
        const container = getContainer()
        const subscriptionModule =
          container.resolve<SubscriptionModuleService>(SUBSCRIPTION_MODULE)
        const cancel = jest.fn()
        const { getProviderCapabilities } = registerFakeProviderCapability(
          container,
          cancel
        )

        try {
          const subscription = await createSubscriptionSeed(container, {
            reference: "SUB-WF-NATIVE-SKIP",
            status: SubscriptionStatus.ACTIVE,
          })

          await cancelSubscriptionWorkflow(container).run({
            input: { id: subscription.id, effective_at: "immediately" },
          })

          // A non-native row is answered before the capability view is even
          // consulted: neither the provider cancel nor the view are reached.
          expect(cancel).not.toHaveBeenCalled()
          expect(getProviderCapabilities).not.toHaveBeenCalled()

          const stored = await subscriptionModule.retrieveSubscription(
            subscription.id
          )
          expect(stored.metadata?.cancel_context).toMatchObject({
            provider_cancel: { status: "skipped", reason: "not_native" },
          })
        } finally {
          container.register({ paymentMethods: asValue(null) })
        }
      })

      it("schedules a plan change with a real variant", async () => {
        const container = getContainer()
        const activityLogModule =
          container.resolve<ActivityLogModuleService>(ACTIVITY_LOG_MODULE)
        const { product, variant } = await createProductWithVariant(container)
        await createPlanOfferSeed(container, {
          name: "PLAN-SUB-WF-004",
          scope: PlanOfferScope.VARIANT,
          product_id: product.id,
          variant_id: variant.id,
          is_enabled: true,
          allowed_frequencies: [
            {
              interval: PlanOfferFrequencyInterval.MONTH,
              value: 2,
            },
          ],
        })
        const subscription = await createSubscriptionSeed(container, {
          reference: "SUB-WF-004",
          product_id: product.id,
          variant_id: variant.id,
        })

        const { result } = await scheduleSubscriptionPlanChangeWorkflow(
          container
        ).run({
          input: {
            id: subscription.id,
            variant_id: variant.id,
            frequency_interval: SubscriptionFrequencyInterval.MONTH,
            frequency_value: 2,
            requested_by: "admin_test",
          },
        })

        expect(result.subscription.pending_update_data).toMatchObject({
          variant_id: variant.id,
          frequency_value: 2,
        })

        const logs = await activityLogModule.listSubscriptionLogs({
          subscription_id: subscription.id,
          event_type: ActivityLogEventType.SUBSCRIPTION_PLAN_CHANGE_SCHEDULED,
        } as any)

        expect(logs).toHaveLength(1)
        expect(logs[0]).toMatchObject({
          subscription_id: subscription.id,
          event_type: ActivityLogEventType.SUBSCRIPTION_PLAN_CHANGE_SCHEDULED,
          actor_type: ActivityLogActorType.USER,
          actor_id: "admin_test",
          metadata: {
            source: "admin",
            effective_at: null,
          },
        })
        expect(logs[0].changed_fields).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              field: "pending_update_data",
            }),
          ])
        )
      })

      it("updates shipping address", async () => {
        const container = getContainer()
        const activityLogModule =
          container.resolve<ActivityLogModuleService>(ACTIVITY_LOG_MODULE)
        const subscription = await createSubscriptionSeed(container, {
          reference: "SUB-WF-005",
        })

        const { result } = await updateSubscriptionShippingAddressWorkflow(
          container
        ).run({
          input: {
            id: subscription.id,
            first_name: "Anna",
            last_name: "Nowak",
            company: null,
            address_1: "Nowa 2",
            address_2: null,
            city: "Krakow",
            postal_code: "30-001",
            province: "Malopolskie",
            country_code: "PL",
            phone: "+48111111111",
          },
        })

        expect(result.subscription.shipping_address.city).toEqual("Krakow")

        const logs = await activityLogModule.listSubscriptionLogs({
          subscription_id: subscription.id,
          event_type: ActivityLogEventType.SUBSCRIPTION_SHIPPING_ADDRESS_UPDATED,
        } as any)

        expect(logs).toHaveLength(1)
        expect(logs[0]).toMatchObject({
          subscription_id: subscription.id,
          event_type: ActivityLogEventType.SUBSCRIPTION_SHIPPING_ADDRESS_UPDATED,
          actor_type: ActivityLogActorType.USER,
          actor_id: null,
          metadata: expect.objectContaining({
            source: "admin",
          }),
          previous_state: expect.objectContaining({
            city: "Warszawa",
          }),
          new_state: expect.objectContaining({
            city: "Krakow",
            country_code: "PL",
          }),
        })
        expect(logs[0].new_state).not.toHaveProperty("address_1")
        expect(logs[0].new_state).not.toHaveProperty("postal_code")
        expect(logs[0].new_state).not.toHaveProperty("phone")
      })
    })
  },
})

jest.setTimeout(60 * 1000)
