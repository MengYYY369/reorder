import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { REDEMPTION_MODULE } from "../../modules/redemption"
import RedemptionModuleService, {
  InvalidRedemptionBatchError,
} from "../../modules/redemption/service"
import {
  CreateRedemptionBatchInput,
  RedemptionBatchDTO,
  RedemptionCodeDTO,
} from "../../modules/redemption/types"

export type ValidateRedemptionGrantTargetStepInput = {
  variant_id: string
  frequency_interval: string
  frequency_value: number
}

export type ValidatedGrantTarget = {
  variant_id: string
  product_id: string
  variant_title: string
  product_title: string
}

/**
 * Grant-target validation is the admin workflow's job: the redemption module
 * cannot see commerce entities. A batch must target an existing variant with
 * an enabled plan-offer that allows the requested frequency.
 */
export const validateRedemptionGrantTargetStep = createStep(
  "validate-redemption-grant-target",
  async function (
    input: ValidateRedemptionGrantTargetStepInput,
    { container }
  ) {
    const query = container.resolve(ContainerRegistrationKeys.QUERY)

    const { data: variants } = await query.graph({
      entity: "variant",
      fields: ["id", "title", "product.id", "product.title"],
      filters: { id: input.variant_id },
    })

    const variant = variants?.[0]
    if (!variant) {
      throw new InvalidRedemptionBatchError(
        `Variant ${input.variant_id} does not exist`
      )
    }

    const productId = variant.product?.id
    if (!productId) {
      throw new InvalidRedemptionBatchError(
        `Variant ${input.variant_id} does not resolve to a product`
      )
    }

    const planOfferModuleService = container.resolve<any>("planOffer")
    const [offers] = await planOfferModuleService.listAndCountPlanOffers({
      scope: "variant",
      variant_id: input.variant_id,
      is_enabled: true,
    })

    const offer = (offers ?? [])[0]
    if (!offer) {
      throw new InvalidRedemptionBatchError(
        `Variant ${input.variant_id} has no enabled plan offer`
      )
    }

    const allowedFrequencies = (offer.allowed_frequencies ?? []) as Array<{
      interval: string
      value: number
    }>
    const frequencyAllowed = allowedFrequencies.some(
      (frequency) =>
        frequency.interval === input.frequency_interval &&
        Number(frequency.value) === input.frequency_value
    )
    if (!frequencyAllowed) {
      throw new InvalidRedemptionBatchError(
        `Frequency ${input.frequency_interval}/${input.frequency_value} is not allowed for variant ${input.variant_id}`
      )
    }

    const validated: ValidatedGrantTarget = {
      variant_id: input.variant_id,
      product_id: productId,
      variant_title: variant.title ?? "Unknown variant",
      product_title: variant.product?.title ?? "Unknown product",
    }

    return new StepResponse(validated, null)
  }
)

export type CreateRedemptionBatchStepOutput = {
  batch: RedemptionBatchDTO
  codes: RedemptionCodeDTO[]
}

export const createRedemptionBatchStep = createStep(
  "create-redemption-batch",
  async function (input: CreateRedemptionBatchInput, { container }) {
    const redemptionModuleService =
      container.resolve<RedemptionModuleService>(REDEMPTION_MODULE)

    const { batch, codes } =
      await redemptionModuleService.createBatchWithCodes(input)

    return new StepResponse<
      CreateRedemptionBatchStepOutput,
      { batch_id: string }
    >({ batch, codes }, { batch_id: batch.id })
  },
  async function (compensation: { batch_id: string } | undefined, { container }) {
    if (!compensation) {
      return
    }
    const redemptionModuleService =
      container.resolve<RedemptionModuleService>(REDEMPTION_MODULE)
    await redemptionModuleService.deleteRedemptionBatches(compensation.batch_id)
  }
)

export const disableRedemptionBatchStep = createStep(
  "disable-redemption-batch",
  async function (input: { id: string }, { container }) {
    const redemptionModuleService =
      container.resolve<RedemptionModuleService>(REDEMPTION_MODULE)

    const batch = await redemptionModuleService.retrieveRedemptionBatch(input.id)
    if (batch.status === "disabled") {
      return new StepResponse(batch.id, null)
    }

    await redemptionModuleService.disableBatch(input.id)

    return new StepResponse(
      batch.id,
      { id: batch.id, previous_status: batch.status }
    )
  },
  async function (
    compensation: { id: string; previous_status: string } | null,
    { container }
  ) {
    if (!compensation) {
      return
    }
    const redemptionModuleService =
      container.resolve<RedemptionModuleService>(REDEMPTION_MODULE)
    await redemptionModuleService.updateRedemptionBatches({
      id: compensation.id,
      status: compensation.previous_status,
    } as any)
  }
)

export const disableRedemptionCodeStep = createStep(
  "disable-redemption-code",
  async function (input: { id: string }, { container }) {
    const redemptionModuleService =
      container.resolve<RedemptionModuleService>(REDEMPTION_MODULE)

    const code = await redemptionModuleService.retrieveRedemptionCode(input.id)
    if (code.status === "disabled") {
      return new StepResponse(code.id, null)
    }

    await redemptionModuleService.disableCode(input.id)

    return new StepResponse(
      code.id,
      { id: code.id, previous_status: code.status }
    )
  },
  async function (
    compensation: { id: string; previous_status: string } | null,
    { container }
  ) {
    if (!compensation) {
      return
    }
    const redemptionModuleService =
      container.resolve<RedemptionModuleService>(REDEMPTION_MODULE)
    await redemptionModuleService.updateRedemptionCodes({
      id: compensation.id,
      status: compensation.previous_status,
    } as any)
  }
)
