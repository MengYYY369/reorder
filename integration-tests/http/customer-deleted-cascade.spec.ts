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

/**
 * The fake `paypalSubscription` service a host on medusa-paypal would present:
 * the cascade's protocol-cancel step duck-types exactly these two methods.
 */
function registerFakePaypalSubscription(container: any) {
  const requestLifecycleAction = jest.fn().mockResolvedValue({ id: "row-1" })
  const listSubscriptions = jest
    .fn()
    .mockResolvedValue([[{ id: "provider-row-1" }], 1])

  container.register({
    paypalSubscription: asValue({ listSubscriptions, requestLifecycleAction }),
  })

  return { listSubscriptions, requestLifecycleAction }
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

      it("cancels a live provider-owned recurrence at PayPal before deleting the mirror row", async () => {
        const container = getContainer()
        const customer = await createCustomer(container)
        const mirror = await createSubscriptionSeed(container, {
          customer_id: customer.id,
          reference: `NATIVE-paypal-${Date.now()}`,
          status: SubscriptionStatus.ACTIVE,
        })

        const capability = registerFakePaypalSubscription(container)

        const outcome = await runCustomerDeletedCascade(container, customer.id)

        expect(outcome.failures).toEqual([])
        expect(outcome.provider_cancels).toHaveLength(1)
        expect(outcome.provider_cancels[0]).toMatchObject({
          status: "cancelled",
        })
        expect(capability.requestLifecycleAction).toHaveBeenCalledWith(
          "provider-row-1",
          "cancel"
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
