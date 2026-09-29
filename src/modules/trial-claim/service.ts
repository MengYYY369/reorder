import {
  MedusaError,
  MedusaService,
} from "@medusajs/framework/utils"
import TrialClaim from "./models/trial-claim"
import {
  RecordTrialClaimInput,
  TrialClaimBindingMethod,
  TrialClaimDTO,
} from "./types"
import { SUBSCRIPTION_MODULE } from "../subscription"
import type SubscriptionModuleService from "../subscription/service"

export class TrialClaimIneligibleError extends MedusaError {
  constructor(message: string) {
    super(MedusaError.Types.INVALID_DATA, message)
  }
}

function trialIneligibleMessage(customerId: string, productId: string): string {
  return `Trial has already been claimed for customer ${customerId} and product ${productId}`
}

/**
 * The reader `assertEligible` needs from the caller's container. Derived from
 * the real subscription service (never restated) and resolved under this
 * exact registration key, so a renamed or re-signed method is a compile error
 * at the consumer, not a runtime surprise inside the module.
 *
 * A module service's own injected container is local to the module —
 * `@medusajs/modules-sdk/dist/loaders/utils/load-internal.js:124-131` registers
 * only the fixed framework set plus the resolution's declared `dependencies`,
 * and auto-registered plugin modules declare none — so the subscription half
 * of the rule takes the caller's container (a step's `{ container }`, a
 * route's `req.scope`, a job's app container), the same way every other
 * cross-domain read in this repo receives one (`analytics/utils/admin-query.ts`,
 * `renewal/utils/scheduler-query.ts`).
 */
export type TrialClaimSubscriptionReader = Pick<
  SubscriptionModuleService,
  "listSubscriptions"
>

export type TrialClaimDependencies = {
  resolve: (key: typeof SUBSCRIPTION_MODULE) => TrialClaimSubscriptionReader
}

/**
 * The DAL's `dbErrorMapper` turns a Postgres 23505 into a `MedusaError`
 * (invalid_data) shaped like `Trial claim with customer_id: <a>, product_id:
 * <b>, already exists.` (@medusajs/utils/dist/dal/mikro-orm/db-error-mapper.js:20-28;
 * the mapper only upper-cases the first letter of the table name). `record`
 * rethrows exactly that shape as the domain refusal, so the unique index —
 * the race-safe anchor — speaks the same wording `assertEligible` speaks. A
 * missed match is harmless: the mapper's message already carries nothing but
 * the ids the caller supplied.
 */
function isTrialClaimUniqueViolation(error: unknown): boolean {
  return (
    error instanceof MedusaError &&
    error.type === MedusaError.Types.INVALID_DATA &&
    /^Trial claim with .*already exists\.$/.test(error.message)
  )
}

class TrialClaimModuleService extends MedusaService({
  TrialClaim,
}) {
  /**
   * The eligibility rule, both halves: a customer is ineligible for a trial
   * of a product when EITHER a ledger row already exists for the pair, OR
   * ANY subscription exists for that customer and product — any rail
   * (`NATIVE-` provider-managed mirrors included), any status.
   *
   * Both halves read live rows only (the DAL excludes soft-deleted ones) and
   * are checked in this order so a plain duplicate claim is answered from
   * this module alone, without touching the subscription module.
   *
   * The subscription half reads the `subscription` table's own
   * `customer_id` and `product_id` columns (NOT NULL and indexed,
   * `src/modules/subscription/models/subscription.ts:12` and `:14`) through
   * `listSubscriptions`, the way the redemption path reads subscriptions. It
   * deliberately does NOT query the `subscription_product` link table: those
   * links are created only by the redemption path, so a link-based query
   * would silently pass every customer who bought the plan through checkout
   * or a native mirror.
   */
  async assertEligible(
    customerId: string,
    productId: string,
    container: TrialClaimDependencies
  ): Promise<void> {
    const existingClaims = await this.listTrialClaims(
      { customer_id: customerId, product_id: productId },
      { select: ["id"], take: 1 }
    )
    if (existingClaims.length > 0) {
      throw new TrialClaimIneligibleError(
        trialIneligibleMessage(customerId, productId)
      )
    }

    // Any subscription counts: no status filter, no reference/rail filter.
    const subscriptionModule = container.resolve(SUBSCRIPTION_MODULE)
    const existingSubscriptions = await subscriptionModule.listSubscriptions(
      { customer_id: customerId, product_id: productId },
      { select: ["id"], take: 1 }
    )
    if (existingSubscriptions.length > 0) {
      throw new TrialClaimIneligibleError(
        trialIneligibleMessage(customerId, productId)
      )
    }
  }

  /**
   * Moves a claim's `binding_method` to its bound value (Phase 14: `vault`,
   * once the customer's approved setup token became a vault id). Keyed by
   * `subscription_id` because that is what the binding step holds after
   * loading the customer's own trial; a trial whose ledger row is missing
   * (no door wrote one) leaves `null` and the caller binds anyway — the
   * ledger records the binding, it does not gate it.
   */
  async updateBindingMethod(
    subscriptionId: string,
    bindingMethod: TrialClaimBindingMethod
  ): Promise<TrialClaimDTO | null> {
    const existing = await this.listTrialClaims(
      { subscription_id: subscriptionId },
      { select: ["id", "binding_method"], take: 1 }
    )
    const claim = existing[0]

    if (!claim) {
      return null
    }

    const updated = await this.updateTrialClaims({
      id: claim.id,
      binding_method: bindingMethod,
    })

    return updated as unknown as TrialClaimDTO
  }

  /**
   * Writes one ledger row. There is no eligibility pre-check here on
   * purpose: the `(customer_id, product_id)` unique index is the race-safe
   * anchor, so a concurrent pair of claims cannot both win no matter which
   * door each came through. A losing insert surfaces as the same
   * `TrialClaimIneligibleError` the pre-check produces.
   */
  async record(input: RecordTrialClaimInput): Promise<TrialClaimDTO> {
    try {
      const claim = await this.createTrialClaims({
        customer_id: input.customer_id,
        product_id: input.product_id,
        variant_id: input.variant_id,
        source: input.source,
        subscription_id: input.subscription_id,
        claimed_at: new Date(),
        trial_ends_at: input.trial_ends_at ?? null,
        binding_method: input.binding_method ?? TrialClaimBindingMethod.NONE,
      })
      return claim as unknown as TrialClaimDTO
    } catch (error) {
      if (isTrialClaimUniqueViolation(error)) {
        throw new TrialClaimIneligibleError(
          trialIneligibleMessage(input.customer_id, input.product_id)
        )
      }
      throw error
    }
  }
}

export default TrialClaimModuleService
