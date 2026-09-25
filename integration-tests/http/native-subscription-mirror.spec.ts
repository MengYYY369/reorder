import path from "path"
import { medusaIntegrationTestRunner } from "@medusajs/test-utils"
import { Modules, MedusaError } from "@medusajs/framework/utils"
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
        const refusals = [
          {
            seed: {
              reference: `NATIVE-GUARD-${Date.now()}`,
              status: SubscriptionStatus.ACTIVE,
              next_renewal_at: new Date(Date.now() + 24 * 60 * 60 * 1000),
              payment_context: {
                payment_provider_id: "pp_paypal_paypal",
                payment_mode: "manual",
                mechanism: "native",
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

      it("reconciles to nothing when the provider module is absent", async () => {
        const container = getContainer()

        await expect(
          nativeSubscriptionBackfillJob(container)
        ).resolves.toBeUndefined()
      })
    })
  },
})
