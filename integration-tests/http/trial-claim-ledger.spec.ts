import path from "path"
import { medusaIntegrationTestRunner } from "@medusajs/test-utils"
import { MedusaError, Modules } from "@medusajs/framework/utils"
import type { MedusaContainer } from "@medusajs/framework/types"
import {
  createAdminAuthHeaders,
  createCustomer,
  createProductWithVariant,
  createStoreCustomerAuthHeaders,
  createSubscriptionSeed,
} from "../helpers/subscription-fixtures"
import { createPlanOfferSeed } from "../helpers/plan-offer-fixtures"
import { createRedemptionBatch } from "../helpers/redemption-fixtures"
import { TRIAL_CLAIM_MODULE } from "../../src/modules/trial-claim"
import TrialClaimModuleService from "../../src/modules/trial-claim/service"
import { TrialClaimSource } from "../../src/modules/trial-claim/types"
import { SUBSCRIPTION_MODULE } from "../../src/modules/subscription"
import type SubscriptionModuleService from "../../src/modules/subscription/service"
import {
  PlanOfferFrequencyInterval,
  PlanOfferScope,
  PlanOfferStackingPolicy,
} from "../../src/modules/plan-offer/types"

jest.setTimeout(120 * 1000)

/**
 * The single refusal the eligibility rule speaks: `assertEligible` throws it
 * for either half of the rule, and `record` throws it when the
 * `(customer_id, product_id)` unique index refuses a concurrent claim.
 */
const expectedIneligibleRefusal = (customerId: string, productId: string) =>
  `Trial has already been claimed for customer ${customerId} and product ${productId}`

type ApiKeyModule = {
  createApiKeys: (input: {
    title: string
    type: string
    created_by: string
  }) => Promise<{ token: string }>
}

async function createStoreHeadersWithPublishableKey(
  container: MedusaContainer,
  customer: { id: string }
): Promise<Record<string, string>> {
  const apiKeyModule = container.resolve<ApiKeyModule>(Modules.API_KEY)
  const pk = await apiKeyModule.createApiKeys({
    title: `trial-claim-test-${Date.now()}`,
    type: "publishable",
    created_by: "test",
  })
  return {
    ...(await createStoreCustomerAuthHeaders(container, customer)),
    "x-publishable-api-key": pk.token,
  }
}

type TrialClaimRow = {
  id: string
  customer_id: string
  product_id: string
  variant_id: string
  claimed_at: Date | string
  trial_ends_at: Date | string | null
  source: string
  subscription_id: string
  binding_method: string
}

async function listClaims(
  container: MedusaContainer,
  filters: { customer_id?: string; product_id?: string }
): Promise<TrialClaimRow[]> {
  const trialClaimModule = container.resolve<TrialClaimModuleService>(
    TRIAL_CLAIM_MODULE
  )
  return (await trialClaimModule.listTrialClaims(
    filters
  )) as unknown as TrialClaimRow[]
}

medusaIntegrationTestRunner({
  medusaConfigFile: path.resolve(process.cwd(), "integration-tests"),
  env: {
    JWT_SECRET: "supersecret",
    COOKIE_SECRET: "supersecret",
  },
  testSuite: ({ api, getContainer }) => {
    describe("trial_claim ledger and the eligibility rule", () => {
      it("records the first claim and lists it through the admin route", async () => {
        const container = getContainer()
        const trialClaimModule = container.resolve<TrialClaimModuleService>(
          TRIAL_CLAIM_MODULE
        )
        const { product, variant } = await createProductWithVariant(container)
        const customer = await createCustomer(container)

        // Eligible before any claim: neither half of the rule fires.
        await expect(
          trialClaimModule.assertEligible(customer.id, product.id, container)
        ).resolves.toBeUndefined()

        const trialEndsAt = new Date(Date.now() + 7 * 86_400_000)
        const claim = await trialClaimModule.record({
          customer_id: customer.id,
          product_id: product.id,
          variant_id: variant.id,
          source: TrialClaimSource.SELF_SERVICE,
          subscription_id: `sub_${Date.now()}`,
          trial_ends_at: trialEndsAt,
        })

        const rows = await listClaims(container, {
          customer_id: customer.id,
        })
        expect(rows).toHaveLength(1)
        expect(rows[0].id).toEqual(claim.id)
        expect(rows[0].customer_id).toEqual(customer.id)
        expect(rows[0].product_id).toEqual(product.id)
        expect(rows[0].variant_id).toEqual(variant.id)
        expect(rows[0].source).toEqual("self_service")
        expect(rows[0].binding_method).toEqual("none")
        expect(rows[0].subscription_id).toBeTruthy()
        expect(new Date(rows[0].trial_ends_at as string).getTime()).toEqual(
          trialEndsAt.getTime()
        )

        // Admin visibility (Q15): read-only list, filtered by customer, and
        // a product filter that matches nothing returns nothing.
        const adminHeaders = await createAdminAuthHeaders(container)
        const list = await api.get(
          `/admin/trial-claims?customer_id=${customer.id}`,
          { headers: adminHeaders }
        )
        expect(list.status).toEqual(200)
        expect(list.data.count).toEqual(1)
        expect(list.data.trial_claims).toHaveLength(1)
        expect(list.data.trial_claims[0].id).toEqual(claim.id)
        expect(list.data.trial_claims[0].claimed_at).toEqual(
          new Date(rows[0].claimed_at as Date).toISOString()
        )

        const { product: otherProduct } = await createProductWithVariant(
          container
        )
        const filteredEmpty = await api.get(
          `/admin/trial-claims?customer_id=${customer.id}&product_id=${otherProduct.id}`,
          { headers: adminHeaders }
        )
        expect(filteredEmpty.status).toEqual(200)
        expect(filteredEmpty.data.count).toEqual(0)
        expect(filteredEmpty.data.trial_claims).toHaveLength(0)
      })

      it("refuses a second claim for the same product, by the rule and by the unique index", async () => {
        const container = getContainer()
        const trialClaimModule = container.resolve<TrialClaimModuleService>(
          TRIAL_CLAIM_MODULE
        )
        const { product, variant } = await createProductWithVariant(container)
        const customer = await createCustomer(container)

        await trialClaimModule.record({
          customer_id: customer.id,
          product_id: product.id,
          variant_id: variant.id,
          source: TrialClaimSource.SELF_SERVICE,
          subscription_id: `sub_first_${Date.now()}`,
          trial_ends_at: new Date(Date.now() + 7 * 86_400_000),
        })

        // The ledger half of the rule answers the second claim. The refusal is
        // pinned by its shape (an invalid_data MedusaError with the exact
        // text) rather than the class: the app resolves the module from the
        // compiled `.medusa/server` build, so the thrown error is that copy of
        // the class, not the src copy this spec imports.
        const ledgerRefusal = await trialClaimModule
          .assertEligible(customer.id, product.id, container)
          .then(
            () => {
              throw new Error("expected the second claim to be refused")
            },
            (error: unknown) => error
          )
        expect(ledgerRefusal).toBeInstanceOf(MedusaError)
        expect((ledgerRefusal as MedusaError).type).toEqual(
          MedusaError.Types.INVALID_DATA
        )
        expect((ledgerRefusal as Error).message).toEqual(
          expectedIneligibleRefusal(customer.id, product.id)
        )

        // A direct record bypassing the pre-check is refused by the
        // `trial_claim_customer_product_unique` index, rethrown as the same
        // refusal — the race-safe anchor, not a separate check.
        await expect(
          trialClaimModule.record({
            customer_id: customer.id,
            product_id: product.id,
            variant_id: variant.id,
            source: TrialClaimSource.SELF_SERVICE,
            subscription_id: `sub_second_${Date.now()}`,
            trial_ends_at: new Date(Date.now() + 7 * 86_400_000),
          })
        ).rejects.toThrow(expectedIneligibleRefusal(customer.id, product.id))

        expect(
          await listClaims(container, { customer_id: customer.id })
        ).toHaveLength(1)
      })

      it("leaves exactly one row when two claims of the same product race", async () => {
        const container = getContainer()
        const trialClaimModule = container.resolve<TrialClaimModuleService>(
          TRIAL_CLAIM_MODULE
        )
        const { product, variant } = await createProductWithVariant(container)
        const customer = await createCustomer(container)

        // Two doors hitting the pair at once, neither waiting for the other:
        // exactly one insert wins, the loser gets the refusal.
        const [first, second] = await Promise.allSettled([
          trialClaimModule.record({
            customer_id: customer.id,
            product_id: product.id,
            variant_id: variant.id,
            source: TrialClaimSource.SELF_SERVICE,
            subscription_id: `sub_race_a_${Date.now()}`,
            trial_ends_at: new Date(Date.now() + 7 * 86_400_000),
          }),
          trialClaimModule.record({
            customer_id: customer.id,
            product_id: product.id,
            variant_id: variant.id,
            source: TrialClaimSource.REDEMPTION,
            subscription_id: `sub_race_b_${Date.now()}`,
            trial_ends_at: new Date(Date.now() + 7 * 86_400_000),
          }),
        ])

        const fulfilled = [first, second].filter(
          (outcome) => outcome.status === "fulfilled"
        )
        const rejected = [first, second].filter(
          (
            outcome
          ): outcome is PromiseRejectedResult => outcome.status === "rejected"
        )
        expect(fulfilled).toHaveLength(1)
        expect(rejected).toHaveLength(1)
        // The loser's refusal, pinned by shape for the same reason as above:
        // the container's service is the compiled copy of the module, so the
        // error's class identity is the compiled one while its contract — an
        // invalid_data MedusaError carrying the fixed refusal text — is what
        // doors and routes actually match on.
        expect(rejected[0].reason).toBeInstanceOf(MedusaError)
        expect((rejected[0].reason as MedusaError).type).toEqual(
          MedusaError.Types.INVALID_DATA
        )
        expect((rejected[0].reason as Error).message).toEqual(
          expectedIneligibleRefusal(customer.id, product.id)
        )

        const rows = await listClaims(container, { customer_id: customer.id })
        expect(rows).toHaveLength(1)
      })

      it("is ineligible when the customer holds a paid subscription but no trial", async () => {
        const container = getContainer()
        const trialClaimModule = container.resolve<TrialClaimModuleService>(
          TRIAL_CLAIM_MODULE
        )
        const { product, variant } = await createProductWithVariant(container)
        const customer = await createCustomer(container)

        // A paid (non-trial) subscription of the product, as a checkout would
        // have created it. Nothing else exists: no ledger row, no trial.
        await createSubscriptionSeed(container, {
          customer_id: customer.id,
          product_id: product.id,
          variant_id: variant.id,
          is_trial: false,
        })

        await expect(
          trialClaimModule.assertEligible(customer.id, product.id, container)
        ).rejects.toThrow(expectedIneligibleRefusal(customer.id, product.id))
        expect(
          await listClaims(container, { customer_id: customer.id })
        ).toHaveLength(0)
      })

      it("is ineligible when a NATIVE- mirror row exists for the customer and product", async () => {
        const container = getContainer()
        const trialClaimModule = container.resolve<TrialClaimModuleService>(
          TRIAL_CLAIM_MODULE
        )
        const subscriptionModule = container.resolve<SubscriptionModuleService>(
          SUBSCRIPTION_MODULE
        )
        const { product, variant } = await createProductWithVariant(container)
        const customer = await createCustomer(container)

        // A provider-managed mirror row: written is_trial: false by the
        // webhook-driven sync (`native-mirror-sync.ts`), reference carries the
        // `NATIVE-` prefix. The eligibility half reads the subscription
        // table's own columns, so the mirror blocks the trial like any other
        // subscription — this case is the primary pin (Task 23 re-asserts it).
        await subscriptionModule.createSubscriptions({
          reference: `NATIVE-test-${Date.now()}`,
          status: "active",
          customer_id: customer.id,
          cart_id: null,
          product_id: product.id,
          variant_id: variant.id,
          frequency_interval: "month",
          frequency_value: 1,
          started_at: new Date(),
          next_renewal_at: new Date(Date.now() + 30 * 86_400_000),
          last_renewal_at: null,
          paused_at: null,
          cancelled_at: null,
          cancel_effective_at: null,
          skip_next_cycle: false,
          free_cycles_remaining: 0,
          is_trial: false,
          trial_ends_at: null,
          customer_snapshot: null,
          product_snapshot: {
            product_id: product.id,
            product_title: "Mirror product",
            variant_id: variant.id,
            variant_title: "Mirror variant",
            sku: null,
          },
          pricing_snapshot: null,
          shipping_address: {
            first_name: "Native",
            last_name: "Mirror",
            company: null,
            address_1: "1 Mirror Way",
            address_2: null,
            city: "Testville",
            postal_code: "00000",
            province: null,
            country_code: "US",
            phone: null,
          },
          payment_context: null,
          pending_update_data: null,
          metadata: { source: "native_mirror" },
        } as never)

        await expect(
          trialClaimModule.assertEligible(customer.id, product.id, container)
        ).rejects.toThrow(expectedIneligibleRefusal(customer.id, product.id))
        expect(
          await listClaims(container, { customer_id: customer.id })
        ).toHaveLength(0)
      })
    })

    describe("the redemption door writes the ledger", () => {
      it("records a claim when a trial-enabled code creates a trial subscription, and nothing for a non-trial grant", async () => {
        const container = getContainer()
        const trialClaimModule = container.resolve<TrialClaimModuleService>(
          TRIAL_CLAIM_MODULE
        )
        const subscriptionModule = container.resolve<SubscriptionModuleService>(
          SUBSCRIPTION_MODULE
        )

        // Trial door: the BATCH enables a trial (ticket 14 / D14 — trial
        // semantics no longer come from the variant's offer), no payment method
        // required (the redemption path cannot collect one and refuses such
        // codes), code of a batch on the variant.
        const trialCustomer = await createCustomer(container)
        const trialHeaders = await createStoreHeadersWithPublishableKey(
          container,
          trialCustomer
        )
        const { product, variant } = await createProductWithVariant(container)

        await createPlanOfferSeed(container, {
          name: `TC-REDEMPTION-TRIAL-${Date.now()}`,
          scope: PlanOfferScope.VARIANT,
          product_id: product.id,
          variant_id: variant.id,
          allowed_frequencies: [
            { interval: PlanOfferFrequencyInterval.MONTH, value: 1 },
          ],
          rules: {
            minimum_cycles: null,
            trial_enabled: true,
            trial_days: 7,
            trial_requires_payment_method: false,
            stacking_policy: PlanOfferStackingPolicy.ALLOWED,
          },
        })

        const trialBatch = await createRedemptionBatch(container, {
          name: `TC-REDEMPTION-TRIAL-BATCH-${Date.now()}`,
          variant_id: variant.id,
          free_cycles: 1,
          generated_code_count: 1,
          trial_enabled: true,
          trial_days: 7,
        })

        const redeem = await api.post(
          "/store/customers/me/redemptions",
          { code: trialBatch.codes[0].code },
          { headers: trialHeaders }
        )
        expect(redeem.status).toEqual(200)
        expect(redeem.data.is_trial).toEqual(true)
        expect(redeem.data.subscription_id).toBeTruthy()

        const [subscription] = await subscriptionModule.listSubscriptions({
          customer_id: trialCustomer.id,
        })
        expect(subscription.is_trial).toEqual(true)

        const claims = await listClaims(container, {
          customer_id: trialCustomer.id,
        })
        expect(claims).toHaveLength(1)
        expect(claims[0].source).toEqual("redemption")
        expect(claims[0].subscription_id).toEqual(subscription.id)
        expect(claims[0].product_id).toEqual(product.id)
        expect(claims[0].variant_id).toEqual(variant.id)
        expect(
          new Date(claims[0].trial_ends_at as string).getTime()
        ).toEqual(
          new Date(subscription.trial_ends_at as unknown as string).getTime()
        )

        // The ledger row now makes the customer ineligible for a further
        // trial of the product through any door.
        await expect(
          trialClaimModule.assertEligible(trialCustomer.id, product.id, container)
        ).rejects.toThrow(
          expectedIneligibleRefusal(trialCustomer.id, product.id)
        )

        // Non-trial door: the same redemption flow with the trial disabled,
        // on a DIFFERENT variant — the plan_offer table allows one
        // variant-scoped offer per variant, so the second grant cannot sit on
        // the same one. It must not write a ledger row.
        const freeCustomer = await createCustomer(container)
        const freeHeaders = await createStoreHeadersWithPublishableKey(
          container,
          freeCustomer
        )
        const { product: freeProduct, variant: freeVariant } =
          await createProductWithVariant(container)

        await createPlanOfferSeed(container, {
          name: `TC-REDEMPTION-FREE-${Date.now()}`,
          scope: PlanOfferScope.VARIANT,
          product_id: freeProduct.id,
          variant_id: freeVariant.id,
          allowed_frequencies: [
            { interval: PlanOfferFrequencyInterval.MONTH, value: 1 },
          ],
          rules: {
            minimum_cycles: 1,
            trial_enabled: false,
            trial_days: null,
            trial_requires_payment_method: false,
            stacking_policy: PlanOfferStackingPolicy.ALLOWED,
          },
        })

        const freeBatch = await createRedemptionBatch(container, {
          name: `TC-REDEMPTION-FREE-BATCH-${Date.now()}`,
          variant_id: freeVariant.id,
          free_cycles: 2,
          generated_code_count: 1,
        })

        const freeRedeem = await api.post(
          "/store/customers/me/redemptions",
          { code: freeBatch.codes[0].code },
          { headers: freeHeaders }
        )
        expect(freeRedeem.status).toEqual(200)
        expect(freeRedeem.data.is_trial).toEqual(false)
        expect(
          await listClaims(container, { customer_id: freeCustomer.id })
        ).toHaveLength(0)
      })
    })
  },
})
