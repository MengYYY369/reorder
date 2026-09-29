import {
  createStep,
  StepResponse,
} from "@medusajs/framework/workflows-sdk"
import {
  MedusaError,
  ContainerRegistrationKeys,
  Modules,
} from "@medusajs/framework/utils"
import {
  SUBSCRIPTION_MODULE,
} from "../../modules/subscription"
import {
  SubscriptionStatus,
  type SubscriptionFrequencyInterval,
  type SubscriptionShippingAddress,
} from "../../modules/subscription/types"
import { buildPaymentModeFields } from "../utils/payment-mode-mechanism"
import SubscriptionModuleService from "../../modules/subscription/service"
import {
  TRIAL_CLAIM_MODULE,
} from "../../modules/trial-claim"
import TrialClaimModuleService, {
  TrialClaimIneligibleError,
} from "../../modules/trial-claim/service"
import { resolveProductSubscriptionConfig } from "../../modules/plan-offer/utils/effective-config"

/**
 * Everything the claim workflow needs after validation, resolved once.
 */
export type TrialClaimContext = {
  customer_id: string
  customer_email: string | null
  product_id: string
  product_title: string
  variant_id: string
  variant_title: string
  sku: string | null
  region_id: string
  /** The offer's first allowed frequency: the deterministic cadence a claimed
   *  trial renews on after conversion. */
  frequency_interval: SubscriptionFrequencyInterval
  frequency_value: number
  trial_days: number
  trial_bonus_days: number | null
  binding: "none" | "vault"
}

type RawVariantRecord = {
  id: string
  title: string | null
  sku: string | null
  product: { id: string; title: string | null }
}

const TRIAL_CLAIM_SHIPPING_PLACEHOLDER: SubscriptionShippingAddress = {
  first_name: "Trial",
  last_name: "Claim",
  company: null,
  address_1: "N/A",
  address_2: null,
  city: "N/A",
  postal_code: "00000",
  province: null,
  country_code: "us",
  phone: null,
}

/**
 * The one guarded entry of the claim workflow: eligibility (both halves of the
 * Task 20 rule), the trial configuration, and the third
 * `trial_requires_payment_method` enforcement point. Everything it refuses,
 * it refuses BEFORE anything is created — no subscription, no template cart,
 * no ledger row (Q19: there is no degradation branch).
 */
export const resolveTrialClaimContextStep = createStep(
  "resolve-trial-claim-context",
  async function (
    input: {
      customer_id: string
      variant_id: string
      region_id: string
      binding: "none" | "vault"
    },
    { container }
  ) {
    const query = container.resolve(ContainerRegistrationKeys.QUERY)
    const trialClaimModule = container.resolve<TrialClaimModuleService>(
      TRIAL_CLAIM_MODULE
    )
    const customerModule = container.resolve<any>(Modules.CUSTOMER)

    const customer = await customerModule.retrieveCustomer(input.customer_id)

    const { data: variantData } = await query.graph({
      entity: "variant",
      fields: ["id", "title", "sku", "product.id", "product.title"],
      filters: { id: [input.variant_id] },
    })

    const variant = (variantData as RawVariantRecord[])[0]

    if (!variant) {
      throw new MedusaError(
        MedusaError.Types.NOT_FOUND,
        `Variant '${input.variant_id}' was not found.`
      )
    }

    const config = await resolveProductSubscriptionConfig(container, {
      product_id: variant.product.id,
      variant_id: input.variant_id,
    })

    if (
      !config.is_enabled ||
      !config.rules?.trial_enabled ||
      config.rules.trial_days === null ||
      config.rules.trial_days === undefined
    ) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "This product does not offer a trial."
      )
    }

    // The claim endpoint is the third enforcement point of
    // `trial_requires_payment_method` (the checkout gate and the redemption
    // refusal are the other two). A card-free claim is a request to bind
    // nothing, so when the rule demands a bound method the claim must name
    // the binding it intends — the vault rail is the only binding mechanism
    // (Q11), and Task 22 consumes it.
    if (config.rules.trial_requires_payment_method && input.binding === "none") {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "This trial requires binding a payment method. Send binding: \"vault\" to claim it."
      )
    }

    await trialClaimModule.assertEligible(
      input.customer_id,
      variant.product.id,
      container
    )

    const regionRows = await query.graph({
      entity: "region",
      fields: ["id", "currency_code"],
      filters: { id: [input.region_id] },
    })

    const region = (
      regionRows.data as Array<{ id: string; currency_code: string }>
    )[0]

    if (!region) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `Region '${input.region_id}' was not found.`
      )
    }

    // The template cart's region fixes the currency of every future renewal
    // order (Q18a), so the variant must be sellable there — a clear refusal
    // here instead of core's "Variants with IDs … do not have a price". The
    // variant's price set is the same surface Medusa's own pricing reads:
    // the `product_variant_price_set` LINK entity resolves only its own
    // schema columns (variant_id, price_set_id — a nested `prices.*` field is
    // silently dropped), so the prices themselves are read from the
    // `price_set` entity by the link's ids. A region-scoped price matches by
    // region, a currency-scoped one (no `region_id`) by currency.
    const { data: variantPriceSetData } = await query.graph({
      entity: "product_variant_price_set",
      fields: ["variant_id", "price_set_id"],
      filters: { variant_id: [input.variant_id] },
    })

    const priceSetIds = (
      variantPriceSetData as Array<{ price_set_id: string }>
    ).map((row) => row.price_set_id)

    const priceSetData = priceSetIds.length
      ? await query.graph({
          entity: "price_set",
          fields: [
            "id",
            "prices.amount",
            "prices.currency_code",
            "prices.region_id",
          ],
          filters: { id: priceSetIds },
        })
      : { data: [] }

    const priceSets = priceSetData.data as Array<{
      prices?: Array<{
        amount: number
        currency_code: string | null
        region_id?: string | null
      }> | null
    }>

    const sellablePrice = priceSets.some((priceSet) =>
      (priceSet.prices ?? []).some(
        (price) =>
          price.region_id === region.id ||
          // The read omits a null `region_id` entirely, so the currency-
          // scoped half must accept both null and undefined.
          (price.region_id == null &&
            price.currency_code === region.currency_code)
      )
    )

    if (!sellablePrice) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `This trial is not available in the selected region '${input.region_id}'.`
      )
    }

    const frequencies = config.allowed_frequencies

    if (!frequencies.length) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "This product's subscription has no configured renewal frequency."
      )
    }

    const context: TrialClaimContext = {
      customer_id: input.customer_id,
      customer_email: customer.email ?? null,
      product_id: variant.product.id,
      product_title: variant.product.title ?? "Unknown product",
      variant_id: variant.id,
      variant_title: variant.title ?? "Unknown variant",
      sku: variant.sku ?? null,
      region_id: region.id,
      frequency_interval: frequencies[0].interval as unknown as SubscriptionFrequencyInterval,
      frequency_value: frequencies[0].value,
      trial_days: config.rules.trial_days,
      trial_bonus_days: config.rules.trial_bonus_days ?? null,
      binding: input.binding,
    }

    return new StepResponse(context, null)
  }
)

export type CreateTrialSubscriptionStepOutput = {
  subscription_id: string
  subscription_reference: string
  trial_ends_at: string
}

/**
 * Creates the claimed trial: `payment_mode: manual` (a claimed trial without a
 * bound method is unchargeable by design — Task 14's trial-end branch ends a
 * manual trial deterministically at `trial_ends_at`), the template cart as the
 * renewal order's source, and the `trial_ends_at` anchor.
 */
export const createTrialSubscriptionStep = createStep(
  "create-trial-subscription",
  async function (
    input: { context: TrialClaimContext; cart_id: string },
    { container }
  ) {
    const subscriptionModuleService =
      container.resolve<SubscriptionModuleService>(SUBSCRIPTION_MODULE)

    const startedAt = new Date()
    const trialEndsAt = new Date(
      startedAt.getTime() + input.context.trial_days * 86_400_000
    )

    const subscription = await subscriptionModuleService.createSubscriptions({
      reference: `SUB-TRIAL-${crypto.randomUUID()}`,
      status: SubscriptionStatus.ACTIVE,
      customer_id: input.context.customer_id,
      cart_id: input.cart_id,
      product_id: input.context.product_id,
      variant_id: input.context.variant_id,
      frequency_interval: input.context.frequency_interval,
      frequency_value: input.context.frequency_value,
      started_at: startedAt,
      next_renewal_at: trialEndsAt,
      last_renewal_at: null,
      paused_at: null,
      cancelled_at: null,
      cancel_effective_at: null,
      skip_next_cycle: false,
      free_cycles_remaining: 0,
      is_trial: true,
      trial_ends_at: trialEndsAt,
      customer_snapshot: {
        email: input.context.customer_email ?? "",
        full_name: null,
      },
      product_snapshot: {
        product_id: input.context.product_id,
        product_title: input.context.product_title,
        variant_id: input.context.variant_id,
        variant_title: input.context.variant_title,
        sku: input.context.sku,
      },
      pricing_snapshot: null,
      shipping_address: TRIAL_CLAIM_SHIPPING_PLACEHOLDER,
      payment_context: {
        ...buildPaymentModeFields("manual"),
        payment_provider_id: null,
        source_payment_collection_id: null,
        source_payment_session_id: null,
        payment_method_reference: null,
        customer_payment_reference: null,
      },
      pending_update_data: null,
      metadata: {
        source: "trial_claim",
        binding: input.context.binding,
        ...(input.context.trial_bonus_days !== null
          ? { trial_bonus_days: input.context.trial_bonus_days }
          : {}),
      },
    } as never)

    const link = container.resolve<any>(ContainerRegistrationKeys.LINK)

    const links = [
      {
        [SUBSCRIPTION_MODULE]: {
          subscription_id: subscription.id,
        },
        [Modules.CUSTOMER]: {
          customer_id: input.context.customer_id,
        },
      },
      {
        [SUBSCRIPTION_MODULE]: {
          subscription_id: subscription.id,
        },
        [Modules.PRODUCT]: {
          product_id: input.context.product_id,
        },
      },
      {
        [SUBSCRIPTION_MODULE]: {
          subscription_id: subscription.id,
        },
        [Modules.PRODUCT]: {
          product_variant_id: input.context.variant_id,
        },
      },
    ]

    await link.create(links)

    return new StepResponse<CreateTrialSubscriptionStepOutput, string>(
      {
        subscription_id: subscription.id,
        subscription_reference: subscription.reference,
        trial_ends_at: trialEndsAt.toISOString(),
      },
      subscription.id
    )
  },
  async function (subscriptionId, { container }) {
    if (!subscriptionId) {
      return
    }

    // Compensation: a failure after this step (ledger, cycle, cart close)
    // must not leave a ledger-backed trial subscription behind.
    const subscriptionModuleService =
      container.resolve<SubscriptionModuleService>(SUBSCRIPTION_MODULE)
    const link = container.resolve<any>(ContainerRegistrationKeys.LINK)

    await link.dismiss([
      {
        [SUBSCRIPTION_MODULE]: {
          subscription_id: subscriptionId,
        },
      },
    ])
    await subscriptionModuleService.deleteSubscriptions(subscriptionId)
  }
)

export { TrialClaimIneligibleError }
