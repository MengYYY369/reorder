import { MedusaError } from "@medusajs/framework/utils"
import {
  createWorkflow,
  transform,
  WorkflowResponse,
} from "@medusajs/framework/workflows-sdk"
import {
  ASSERT_AUTO_RENEW_NOT_NATIVE_STEP_NAME,
  ASSERT_AUTO_RENEW_NOT_OVERDUE_STEP_NAME,
  assertAutoRenewNotNativeStep,
  assertAutoRenewNotOverdueStep,
  updateSubscriptionPaymentModeStep,
} from "./steps/set-subscription-auto-renew"
import type { CustomerRefusal } from "./utils/store-step-failure"
import type { SubscriptionPaymentMode } from "../modules/subscription/types"

export type SetSubscriptionAutoRenewWorkflowInput = {
  subscription_id: string
  enabled: boolean
}

export type SetSubscriptionAutoRenewWorkflowResult = {
  subscription_id: string
  payment_mode: SubscriptionPaymentMode
}

/**
 * The refusals this workflow authors for the caller, and the only ones a
 * `POST /store/saas/auto-renew` response may quote.
 *
 * Both guards refuse with their own `invalid_data` about the caller's request.
 * Everything else this workflow runs — above all the write — fails for
 * infrastructure reasons, and a caller must not be told those failures are its
 * own fault. The list is owned here because this is the module that composes the
 * steps, so the route never names a step itself.
 *
 * Each entry declares its exact text, and that is not decoration: the native
 * mirror guard is not a predicate over its input, it resolves the subscription
 * module and reads the row (`steps/set-subscription-auto-renew.ts:94-99`). The
 * DAL converts a driver fault on that read into an `INVALID_DATA` MedusaError
 * whose message is the database's own (`db-error-mapper.js:34-37` for SQLSTATE
 * 42703, which quotes the missing column), and the engine reports it under that
 * guard's `action`. Without the declared text the disclosure rule would have
 * nothing to refuse and would quote a column name to the customer as a
 * permanent 400 — pinned by
 * `integration-tests/http/native-subscription-mirror.spec.ts`.
 *
 * The `not_found` the same read can produce is filtered out by the declared
 * `type` and answered as a 404 with the route's own text.
 */
export const AUTO_RENEW_CUSTOMER_REFUSALS: readonly CustomerRefusal[] = [
  {
    step: ASSERT_AUTO_RENEW_NOT_NATIVE_STEP_NAME,
    type: MedusaError.Types.INVALID_DATA,
    copy: /^Subscription '[^']*' is a mirror of a provider-managed recurrence; manage auto-renewal at the provider$/,
  },
  {
    step: ASSERT_AUTO_RENEW_NOT_OVERDUE_STEP_NAME,
    type: MedusaError.Types.INVALID_DATA,
    copy: /^Subscription '[^']*' is overdue — renew manually before enabling auto-renewal$/,
  },
]

/**
 * Flips a subscription between the manual (cashier-link) and the automatic
 * (off-session scheduler) renewal mode.
 *
 * Tenant visibility is a request-bound rule and stays with the route
 * (`src/api/store/saas/lib/tenant-ownership.ts`); everything that decides
 * whether the mode may change and what gets written lives here:
 *
 *  1. `assert-subscription-auto-renew-not-native` — the write-side mirror guard
 *  2. `assert-subscription-auto-renew-not-overdue` — the surprise-charge guard
 *  3. `update-subscription-payment-mode` — the only state-changing write, which
 *     compensates by restoring the previous `payment_context`
 *
 * A stale stored method reference is not checked here: it surfaces as
 * `renewal.failed` + PAST_DUE on the scheduler side, the documented behavior of
 * the toggle.
 */
export const setSubscriptionAutoRenewWorkflow = createWorkflow(
  "set-subscription-auto-renew",
  function (input: SetSubscriptionAutoRenewWorkflowInput) {
    const subscription = assertAutoRenewNotNativeStep({
      subscription_id: input.subscription_id,
    })

    const guardInput = transform(
      { subscription, input },
      function ({ subscription, input }) {
        return {
          id: subscription.id,
          status: subscription.status,
          next_renewal_at: subscription.next_renewal_at,
          current_mode: subscription.current_mode,
          enabled: input.enabled,
        }
      }
    )

    const committedMode = assertAutoRenewNotOverdueStep(guardInput)

    const writeInput = transform(
      { committedMode, input },
      function ({ committedMode, input }) {
        return {
          subscription_id: input.subscription_id,
          payment_mode: committedMode.payment_mode,
        }
      }
    )

    const updated = updateSubscriptionPaymentModeStep(writeInput)

    return new WorkflowResponse<SetSubscriptionAutoRenewWorkflowResult>({
      subscription_id: updated.subscription_id,
      payment_mode: updated.payment_mode,
    })
  }
)

export default setSubscriptionAutoRenewWorkflow
