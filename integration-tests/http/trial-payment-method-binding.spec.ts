import path from "path"
import { asValue } from "awilix"
import { medusaIntegrationTestRunner } from "@medusajs/test-utils"
import {
  ContainerRegistrationKeys,
  MedusaError,
  Modules,
} from "@medusajs/framework/utils"
import type { MedusaContainer } from "@medusajs/framework/types"
import {
  createCustomer,
  createProductWithVariant,
  createStoreCustomerAuthHeaders,
} from "../helpers/subscription-fixtures"
import { createPlanOfferSeed } from "../helpers/plan-offer-fixtures"
import { SUBSCRIPTION_MODULE } from "../../src/modules/subscription"
import type SubscriptionModuleService from "../../src/modules/subscription/service"
import { RENEWAL_MODULE } from "../../src/modules/renewal"
import type RenewalModuleService from "../../src/modules/renewal/service"
import { RenewalCycleStatus } from "../../src/modules/renewal/types"
import { TRIAL_CLAIM_MODULE } from "../../src/modules/trial-claim"
import type TrialClaimModuleService from "../../src/modules/trial-claim/service"
import { processRenewalCycleWorkflow } from "../../src/workflows"
import {
  PlanOfferScope,
  PlanOfferStackingPolicy,
} from "../../src/modules/plan-offer/types"

jest.setTimeout(180 * 1000)

const DAY_MS = 86_400_000

/**
 * The fake PayPal provider's declaration id. Deliberately NOT "paypal": the
 * derived registration key must be read off the declaration (the way
 * medusa-paypal's findPaypalProviderDeclaration does), so the test plants a
 * non-default id and asserts the non-default key comes out.
 */
const FAKE_PAYPAL_DECLARATION_ID = "paypal_test"
const FAKE_PAYMENT_PROVIDER_KEY = "pp_paypal_paypal_test"

type ApiKeyModule = {
  createApiKeys: (input: {
    title: string
    type: string
    created_by: string
  }) => Promise<{ token: string }>
}

type SubscriptionRow = {
  id: string
  reference: string
  status: string
  customer_id: string
  is_trial: boolean
  started_at: Date | string
  trial_ends_at: Date | string | null
  next_renewal_at: Date | string | null
  cancelled_at: Date | string | null
  payment_context: {
    payment_provider_id?: string | null
    payment_mode?: string
    mechanism?: string
    payment_method_reference?: string | null
  } | null
  metadata: Record<string, unknown> | null
}

type RenewalCycleRow = {
  id: string
  subscription_id: string
  status: string
  scheduled_for: Date | string
}

type AxiosLikeError = {
  response?: { status: number; data: { message?: string } }
  message: string
}

async function postBind(
  api: {
    post: (url: string, body?: unknown, config?: unknown) => Promise<unknown>
  },
  subscriptionId: string,
  body: Record<string, unknown>,
  headers: Record<string, string>
): Promise<{ status: number; data: { message?: string; bind?: unknown } }> {
  const result = (await api
    .post(`/store/customers/me/trials/${subscriptionId}/bind`, body, {
      headers,
    })
    .catch((error: AxiosLikeError) => {
      if (!error.response) {
        throw error
      }

      return error.response
    })) as { status: number; data: { message?: string; bind?: unknown } }

  return result
}

async function createStoreHeadersWithPublishableKey(
  container: MedusaContainer,
  customer: { id: string }
): Promise<Record<string, string>> {
  const apiKeyModule = container.resolve<ApiKeyModule>(Modules.API_KEY)
  const pk = await apiKeyModule.createApiKeys({
    title: `trial-bind-route-${Date.now()}-${Math.random()}`,
    type: "publishable",
    created_by: "test",
  })
  return {
    ...(await createStoreCustomerAuthHeaders(container, customer)),
    "x-publishable-api-key": pk.token,
  }
}

async function createRegion(
  container: MedusaContainer,
  currency: string
): Promise<{ id: string; currency_code: string }> {
  const regionModule = container.resolve(Modules.REGION) as {
    createRegions: (input: unknown) => Promise<{ id: string }>
  }
  return await regionModule.createRegions({
    name: `trial-bind-${currency}-${Date.now()}-${Math.random()}`,
    currency_code: currency,
  } as never)
}

async function attachPrice(
  container: MedusaContainer,
  variantId: string,
  currency: string,
  amount: number
): Promise<void> {
  const pricingModule = container.resolve(Modules.PRICING) as {
    createPriceSets: (input: {
      prices: Array<{ amount: number; currency_code: string }>
    }) => Promise<{ id: string }>
  }
  const priceSet = await pricingModule.createPriceSets({
    prices: [{ amount, currency_code: currency }],
  })

  const link = container.resolve(ContainerRegistrationKeys.LINK)
  await link.create({
    [Modules.PRODUCT]: {
      variant_id: variantId,
    },
    [Modules.PRICING]: {
      price_set_id: priceSet.id,
    },
  })
}

async function createTrialOffer(container: MedusaContainer, productId: string) {
  const region = await createRegion(container, "usd")
  await createPlanOfferSeed(container, {
    scope: PlanOfferScope.PRODUCT,
    product_id: productId,
    rules: {
      minimum_cycles: 1,
      trial_enabled: true,
      trial_days: 7,
      trial_requires_payment_method: false,
      stacking_policy: PlanOfferStackingPolicy.ALLOWED,
      trial_bonus_days: 3,
    },
  })

  const productModule = container.resolve(Modules.PRODUCT) as {
    updateProducts: (id: string, data: unknown) => Promise<unknown>
  }
  await productModule.updateProducts(productId, { status: "published" })

  return { region }
}

async function claimTrial(
  container: MedusaContainer,
  api: {
    post: (url: string, body?: unknown, config?: unknown) => Promise<unknown>
  },
  input: {
    customer: { id: string }
    variantId: string
    regionId: string
  }
): Promise<{ subscriptionId: string; headers: Record<string, string> }> {
  const headers = await createStoreHeadersWithPublishableKey(
    container,
    input.customer
  )
  const response = (await api.post(
    "/store/customers/me/trials",
    {
      variant_id: input.variantId,
      region_id: input.regionId,
      binding: "none",
    },
    { headers }
  )) as { status: number; data: { trial?: { subscription_id?: string } } }

  expect(response.status).toEqual(201)
  const subscriptionId = response.data.trial?.subscription_id
  expect(subscriptionId).toBeTruthy()

  return { subscriptionId: subscriptionId as string, headers }
}

async function getSubscriptionRow(
  container: MedusaContainer,
  subscriptionId: string
): Promise<SubscriptionRow> {
  const subscriptionModule =
    container.resolve<SubscriptionModuleService>(SUBSCRIPTION_MODULE)
  const rows = (await subscriptionModule.listSubscriptions({
    id: subscriptionId,
  })) as unknown as SubscriptionRow[]

  expect(rows).toHaveLength(1)

  return rows[0]
}

async function listCycles(
  container: MedusaContainer,
  subscriptionId: string
): Promise<RenewalCycleRow[]> {
  const renewalModule = container.resolve<RenewalModuleService>(RENEWAL_MODULE)
  return (await renewalModule.listRenewalCycles({
    subscription_id: subscriptionId,
  } as Record<string, unknown>)) as unknown as RenewalCycleRow[]
}

function toMs(value: Date | string | null | undefined): number {
  expect(value).toBeTruthy()
  return new Date(value as Date | string).getTime()
}

/**
 * Registers the fake payment-methods module the way a host on
 * @mengyyy369/medusa-payment-methods >= 0.2.0 would present it:
 * `container.resolve("paymentMethods")` answers the duck-typed binding
 * surface (0.2.0 takes the container as its first argument — the arity IS
 * the version discriminator, so the fake's methods are declared with two
 * parameters), and the returned method row carries the provider key the
 * renewal engine charges through. Returns a restore function — the suite's
 * container is shared by the file's tests.
 */
function registerFakeVaultProvider(
  container: MedusaContainer,
  input: {
    setupTokenId: string
    approveUrl: string
    vaultId: string
    completionStatus?: string
  }
): {
  fakeVaultModule: {
    startCalls: Array<Record<string, unknown>>
    completeCalls: Array<Record<string, unknown>>
  }
  restore: () => void
} {
  // Plain async functions, NOT jest.fn(): the 0.2.0 capability resolver
  // reads the function's arity (length >= 2) as the version gate, and a
  // jest.fn() mock always reports length 0 no matter its implementation,
  // which made the resolver refuse the fake as an outdated module.
  const startCalls: Array<Record<string, unknown>> = []
  const completeCalls: Array<Record<string, unknown>> = []
  const fakeVaultModule = {
    // Two declared parameters: the 0.2.0 binding surface is (container,
    // input), and reorder's capability resolver reads the arity as the
    // version gate.
    startBinding: async function (_container: unknown, call: unknown) {
      startCalls.push(call as Record<string, unknown>)
      return { approvalUrl: input.approveUrl, state: input.setupTokenId }
    },
    completeBinding: async function (_container: unknown, call: unknown) {
      completeCalls.push(call as Record<string, unknown>)
      if (input.completionStatus) {
        // The sandbox's real pending case, surfaced the way the plugin's
        // binder authors it: an invalid_data refusal the route quotes.
        throw new MedusaError(
          MedusaError.Types.INVALID_DATA,
          `PayPal setup token is not approved (status: ${input.completionStatus})`
        )
      }

      return {
        method: {
          id: input.vaultId,
          provider_id: FAKE_PAYMENT_PROVIDER_KEY,
        },
      }
    },
  }

  container.register({ paymentMethods: asValue(fakeVaultModule) })

  // Plant the PayPal-shaped declaration on the resolved payment module: the
  // renewal charge dispatch still routes by the provider key the fake's
  // method row carries, and no real provider answers it in the test container.
  const paymentModule = container.resolve(Modules.PAYMENT) as unknown as {
    moduleDeclaration?: { providers?: Array<Record<string, unknown>> }
  }
  const previousDeclaration = paymentModule.moduleDeclaration
  paymentModule.moduleDeclaration = {
    ...(previousDeclaration ?? {}),
    providers: [
      ...(previousDeclaration?.providers ?? []),
      {
        resolve: "@mengyyy369/medusa-paypal/providers/paypal",
        id: FAKE_PAYPAL_DECLARATION_ID,
        options: {},
      },
    ],
  }
  return {
    fakeVaultModule: { startCalls, completeCalls },
    restore: () => {
      container.register({ paymentMethods: asValue(null) })
      paymentModule.moduleDeclaration = previousDeclaration
    },
  }
}

/**
 * The bound subscription's `payment_provider_id` is the derived
 * `pp_paypal_paypal_test` key, which no real provider answers in the test
 * container — the payment module's provider dispatch happens inside its own
 * isolated module container, which a test cannot register into. So the
 * off-session charge is completed by spying on the payment module's
 * `paymentProviderService_` dispatch (account holder + create session ->
 * authorize -> capture), returning exactly what Medusa's own system-default
 * provider returns. Every payment row is still real: sessions, authorizations
 * and captures persist through the module's own service methods.
 */
function spyPaymentProviderDispatch(container: MedusaContainer): void {
  const paymentModule = container.resolve(Modules.PAYMENT) as unknown as {
    paymentProviderService_?: {
      createSession: (
        providerId: string,
        input: { data?: Record<string, unknown> }
      ) => Promise<unknown>
      authorizePayment: (
        providerId: string,
        input: unknown
      ) => Promise<unknown>
      capturePayment: (providerId: string, input: unknown) => Promise<unknown>
      createAccountHolder: (input: unknown) => Promise<unknown>
    }
  }

  const providerService = paymentModule.paymentProviderService_
  if (!providerService) {
    throw new Error("Payment module does not expose paymentProviderService_")
  }

  jest
    .spyOn(providerService, "createAccountHolder")
    .mockImplementation(async () => ({ id: "fake-account-holder" }))
  jest
    .spyOn(providerService, "createSession")
    .mockImplementation(async (_providerId, input) => ({
      // The PayPal provider's off-session short-circuit: the vault id rides
      // in `data.payment_method`.
      data: { payment_method: input.data?.payment_method },
      id: `fake-provider-session-${Math.random()}`,
      status: "pending",
    }))
  jest
    .spyOn(providerService, "authorizePayment")
    .mockImplementation(async () => ({ data: {}, status: "authorized" }))
  jest
    .spyOn(providerService, "capturePayment")
    .mockImplementation(async () => ({ data: {} }))
}

async function queryLinkedOrderIds(
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
  testSuite: ({ api, getContainer }) => {
    describe("POST /store/customers/me/trials/:id/bind (two-phase vault binding)", () => {
      let runId: string

      beforeEach(() => {
        jest.restoreAllMocks()
        runId = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`
      })

      it("binds an approved setup token: auto mode, declaration-derived provider id, extension anchored on started_at, one re-pointed cycle, vault ledger", async () => {
        const container = getContainer()
        const trialClaimModule =
          container.resolve<TrialClaimModuleService>(TRIAL_CLAIM_MODULE)
        const { product, variant } = await createProductWithVariant(container)
        const customer = await createCustomer(container)
        const { region } = await createTrialOffer(container, product.id)
        await attachPrice(container, variant.id, "usd", 1800)

        const { subscriptionId, headers } = await claimTrial(container, api, {
          customer,
          variantId: variant.id,
          regionId: region.id,
        })

        const beforeBind = await getSubscriptionRow(container, subscriptionId)
        const originalEndMs = toMs(beforeBind.trial_ends_at)
        const startedMs = toMs(beforeBind.started_at)

        const { restore, fakeVaultModule } = registerFakeVaultProvider(
          container,
          {
            setupTokenId: `ST-${runId}`,
            approveUrl: `https://www.sandbox.paypal.com/vault/setup-tokens/ST-${runId}`,
            vaultId: `VAULT-${runId}`,
          }
        )

        try {
          // Phase (a): the approval starts, the approve_url comes back, and
          // the unbound trial keeps its original single cycle and stays
          // card-free.
          const start = await postBind(
            api,
            subscriptionId,
            {
              action: "start",
              return_url: "https://storefront.example/subscription/return",
              cancel_url: "https://storefront.example/subscription/cancel",
            },
            headers
          )
          expect(start.status).toEqual(200)
          expect(start.data.bind).toMatchObject({
            phase: "approval_pending",
            subscription_id: subscriptionId,
            setup_token_id: `ST-${runId}`,
          })

          // The provider half is DELEGATED (B6): the plugin's binding surface
          // was called with the trial scope and the caller-owned routes.
          expect(fakeVaultModule.startCalls[0]).toMatchObject(
            expect.objectContaining({
              customerId: customer.id,
              scope: "trial",
              returnUrl: "https://storefront.example/subscription/return",
              cancelUrl: "https://storefront.example/subscription/cancel",
            })
          )

          const pending = await getSubscriptionRow(container, subscriptionId)
          expect(pending.metadata?.trial_binding).toMatchObject({
            state: `ST-${runId}`,
          })
          expect(pending.payment_context?.payment_mode).toEqual("manual")
          expect(pending.payment_context?.payment_method_reference ?? null).toBeNull()

          const pendingCycles = await listCycles(container, subscriptionId)
          expect(pendingCycles).toHaveLength(1)
          expect(toMs(pendingCycles[0].scheduled_for)).toBe(originalEndMs)

          // Phase (b): the customer returned from PayPal; the token is
          // exchanged and the trial is bound.
          const complete = await postBind(
            api,
            subscriptionId,
            { action: "complete", setup_token_id: `ST-${runId}` },
            headers
          )
          expect(complete.status).toEqual(200)
          expect(complete.data.bind).toMatchObject({
            phase: "bound",
            subscription_id: subscriptionId,
            // The plugin ledger's provider key, returned on the method row —
            // not a hardcoded "pp_paypal_paypal" literal.
            payment_provider_id: FAKE_PAYMENT_PROVIDER_KEY,
            payment_method_reference: `VAULT-${runId}`,
            payment_mode: "auto",
            bonus_days_applied: 3,
          })

          // The completion is delegated with the same session state the start
          // minted, still under the trial scope.
          expect(fakeVaultModule.completeCalls[0]).toMatchObject(
            expect.objectContaining({
              customerId: customer.id,
              state: `ST-${runId}`,
              scope: "trial",
            })
          )

          const bound = await getSubscriptionRow(container, subscriptionId)
          expect(bound.payment_context?.payment_mode).toEqual("auto")
          expect(bound.payment_context?.mechanism).toEqual("reorder_auto")
          expect(bound.payment_context?.payment_provider_id).toEqual(
            FAKE_PAYMENT_PROVIDER_KEY
          )
          expect(bound.payment_context?.payment_method_reference).toEqual(
            `VAULT-${runId}`
          )

          // The extension is anchored on started_at: 7 trial days + 3 bonus.
          const expectedEndMs = startedMs + 10 * DAY_MS
          expect(Math.abs(toMs(bound.trial_ends_at) - expectedEndMs)).toBeLessThan(1000)
          expect(
            Math.abs(toMs(bound.next_renewal_at) - expectedEndMs)
          ).toBeLessThan(1000)
          expect(bound.metadata?.trial_binding).toBeNull()
          expect(bound.metadata?.binding).toEqual("vault")

          // The ledger records the bound rail.
          const claims = (await trialClaimModule.listTrialClaims({
            subscription_id: subscriptionId,
          })) as Array<{ binding_method: string }>
          expect(claims).toHaveLength(1)
          expect(claims[0].binding_method).toEqual("vault")

          // Exactly ONE cycle survives the re-point, standing on the
          // extended date — the stale-cycle-every-five-minutes failure mode
          // is the risk here, not a double charge.
          const cycles = await listCycles(container, subscriptionId)
          expect(cycles).toHaveLength(1)
          expect(cycles[0].status).toEqual(RenewalCycleStatus.SCHEDULED)
          expect(
            Math.abs(toMs(cycles[0].scheduled_for) - expectedEndMs)
          ).toBeLessThan(1000)
        } finally {
          restore()
        }
      })

      it("charges the bound trial exactly once at the extended date", async () => {
        const container = getContainer()
        const renewalModule = container.resolve<RenewalModuleService>(RENEWAL_MODULE)
        const paymentModule = container.resolve(Modules.PAYMENT) as {
          listPaymentCollections: (
            filters: unknown,
            config: unknown
          ) => Promise<Array<{
            id: string
            amount: number
            payments: Array<{ id: string; captured_at: string | null }>
          }>>
        }
        const { product, variant } = await createProductWithVariant(container)
        const customer = await createCustomer(container)
        const { region } = await createTrialOffer(container, product.id)
        await attachPrice(container, variant.id, "usd", 1800)

        const { subscriptionId, headers } = await claimTrial(container, api, {
          customer,
          variantId: variant.id,
          regionId: region.id,
        })

        spyPaymentProviderDispatch(container)
        const { restore } = registerFakeVaultProvider(container, {
          setupTokenId: `ST-${runId}`,
          approveUrl: `https://www.sandbox.paypal.com/vault/setup-tokens/ST-${runId}`,
          vaultId: `VAULT-${runId}`,
        })

        try {
          const start = await postBind(
            api,
            subscriptionId,
            {
              action: "start",
              return_url: "https://storefront.example/return",
              cancel_url: "https://storefront.example/cancel",
            },
            headers
          )
          expect(start.status).toEqual(200)

          const complete = await postBind(
            api,
            subscriptionId,
            { action: "complete", setup_token_id: `ST-${runId}` },
            headers
          )
          expect(complete.status).toEqual(200)

          // Time-travel the bound trial to its end: the anchors move together
          // (fixture work only — the workflow itself never writes
          // scheduled_for directly), so the cycle sits exactly at the
          // (backdated) extended trial_ends_at the way the scheduler meets it.
          const past = new Date(Date.now() - 5 * 60_000)
          const subscriptionModule =
            container.resolve<SubscriptionModuleService>(SUBSCRIPTION_MODULE)
          await subscriptionModule.updateSubscriptions({
            id: subscriptionId,
            trial_ends_at: past,
            next_renewal_at: past,
          } as never)

          const cycles = await listCycles(container, subscriptionId)
          expect(cycles).toHaveLength(1)
          await renewalModule.updateRenewalCycles({
            id: cycles[0].id,
            scheduled_for: past,
          } as never)

          const { result } = await processRenewalCycleWorkflow(container).run({
            input: {
              renewal_cycle_id: cycles[0].id,
              trigger_type: "scheduler",
            },
          })

          expect(result.renewal_cycle.status).toEqual(
            RenewalCycleStatus.SUCCEEDED
          )

          // Exactly one charge: one order, one collection, one captured
          // payment.
          const orderIds = await queryLinkedOrderIds(container, subscriptionId)
          expect(orderIds).toHaveLength(1)

          const query = container.resolve(ContainerRegistrationKeys.QUERY)
          const { data: collectionLinks } = await query.graph({
            entity: "order_payment_collection",
            fields: ["payment_collection_id"],
            filters: { order_id: orderIds[0] },
          })
          const collectionIds = (collectionLinks as Array<{
            payment_collection_id: string
          }>).map((entry) => entry.payment_collection_id)
          expect(collectionIds).toHaveLength(1)

          const collections = await paymentModule.listPaymentCollections(
            { id: collectionIds },
            { relations: ["payments"] }
          )
          expect(collections).toHaveLength(1)
          expect(collections[0].amount).toEqual(1800)
          expect(collections[0].payments).toHaveLength(1)
          expect(collections[0].payments[0].captured_at).toBeTruthy()

          // The conversion anchors the next period on the extended date.
          const bound = await getSubscriptionRow(container, subscriptionId)
          expect(bound.status).toEqual("active")
          const expectedNextPeriod = new Date(past)
          expectedNextPeriod.setUTCMonth(expectedNextPeriod.getUTCMonth() + 1)
          expect(
            Math.abs(toMs(bound.next_renewal_at) - expectedNextPeriod.getTime())
          ).toBeLessThan(1000)

          // The charged period is settled and exactly ONE next scheduled
          // cycle stands after it, on the converted anchor.
          const cyclesAfter = await listCycles(container, subscriptionId)
          const scheduledAfter = cyclesAfter.filter(
            (cycle) => cycle.status === RenewalCycleStatus.SCHEDULED
          )
          expect(scheduledAfter).toHaveLength(1)
          expect(scheduledAfter[0].id).not.toEqual(cycles[0].id)
          expect(
            Math.abs(
              toMs(scheduledAfter[0].scheduled_for) - expectedNextPeriod.getTime()
            )
          ).toBeLessThan(1000)
        } finally {
          restore()
        }
      })

      it("binding on day 5 lands on the same started_at + (trial + bonus) date binding on day 1 would have produced", async () => {
        const container = getContainer()
        const renewalModule = container.resolve<RenewalModuleService>(RENEWAL_MODULE)
        const { product, variant } = await createProductWithVariant(container)
        const customerA = await createCustomer(container, {
          email: `bind-day1-${runId}@medusa.test`,
        })
        const customerB = await createCustomer(container, {
          email: `bind-day5-${runId}@medusa.test`,
        })
        const { region } = await createTrialOffer(container, product.id)
        await attachPrice(container, variant.id, "usd", 1800)

        const { restore } = registerFakeVaultProvider(container, {
          setupTokenId: `ST-${runId}`,
          approveUrl: `https://www.sandbox.paypal.com/vault/setup-tokens/ST-${runId}`,
          vaultId: `VAULT-${runId}`,
        })

        try {
          const claimA = await claimTrial(container, api, {
            customer: customerA,
            variantId: variant.id,
            regionId: region.id,
          })

          // Day-1 bind: the extension is 7 + 3 days after the trial started.
          const startA = await postBind(
            api,
            claimA.subscriptionId,
            {
              action: "start",
              return_url: "https://storefront.example/return",
              cancel_url: "https://storefront.example/cancel",
            },
            claimA.headers
          )
          expect(startA.status).toEqual(200)
          const completeA = await postBind(
            api,
            claimA.subscriptionId,
            { action: "complete", setup_token_id: `ST-${runId}` },
            claimA.headers
          )
          expect(completeA.status).toEqual(200)
          const boundA = await getSubscriptionRow(container, claimA.subscriptionId)
          const expectedEndA = toMs(boundA.started_at) + 10 * DAY_MS
          expect(Math.abs(toMs(boundA.trial_ends_at) - expectedEndA)).toBeLessThan(1000)

          // Day-5 bind: a second customer's trial is backdated so five days
          // of its seven have already elapsed when the binding happens.
          const claimB = await claimTrial(container, api, {
            customer: customerB,
            variantId: variant.id,
            regionId: region.id,
          })
          const fiveDaysAgo = new Date(Date.now() - 5 * DAY_MS)
          const twoDaysFromNow = new Date(Date.now() + 2 * DAY_MS)
          const subscriptionModule =
            container.resolve<SubscriptionModuleService>(SUBSCRIPTION_MODULE)
          await subscriptionModule.updateSubscriptions({
            id: claimB.subscriptionId,
            started_at: fiveDaysAgo,
            trial_ends_at: twoDaysFromNow,
            next_renewal_at: twoDaysFromNow,
          } as never)
          const cyclesB = await listCycles(container, claimB.subscriptionId)
          expect(cyclesB).toHaveLength(1)
          await renewalModule.updateRenewalCycles({
            id: cyclesB[0].id,
            scheduled_for: twoDaysFromNow,
          } as never)

          const startB = await postBind(
            api,
            claimB.subscriptionId,
            {
              action: "start",
              return_url: "https://storefront.example/return",
              cancel_url: "https://storefront.example/cancel",
            },
            claimB.headers
          )
          expect(startB.status).toEqual(200)
          const completeB = await postBind(
            api,
            claimB.subscriptionId,
            { action: "complete", setup_token_id: `ST-${runId}` },
            claimB.headers
          )
          expect(completeB.status).toEqual(200)

          // The end date moved nowhere the customer could not predict: it is
          // the trial's own started_at + 10 days — identical to what binding
          // on day 1 would have produced, never now + 10 days.
          const boundB = await getSubscriptionRow(container, claimB.subscriptionId)
          const expectedEndB = toMs(boundB.started_at) + 10 * DAY_MS
          expect(Math.abs(toMs(boundB.trial_ends_at) - expectedEndB)).toBeLessThan(1000)
          expect(Math.abs(expectedEndB - twoDaysFromNow.getTime() - 3 * DAY_MS)).toBeLessThan(1000)

          const cyclesAfterB = await listCycles(container, claimB.subscriptionId)
          expect(cyclesAfterB).toHaveLength(1)
          expect(
            Math.abs(toMs(cyclesAfterB[0].scheduled_for) - expectedEndB)
          ).toBeLessThan(1000)
        } finally {
          restore()
        }
      })

      it("leaves an unbound trial to end at its original date with no charge", async () => {
        const container = getContainer()
        const renewalModule = container.resolve<RenewalModuleService>(RENEWAL_MODULE)
        const { product, variant } = await createProductWithVariant(container)
        const customer = await createCustomer(container)
        const { region } = await createTrialOffer(container, product.id)
        await attachPrice(container, variant.id, "usd", 1800)

        const { subscriptionId } = await claimTrial(container, api, {
          customer,
          variantId: variant.id,
          regionId: region.id,
        })

        const before = await getSubscriptionRow(container, subscriptionId)
        const originalEnd = new Date(toMs(before.trial_ends_at))

        // No binding happens. The trial runs out at its original date.
        const past = new Date(Date.now() - 5 * 60_000)
        expect(originalEnd.getTime()).toBeGreaterThan(Date.now())

        const subscriptionModule =
          container.resolve<SubscriptionModuleService>(SUBSCRIPTION_MODULE)
        await subscriptionModule.updateSubscriptions({
          id: subscriptionId,
          trial_ends_at: past,
          next_renewal_at: past,
        } as never)
        const cycles = await listCycles(container, subscriptionId)
        expect(cycles).toHaveLength(1)
        await renewalModule.updateRenewalCycles({
          id: cycles[0].id,
          scheduled_for: past,
        } as never)

        const { result } = await processRenewalCycleWorkflow(container).run({
          input: {
            renewal_cycle_id: cycles[0].id,
            trigger_type: "scheduler",
          },
        })

        // The manual rail ends the trial deterministically: no order, no
        // charge, cancelled effective exactly at the original anchor.
        expect(result.renewal_cycle.status).toEqual(RenewalCycleStatus.SUCCEEDED)
        expect(result.generated_order_id).toBeNull()

        const ended = await getSubscriptionRow(container, subscriptionId)
        expect(ended.status).toEqual("cancelled")
        expect(ended.payment_context?.payment_method_reference ?? null).toBeNull()

        const orderIds = await queryLinkedOrderIds(container, subscriptionId)
        expect(orderIds).toHaveLength(0)
      })

      it("answers 404 when a customer binds a subscription they do not own", async () => {
        const container = getContainer()
        const { product, variant } = await createProductWithVariant(container)
        const owner = await createCustomer(container)
        const stranger = await createCustomer(container)
        const { region } = await createTrialOffer(container, product.id)
        await attachPrice(container, variant.id, "usd", 1800)

        const { subscriptionId } = await claimTrial(container, api, {
          customer: owner,
          variantId: variant.id,
          regionId: region.id,
        })

        const { restore } = registerFakeVaultProvider(container, {
          setupTokenId: `ST-${runId}`,
          approveUrl: `https://www.sandbox.paypal.com/vault/setup-tokens/ST-${runId}`,
          vaultId: `VAULT-${runId}`,
        })

        try {
          const strangerHeaders = await createStoreHeadersWithPublishableKey(
            container,
            stranger
          )
          const start = await postBind(
            api,
            subscriptionId,
            {
              action: "start",
              return_url: "https://storefront.example/return",
              cancel_url: "https://storefront.example/cancel",
            },
            strangerHeaders
          )
          expect(start.status).toEqual(404)
          expect(start.data.message).toEqual(
            `Subscription '${subscriptionId}' was not found for the authenticated customer.`
          )

          const pending = await getSubscriptionRow(container, subscriptionId)
          expect(pending.metadata?.trial_binding).toBeUndefined()
        } finally {
          restore()
        }
      })

      it("refuses the binding when the installed provider predates the capability, leaving the trial untouched and card-free", async () => {
        const container = getContainer()
        const trialClaimModule =
          container.resolve<TrialClaimModuleService>(TRIAL_CLAIM_MODULE)
        const { product, variant } = await createProductWithVariant(container)
        const customer = await createCustomer(container)
        const { region } = await createTrialOffer(container, product.id)
        await attachPrice(container, variant.id, "usd", 1800)

        const { subscriptionId, headers } = await claimTrial(container, api, {
          customer,
          variantId: variant.id,
          regionId: region.id,
        })

        // An outdated @mengyyy369/medusa-payment-methods: resolvable, but
        // without the 0.2.0 binding methods. The duck-type, not the package
        // version, is the gate; the arity is the version discriminator.
        container.register({
          paymentMethods: asValue({
            listCustomerPaymentMethods: jest.fn(),
          }),
        })

        try {
          const start = await postBind(
            api,
            subscriptionId,
            {
              action: "start",
              return_url: "https://storefront.example/return",
              cancel_url: "https://storefront.example/cancel",
            },
            headers
          )
          expect(start.status).toEqual(400)
          expect(start.data.message).toContain(
            "the installed payment-methods module does not provide the binding capability"
          )

          // Untouched and card-free: no pending binding, no payment mode
          // change, no stored reference, ledger still unbound, and the
          // original cycle still standing at the original date.
          const untouched = await getSubscriptionRow(container, subscriptionId)
          expect(untouched.metadata?.trial_binding).toBeUndefined()
          expect(untouched.payment_context?.payment_mode).toEqual("manual")
          expect(untouched.payment_context?.payment_method_reference ?? null).toBeNull()
          expect(untouched.payment_context?.payment_provider_id ?? null).toBeNull()

          const claims = (await trialClaimModule.listTrialClaims({
            subscription_id: subscriptionId,
          })) as Array<{ binding_method: string }>
          expect(claims[0].binding_method).toEqual("none")

          const cycles = await listCycles(container, subscriptionId)
          expect(cycles).toHaveLength(1)
          expect(cycles[0].status).toEqual(RenewalCycleStatus.SCHEDULED)
          expect(toMs(cycles[0].scheduled_for)).toBe(toMs(untouched.trial_ends_at))
        } finally {
          container.register({ paymentMethods: asValue(null) })
        }
      })

      it("refuses completing a binding that was never started, and a not-yet-approved token binds nothing", async () => {
        const container = getContainer()
        const { product, variant } = await createProductWithVariant(container)
        const customer = await createCustomer(container)
        const { region } = await createTrialOffer(container, product.id)
        await attachPrice(container, variant.id, "usd", 1800)

        const { subscriptionId, headers } = await claimTrial(container, api, {
          customer,
          variantId: variant.id,
          regionId: region.id,
        })

        const { restore } = registerFakeVaultProvider(container, {
          setupTokenId: `ST-${runId}`,
          approveUrl: `https://www.sandbox.paypal.com/vault/setup-tokens/ST-${runId}`,
          vaultId: `VAULT-${runId}`,
          // The sandbox's real pending status: the buyer has not approved.
          completionStatus: "PAYER_ACTION_REQUIRED",
        })

        try {
          const premature = await postBind(
            api,
            subscriptionId,
            { action: "complete", setup_token_id: `ST-${runId}` },
            headers
          )
          expect(premature.status).toEqual(400)
          expect(premature.data.message).toEqual(
            "This trial has no pending payment-method approval. Start the binding first."
          )

          const start = await postBind(
            api,
            subscriptionId,
            {
              action: "start",
              return_url: "https://storefront.example/return",
              cancel_url: "https://storefront.example/cancel",
            },
            headers
          )
          expect(start.status).toEqual(200)

          const notApproved = await postBind(
            api,
            subscriptionId,
            { action: "complete", setup_token_id: `ST-${runId}` },
            headers
          )
          expect(notApproved.status).toEqual(400)
          expect(notApproved.data.message).toContain(
            "PayPal setup token is not approved (status:"
          )

          const untouched = await getSubscriptionRow(container, subscriptionId)
          expect(untouched.payment_context?.payment_mode).toEqual("manual")
          expect(untouched.payment_context?.payment_method_reference ?? null).toBeNull()
          // The pending binding survives, so the customer can retry the
          // completion after actually approving in PayPal.
          expect(untouched.metadata?.trial_binding).toMatchObject({
            state: `ST-${runId}`,
          })
        } finally {
          restore()
        }
      })

      it("requires customer authentication on the nested bind route", async () => {
        const container = getContainer()
        const apiKeyModule = container.resolve<ApiKeyModule>(Modules.API_KEY)
        const pk = await apiKeyModule.createApiKeys({
          title: `trial-bind-anon-${Date.now()}`,
          type: "publishable",
          created_by: "test",
        })

        const response = (await api
          .post(
            "/store/customers/me/trials/does-not-matter/bind",
            { action: "start" },
            { headers: { "x-publishable-api-key": pk.token } }
          )
          .catch((error: AxiosLikeError) => {
            if (!error.response) {
              throw error
            }

            return error.response
          })) as { status: number }

        // The trials prefix middleware covers the nested action route: an
        // anonymous call is refused by authentication, not by a missing route.
        expect(response.status).toEqual(401)
      })
    })
  },
})
