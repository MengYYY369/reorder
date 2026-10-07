import { medusaIntegrationTestRunner } from "@medusajs/test-utils"
import path from "path"
import { asValue } from "awilix"
import {
  createCustomer,
  createSubscriptionSeed,
} from "../helpers/subscription-fixtures"
import { ACTIVITY_LOG_MODULE } from "../../src/modules/activity-log"
import { CANCELLATION_MODULE } from "../../src/modules/cancellation"
import { DUNNING_MODULE } from "../../src/modules/dunning"
import { RENEWAL_MODULE } from "../../src/modules/renewal"
import { TRIAL_CLAIM_MODULE } from "../../src/modules/trial-claim"
import { SUBSCRIPTION_MODULE } from "../../src/modules/subscription"
import type SubscriptionModuleService from "../../src/modules/subscription/service"
import { SubscriptionStatus } from "../../src/modules/subscription/types"
import { runCustomerDeletedCascade } from "../../src/subscribers/customer-deleted-cascade"

jest.setTimeout(180 * 1000)

/** The provider's own subscription id the mirror row points at. */
const PROVIDER_SUBSCRIPTION_ID = "I-CASCADE-1"

/**
 * The fake `paymentMethods` service a host with the payment-methods plugin
 * presents: the cascade's provider cancel goes through the capability view
 * (`getProviderCapabilities`), never through a provider module by name
 * (2026-10-06 rail decoupling).
 */
function registerFakeProviderCapability(container: any) {
  const cancel = jest.fn().mockResolvedValue({
    status: "cancelled",
    provider_subscription_id: PROVIDER_SUBSCRIPTION_ID,
    provider_row_id: "provider-row-1",
  })

  container.register({
    paymentMethods: asValue({
      getProviderCapabilities: async () => [
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
      ],
    }),
  })

  return { cancel }
}

async function seedSubscriptionChain(container: any, customerId: string) {
  const subscription = await createSubscriptionSeed(container, {
    customer_id: customerId,
    reference: `SUB-CASCADE-${Date.now()}`,
    status: SubscriptionStatus.CANCELLED,
  })

  const renewalModule = container.resolve(RENEWAL_MODULE) as any
  const cycle = await renewalModule.createRenewalCycles({
    subscription_id: subscription.id,
    scheduled_for: new Date(),
    status: "succeeded",
  } as any)
  const attempt = await renewalModule.createRenewalAttempts({
    renewal_cycle_id: cycle.id,
    attempt_no: 1,
    started_at: new Date(),
    status: "succeeded",
  } as any)

  const dunningModule = container.resolve(DUNNING_MODULE) as any
  const dunningCase = await dunningModule.createDunningCases({
    subscription_id: subscription.id,
    renewal_cycle_id: cycle.id,
    max_attempts: 3,
    status: "unrecovered",
  } as any)

  const cancellationModule = container.resolve(CANCELLATION_MODULE) as any
  const cancellationCase = await cancellationModule.createCancellationCases({
    subscription_id: subscription.id,
    status: "canceled",
  } as any)

  const activityLogModule = container.resolve(ACTIVITY_LOG_MODULE) as any
  const log = await activityLogModule.createSubscriptionLogs({
    subscription_id: subscription.id,
    customer_id: customerId,
    event_type: "subscription.created",
    actor_type: "system",
    dedupe_key: `cascade-${subscription.id}`,
  } as any)

  const trialClaimModule = container.resolve(TRIAL_CLAIM_MODULE) as any
  const claim = await trialClaimModule.createTrialClaims({
    customer_id: customerId,
    product_id: subscription.product_id,
    variant_id: subscription.variant_id,
    claimed_at: new Date(),
    source: "self_service",
    subscription_id: subscription.id,
    binding_method: "none",
  } as any)

  return {
    subscription,
    cycle,
    attempt,
    dunningCase,
    cancellationCase,
    log,
    claim,
  }
}

medusaIntegrationTestRunner({
  medusaConfigFile: path.resolve(process.cwd(), "integration-tests"),
  env: {
    JWT_SECRET: "supersecret",
    COOKIE_SECRET: "supersecret",
  },
  testSuite: ({ getContainer }) => {
    describe("customer.deleted cascade (ticket 13)", () => {
      it("deletes a cancelled subscription's full chain and stays idempotent on a replay", async () => {
        const container = getContainer()
        const customer = await createCustomer(container)
        const chain = await seedSubscriptionChain(container, customer.id)

        const outcome = await runCustomerDeletedCascade(container, customer.id)

        expect(outcome.failures).toEqual([])
        expect(outcome.subscriptions_deleted).toEqual(1)
        expect(outcome.payment_links).toMatchObject({
          customer_payment_preferences: 0,
        })

        const subscriptionModule = container.resolve(
          SUBSCRIPTION_MODULE
        ) as SubscriptionModuleService
        await expect(
          subscriptionModule.retrieveSubscription(chain.subscription.id)
        ).rejects.toThrow()

        const renewalModule = container.resolve(RENEWAL_MODULE) as any
        expect(
          await renewalModule.listRenewalCycles({ id: chain.cycle.id })
        ).toHaveLength(0)
        expect(
          await renewalModule.listRenewalAttempts({ id: chain.attempt.id })
        ).toHaveLength(0)

        const dunningModule = container.resolve(DUNNING_MODULE) as any
        expect(
          await dunningModule.listDunningCases({ id: chain.dunningCase.id })
        ).toHaveLength(0)

        const cancellationModule = container.resolve(CANCELLATION_MODULE) as any
        expect(
          await cancellationModule.listCancellationCases({
            id: chain.cancellationCase.id,
          })
        ).toHaveLength(0)

        const activityLogModule = container.resolve(ACTIVITY_LOG_MODULE) as any
        expect(
          await activityLogModule.listSubscriptionLogs({ id: chain.log.id })
        ).toHaveLength(0)

        const trialClaimModule = container.resolve(TRIAL_CLAIM_MODULE) as any
        expect(
          await trialClaimModule.listTrialClaims({ id: chain.claim.id })
        ).toHaveLength(0)

        // The subscriber may fire twice: the replay finds nothing to do and
        // must not record a failure.
        const replay = await runCustomerDeletedCascade(container, customer.id)
        expect(replay.failures).toEqual([])
        expect(replay.subscriptions_deleted).toEqual(0)
        expect(replay.provider_cancels).toEqual([])
      })

      it("cancels a live provider-owned recurrence at the provider before deleting the mirror row", async () => {
        const container = getContainer()
        const customer = await createCustomer(container)
        const mirror = await createSubscriptionSeed(container, {
          customer_id: customer.id,
          reference: `NATIVE-paypal-${Date.now()}`,
          status: SubscriptionStatus.ACTIVE,
          // The cancel target: which provider key owns the row, and the
          // provider's own subscription id (never parsed out of the reference).
          payment_context: {
            payment_provider_id: "pp_paypal_paypal",
            payment_mode: "manual",
            mechanism: "native",
            source_payment_collection_id: null,
            source_payment_session_id: null,
            payment_method_reference: null,
            customer_payment_reference: PROVIDER_SUBSCRIPTION_ID,
          },
        })

        const capability = registerFakeProviderCapability(container)

        const outcome = await runCustomerDeletedCascade(container, customer.id)

        expect(outcome.failures).toEqual([])
        expect(outcome.provider_cancels).toHaveLength(1)
        expect(outcome.provider_cancels[0]).toMatchObject({
          status: "cancelled",
        })
        expect(capability.cancel).toHaveBeenCalledWith(
          expect.anything(),
          PROVIDER_SUBSCRIPTION_ID
        )

        const subscriptionModule = container.resolve(
          SUBSCRIPTION_MODULE
        ) as SubscriptionModuleService
        await expect(
          subscriptionModule.retrieveSubscription(mirror.id)
        ).rejects.toThrow()
      })
    })
  },
})
