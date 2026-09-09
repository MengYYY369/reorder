import { medusaIntegrationTestRunner } from "@medusajs/test-utils"
import path from "path"
import {
  createAdminAuthHeaders,
  createProductWithVariant,
} from "../helpers/subscription-fixtures"
import { createPlanOfferSeed } from "../helpers/plan-offer-fixtures"
import { REDEMPTION_MODULE } from "../../src/modules/redemption"

medusaIntegrationTestRunner({
  medusaConfigFile: path.resolve(process.cwd(), "integration-tests"),
  env: {
    JWT_SECRET: "supersecret",
    COOKIE_SECRET: "supersecret",
  },
  testSuite: ({ api, getContainer }) => {
    describe("admin redemption batch endpoints", () => {
      it("creates a batch with generated and custom codes", async () => {
        const container = getContainer()
        const headers = await createAdminAuthHeaders(container)
        const { variant } = await createProductWithVariant(container)

        await createPlanOfferSeed(container, {
          name: "RDM-OFFER-001",
          scope: "variant",
          variant_id: variant.id,
          allowed_frequencies: [{ interval: "month", value: 1 }],
        })

        const response = await api.post(
          "/admin/redemptions/batches",
          {
            name: "RDM-BATCH-001",
            variant_id: variant.id,
            frequency_interval: "month",
            frequency_value: 1,
            free_cycles: 3,
            max_redemptions_per_code: 5,
            generated_code_count: 4,
            custom_codes: ["BLACKFRIDAY2026"],
          },
          { headers }
        )

        expect(response.status).toEqual(200)
        expect(response.data.redemption_batch.name).toEqual("RDM-BATCH-001")
        expect(response.data.redemption_batch.free_cycles).toEqual(3)
        expect(response.data.redemption_batch.status).toEqual("active")
        expect(response.data.redemption_batch.code_count).toEqual(5)

        const codes = response.data.codes
        expect(codes).toHaveLength(5)
        const custom = codes.find((code: { code: string }) => code.code === "BLACKFRIDAY2026")
        expect(custom).toBeDefined()
        for (const code of codes) {
          expect(code.status).toEqual("active")
          expect(code.max_redemptions).toEqual(5)
        }
      })

      it("rejects a batch whose variant has no enabled plan offer", async () => {
        const container = getContainer()
        const headers = await createAdminAuthHeaders(container)
        const { variant } = await createProductWithVariant(container)

        await expect(
          api.post(
            "/admin/redemptions/batches",
            {
              name: "RDM-BATCH-NO-OFFER",
              variant_id: variant.id,
              frequency_interval: "month",
              frequency_value: 1,
              free_cycles: 1,
              generated_code_count: 1,
            },
            { headers }
          )
        ).rejects.toMatchObject({
          response: { status: 400 },
        })
      })

      it("rejects a batch with a frequency outside the plan offer", async () => {
        const container = getContainer()
        const headers = await createAdminAuthHeaders(container)
        const { variant } = await createProductWithVariant(container)

        await createPlanOfferSeed(container, {
          name: "RDM-OFFER-002",
          scope: "variant",
          variant_id: variant.id,
          allowed_frequencies: [{ interval: "month", value: 1 }],
        })

        await expect(
          api.post(
            "/admin/redemptions/batches",
            {
              name: "RDM-BATCH-BAD-FREQ",
              variant_id: variant.id,
              frequency_interval: "year",
              frequency_value: 1,
              free_cycles: 1,
              generated_code_count: 1,
            },
            { headers }
          )
        ).rejects.toMatchObject({
          response: { status: 400 },
        })
      })

      it("rejects a batch without any codes", async () => {
        const container = getContainer()
        const headers = await createAdminAuthHeaders(container)
        const { variant } = await createProductWithVariant(container)

        await expect(
          api.post(
            "/admin/redemptions/batches",
            {
              name: "RDM-BATCH-NO-CODES",
              variant_id: variant.id,
              frequency_interval: "month",
              frequency_value: 1,
              free_cycles: 1,
            },
            { headers }
          )
        ).rejects.toMatchObject({
          response: { status: 400 },
        })
      })

      it("lists batches and returns batch detail", async () => {
        const container = getContainer()
        const headers = await createAdminAuthHeaders(container)
        const { variant } = await createProductWithVariant(container)

        await createPlanOfferSeed(container, {
          name: "RDM-OFFER-003",
          scope: "variant",
          variant_id: variant.id,
          allowed_frequencies: [{ interval: "month", value: 1 }],
        })

        const createResponse = await api.post(
          "/admin/redemptions/batches",
          {
            name: "RDM-BATCH-LIST-001",
            variant_id: variant.id,
            frequency_interval: "month",
            frequency_value: 1,
            free_cycles: 2,
            generated_code_count: 2,
          },
          { headers }
        )
        const batchId = createResponse.data.redemption_batch.id

        const listResponse = await api.get(
          "/admin/redemptions/batches?q=RDM-BATCH-LIST-001",
          { headers }
        )
        expect(listResponse.status).toEqual(200)
        expect(listResponse.data.redemption_batches).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ id: batchId, name: "RDM-BATCH-LIST-001" }),
          ])
        )

        const detailResponse = await api.get(
          `/admin/redemptions/batches/${batchId}`,
          { headers }
        )
        expect(detailResponse.status).toEqual(200)
        expect(detailResponse.data.redemption_batch.id).toEqual(batchId)
        expect(detailResponse.data.codes).toHaveLength(2)
      })

      it("disables a batch and a single code", async () => {
        const container = getContainer()
        const headers = await createAdminAuthHeaders(container)
        const { variant } = await createProductWithVariant(container)

        await createPlanOfferSeed(container, {
          name: "RDM-OFFER-004",
          scope: "variant",
          variant_id: variant.id,
          allowed_frequencies: [{ interval: "month", value: 1 }],
        })

        const createResponse = await api.post(
          "/admin/redemptions/batches",
          {
            name: "RDM-BATCH-DISABLE-001",
            variant_id: variant.id,
            frequency_interval: "month",
            frequency_value: 1,
            free_cycles: 1,
            generated_code_count: 3,
          },
          { headers }
        )
        const batchId = createResponse.data.redemption_batch.id
        const codeId = createResponse.data.codes[0].id

        const disableCodeResponse = await api.post(
          `/admin/redemptions/codes/${codeId}/disable`,
          {},
          { headers }
        )
        expect(disableCodeResponse.status).toEqual(200)
        expect(disableCodeResponse.data.code.status).toEqual("disabled")

        const disableBatchResponse = await api.post(
          `/admin/redemptions/batches/${batchId}/disable`,
          {},
          { headers }
        )
        expect(disableBatchResponse.status).toEqual(200)
        expect(disableBatchResponse.data.redemption_batch.status).toEqual(
          "disabled"
        )

        const detailResponse = await api.get(
          `/admin/redemptions/batches/${batchId}`,
          { headers }
        )
        const disabledCode = detailResponse.data.codes.find(
          (code: { id: string }) => code.id === codeId
        )
        expect(disabledCode.status).toEqual("disabled")
      })

      it("requires admin authentication", async () => {
        await expect(
          api.get("/admin/redemptions/batches")
        ).rejects.toMatchObject({
          response: { status: 401 },
        })
      })

      it("lists redemption records for a batch", async () => {
        const container = getContainer()
        const headers = await createAdminAuthHeaders(container)
        const { variant } = await createProductWithVariant(container)

        await createPlanOfferSeed(container, {
          name: "RDM-OFFER-005",
          scope: "variant",
          variant_id: variant.id,
          allowed_frequencies: [{ interval: "month", value: 1 }],
        })

        const createResponse = await api.post(
          "/admin/redemptions/batches",
          {
            name: "RDM-BATCH-RECORDS",
            variant_id: variant.id,
            frequency_interval: "month",
            frequency_value: 1,
            free_cycles: 2,
            generated_code_count: 1,
          },
          { headers }
        )
        const batchId = createResponse.data.redemption_batch.id

        const emptyRecords = await api.get(
          `/admin/redemptions/batches/${batchId}/records`,
          { headers }
        )
        expect(emptyRecords.status).toEqual(200)
        expect(emptyRecords.data.redemption_records).toHaveLength(0)

        const redemptionModule = container.resolve(
          REDEMPTION_MODULE
        ) as any
        await redemptionModule.createRedemptionRecords({
          batch_id: batchId,
          code_id: createResponse.data.codes[0].id,
          customer_id: "cus_records_001",
          subscription_id: "sub_records_001",
          outcome: "subscription_created",
          free_cycles_applied: 2,
          frequency_interval: "month",
          frequency_value: 1,
        })

        const records = await api.get(
          `/admin/redemptions/batches/${batchId}/records`,
          { headers }
        )
        expect(records.status).toEqual(200)
        expect(records.data.count).toEqual(1)
        expect(records.data.redemption_records[0]).toMatchObject({
          customer_id: "cus_records_001",
          outcome: "subscription_created",
          free_cycles_applied: 2,
        })
      })
    })
  },
})

jest.setTimeout(60 * 1000)
