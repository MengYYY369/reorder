import { moduleIntegrationTestRunner } from "@medusajs/test-utils"
import { REDEMPTION_MODULE } from ".."
import RedemptionBatch from "../models/redemption-batch"
import RedemptionCode from "../models/redemption-code"
import RedemptionRecord from "../models/redemption-record"
import RedemptionModuleService, {
  InvalidRedemptionBatchError,
} from "../service"
import { RedemptionCodeStatus, RedemptionFrequencyInterval } from "../types"

moduleIntegrationTestRunner<RedemptionModuleService>({
  moduleName: REDEMPTION_MODULE,
  moduleModels: [RedemptionBatch, RedemptionCode, RedemptionRecord],
  resolve: "./src/modules/redemption",
  testSuite: ({ service }) => {
    describe("RedemptionModuleService — batch creation", () => {
      it("creates a batch with generated codes", async () => {
        const { batch, codes } = await service.createBatchWithCodes({
          name: "Summer Giveaway",
          variant_id: "variant_001",
          frequency_interval: RedemptionFrequencyInterval.MONTH,
          frequency_value: 1,
          free_cycles: 3,
          generated_code_count: 5,
          max_redemptions_per_code: 10,
        })

        expect(batch.status).toBe("active")
        expect(batch.code_prefix).toBe("RDM")
        expect(batch.free_cycles).toBe(3)
        expect(codes).toHaveLength(5)
        for (const code of codes) {
          expect(code.code).toMatch(/^RDM(-[2-9A-HJKMNP-Z]{4}){3}$/)
          expect(code.status).toBe(RedemptionCodeStatus.ACTIVE)
          expect(code.max_redemptions).toBe(10)
          expect(code.redemption_count).toBe(0)
        }
      })

      it("normalizes custom codes and rejects collisions with generated ones", async () => {
        const { codes } = await service.createBatchWithCodes({
          name: "Mixed Campaign",
          variant_id: "variant_001",
          frequency_interval: RedemptionFrequencyInterval.MONTH,
          frequency_value: 1,
          free_cycles: 1,
          generated_code_count: 3,
          custom_codes: ["  black-friday-2026 "],
        })

        const custom = codes.find((code) => code.code === "BLACK-FRIDAY-2026")
        expect(custom).toBeDefined()

        await expect(
          service.createBatchWithCodes({
            name: "Second Campaign",
            variant_id: "variant_001",
            frequency_interval: RedemptionFrequencyInterval.MONTH,
            frequency_value: 1,
            free_cycles: 1,
            custom_codes: ["black-friday-2026"],
          })
        ).rejects.toThrow(/already exists/i)
      })

      it("rejects invalid custom codes", async () => {
        await expect(
          service.createBatchWithCodes({
            name: "Bad Codes",
            variant_id: "variant_001",
            frequency_interval: RedemptionFrequencyInterval.MONTH,
            frequency_value: 1,
            free_cycles: 1,
            custom_codes: ["-leading"],
          })
        ).rejects.toThrow(InvalidRedemptionBatchError)
      })

      it("enforces grant-config validation", async () => {
        await expect(
          service.createBatchWithCodes({
            name: "No Variant",
            variant_id: "",
            frequency_interval: RedemptionFrequencyInterval.MONTH,
            frequency_value: 1,
            free_cycles: 1,
            generated_code_count: 1,
          })
        ).rejects.toThrow(/variant_id/)

        await expect(
          service.createBatchWithCodes({
            name: "Zero Cycles",
            variant_id: "variant_001",
            frequency_interval: RedemptionFrequencyInterval.MONTH,
            frequency_value: 1,
            free_cycles: 0,
            generated_code_count: 1,
          })
        ).rejects.toThrow(/free_cycles/)

        await expect(
          service.createBatchWithCodes({
            name: "No Codes",
            variant_id: "variant_001",
            frequency_interval: RedemptionFrequencyInterval.MONTH,
            frequency_value: 1,
            free_cycles: 1,
          })
        ).rejects.toThrow(/at least one code/)

        await expect(
          service.createBatchWithCodes({
            name: "Inverted Window",
            variant_id: "variant_001",
            frequency_interval: RedemptionFrequencyInterval.MONTH,
            frequency_value: 1,
            free_cycles: 1,
            generated_code_count: 1,
            starts_at: new Date("2026-12-31"),
            expires_at: new Date("2026-01-01"),
          })
        ).rejects.toThrow(/starts_at/)
      })

      it("disables a batch and a code", async () => {
        const { batch, codes } = await service.createBatchWithCodes({
          name: "Disable Me",
          variant_id: "variant_001",
          frequency_interval: RedemptionFrequencyInterval.MONTH,
          frequency_value: 1,
          free_cycles: 1,
          generated_code_count: 2,
        })

        await service.disableBatch(batch.id)
        await service.disableCode(codes[0].id)

        const updatedBatch = await service.retrieveRedemptionBatch(batch.id)
        expect(updatedBatch.status).toBe("disabled")

        const updatedCode = await service.retrieveRedemptionCode(codes[0].id)
        expect(updatedCode.status).toBe(RedemptionCodeStatus.DISABLED)
        expect(updatedCode.code).toBe(codes[0].code)
      })

      it("enforces schema-level uniqueness on (code, customer)", async () => {
        const { codes } = await service.createBatchWithCodes({
          name: "Uniqueness",
          variant_id: "variant_001",
          frequency_interval: RedemptionFrequencyInterval.MONTH,
          frequency_value: 1,
          free_cycles: 1,
          generated_code_count: 1,
        })

        await service.createRedemptionRecords({
          batch_id: codes[0].batch_id,
          code_id: codes[0].id,
          customer_id: "cus_001",
          subscription_id: "sub_001",
          outcome: "subscription_created",
          free_cycles_applied: 1,
          frequency_interval: RedemptionFrequencyInterval.MONTH,
          frequency_value: 1,
        } as any)

        await expect(
          service.createRedemptionRecords({
            batch_id: codes[0].batch_id,
            code_id: codes[0].id,
            customer_id: "cus_001",
            subscription_id: "sub_002",
            outcome: "subscription_created",
            free_cycles_applied: 1,
            frequency_interval: RedemptionFrequencyInterval.MONTH,
            frequency_value: 1,
          } as any)
        ).rejects.toThrow()
      })
    })
  },
})

jest.setTimeout(60 * 1000)
