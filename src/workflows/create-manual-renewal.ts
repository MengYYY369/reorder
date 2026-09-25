import {
  createWorkflow,
  transform,
  WorkflowResponse,
} from "@medusajs/framework/workflows-sdk"
import { MedusaError } from "@medusajs/framework/utils"
import { acquireLockStep, releaseLockStep } from "@medusajs/medusa/core-flows"
import {
  createManualRenewalStep,
  type CreateManualRenewalStepOutput,
} from "./steps/create-manual-renewal"
import type { CustomerRefusal } from "./utils/store-step-failure"

export type CreateManualRenewalWorkflowInput = {
  subscription_id: string
  triggered_by?: string | null
  reason?: string | null
}

/**
 * The refusals this workflow authors for the caller, and the only ones a
 * `POST /store/saas/renew` response may quote — each with its exact text.
 *
 * Owned here, with the composition, for the same reason as
 * `AUTO_RENEW_CUSTOMER_REFUSALS`: the route that discloses a failure must not
 * be the place that decides which step may speak. The step's name is read off
 * the step itself (`__step__`, typed by the workflow SDK), so this list cannot
 * drift from the `createStep` registration.
 *
 * Every entry declares its text because the step is not a pure guard: after
 * these checks it creates the renewal order and its payment sessions through
 * core workflows, and a `MedusaError` raised in there carries the same `action`
 * as our refusals.
 *
 * What is deliberately NOT in the list, and what happens instead:
 * - the row-not-found refusal (the handler checked existence a moment earlier,
 *   so it is a race): kept as a 404 with the route's own text.
 * - `Renewal '…' is already processing` (`conflict`): answers 409 instead of
 *   the 400 it used to be given — retryable, which is what it is. Core replaces
 *   the body text of every 409 with its own retry sentence.
 * - `Subscription '…' is missing 'cart_id' …`: a broken row of ours, not a
 *   refusal of the caller's request. It keeps a 400 and loses its wording,
 *   which names an internal column.
 * - anything that is not a `MedusaError` at all (driver, connection): 500.
 */
export const RENEW_CUSTOMER_REFUSALS: readonly CustomerRefusal[] = [
  {
    step: createManualRenewalStep.__step__,
    type: MedusaError.Types.INVALID_DATA,
    copy: /^Subscription '[^']*' is a mirror of a PayPal-managed recurrence and cannot be renewed here$/,
  },
  {
    step: createManualRenewalStep.__step__,
    type: MedusaError.Types.INVALID_DATA,
    copy: /^Subscription '[^']*' is not in manual payment mode; use the standard renewal flow$/,
  },
  {
    step: createManualRenewalStep.__step__,
    type: MedusaError.Types.INVALID_DATA,
    copy: /^Subscription '[^']*' is '[a-z_]+'; only active subscriptions can be manually renewed$/,
  },
]

/**
 * Manual renewal for manual-payment-mode subscriptions (redirect-only
 * providers): creates the renewal order + an UNCONFIRMED payment session and
 * returns the cashier URL. The cycle is finalized by complete-manual-renewal
 * once the payment capture lands.
 *
 * Invoke BY NAME through the workflow engine — the workflow is registered by
 * the plugin's workflow loader and must not be imported from host code (its
 * flow graph embeds per-instance random ids; a second registration from a
 * different module graph diverges and throws).
 */
export const createManualRenewalWorkflow = createWorkflow(
  "create-manual-renewal",
  function (input: CreateManualRenewalWorkflowInput) {
    const lockInput = transform({ input }, ({ input }) => ({
      key: `manual-renewal:${input.subscription_id}`,
      timeout: 30,
      ttl: 120,
    }))

    acquireLockStep(lockInput)

    const renewal = createManualRenewalStep({
      subscription_id: input.subscription_id,
      triggered_by: input.triggered_by ?? null,
      reason: input.reason ?? null,
    })

    releaseLockStep(
      transform({ renewal }, ({ renewal }) => ({
        key: `manual-renewal:${renewal.subscription_id}`,
      }))
    )

    return new WorkflowResponse<CreateManualRenewalStepOutput>(renewal)
  }
)

export default createManualRenewalWorkflow
