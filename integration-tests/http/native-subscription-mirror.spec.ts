import path from "path"
import { medusaIntegrationTestRunner } from "@medusajs/test-utils"
import { Modules } from "@medusajs/framework/utils"
import type { MedusaContainer } from "@medusajs/framework/types"
import paypalSubscriptionMirrorHandler from "../../src/subscribers/paypal-subscription-mirror"
import nativeSubscriptionBackfillJob from "../../src/jobs/native-subscription-backfill"
import { SUBSCRIPTION_MODULE } from "../../src/modules/subscription"
import type SubscriptionModuleService from "../../src/modules/subscription/service"
import {
  SubscriptionFrequencyInterval,
  SubscriptionStatus,
} from "../../src/modules/subscription/types"
import { listDueRenewalCyclesForProcessing } from "../../src/modules/renewal/utils/scheduler-query"
import { createRenewalCycleSeed } from "../helpers/renewal-fixtures"
import {
  createCustomer,
  createSubscriptionSeed,
} from "../helpers/subscription-fixtures"

jest.setTimeout(120 * 1000)

const BRIDGE_SECRET = "test-bridge-secret"

const PAYPAL_ID = "I-MIRROR01"

const ACTIVATED_PAYLOAD = {
  paypal_subscription_id: PAYPAL_ID,
  status: "ACTIVE",
  customer_id: "",
  product_id: "prod_mirror",
  variant_id: "variant_mirror",
  plan_id: "P-PLAN1",
  frequency_interval: "month",
  frequency_value: 1,
  next_billing_at: "2026-11-01T00:00:00Z",
  last_billing_at: "2026-10-01T00:00:00Z",
}

async function emit(
  container: MedusaContainer,
  name: string,
  data: Record<string, unknown>
) {
  await paypalSubscriptionMirrorHandler({
    event: { name, data, broadcast: false },
    container,
    pluginOptions: {},
  } as never)
}

medusaIntegrationTestRunner({
  medusaConfigFile: path.resolve(process.cwd(), "integration-tests"),
  env: {
    JWT_SECRET: "supersecret",
    COOKIE_SECRET: "supersecret",
  },
  testSuite: ({ api, getContainer }) => {
    describe("native subscription mirror", () => {
      it("creates, replays and updates one row per provider subscription", async () => {
        const container = getContainer()
        const subscriptionModule = container.resolve<SubscriptionModuleService>(
          SUBSCRIPTION_MODULE
        )
        const customer = await createCustomer(container)
        const payload = { ...ACTIVATED_PAYLOAD, customer_id: customer.id }

        await emit(container, "paypal.subscription.activated", payload)
        await emit(container, "paypal.subscription.activated", payload)

        const rows = await subscriptionModule.listSubscriptions({
          reference: [`NATIVE-${PAYPAL_ID}`],
        })

        expect(rows).toHaveLength(1)
        expect(rows[0]).toMatchObject({
          reference: `NATIVE-${PAYPAL_ID}`,
          status: SubscriptionStatus.ACTIVE,
          customer_id: customer.id,
          product_id: "prod_mirror",
          frequency_interval: SubscriptionFrequencyInterval.MONTH,
          frequency_value: 1,
        })
        expect(rows[0].payment_context).toMatchObject({
          payment_mode: "manual",
          mechanism: "native",
        })
        expect(new Date(rows[0].next_renewal_at!).toISOString()).toEqual(
          "2026-11-01T00:00:00.000Z"
        )

        await emit(container, "paypal.subscription.payment_failed", payload)

        const afterFailure = await subscriptionModule.listSubscriptions({
          reference: [`NATIVE-${PAYPAL_ID}`],
        })

        expect(afterFailure).toHaveLength(1)
        expect(afterFailure[0].status).toEqual(SubscriptionStatus.PAST_DUE)
        // A later event without a billing date must not erase the known one.
        expect(new Date(afterFailure[0].next_renewal_at!).toISOString()).toEqual(
          "2026-11-01T00:00:00.000Z"
        )
      })

      it("leaves the renewal date null when activation reported none", async () => {
        const container = getContainer()
        const subscriptionModule = container.resolve<SubscriptionModuleService>(
          SUBSCRIPTION_MODULE
        )
        const customer = await createCustomer(container)

        await emit(container, "paypal.subscription.activated", {
          ...ACTIVATED_PAYLOAD,
          customer_id: customer.id,
          paypal_subscription_id: "I-NODATE01",
          next_billing_at: null,
          last_billing_at: null,
        })

        const [row] = await subscriptionModule.listSubscriptions({
          reference: ["NATIVE-I-NODATE01"],
        })

        expect(row).toBeDefined()
        expect(row.next_renewal_at).toBeNull()
      })

      it("writes nothing when the payload cannot build a row", async () => {
        const container = getContainer()
        const subscriptionModule = container.resolve<SubscriptionModuleService>(
          SUBSCRIPTION_MODULE
        )
        const customer = await createCustomer(container)

        await emit(container, "paypal.subscription.activated", {
          ...ACTIVATED_PAYLOAD,
          customer_id: customer.id,
          paypal_subscription_id: "I-PARTIAL1",
          product_id: null,
        })

        expect(
          await subscriptionModule.listSubscriptions({
            reference: ["NATIVE-I-PARTIAL1"],
          })
        ).toHaveLength(0)
      })

      it("keeps mirror rows out of the renewal scheduler and their cycles untouched", async () => {
        const container = getContainer()
        const customer = await createCustomer(container)

        const nativeSubscription = await createSubscriptionSeed(container, {
          customer_id: customer.id,
          reference: `NATIVE-${Date.now()}`,
          status: SubscriptionStatus.ACTIVE,
          next_renewal_at: new Date(Date.now() - 1000),
          payment_context: {
            payment_provider_id: "pp_paypal_paypal",
            payment_mode: "manual",
            mechanism: "native",
          },
        })

        const reorderSubscription = await createSubscriptionSeed(container, {
          customer_id: customer.id,
          reference: `SUB-${Date.now()}`,
          status: SubscriptionStatus.ACTIVE,
          next_renewal_at: new Date(Date.now() - 1000),
          payment_context: {
            payment_provider_id: "pp_system_default",
            payment_mode: "auto",
            payment_method_reference: "pm_auto",
          },
        })

        const nativeCycle = await createRenewalCycleSeed(container, {
          subscription_id: Array.isArray(nativeSubscription)
            ? nativeSubscription[0].id
            : nativeSubscription.id,
          scheduled_for: new Date(Date.now() - 1000),
        })

        const reorderCycle = await createRenewalCycleSeed(container, {
          subscription_id: Array.isArray(reorderSubscription)
            ? reorderSubscription[0].id
            : reorderSubscription.id,
          scheduled_for: new Date(Date.now() - 1000),
        })

        const { cycles } = await listDueRenewalCyclesForProcessing(container, {
          limit: 50,
          offset: 0,
        })

        const cycleIds = cycles.map((cycle) => cycle.id)

        expect(cycleIds).toContain(reorderCycle.id)
        expect(cycleIds).not.toContain(nativeCycle.id)
      })

      it("refuses to switch a mirror row to auto-renewal", async () => {
        const container = getContainer()
        const subscriptionModule = container.resolve<SubscriptionModuleService>(
          SUBSCRIPTION_MODULE
        )
        const apiKeyModule = container.resolve<{
          createApiKeys: (input: {
            title: string
            type: string
            created_by: string
          }) => Promise<{ token: string }>
        }>(Modules.API_KEY)
        const publishableKey = await apiKeyModule.createApiKeys({
          title: `native-mirror-${Date.now()}`,
          type: "publishable",
          created_by: "test",
        })
        const customer = await createCustomer(container)

        const nativeSubscription = await createSubscriptionSeed(container, {
          customer_id: customer.id,
          reference: `NATIVE-${Date.now()}`,
          status: SubscriptionStatus.ACTIVE,
          payment_context: {
            payment_provider_id: "pp_paypal_paypal",
            payment_mode: "manual",
            mechanism: "native",
          },
        })

        const subscriptionId = Array.isArray(nativeSubscription)
          ? nativeSubscription[0].id
          : nativeSubscription.id

        const response = await api.post(
          "/store/saas/auto-renew",
          { subscription_id: subscriptionId, enabled: true },
          {
            headers: {
              "x-publishable-api-key": publishableKey.token,
              "x-bridge-secret": BRIDGE_SECRET,
              "x-tenant-id": "default",
            },
            validateStatus: () => true,
          }
        )

        expect(response.status).toEqual(400)

        const [row] = await subscriptionModule.listSubscriptions({
          id: [subscriptionId],
        })

        expect(row.payment_context).toMatchObject({ payment_mode: "manual" })
      })

      it("reconciles to nothing when the provider module is absent", async () => {
        const container = getContainer()

        await expect(
          nativeSubscriptionBackfillJob(container)
        ).resolves.toBeUndefined()
      })
    })
  },
})
