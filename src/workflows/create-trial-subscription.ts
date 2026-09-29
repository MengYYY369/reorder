import {
  createWorkflow,
  transform,
  WorkflowResponse,
} from "@medusajs/framework/workflows-sdk"
import { acquireLockStep, releaseLockStep } from "@medusajs/medusa/core-flows"
import {
  createCartWorkflow,
  updateCartsStep,
} from "@medusajs/medusa/core-flows"
import {
  createTrialSubscriptionStep,
  resolveTrialClaimContextStep,
  type CreateTrialSubscriptionStepOutput,
  type TrialClaimContext,
} from "./steps/create-trial-subscription"
import { recordTrialClaimStep } from "./steps/record-trial-claim"
import { TrialClaimSource } from "../modules/trial-claim/types"
import { ensureNextRenewalCycleStep } from "./steps/ensure-next-renewal-cycle"
import {
  createSubscriptionLogEventStep,
} from "./steps/create-subscription-log-event"
import {
  ActivityLogEventType,
  ActivityLogActorType,
} from "../modules/activity-log/types"
import { normalizeActivityLogEvent } from "../modules/activity-log/utils/normalize-log-event"

export type CreateTrialSubscriptionWorkflowInput = {
  customer_id: string
  variant_id: string
  region_id: string
  binding: "none" | "vault"
}

export type CreateTrialSubscriptionWorkflowOutput =
  CreateTrialSubscriptionStepOutput & {
    cart_id: string
    claim_recorded: boolean
  }

/**
 * The self-service trial claim (Phase 13): a card-free trial with no order
 * and no payment, copied from the redemption path's payment shape.
 *
 * The template cart (Q18a) exists only so `createRenewalOrder` has a source —
 * every charge path in the plugin refuses a subscription without a cart, and
 * Task 14's conversion branch is one of them. It is created through core
 * `createCartWorkflow` (region + one line for the variant), the subscription's
 * `cart_id` is pointed at it, and `completed_at` is set in a separate write:
 * `createCartWorkflow` cannot create a completed cart (its promotion update
 * runs `validateCartStep`, which throws "already completed" and compensates by
 * deleting the cart).
 *
 * Known residual risk, accepted for now: `updateCart` and
 * `updateLineItemInCart` do not select `completed_at`, so their queries are
 * blind to the column — a holder of the leaked id could still mutate the
 * template cart's email, addresses and quantities. The id is not disclosed to
 * the customer (the `renewal_source_cart_id` line-item metadata write is
 * deleted at the source), so the exposure is defense-in-depth depth, not the
 * primary guard.
 */
export const createTrialSubscriptionWorkflow = createWorkflow(
  "create-trial-subscription",
  function (input: CreateTrialSubscriptionWorkflowInput) {
    const lockKey = transform({ input }, function ({ input }) {
      return `trial-claim:${input.customer_id}:${input.variant_id}`
    })

    acquireLockStep({
      key: lockKey,
      timeout: 10,
      ttl: 120,
    })

    const context: TrialClaimContext = resolveTrialClaimContextStep(input)

    const cartInput = transform(
      { context },
      function ({ context }: { context: TrialClaimContext }) {
        return {
          region_id: context.region_id,
          email: context.customer_email ?? undefined,
          customer_id: context.customer_id,
          // Digital product: cart validation requires a shipping address; no
          // fulfillment follows a trial claim, so the placeholder mirrors the
          // SaaS cart route's approach.
          shipping_address: {
            first_name: "Trial",
            last_name: "Claim",
            address_1: "N/A",
            city: "N/A",
            postal_code: "00000",
            country_code: "us",
          },
          items: [
            {
              variant_id: context.variant_id,
              quantity: 1,
              metadata: {
                is_subscription: true,
                source: "trial_claim",
              },
            },
          ],
        }
      }
    )

    const cart = createCartWorkflow.runAsStep({ input: cartInput })

    // `completed_at` is what makes the template cart un-completable and
    // un-subscribable: addToCart, addShippingMethodToCart, refreshCartItems,
    // sync-subscription-cart-pricing and createPaymentCollectionForCart all
    // refuse a completed cart, and a payment collection is what
    // `completeCartWorkflow` requires.
    const cartCompletion = transform(
      { cart },
      function ({ cart }: { cart: { id: string } }) {
        return [
          {
            id: cart.id,
            completed_at: new Date(),
          },
        ] as never
      }
    )
    updateCartsStep(cartCompletion).config({
      name: "mark-trial-template-cart-completed",
    })

    const created = createTrialSubscriptionStep({
      context,
      cart_id: (cart as unknown as { id: string }).id,
    })

    const claimInput = transform(
      { context, created },
      function ({
        context,
        created,
      }: {
        context: TrialClaimContext
        created: CreateTrialSubscriptionStepOutput
      }) {
        return {
          customer_id: context.customer_id,
          product_id: context.product_id,
          variant_id: context.variant_id,
          source: TrialClaimSource.SELF_SERVICE,
          subscription_id: created.subscription_id,
          trial_ends_at: created.trial_ends_at,
          is_trial: true,
        }
      }
    )
    const claim = recordTrialClaimStep(claimInput).config({
      name: "record-self-service-trial-claim",
    })

    ensureNextRenewalCycleStep(
      transform({ created }, function ({ created }) {
        return { subscription_id: created.subscription_id }
      })
    ).config({ name: "create-claimed-trial-initial-renewal-cycle" })

    const logInput = transform(
      { context, created },
      function ({
        context,
        created,
      }: {
        context: TrialClaimContext
        created: CreateTrialSubscriptionStepOutput
      }) {
        return {
          log_event: normalizeActivityLogEvent({
            subscription_id: created.subscription_id,
            customer_id: context.customer_id,
            event_type: ActivityLogEventType.SUBSCRIPTION_CREATED,
            actor_type: ActivityLogActorType.CUSTOMER,
            actor_id: context.customer_id,
            display: {
              subscription_reference: created.subscription_reference,
              product_title: context.product_title,
              variant_title: context.variant_title,
            },
            previous_state: null,
            new_state: {
              source: "trial_claim",
              trial_days: context.trial_days,
              binding: context.binding,
            },
            metadata: {
              source: "trial_claim",
              variant_id: context.variant_id,
              region_id: context.region_id,
            },
            dedupe: {
              scope: "trial_claim",
              target_id: created.subscription_id,
            },
          }),
        }
      }
    )
    createSubscriptionLogEventStep(logInput).config({
      name: "create-claimed-trial-created-log-event",
    })

    const result = transform(
      { created, cart, claim },
      function ({
        created,
        cart,
        claim,
      }: {
        created: CreateTrialSubscriptionStepOutput
        cart: { id: string }
        claim: { recorded: boolean }
      }) {
        return {
          ...created,
          cart_id: cart.id,
          claim_recorded: claim.recorded,
        }
      }
    )

    releaseLockStep({
      key: lockKey,
    })

    return new WorkflowResponse(result)
  }
)

export default createTrialSubscriptionWorkflow
