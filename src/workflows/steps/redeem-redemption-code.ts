import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { REDEMPTION_MODULE } from "../../modules/redemption"
import RedemptionModuleService from "../../modules/redemption/service"
import {
  RedemptionBatchDTO,
  RedemptionCodeDTO,
} from "../../modules/redemption/types"
import { redemptionErrors } from "../../modules/redemption/utils/errors"
import { normalizeRedemptionCode } from "../../modules/redemption/utils/code-generator"
import { resolveProductSubscriptionConfig } from "../../modules/plan-offer/utils/effective-config"
import { SUBSCRIPTION_MODULE } from "../../modules/subscription"
import type SubscriptionModuleService from "../../modules/subscription/service"
import { SubscriptionStatus } from "../../modules/subscription/types"
import {
  SubscriptionFrequencyInterval,
  SubscriptionPaymentContext,
  SubscriptionProductSnapshot,
  SubscriptionShippingAddress,
} from "../../modules/subscription/types"

export type ResolveRedemptionCodeStepInput = {
  code: string
  customer_id: string
  subscription_id?: string | null
  /**
   * "redeem" throws the interim extension error when a matching
   * subscription exists; "preview" reports the resolution read-only.
   */
  mode?: "preview" | "redeem"
}

export type RedemptionGrantSnapshot = {
  product_id: string
  product_title: string
  variant_id: string
  variant_title: string
  sku: string | null
  frequency_interval: SubscriptionFrequencyInterval
  frequency_value: number
  free_cycles: number
}

export type RedemptionTrialInfo = {
  is_enabled: boolean
  days: number | null
  requires_payment_method: boolean
}

export type RedemptionResolution = {
  kind: "create" | "extend"
  batch: RedemptionBatchDTO
  code: RedemptionCodeDTO
  grant: RedemptionGrantSnapshot
  /** Inherited from the batch variant's effective plan-offer rules. */
  trial: RedemptionTrialInfo
  target_subscription_id: string | null
  customer_id: string
  customer: {
    email: string
    full_name: string | null
  }
}

function isWithinWindow(
  batch: RedemptionBatchDTO,
  now: Date
): boolean {
  if (batch.starts_at && now < new Date(batch.starts_at)) {
    return false
  }
  if (batch.expires_at && now > new Date(batch.expires_at)) {
    return false
  }
  return true
}

/**
 * Read-only validation and target resolution shared by preview and redeem.
 * Loads the code (case-insensitively), its batch, the grant target and the
 * customer's matching subscription. Throws a domain error describing exactly
 * why the code cannot be redeemed when validation fails.
 */
export const resolveRedemptionCodeStep = createStep(
  "resolve-redemption-code",
  async function (
    input: ResolveRedemptionCodeStepInput,
    { container }
  ) {
    const normalized = normalizeRedemptionCode(input.code)
    if (!normalized) {
      throw redemptionErrors.invalidCode(input.code)
    }

    const redemptionModuleService =
      container.resolve<RedemptionModuleService>(REDEMPTION_MODULE)

    const matchingCodes = await redemptionModuleService.listRedemptionCodes({
      code: normalized,
    })
    const code = matchingCodes[0]
    if (!code) {
      throw redemptionErrors.invalidCode(normalized)
    }
    if (code.status === "disabled") {
      throw redemptionErrors.codeDisabled(code.code)
    }

    const batch = await redemptionModuleService.retrieveRedemptionBatch(
      code.batch_id
    )
    if (batch.status === "disabled") {
      throw redemptionErrors.batchDisabled(batch.id)
    }
    if (!isWithinWindow(batch, new Date())) {
      throw redemptionErrors.outsideWindow(code.code)
    }
    if (code.redemption_count >= code.max_redemptions) {
      throw redemptionErrors.codeExhausted(code.code)
    }

    const customerRecords =
      await redemptionModuleService.listRedemptionRecords({
        code_id: code.id,
        customer_id: input.customer_id,
      })
    if (customerRecords.length > 0) {
      throw redemptionErrors.alreadyRedeemedByCustomer(code.code)
    }

    const query = container.resolve<any>(ContainerRegistrationKeys.QUERY)

    const { data: variants } = await query.graph({
      entity: "variant",
      fields: ["id", "title", "sku", "product.id", "product.title"],
      filters: { id: batch.variant_id },
    })
    const variant = variants?.[0]
    if (!variant || !variant.product) {
      throw redemptionErrors.batchNotFound(batch.id)
    }

    // Trial semantics are inherited from the batch variant's effective
    // plan-offer rules (batch itself carries no trial config). Batch creation
    // already requires an enabled plan-offer on the target variant, so the
    // config resolves; a defensive null fallback disables trial if absent.
    const effectiveConfig = await resolveProductSubscriptionConfig(container, {
      product_id: variant.product.id,
      variant_id: variant.id,
    }).catch(() => null)
    const trial: RedemptionTrialInfo = {
      is_enabled:
        !!effectiveConfig?.is_enabled &&
        !!effectiveConfig.rules?.trial_enabled,
      days: effectiveConfig?.rules?.trial_enabled
        ? effectiveConfig.rules.trial_days ?? null
        : null,
      requires_payment_method:
        effectiveConfig?.rules?.trial_requires_payment_method ?? false,
    }

    const { data: customers } = await query.graph({
      entity: "customer",
      fields: ["id", "email", "first_name", "last_name"],
      filters: { id: input.customer_id },
    })
    const customer = customers?.[0]
    if (!customer) {
      // The customer row is gone — the caller's subject vanished, which is not
      // a statement about subscriptions. A route that already checked the row
      // reaches here when it is deleted in between, and the customer-scoped
      // route reaches it on any request whose session outlived the row.
      throw redemptionErrors.customerNotFound(input.customer_id)
    }

    const subscriptionModuleService =
      container.resolve<SubscriptionModuleService>(SUBSCRIPTION_MODULE)

    const candidateSubscriptions = await subscriptionModuleService.listSubscriptions(
      {
        customer_id: input.customer_id,
        variant_id: batch.variant_id,
      }
    )

    const extendable = candidateSubscriptions.filter((subscription) => {
      if (input.subscription_id && subscription.id !== input.subscription_id) {
        return false
      }
      if (subscription.cancelled_at) {
        return false
      }
      return (
        subscription.status === SubscriptionStatus.ACTIVE ||
        subscription.status === SubscriptionStatus.PAST_DUE
      )
    })

    // Trial codes are new-user-only: an existing subscription for the target
    // variant (paid, free-cycle, or another trial) or any prior paid order
    // containing the variant disqualifies the customer.
    if (trial.is_enabled && extendable.length > 0) {
      throw redemptionErrors.trialOnlyForNewUsers()
    }
    if (trial.is_enabled) {
      const { data: customerOrders } = await query.graph({
        entity: "order",
        fields: ["id", "items.variant_id"],
        filters: { customer_id: input.customer_id },
      })
      const hasVariantOrder = (
        customerOrders as unknown as Array<{
          items?: Array<{ variant_id?: string | null }>
        }>
      ).some((order) =>
        (order.items ?? []).some((item) => item.variant_id === variant.id)
      )
      if (hasVariantOrder) {
        throw redemptionErrors.trialOnlyForNewUsers()
      }
    }

    let targetSubscriptionId: string | null = null
    let kind: "create" | "extend" = "create"

    if (extendable.length > 0) {
      kind = "extend"
      if (!input.subscription_id && extendable.length > 1) {
        throw redemptionErrors.ambiguousTarget()
      }
      targetSubscriptionId = extendable[0].id
    } else if (input.subscription_id) {
      // The caller asked for a specific subscription that either does not
      // exist or is not extendable.
      throw redemptionErrors.noMatchingSubscription(batch.variant_id)
    }

    const grant: RedemptionGrantSnapshot = {
      product_id: variant.product.id,
      product_title: variant.product.title ?? "Unknown product",
      variant_id: variant.id,
      variant_title: variant.title ?? "Unknown variant",
      sku: variant.sku ?? null,
      frequency_interval: batch.frequency_interval as unknown as SubscriptionFrequencyInterval,
      frequency_value: batch.frequency_value,
      free_cycles: batch.free_cycles,
    }

    const resolution: RedemptionResolution = {
      kind,
      batch,
      code,
      grant,
      trial,
      target_subscription_id: targetSubscriptionId,
      customer_id: input.customer_id,
      customer: {
        email: customer.email ?? "",
        full_name:
          [customer.first_name, customer.last_name]
            .filter(Boolean)
            .join(" ") || null,
      },
    }

    return new StepResponse(resolution, null)
  }
)

export type RedeemCreateStepOutput = {
  subscription_id: string
  subscription_reference: string
  record_id: string
  is_trial: boolean
  trial_ends_at: string | null
}

const REDEMPTION_SHIPPING_PLACEHOLDER: SubscriptionShippingAddress = {
  first_name: "Redemption",
  last_name: "Redemption",
  company: null,
  address_1: "Redemption",
  address_2: null,
  city: "Redemption",
  postal_code: "00000",
  province: null,
  country_code: "US",
  phone: null,
}

const REDEMPTION_PAYMENT_CONTEXT: SubscriptionPaymentContext = {
  payment_provider_id: null,
  // "auto" keeps the free cycles inside the scheduler's due set; the
  // generalized free-cycle branch never builds an order or touches payment.
  payment_mode: "auto",
  source_payment_collection_id: null,
  source_payment_session_id: null,
  payment_method_reference: null,
  customer_payment_reference: null,
}

const REDEMPTION_TRIAL_PAYMENT_CONTEXT: SubscriptionPaymentContext = {
  ...REDEMPTION_PAYMENT_CONTEXT,
  // No payment method is collected for v1 trials; payment_mode stays "auto"
  // exactly like the free-cycles path so the trial-end renewal cycle lands in
  // the scheduler's due set. The clean-end branch (process-renewal-cycle,
  // ticket 05) intercepts the trial-end cycle BEFORE any order/payment logic,
  // so an "auto" mode here never results in a charge.
}

function buildRedemptionReference(redemptionRecordId: string): string {
  return `SUB-RDM-${redemptionRecordId}`
}

/**
 * The create branch: consumes one redemption from the code, mints a
 * payment-free subscription per the free-period timing semantics and
 * persists the redemption record.
 */
export const redeemCreateSubscriptionStep = createStep(
  "redeem-create-subscription",
  async function (
    input: { resolution: RedemptionResolution },
    { container }
  ) {
    const { resolution } = input
    const redemptionModuleService =
      container.resolve<RedemptionModuleService>(REDEMPTION_MODULE)
    const subscriptionModuleService =
      container.resolve<SubscriptionModuleService>(SUBSCRIPTION_MODULE)

    const record = await redemptionModuleService.createRedemptionRecords({
      batch_id: resolution.batch.id,
      code_id: resolution.code.id,
      customer_id: resolution.customer_id,
      subscription_id: "pending",
      outcome: "subscription_created",
      free_cycles_applied: resolution.grant.free_cycles,
      frequency_interval: resolution.grant.frequency_interval,
      frequency_value: resolution.grant.frequency_value,
      metadata: null,
    } as any)

    const startedAt = new Date()
    const isTrial = resolution.trial.is_enabled && resolution.trial.days !== null
    const trialEndsAt = isTrial
      ? new Date(startedAt.getTime() + resolution.trial.days! * 86_400_000)
      : null
    const cadenceMs = cadenceToMillis(
      resolution.grant.frequency_interval,
      resolution.grant.frequency_value
    )
    const cancelEffectiveAt = isTrial
      ? null
      : new Date(
          startedAt.getTime() + cadenceMs * resolution.grant.free_cycles
        )

    const subscription = await subscriptionModuleService.createSubscriptions({
      reference: buildRedemptionReference(record.id),
      status: SubscriptionStatus.ACTIVE,
      customer_id: resolution.customer_id,
      cart_id: null,
      product_id: resolution.grant.product_id,
      variant_id: resolution.grant.variant_id,
      frequency_interval: resolution.grant.frequency_interval,
      frequency_value: resolution.grant.frequency_value,
      started_at: startedAt,
      // Trial subscriptions anchor the first renewal cycle at trial end so
      // the clean-end branch (ticket 05) picks it up; free-period ones stay
      // on the startedAt anchor as before.
      next_renewal_at: isTrial ? trialEndsAt! : startedAt,
      last_renewal_at: null,
      paused_at: null,
      cancelled_at: null,
      cancel_effective_at: cancelEffectiveAt,
      skip_next_cycle: false,
      free_cycles_remaining: isTrial ? 0 : resolution.grant.free_cycles,
      is_trial: isTrial,
      trial_ends_at: trialEndsAt,
      customer_snapshot: {
        email: resolution.customer.email,
        full_name: resolution.customer.full_name,
      },
      product_snapshot: {
        product_id: resolution.grant.product_id,
        product_title: resolution.grant.product_title,
        variant_id: resolution.grant.variant_id,
        variant_title: resolution.grant.variant_title,
        sku: resolution.grant.sku,
      },
      pricing_snapshot: null,
      shipping_address: REDEMPTION_SHIPPING_PLACEHOLDER,
      payment_context: isTrial
        ? REDEMPTION_TRIAL_PAYMENT_CONTEXT
        : REDEMPTION_PAYMENT_CONTEXT,
      pending_update_data: null,
      metadata: {
        source: "redemption",
        redemption_batch_id: resolution.batch.id,
        redemption_code_id: resolution.code.id,
        ...(isTrial ? { trial: true } : {}),
      },
    } as any)

    await redemptionModuleService.updateRedemptionRecords({
      id: record.id,
      subscription_id: subscription.id,
    } as any)

    await redemptionModuleService.updateRedemptionCodes({
      id: resolution.code.id,
      redemption_count: resolution.code.redemption_count + 1,
    } as any)

    return new StepResponse<
      RedeemCreateStepOutput,
      { subscription_id: string; record_id: string; code_id: string }
    >(
      {
        subscription_id: subscription.id,
        subscription_reference: subscription.reference,
        record_id: record.id,
        is_trial: isTrial,
        trial_ends_at: trialEndsAt ? trialEndsAt.toISOString() : null,
      },
      {
        subscription_id: subscription.id,
        record_id: record.id,
        code_id: resolution.code.id,
      }
    )
  },
  async function (compensation, { container }) {
    if (!compensation) {
      return
    }
    const redemptionModuleService =
      container.resolve<RedemptionModuleService>(REDEMPTION_MODULE)
    const subscriptionModuleService =
      container.resolve<SubscriptionModuleService>(SUBSCRIPTION_MODULE)

    await subscriptionModuleService.deleteSubscriptions([
      compensation.subscription_id,
    ])
    await redemptionModuleService.deleteRedemptionRecords(compensation.record_id)

    const code = await redemptionModuleService.retrieveRedemptionCode(
      compensation.code_id
    )
    await redemptionModuleService.updateRedemptionCodes({
      id: code.id,
      redemption_count: Math.max(0, code.redemption_count - 1),
    } as any)
  }
)

export type RedeemExtendStepOutput = {
  subscription_id: string
  subscription_reference: string
  record_id: string
  free_cycles_remaining: number
  dunning_recovered: boolean
}

/**
 * The extend branch: consumes one redemption from the code, appends the
 * granted free cycles to the resolved subscription and persists the
 * redemption record. PAST_DUE targets additionally have their open dunning
 * case recovered and are flipped back to ACTIVE — the failed charge
 * obligation is replaced by the free cycles.
 */
export const redeemExtendSubscriptionStep = createStep(
  "redeem-extend-subscription",
  async function (
    input: { resolution: RedemptionResolution },
    { container }
  ) {
    const { resolution } = input
    const redemptionModuleService =
      container.resolve<RedemptionModuleService>(REDEMPTION_MODULE)
    const subscriptionModuleService =
      container.resolve<SubscriptionModuleService>(SUBSCRIPTION_MODULE)

    const subscription = await subscriptionModuleService.retrieveSubscription(
      resolution.target_subscription_id!
    )

    const record = await redemptionModuleService.createRedemptionRecords({
      batch_id: resolution.batch.id,
      code_id: resolution.code.id,
      customer_id: resolution.customer_id,
      subscription_id: subscription.id,
      outcome: "subscription_extended",
      free_cycles_applied: resolution.grant.free_cycles,
      frequency_interval: resolution.grant.frequency_interval,
      frequency_value: resolution.grant.frequency_value,
      metadata: null,
    } as any)

    const nextFreeCycles =
      (subscription.free_cycles_remaining ?? 0) + resolution.grant.free_cycles

    const wasPastDue = subscription.status === SubscriptionStatus.PAST_DUE

    await subscriptionModuleService.updateSubscriptions({
      id: subscription.id,
      status: SubscriptionStatus.ACTIVE,
      free_cycles_remaining: nextFreeCycles,
      // A dunning-recovered subscription resumes normal scheduling; the
      // boundary semantics are untouched for redemption-created ones.
      metadata: {
        ...(subscription.metadata ?? {}),
        last_redemption_batch_id: resolution.batch.id,
        last_redemption_code_id: resolution.code.id,
      },
    } as any)

    await redemptionModuleService.updateRedemptionCodes({
      id: resolution.code.id,
      redemption_count: resolution.code.redemption_count + 1,
    } as any)

    // Recover the open dunning case when extending a PAST_DUE subscription.
    let dunningRecovered = false
    if (wasPastDue) {
      const dunningModuleService = container.resolve<any>("dunning")
      const openCases = await dunningModuleService.listDunningCases({
        subscription_id: subscription.id,
        status: [
          "open",
          "retry_scheduled",
          "retrying",
          "awaiting_manual_resolution",
        ],
      } as any)

      for (const dunningCase of openCases ?? []) {
        await dunningModuleService.updateDunningCases({
          id: dunningCase.id,
          status: "recovered",
          recovered_at: new Date(),
          closed_at: new Date(),
          recovery_reason: "redemption_free_cycles_applied",
        } as any)
        dunningRecovered = true
      }
    }

    return new StepResponse<
      RedeemExtendStepOutput,
      {
        subscription_id: string
        record_id: string
        code_id: string
        previous_status: string
        previous_free_cycles: number
        recovered_case_ids: string[]
      }
    >(
      {
        subscription_id: subscription.id,
        subscription_reference: subscription.reference,
        record_id: record.id,
        free_cycles_remaining: nextFreeCycles,
        dunning_recovered: dunningRecovered,
      },
      {
        subscription_id: subscription.id,
        record_id: record.id,
        code_id: resolution.code.id,
        previous_status: subscription.status,
        previous_free_cycles: subscription.free_cycles_remaining ?? 0,
        recovered_case_ids: wasPastDue
          ? ((await container.resolve<any>("dunning").listDunningCases({
              subscription_id: subscription.id,
              status: ["recovered"],
            } as any)) ?? [])
              .filter((dunningCase: { recovery_reason: string | null }) =>
                dunningCase.recovery_reason === "redemption_free_cycles_applied"
              )
              .map((dunningCase: { id: string }) => dunningCase.id)
          : [],
      }
    )
  },
  async function (compensation, { container }) {
    if (!compensation) {
      return
    }
    const redemptionModuleService =
      container.resolve<RedemptionModuleService>(REDEMPTION_MODULE)
    const subscriptionModuleService =
      container.resolve<SubscriptionModuleService>(SUBSCRIPTION_MODULE)
    const dunningModuleService = container.resolve<any>("dunning")

    await subscriptionModuleService.updateSubscriptions({
      id: compensation.subscription_id,
      status: compensation.previous_status,
      free_cycles_remaining: compensation.previous_free_cycles,
    } as any)

    for (const caseId of compensation.recovered_case_ids) {
      await dunningModuleService.updateDunningCases({
        id: caseId,
        status: "open",
        recovered_at: null,
        closed_at: null,
        recovery_reason: null,
      } as any)
    }

    await redemptionModuleService.deleteRedemptionRecords(compensation.record_id)

    const code = await redemptionModuleService.retrieveRedemptionCode(
      compensation.code_id
    )
    await redemptionModuleService.updateRedemptionCodes({
      id: code.id,
      redemption_count: Math.max(0, code.redemption_count - 1),
    } as any)
  }
)

/**
 * Links the redemption subscription to customer, product and variant. No
 * order/cart links exist for redemption subscriptions.
 */
export const linkRedemptionSubscriptionEntitiesStep = createStep(
  "link-redemption-subscription-entities",
  async function (
    input: {
      subscription_id: string
      customer_id: string
      product_id: string
      variant_id: string
    },
    { container }
  ) {
    const link = container.resolve<any>(ContainerRegistrationKeys.LINK)
    const { Modules } = await import("@medusajs/framework/utils")

    const links = [
      {
        [SUBSCRIPTION_MODULE]: {
          subscription_id: input.subscription_id,
        },
        [Modules.CUSTOMER]: {
          customer_id: input.customer_id,
        },
      },
      {
        [SUBSCRIPTION_MODULE]: {
          subscription_id: input.subscription_id,
        },
        [Modules.PRODUCT]: {
          product_id: input.product_id,
        },
      },
      {
        [SUBSCRIPTION_MODULE]: {
          subscription_id: input.subscription_id,
        },
        [Modules.PRODUCT]: {
          product_variant_id: input.variant_id,
        },
      },
    ]

    await link.create(links)

    return new StepResponse(links, links)
  },
  async function (links, { container }) {
    if (!links?.length) {
      return
    }
    const link = container.resolve<any>(ContainerRegistrationKeys.LINK)
    await link.dismiss(links)
  }
)

function cadenceToMillis(
  interval: SubscriptionFrequencyInterval,
  value: number
): number {
  const day = 24 * 60 * 60 * 1000
  switch (interval) {
    case "week":
      return value * 7 * day
    case "month":
      // Approximation is acceptable here: cancel_effective_at only bounds the
      // scheduling window; the engine advances the real anchor per cycle.
      return value * 30 * day
    case "year":
      return value * 365 * day
    default:
      return value * 30 * day
  }
}
