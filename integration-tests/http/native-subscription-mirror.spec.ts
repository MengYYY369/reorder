import path from "path"
import { asValue } from "awilix"
import { medusaIntegrationTestRunner } from "@medusajs/test-utils"
import { Modules, MedusaError } from "@medusajs/framework/utils"
import type { MedusaContainer } from "@medusajs/framework/types"
import {
  NATIVE_SUBSCRIPTION_CHANGED_EVENT,
  type NativeSubscriptionChangedPayload,
  type NativeSubscriptionRecord,
  type ProviderCapabilityView,
} from "@mengyyy369/medusa-payment-methods"
import nativeSubscriptionMirrorHandler from "../../src/subscribers/native-subscription-mirror"
import nativeSubscriptionBackfillJob from "../../src/jobs/native-subscription-backfill"
import { SUBSCRIPTION_MODULE } from "../../src/modules/subscription"
import type SubscriptionModuleService from "../../src/modules/subscription/service"
import {
  SubscriptionFrequencyInterval,
  SubscriptionStatus,
  type SubscriptionPaymentContext,
} from "../../src/modules/subscription/types"
import { listDueRenewalCyclesForProcessing } from "../../src/modules/renewal/utils/scheduler-query"
import { createRenewalCycleSeed } from "../helpers/renewal-fixtures"
import {
  createCustomer,
  createProductWithVariant,
  createSubscriptionSeed,
} from "../helpers/subscription-fixtures"

jest.setTimeout(120 * 1000)

const BRIDGE_SECRET = "test-bridge-secret"

const PAYPAL_ID = "I-MIRROR01"

/** The registration key the capability view maps the `paypal` kind to. */
const PAYPAL_PROVIDER_ID = "pp_paypal_paypal"

/** `NATIVE-{kind}-{providerSubscriptionId}` — the key the mirror upserts on. */
function mirrorReference(providerSubscriptionId: string): string {
  return `NATIVE-paypal-${providerSubscriptionId}`
}

/**
 * A rail-neutral record as the provider publishes it on
 * `payment-rail.native_subscription.changed`. `product_id` is deliberately
 * absent: the handler resolves it from `variant_id` through the catalog, so a
 * test that wants a row has to seed a real variant and override `variant_id`.
 *
 * `provider_id` is the provider's own echo and is deliberately `null` here
 * (the real payloads often are): the row's `payment_provider_id` must come from
 * the capability view's registration key, never from this field.
 */
const ACTIVATED_PAYLOAD: NativeSubscriptionChangedPayload = {
  provider_subscription_id: PAYPAL_ID,
  plan_id: "P-PLAN1",
  status: "active",
  customer_id: null,
  variant_id: null,
  interval_unit: "MONTH",
  interval_count: 1,
  next_billing_at: "2026-11-01T00:00:00Z",
  last_billing_at: "2026-10-01T00:00:00Z",
  kind: "paypal",
  provider_id: null,
  transition: "payment_succeeded",
}

/**
 * The fake `paymentMethods` module a host on
 * `@mengyyy369/medusa-payment-methods` registers: the mirror handler and the
 * backfill job resolve their capability view from the container and map
 * `kind` → the registration key. Without a registration both warn and write
 * nothing.
 *
 * `records` is handed back by reference so a test can change what the next
 * `listRecords` pass returns. Returns a restore function — the suite's
 * container is shared by the file's tests (same pattern as
 * `trial-payment-method-binding.spec.ts`).
 */
function registerFakePaymentMethods(
  container: MedusaContainer,
  records: NativeSubscriptionRecord[] = []
): { records: NativeSubscriptionRecord[]; restore: () => void } {
  const capability: ProviderCapabilityView = {
    provider_id: PAYPAL_PROVIDER_ID,
    kind: "paypal",
    display_name: "PayPal",
    display_name_i18n: null,
    binding: { supported: true },
    native: {
      supported: true,
      readVariantDeclaration: () => null,
      listRecords: async () => records,
      cancel: async () => ({
        status: "skipped",
        reason: "provider_row_missing",
      }),
    },
  }

  container.register({
    paymentMethods: asValue({
      getProviderCapabilities: async () => [capability],
    }),
  })

  return {
    records,
    restore: () => {
      container.register({ paymentMethods: asValue(null) })
    },
  }
}

/**
 * Delivers the rail-neutral event straight to the subscriber, the way the
 * provider's injected hook publishes it on the bus.
 */
async function emit(
  container: MedusaContainer,
  data: Record<string, unknown>
) {
  await nativeSubscriptionMirrorHandler({
    event: {
      name: NATIVE_SUBSCRIPTION_CHANGED_EVENT,
      data,
      broadcast: false,
    },
    container,
    pluginOptions: {},
  } as never)
}

/**
 * Headers `/store/saas/auto-renew` accepts: a publishable key plus the bridge
 * secret and tenant the SaaS bridge sends.
 */
async function bridgeRequestHeaders(
  container: MedusaContainer
): Promise<Record<string, string>> {
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

  return {
    "x-publishable-api-key": publishableKey.token,
    "x-bridge-secret": BRIDGE_SECRET,
    "x-tenant-id": "default",
  }
}

/**
 * The members `acquireLockStep` / `releaseLockStep` call on the locking module
 * (`@medusajs/core-flows/dist/locking/steps/acquire-lock.js`), and nothing else:
 * the steps go through `acquire`/`release`, never through `execute`, which is
 * what the locking-interception form in `analytics-workflows.spec.ts` wraps.
 */
type LockingServiceLike = {
  acquire(
    keys: string | string[],
    args?: { ownerId?: string; expire?: number; provider?: string }
  ): Promise<void>
  release(
    keys: string | string[],
    args?: { ownerId?: string; provider?: string }
  ): Promise<boolean>
}

/** The lock family this endpoint owns; a second prefix would not serialize it. */
const AUTO_RENEW_LOCK_PREFIX = "auto-renew:"

function lockKeys(keys: string | string[]): string[] {
  return Array.isArray(keys) ? keys : [keys]
}

function autoRenewKeys(calls: [string | string[], ...unknown[]][]): string[] {
  return calls
    .flatMap(([keys]) => lockKeys(keys))
    .filter((key) => key.startsWith(AUTO_RENEW_LOCK_PREFIX))
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
        const { product, variant } = await createProductWithVariant(container)
        const { restore } = registerFakePaymentMethods(container)

        try {
          const payload = {
            ...ACTIVATED_PAYLOAD,
            customer_id: customer.id,
            variant_id: variant.id,
          }

          await emit(container, payload)
          await emit(container, payload)

          const rows = await subscriptionModule.listSubscriptions({
            reference: [mirrorReference(PAYPAL_ID)],
          })

          expect(rows).toHaveLength(1)
          expect(rows[0]).toMatchObject({
            reference: mirrorReference(PAYPAL_ID),
            status: SubscriptionStatus.ACTIVE,
            customer_id: customer.id,
            product_id: product.id,
            variant_id: variant.id,
            frequency_interval: SubscriptionFrequencyInterval.MONTH,
            frequency_value: 1,
          })
          expect(rows[0].payment_context).toMatchObject({
            // The capability view's registration key, not the payload's echo
            // (which is null in this fixture).
            payment_provider_id: PAYPAL_PROVIDER_ID,
            payment_mode: "manual",
            mechanism: "native",
            customer_payment_reference: PAYPAL_ID,
          })
          expect(rows[0].metadata).toMatchObject({
            source: "native_mirror",
            plan_id: "P-PLAN1",
          })
          expect(new Date(rows[0].next_renewal_at!).toISOString()).toEqual(
            "2026-11-01T00:00:00.000Z"
          )

          await emit(container, {
            ...payload,
            status: "past_due",
            // A failed charge says nothing new about the date: the row must
            // keep the one the provider reported earlier.
            next_billing_at: null,
            transition: "payment_failed",
          })

          const afterFailure = await subscriptionModule.listSubscriptions({
            reference: [mirrorReference(PAYPAL_ID)],
          })

          expect(afterFailure).toHaveLength(1)
          expect(afterFailure[0].status).toEqual(SubscriptionStatus.PAST_DUE)
          expect(
            new Date(afterFailure[0].next_renewal_at!).toISOString()
          ).toEqual("2026-11-01T00:00:00.000Z")
        } finally {
          restore()
        }
      })

      it("leaves the renewal date null when activation reported none", async () => {
        const container = getContainer()
        const subscriptionModule = container.resolve<SubscriptionModuleService>(
          SUBSCRIPTION_MODULE
        )
        const customer = await createCustomer(container)
        const { variant } = await createProductWithVariant(container)
        const { restore } = registerFakePaymentMethods(container)

        try {
          await emit(container, {
            ...ACTIVATED_PAYLOAD,
            customer_id: customer.id,
            variant_id: variant.id,
            provider_subscription_id: "I-NODATE01",
            next_billing_at: null,
            last_billing_at: null,
          })

          const [row] = await subscriptionModule.listSubscriptions({
            reference: [mirrorReference("I-NODATE01")],
          })

          expect(row).toBeDefined()
          expect(row.next_renewal_at).toBeNull()
        } finally {
          restore()
        }
      })

      it("writes nothing when the payload cannot build a row", async () => {
        const container = getContainer()
        const subscriptionModule = container.resolve<SubscriptionModuleService>(
          SUBSCRIPTION_MODULE
        )
        const customer = await createCustomer(container)
        const { variant } = await createProductWithVariant(container)
        const { restore } = registerFakePaymentMethods(container)

        try {
          // No variant means no product to resolve: a row built without one
          // would look like a live recurrence and block the wrong checkout.
          await emit(container, {
            ...ACTIVATED_PAYLOAD,
            customer_id: customer.id,
            variant_id: null,
            provider_subscription_id: "I-PARTIAL1",
          })

          // The rail's `null` status is "do not mirror" (an approval nobody
          // finished), and a status outside the vocabulary is not writable
          // either.
          await emit(container, {
            ...ACTIVATED_PAYLOAD,
            customer_id: customer.id,
            variant_id: variant.id,
            provider_subscription_id: "I-NULLSTATUS1",
            status: null,
          })
          await emit(container, {
            ...ACTIVATED_PAYLOAD,
            customer_id: customer.id,
            variant_id: variant.id,
            provider_subscription_id: "I-UNKNOWN1",
            status: "something_new",
          })

          expect(
            await subscriptionModule.listSubscriptions({
              reference: [
                mirrorReference("I-PARTIAL1"),
                mirrorReference("I-NULLSTATUS1"),
                mirrorReference("I-UNKNOWN1"),
              ],
            })
          ).toHaveLength(0)
        } finally {
          restore()
        }
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
            source_payment_collection_id: null,
            source_payment_session_id: null,
            payment_method_reference: null,
            customer_payment_reference: null,
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
            source_payment_collection_id: null,
            source_payment_session_id: null,
            customer_payment_reference: null,
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
            source_payment_collection_id: null,
            source_payment_session_id: null,
            payment_method_reference: null,
            customer_payment_reference: null,
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

      it("writes the mode and its mechanism annotation in one update", async () => {
        const container = getContainer()
        const subscriptionModule = container.resolve<SubscriptionModuleService>(
          SUBSCRIPTION_MODULE
        )
        const headers = await bridgeRequestHeaders(container)
        const customer = await createCustomer(container)

        // A row in the shape the toggle used to be handed: manual, and with no
        // mechanism key at all, because it predates the discriminator.
        const reorderSubscription = await createSubscriptionSeed(container, {
          customer_id: customer.id,
          reference: `SUB-TOGGLE-${Date.now()}`,
          status: SubscriptionStatus.ACTIVE,
          next_renewal_at: new Date(Date.now() + 24 * 60 * 60 * 1000),
          payment_context: {
            payment_provider_id: "pp_system_default",
            payment_mode: "manual",
            payment_method_reference: "pm_toggle",
            source_payment_collection_id: null,
            source_payment_session_id: null,
            customer_payment_reference: null,
          },
        })

        const subscriptionId = Array.isArray(reorderSubscription)
          ? reorderSubscription[0].id
          : reorderSubscription.id

        const updateSpy = jest.spyOn(subscriptionModule, "updateSubscriptions")

        const enable = await api.post(
          "/store/saas/auto-renew",
          { subscription_id: subscriptionId, enabled: true },
          { headers }
        )

        expect(enable.status).toEqual(200)
        expect(enable.data).toEqual({
          subscription_id: subscriptionId,
          payment_mode: "auto",
        })

        // Mode and mechanism have to travel together in a single write: a
        // mode-only update leaves the row labelled `manual` while the scheduler
        // already charges it, which is the drift this case pins.
        expect(updateSpy).toHaveBeenCalledTimes(1)
        expect(updateSpy.mock.calls[0][0]).toMatchObject({
          payment_context: {
            payment_mode: "auto",
            mechanism: "reorder_auto",
          },
        })

        const [enabledRow] = await subscriptionModule.listSubscriptions({
          id: [subscriptionId],
        })

        expect(enabledRow.payment_context).toMatchObject({
          payment_mode: "auto",
          mechanism: "reorder_auto",
          // Everything the other write paths own must survive the merge.
          payment_provider_id: "pp_system_default",
          payment_method_reference: "pm_toggle",
        })

        const disable = await api.post(
          "/store/saas/auto-renew",
          { subscription_id: subscriptionId, enabled: false },
          { headers }
        )

        expect(disable.status).toEqual(200)

        const [disabledRow] = await subscriptionModule.listSubscriptions({
          id: [subscriptionId],
        })

        expect(disabledRow.payment_context).toMatchObject({
          payment_mode: "manual",
          mechanism: "manual",
        })

        updateSpy.mockRestore()
      })

      it("takes the subscription lock once and releases it, on a run that refuses too", async () => {
        const container = getContainer()
        const headers = await bridgeRequestHeaders(container)
        const customer = await createCustomer(container)
        const stamp = Date.now()

        // Spied on the resolved module service rather than by replacing the
        // container's `resolve`: the steps call `acquire`/`release`, and this is
        // the same seam the toggle's write is asserted through below (a route run
        // reaches the workflow the instance this container already holds).
        const locking = container.resolve<LockingServiceLike>(Modules.LOCKING)

        const seeded = await createSubscriptionSeed(container, {
          customer_id: customer.id,
          reference: `SUB-LOCK-${stamp}`,
          status: SubscriptionStatus.ACTIVE,
          next_renewal_at: new Date(Date.now() + 24 * 60 * 60 * 1000),
          payment_context: {
            payment_provider_id: "pp_system_default",
            payment_mode: "manual",
            payment_method_reference: "pm_lock",
            source_payment_collection_id: null,
            source_payment_session_id: null,
            customer_payment_reference: null,
          },
        })

        const subscriptionId = Array.isArray(seeded)
          ? seeded[0].id
          : seeded.id

        const mirror = await createSubscriptionSeed(container, {
          customer_id: customer.id,
          reference: `NATIVE-LOCK-${stamp}`,
          status: SubscriptionStatus.ACTIVE,
          next_renewal_at: new Date(Date.now() + 24 * 60 * 60 * 1000),
          payment_context: {
            payment_provider_id: "pp_paypal_paypal",
            payment_mode: "manual",
            mechanism: "native",
            source_payment_collection_id: null,
            source_payment_session_id: null,
            payment_method_reference: null,
            customer_payment_reference: null,
          },
        })

        const mirrorId = Array.isArray(mirror) ? mirror[0].id : mirror.id

        const acquireSpy = jest.spyOn(locking, "acquire")
        const releaseSpy = jest.spyOn(locking, "release")

        const response = await api.post(
          "/store/saas/auto-renew",
          { subscription_id: subscriptionId, enabled: true },
          { headers }
        )

        expect(response.status).toEqual(200)

        // The count is the assertion: the toggle decides "overdue" from the
        // guard's snapshot and re-reads at the write, so one run must hold one
        // lock over both. A second acquire of the same key is the duplicate the
        // siblings do not have.
        expect(autoRenewKeys(acquireSpy.mock.calls)).toEqual([
          `auto-renew:${subscriptionId}`,
        ])
        expect(autoRenewKeys(releaseSpy.mock.calls)).toEqual([
          `auto-renew:${subscriptionId}`,
        ])
        // The sibling's lock settings, not a third set: `ttl` is what a run that
        // dies without compensating leaves the key held for.
        expect(acquireSpy.mock.calls[0][1]).toMatchObject({ expire: 120 })

        acquireSpy.mockClear()
        releaseSpy.mockClear()

        // A refusal is the other half: the guard answers after the lock is
        // taken, so a leaked lock would turn the next legitimate toggle into a
        // 30-second wait. `acquireLockStep` registers its own compensation, and
        // this is the only gate that reaches it.
        const refused = await api.post(
          "/store/saas/auto-renew",
          { subscription_id: mirrorId, enabled: true },
          { headers, validateStatus: () => true }
        )

        expect(refused.status).toEqual(400)
        expect(autoRenewKeys(acquireSpy.mock.calls)).toEqual([
          `auto-renew:${mirrorId}`,
        ])
        expect(autoRenewKeys(releaseSpy.mock.calls)).toEqual([
          `auto-renew:${mirrorId}`,
        ])

        acquireSpy.mockRestore()
        releaseSpy.mockRestore()
      })

      it("refuses an overdue row before writing anything", async () => {
        const container = getContainer()
        const subscriptionModule = container.resolve<SubscriptionModuleService>(
          SUBSCRIPTION_MODULE
        )
        const headers = await bridgeRequestHeaders(container)
        const customer = await createCustomer(container)

        const overdueSubscription = await createSubscriptionSeed(container, {
          customer_id: customer.id,
          reference: `SUB-OVERDUE-${Date.now()}`,
          status: SubscriptionStatus.ACTIVE,
          next_renewal_at: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000),
          payment_context: {
            payment_provider_id: "pp_system_default",
            payment_mode: "manual",
            payment_method_reference: "pm_overdue",
            source_payment_collection_id: null,
            source_payment_session_id: null,
            customer_payment_reference: null,
          },
        })

        const subscriptionId = Array.isArray(overdueSubscription)
          ? overdueSubscription[0].id
          : overdueSubscription.id

        const response = await api.post(
          "/store/saas/auto-renew",
          { subscription_id: subscriptionId, enabled: true },
          { headers, validateStatus: () => true }
        )

        // Enabling here would let the scheduler charge in the same request, so
        // the guard has to answer before the write step runs.
        expect(response.status).toEqual(400)

        const [row] = await subscriptionModule.listSubscriptions({
          id: [subscriptionId],
        })

        expect(row.payment_context).toMatchObject({ payment_mode: "manual" })
        expect(row.payment_context).not.toHaveProperty("mechanism")
      })

      it("answers each guard refusal with 400 and that guard's own copy", async () => {
        const container = getContainer()
        const headers = await bridgeRequestHeaders(container)
        const customer = await createCustomer(container)

        // The two guards are the only steps allowed to speak to the customer,
        // and what they say is authored as customer copy: the status is 400 and
        // the message is theirs, not the engine's. Each is asserted in full,
        // because the whole sentence is what the whitelist in
        // `src/workflows/set-subscription-auto-renew.ts` declares.
        type GuardRefusalSeed = {
          reference: string
          status: SubscriptionStatus
          next_renewal_at: Date
          payment_context: SubscriptionPaymentContext
        }

        const refusals: Array<{
          seed: GuardRefusalSeed
          copy: (id: string) => string
        }> = [
          {
            seed: {
              reference: `NATIVE-GUARD-${Date.now()}`,
              status: SubscriptionStatus.ACTIVE,
              next_renewal_at: new Date(Date.now() + 24 * 60 * 60 * 1000),
              payment_context: {
                payment_provider_id: "pp_paypal_paypal",
                payment_mode: "manual",
                mechanism: "native",
                source_payment_collection_id: null,
                source_payment_session_id: null,
                payment_method_reference: null,
                customer_payment_reference: null,
              },
            },
            copy: (id: string) =>
              `Subscription '${id}' is a mirror of a provider-managed recurrence; manage auto-renewal at the provider`,
          },
          {
            seed: {
              reference: `SUB-GUARD-${Date.now()}`,
              status: SubscriptionStatus.PAST_DUE,
              next_renewal_at: new Date(Date.now() + 24 * 60 * 60 * 1000),
              payment_context: {
                payment_provider_id: "pp_system_default",
                payment_mode: "manual",
                // The overdue guard exempts rows with no stored method (a free
                // grant could never have been charged), so the row has to carry
                // one for the refusal this case pins to fire at all.
                payment_method_reference: "pm_guard",
                source_payment_collection_id: null,
                source_payment_session_id: null,
                customer_payment_reference: null,
              },
            },
            copy: (id: string) =>
              `Subscription '${id}' is overdue — renew manually before enabling auto-renewal`,
          },
        ]

        for (const refusal of refusals) {
          const seeded = await createSubscriptionSeed(container, {
            customer_id: customer.id,
            ...refusal.seed,
          })

          const subscriptionId = Array.isArray(seeded)
            ? seeded[0].id
            : seeded.id

          const response = await api.post(
            "/store/saas/auto-renew",
            { subscription_id: subscriptionId, enabled: true },
            { headers, validateStatus: () => true }
          )

          expect(response.status).toEqual(400)
          expect(response.data).toMatchObject({ type: "invalid_data" })
          expect(String(response.data?.message)).toEqual(
            refusal.copy(subscriptionId)
          )
        }
      })

      it("keeps a guard step's DAL failure out of the response text", async () => {
        const container = getContainer()
        const subscriptionModule = container.resolve<SubscriptionModuleService>(
          SUBSCRIPTION_MODULE
        )
        const headers = await bridgeRequestHeaders(container)
        const customer = await createCustomer(container)
        const stamp = Date.now()

        const seeded = await createSubscriptionSeed(container, {
          customer_id: customer.id,
          reference: `SUB-GUARDDAL-${stamp}`,
          status: SubscriptionStatus.ACTIVE,
          next_renewal_at: new Date(Date.now() + 24 * 60 * 60 * 1000),
          payment_context: {
            payment_provider_id: "pp_system_default",
            payment_mode: "manual",
            source_payment_collection_id: null,
            source_payment_session_id: null,
            payment_method_reference: null,
            customer_payment_reference: null,
          },
        })

        const subscriptionId = Array.isArray(seeded)
          ? seeded[0].id
          : seeded.id

        // The native-mirror guard is not a pure predicate over its input: it
        // reads the row through the DAL first, and the DAL's error mapper turns a
        // driver fault (42703 undefined_column) into an `invalid_data`
        // MedusaError whose message quotes the missing column
        // (`@medusajs/utils/dist/dal/mikro-orm/db-error-mapper.js`). Step name and
        // type therefore authorize nothing on their own: a guard step can fail
        // with an `invalid_data` nobody wrote for a customer, and quoting it
        // would put a column name in front of the SaaS as a permanent 400.
        const column = `subscription.next_renewal__canary_${stamp}`
        const retrieveSpy = jest
          .spyOn(subscriptionModule, "retrieveSubscription")
          .mockRejectedValue(
            new MedusaError(
              MedusaError.Types.INVALID_DATA,
              `column "${column}" does not exist`
            )
          )

        const response = await api.post(
          "/store/saas/auto-renew",
          { subscription_id: subscriptionId, enabled: true },
          { headers, validateStatus: () => true }
        )

        retrieveSpy.mockRestore()

        // A refusal-shaped fault of ours: the status stays whatever the thrown
        // type maps to, and only the wording is the route's.
        expect(response.status).toEqual(400)
        expect(String(response.data?.message)).toEqual(
          "auto-renewal could not be updated"
        )

        const body = JSON.stringify(response.data ?? {})
        expect(body).not.toContain(column)
        expect(body).not.toContain("does not exist")

        const [row] = await subscriptionModule.listSubscriptions({
          id: [subscriptionId],
        })

        expect(row.payment_context).toMatchObject({ payment_mode: "manual" })
        expect(row.payment_context).not.toHaveProperty("mechanism")
      })

      it("bubbles a write-step failure as an internal error and never echoes it", async () => {
        const container = getContainer()
        const subscriptionModule = container.resolve<SubscriptionModuleService>(
          SUBSCRIPTION_MODULE
        )
        const headers = await bridgeRequestHeaders(container)
        const customer = await createCustomer(container)

        const seeded = await createSubscriptionSeed(container, {
          customer_id: customer.id,
          reference: `SUB-BUBBLE-${Date.now()}`,
          status: SubscriptionStatus.ACTIVE,
          next_renewal_at: new Date(Date.now() + 24 * 60 * 60 * 1000),
          payment_context: {
            payment_provider_id: "pp_system_default",
            payment_mode: "manual",
            source_payment_collection_id: null,
            source_payment_session_id: null,
            payment_method_reference: null,
            customer_payment_reference: null,
          },
        })

        const subscriptionId = Array.isArray(seeded)
          ? seeded[0].id
          : seeded.id

        // Stands in for the driver/connection failure BASE let bubble out of the
        // route. It is not customer copy, so the route must neither relabel it
        // as a 400 the SaaS would treat as permanent nor quote its text.
        const internalMessage = `connect ECONNREFUSED ${Date.now()} reorder-internal-pool-detail`

        const updateSpy = jest
          .spyOn(subscriptionModule, "updateSubscriptions")
          .mockRejectedValue(new Error(internalMessage))

        const response = await api.post(
          "/store/saas/auto-renew",
          { subscription_id: subscriptionId, enabled: true },
          { headers, validateStatus: () => true }
        )

        updateSpy.mockRestore()

        expect(response.status).not.toEqual(400)
        expect(response.status).toEqual(500)
        expect(JSON.stringify(response.data ?? {})).not.toContain(
          internalMessage
        )
        expect(String(response.data?.message ?? "")).not.toContain(
          "reorder-internal-pool-detail"
        )

        // Nothing committed: the failure is reported, not papered over.
        const [row] = await subscriptionModule.listSubscriptions({
          id: [subscriptionId],
        })

        expect(row.payment_context).toMatchObject({ payment_mode: "manual" })
        expect(row.payment_context).not.toHaveProperty("mechanism")
      })

      it("keeps the status of a MedusaError raised outside the guards, never its text", async () => {
        const container = getContainer()
        const subscriptionModule = container.resolve<SubscriptionModuleService>(
          SUBSCRIPTION_MODULE
        )
        const headers = await bridgeRequestHeaders(container)
        const customer = await createCustomer(container)
        const stamp = Date.now()

        // The disclosure rule has two halves, and the previous case only pinned
        // the 500 half. A `MedusaError` that is not a declared refusal keeps the
        // HTTP semantics it was thrown with — a future 404/409 business
        // rejection must not be demoted to a permanent 500 — while its text is
        // still replaced by the route's own wording, because the engine hands
        // back a deserialized value whose message nobody wrote for a customer.
        const internalFailures = [
          {
            thrown: new MedusaError(
              MedusaError.Types.NOT_FOUND,
              `Subscription 'SUB-GONE-${stamp}' was not found internal-detail-${stamp}`
            ),
            status: 404,
            // the route's own fixed text for a preserved 404
            message: "subscription not found",
          },
          {
            thrown: new MedusaError(
              MedusaError.Types.CONFLICT,
              `Renewal 'RC-${stamp}' is already processing internal-detail-${stamp}`
            ),
            // Core replaces the body text of every 409 with its own retry
            // sentence, so only the status and the absence of the canary hold.
            status: 409,
            message: null,
          },
        ]

        for (const internal of internalFailures) {
          const seeded = await createSubscriptionSeed(container, {
            customer_id: customer.id,
            reference: `SUB-STATUS-${stamp}-${internal.status}`,
            status: SubscriptionStatus.ACTIVE,
            next_renewal_at: new Date(Date.now() + 24 * 60 * 60 * 1000),
            payment_context: {
              payment_provider_id: "pp_system_default",
              payment_mode: "manual",
              source_payment_collection_id: null,
              source_payment_session_id: null,
              payment_method_reference: null,
              customer_payment_reference: null,
            },
          })

          const subscriptionId = Array.isArray(seeded)
            ? seeded[0].id
            : seeded.id

          const updateSpy = jest
            .spyOn(subscriptionModule, "updateSubscriptions")
            .mockRejectedValue(internal.thrown)

          const response = await api.post(
            "/store/saas/auto-renew",
            { subscription_id: subscriptionId, enabled: true },
            { headers, validateStatus: () => true }
          )

          updateSpy.mockRestore()

          // Not a guard refusal: it must not read as the guards' 400, and it
          // must not be flattened into a 500 either.
          expect(response.status).not.toEqual(400)
          expect(response.status).toEqual(internal.status)

          if (internal.message !== null) {
            expect(String(response.data?.message)).toEqual(internal.message)
          }

          expect(JSON.stringify(response.data ?? {})).not.toContain(
            `internal-detail-${stamp}`
          )

          const [row] = await subscriptionModule.listSubscriptions({
            id: [subscriptionId],
          })

          expect(row.payment_context).toMatchObject({ payment_mode: "manual" })
          expect(row.payment_context).not.toHaveProperty("mechanism")
        }
      })

      it("keeps a serialized Postgres fault a 500 and out of the response body", async () => {
        const container = getContainer()
        const subscriptionModule = container.resolve<SubscriptionModuleService>(
          SUBSCRIPTION_MODULE
        )
        const headers = await bridgeRequestHeaders(container)
        const customer = await createCustomer(container)
        const stamp = Date.now()

        // Exactly what a driver fault looks like once the engine has
        // serialized it: an `Error` whose own `code`/`table`/`detail` survive.
        // Rethrowing that value as it stands is NOT safe here —
        // `formatException` switches on `err.code` and rewrites `23505` into a
        // 422 whose message embeds `err.table` and `err.detail`, i.e. the
        // schema in front of the customer. This case is what distinguishes
        // "construct our own error" from "rethrow whatever the engine gave us".
        const table = `reorder_canary_table_${stamp}`
        const detail = `Key (id)=(canary-value-${stamp}) already exists.`
        const driverFault = new Error(
          `duplicate key value violates unique constraint "reorder_canary_pkey"`
        ) as Error & { code: string; table: string; detail: string }
        driverFault.code = "23505"
        driverFault.table = table
        driverFault.detail = detail

        const seeded = await createSubscriptionSeed(container, {
          customer_id: customer.id,
          reference: `SUB-PGCANARY-${stamp}`,
          status: SubscriptionStatus.ACTIVE,
          next_renewal_at: new Date(Date.now() + 24 * 60 * 60 * 1000),
          payment_context: {
            payment_provider_id: "pp_system_default",
            payment_mode: "manual",
            source_payment_collection_id: null,
            source_payment_session_id: null,
            payment_method_reference: null,
            customer_payment_reference: null,
          },
        })

        const subscriptionId = Array.isArray(seeded)
          ? seeded[0].id
          : seeded.id

        const updateSpy = jest
          .spyOn(subscriptionModule, "updateSubscriptions")
          .mockRejectedValue(driverFault)

        const response = await api.post(
          "/store/saas/auto-renew",
          { subscription_id: subscriptionId, enabled: true },
          { headers, validateStatus: () => true }
        )

        updateSpy.mockRestore()

        // Our fault, not the caller's: 5xx, and not the 422 the raw `code`
        // would have been mapped to.
        expect(response.status).not.toEqual(400)
        expect(response.status).not.toEqual(422)
        expect(response.status).toEqual(500)

        const body = JSON.stringify(response.data ?? {})
        expect(body).not.toContain(table)
        expect(body).not.toContain(detail)
        expect(body).not.toContain("canary-value-")
        expect(body).not.toContain("already exists")
        expect(body).not.toContain("23505")

        const [row] = await subscriptionModule.listSubscriptions({
          id: [subscriptionId],
        })

        expect(row.payment_context).toMatchObject({ payment_mode: "manual" })
        expect(row.payment_context).not.toHaveProperty("mechanism")
      })

      it("backfills the provider's records, then updates the row it created", async () => {
        const container = getContainer()
        const subscriptionModule = container.resolve<SubscriptionModuleService>(
          SUBSCRIPTION_MODULE
        )
        const customer = await createCustomer(container)
        const { product, variant } = await createProductWithVariant(container)

        // The records the provider's capability view hands over — the backfill
        // no longer reads a provider table, so this is the whole input.
        const { records, restore } = registerFakePaymentMethods(container, [
          {
            provider_subscription_id: "I-BACKFILL1",
            plan_id: "P-BACKFILL",
            status: "active",
            customer_id: customer.id,
            variant_id: variant.id,
            interval_unit: "MONTH",
            interval_count: 1,
            next_billing_at: "2026-12-01T00:00:00Z",
            last_billing_at: "2026-11-01T00:00:00Z",
          },
        ])

        try {
          await nativeSubscriptionBackfillJob(container)

          const created = await subscriptionModule.listSubscriptions({
            reference: [mirrorReference("I-BACKFILL1")],
          })

          expect(created).toHaveLength(1)
          expect(created[0]).toMatchObject({
            reference: mirrorReference("I-BACKFILL1"),
            status: SubscriptionStatus.ACTIVE,
            customer_id: customer.id,
            product_id: product.id,
            frequency_interval: SubscriptionFrequencyInterval.MONTH,
            frequency_value: 1,
          })
          expect(created[0].payment_context).toMatchObject({
            payment_provider_id: PAYPAL_PROVIDER_ID,
            payment_mode: "manual",
            mechanism: "native",
            customer_payment_reference: "I-BACKFILL1",
          })
          expect(created[0].metadata).toMatchObject({
            source: "native_mirror",
            plan_id: "P-BACKFILL",
          })

          // The provider cancelled the subscription between passes: the next
          // run reconciles the same row instead of creating a second one.
          records[0].status = "cancelled"

          await nativeSubscriptionBackfillJob(container)

          const updated = await subscriptionModule.listSubscriptions({
            reference: [mirrorReference("I-BACKFILL1")],
          })

          expect(updated).toHaveLength(1)
          expect(updated[0].id).toEqual(created[0].id)
          expect(updated[0].status).toEqual(SubscriptionStatus.CANCELLED)
        } finally {
          restore()
        }
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
