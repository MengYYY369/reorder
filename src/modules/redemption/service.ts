import { MedusaError, MedusaService } from "@medusajs/framework/utils"
import RedemptionBatch from "./models/redemption-batch"
import RedemptionCode from "./models/redemption-code"
import RedemptionRecord from "./models/redemption-record"
import {
  CreateRedemptionBatchInput,
  RedemptionBatchDTO,
  RedemptionBatchStatus,
  RedemptionCodeDTO,
  RedemptionCodeStatus,
  RedemptionFrequencyInterval,
  RedemptionOutcome,
  RedemptionRecordDTO,
} from "./types"
import {
  generateUniqueRedemptionCodes,
  normalizeCustomRedemptionCode,
} from "./utils/code-generator"

const DEFAULT_CODE_PREFIX = "RDM"
const DEFAULT_MAX_REDEMPTIONS_PER_CODE = 1
const MIN_FREE_CYCLES = 1
const MIN_FREQUENCY_VALUE = 1
const MAX_BATCH_NAME_LENGTH = 200

export class InvalidRedemptionBatchError extends MedusaError {
  constructor(message: string) {
    super(MedusaError.Types.INVALID_DATA, message)
  }
}

function assertValidGrantConfig(input: CreateRedemptionBatchInput): void {
  if (!input.name || input.name.trim().length === 0) {
    throw new InvalidRedemptionBatchError("Batch name is required")
  }
  if (input.name.trim().length > MAX_BATCH_NAME_LENGTH) {
    throw new InvalidRedemptionBatchError(
      `Batch name must be at most ${MAX_BATCH_NAME_LENGTH} characters`,
    )
  }
  if (!input.variant_id) {
    throw new InvalidRedemptionBatchError("variant_id is required")
  }
  if (!Object.values(RedemptionFrequencyInterval).includes(input.frequency_interval)) {
    throw new InvalidRedemptionBatchError(
      `frequency_interval must be one of: ${Object.values(RedemptionFrequencyInterval).join(", ")}`,
    )
  }
  if (!Number.isInteger(input.frequency_value) || input.frequency_value < MIN_FREQUENCY_VALUE) {
    throw new InvalidRedemptionBatchError(
      `frequency_value must be an integer >= ${MIN_FREQUENCY_VALUE}`,
    )
  }
  if (!Number.isInteger(input.free_cycles) || input.free_cycles < MIN_FREE_CYCLES) {
    throw new InvalidRedemptionBatchError(
      `free_cycles must be an integer >= ${MIN_FREE_CYCLES}`,
    )
  }
  if (
    input.max_redemptions_per_code !== undefined &&
    (!Number.isInteger(input.max_redemptions_per_code) ||
      input.max_redemptions_per_code < 1)
  ) {
    throw new InvalidRedemptionBatchError(
      "max_redemptions_per_code must be an integer >= 1",
    )
  }
  const generatedCount = input.generated_code_count ?? 0
  if (!Number.isInteger(generatedCount) || generatedCount < 0) {
    throw new InvalidRedemptionBatchError(
      "generated_code_count must be an integer >= 0",
    )
  }
  const customCount = input.custom_codes?.length ?? 0
  if (generatedCount + customCount === 0) {
    throw new InvalidRedemptionBatchError(
      "A batch requires at least one code (generated_code_count or custom_codes)",
    )
  }
}

function normalizeWindow(
  value: Date | null | undefined,
  field: "starts_at" | "expires_at",
): Date | null {
  if (value === undefined || value === null) {
    return null
  }
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) {
    throw new InvalidRedemptionBatchError(`${field} is not a valid date`)
  }
  return date
}

class RedemptionModuleService extends MedusaService({
  RedemptionBatch,
  RedemptionCode,
  RedemptionRecord,
}) {
  /**
   * Persists a batch and its code set in one create. Grant-target validation
   * (variant/plan-offer/frequency against commerce) is the admin workflow's
   * job — this layer only sees opaque ids, so it validates shape and codes.
   */
  async createBatchWithCodes(
    input: CreateRedemptionBatchInput
  ): Promise<{ batch: RedemptionBatchDTO; codes: RedemptionCodeDTO[] }> {
    assertValidGrantConfig(input)

    const prefix = (input.code_prefix ?? DEFAULT_CODE_PREFIX).trim().toUpperCase()
    if (prefix.length === 0) {
      throw new InvalidRedemptionBatchError("code_prefix must not be empty")
    }

    const maxRedemptions =
      input.max_redemptions_per_code ?? DEFAULT_MAX_REDEMPTIONS_PER_CODE
    const startsAt = normalizeWindow(input.starts_at, "starts_at")
    const expiresAt = normalizeWindow(input.expires_at, "expires_at")
    if (
      startsAt !== null &&
      expiresAt !== null &&
      startsAt.getTime() >= expiresAt.getTime()
    ) {
      throw new InvalidRedemptionBatchError("starts_at must be before expires_at")
    }

    const existingCodes = await this.listRedemptionCodes(
      {},
      { select: ["code"] }
    )
    const occupiedCodes = existingCodes.map((code) => code.code)

    const normalizedCustomCodes: string[] = []
    for (const rawCode of input.custom_codes ?? []) {
      const normalized = normalizeCustomRedemptionCode(rawCode)
      if (normalized === null) {
        throw new InvalidRedemptionBatchError(
          `Custom code "${rawCode}" is invalid: use letters, digits and inner hyphens only (min 2 characters)`
        )
      }
      if (normalizedCustomCodes.includes(normalized)) {
        throw new InvalidRedemptionBatchError(
          `Custom code "${rawCode}" is duplicated within the batch`
        )
      }
      if (occupiedCodes.includes(normalized)) {
        throw new InvalidRedemptionBatchError(
          `Custom code "${rawCode}" already exists in another batch`
        )
      }
      normalizedCustomCodes.push(normalized)
    }

    const generatedCount = input.generated_code_count ?? 0
    const generatedCodes = generateUniqueRedemptionCodes(
      generatedCount,
      [...occupiedCodes, ...normalizedCustomCodes],
      { prefix }
    )

    const batch = await this.createRedemptionBatches({
      name: input.name.trim(),
      variant_id: input.variant_id,
      frequency_interval: input.frequency_interval,
      frequency_value: input.frequency_value,
      free_cycles: input.free_cycles,
      status: RedemptionBatchStatus.ACTIVE,
      code_prefix: prefix,
      max_redemptions_per_code: maxRedemptions,
      starts_at: startsAt,
      expires_at: expiresAt,
      metadata: input.metadata ?? null,
    } as any)

    const codes = await this.createRedemptionCodes(
      [...generatedCodes, ...normalizedCustomCodes].map((code) => ({
        batch_id: batch.id,
        // Codes are stored uppercase; the DB unique index is on the raw
        // column, so case-insensitive uniqueness relies on this invariant.
        code,
        status: RedemptionCodeStatus.ACTIVE,
        max_redemptions: maxRedemptions,
        redemption_count: 0,
      })) as any
    )

    return {
      batch: batch as unknown as RedemptionBatchDTO,
      codes: codes as unknown as RedemptionCodeDTO[],
    }
  }

  async disableBatch(batchId: string): Promise<void> {
    await this.updateRedemptionBatches({
      id: batchId,
      status: RedemptionBatchStatus.DISABLED,
    } as any)
  }

  async disableCode(codeId: string): Promise<void> {
    await this.updateRedemptionCodes({
      id: codeId,
      status: RedemptionCodeStatus.DISABLED,
    } as any)
  }

  async listBatchCodes(batchId: string): Promise<RedemptionCodeDTO[]> {
    return (await this.listRedemptionCodes(
      { batch_id: batchId } as any,
      { order: { created_at: "ASC" } }
    )) as RedemptionCodeDTO[]
  }

  async listBatchRecords(batchId: string): Promise<RedemptionRecordDTO[]> {
    return (await this.listRedemptionRecords(
      { batch_id: batchId } as any,
      { order: { created_at: "ASC" } }
    )) as RedemptionRecordDTO[]
  }

  async listCustomerRecords(
    customerId: string
  ): Promise<RedemptionRecordDTO[]> {
    return (await this.listRedemptionRecords(
      { customer_id: customerId } as any,
      { order: { created_at: "DESC" } }
    )) as RedemptionRecordDTO[]
  }
}

export default RedemptionModuleService
export { RedemptionOutcome, RedemptionFrequencyInterval }
