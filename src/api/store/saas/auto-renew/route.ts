import { MedusaError } from "@medusajs/framework/utils"
import { Modules } from "@medusajs/framework/utils"
import type {
  MedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http"
import type {
  ICustomerModuleService,
} from "@medusajs/framework/types"
import {
  readFailureLogger,
  assertTenantVisible,
  readTenantScoped,
} from "../lib/tenant-ownership"
import {
  AUTO_RENEW_CUSTOMER_REFUSALS,
  setSubscriptionAutoRenewWorkflow,
} from "../../../../workflows/set-subscription-auto-renew"
import {
  classifyStepFailure,
  logUnquotedStepFailure,
  type StepFailureCopy,
} from "../../../../workflows/utils/store-step-failure"
import type { SubscriptionPaymentMode } from "../../../../modules/subscription/types"
import { SUBSCRIPTION_MODULE } from "../../../../modules/subscription"
import type SubscriptionModuleService from "../../../../modules/subscription/service"

// Both readers are derived from the real services rather than restated here: a
// resolved-by-string module gives the compiler nothing to check against, so a
// restated signature turns a rename upstream into a runtime `TypeError` instead
// of a build failure (`.agents/lessons.md`).
type CustomerModule = Pick<ICustomerModuleService, "retrieveCustomer">

type SubscriptionModule = Pick<SubscriptionModuleService, "listSubscriptions">

/**
 * The response texts for a failure that is not one of the guards' refusals.
 * They are ours, fixed, and say nothing about the cause: the cause goes to the
 * log. `refused` and `failed` are deliberately the same sentence — which status
 * class a non-refusal failure keeps is the caller's business, not its wording.
 */
const AUTO_RENEW_FAILURE_COPY: StepFailureCopy = {
  notFound: "subscription not found",
  refused: "auto-renewal could not be updated",
  failed: "auto-renewal could not be updated",
}

/**
 * POST /store/saas/auto-renew
 * Body: { subscription_id, enabled: boolean }
 * → { subscription_id, payment_mode }
 *
 * Flips the subscription between manual (cashier-link) and auto (off-session
 * scheduler) renewal by running the set-subscription-auto-renew workflow —
 * the same write side the payment-method update uses, so `payment_mode` and its
 * `mechanism` annotation always change together. This handler only validates the
 * body, applies the request-bound tenant rule, and shapes the response.
 *
 * FAILURE DISCLOSURE: the two guards owned by the workflow — a mirror of a
 * provider-owned recurrence and an overdue subscription — answer 400 with their
 * own message before anything is written. No other failure is quoted: it keeps
 * the HTTP semantics of the `MedusaError` it was thrown as (a vanished row is a
 * 404, a conflict a 409) or becomes a 500, and its text is replaced by ours
 * while the cause is logged. See
 * `src/workflows/utils/store-step-failure.ts`.
 *
 * TENANT ISOLATION: subscription → customer → metadata.tenant_id must match the
 * calling tenant, else 404 (existence is not leaked).
 *
 * READ BOUNDARY: both scoping reads are `readTenantScoped` calls, so a read that
 * fails answers the same 404 `subscription not found` a read that finds nothing
 * does, and the cause only reaches the log — a driver message naming a table or
 * column cannot be quoted here. See
 * `src/modules/subscription/utils/store-read-failure.ts`.
 */
export async function POST(
  req: MedusaRequest,
  res: MedusaResponse
) {
  const { subscription_id, enabled } = (req.body ?? {}) as {
    subscription_id?: string
    enabled?: boolean
  }

  // reorder mints subscription ids without a prefix — accept any non-empty
  // string; existence + tenant ownership are checked below.
  if (typeof subscription_id !== "string" || !subscription_id.trim()) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      "body.subscription_id must be a subscription id"
    )
  }
  if (typeof enabled !== "boolean") {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      "body.enabled must be a boolean"
    )
  }

  const customerModule = req.scope.resolve<CustomerModule>(Modules.CUSTOMER)
  const subscriptionModule = req.scope.resolve<SubscriptionModule>(
    SUBSCRIPTION_MODULE
  )
  const logger = readFailureLogger(req)

  const subscriptions = await readTenantScoped(
    logger,
    "auto-renew subscription lookup",
    AUTO_RENEW_FAILURE_COPY,
    () =>
      subscriptionModule.listSubscriptions({
        id: [subscription_id],
      })
  )
  const subscription = subscriptions[0] ?? null

  // A read that *answered* with no row is the honest 404 this route has always
  // given; the wrapper above only covers a read that failed to answer.
  if (!subscription) {
    throw new MedusaError(
      MedusaError.Types.NOT_FOUND,
      AUTO_RENEW_FAILURE_COPY.notFound
    )
  }

  const customer = await readTenantScoped(
    logger,
    "auto-renew tenant check",
    AUTO_RENEW_FAILURE_COPY,
    () => customerModule.retrieveCustomer(subscription.customer_id)
  )

  assertTenantVisible(req, customer?.metadata, "subscription")

  const { errors, result } = await setSubscriptionAutoRenewWorkflow(
    req.scope
  ).run({
    input: {
      subscription_id: subscription.id,
      enabled,
    },
    throwOnError: false,
  })

  if (errors?.length) {
    const failure = classifyStepFailure({
      errors,
      refusals: AUTO_RENEW_CUSTOMER_REFUSALS,
      copy: AUTO_RENEW_FAILURE_COPY,
    })

    if (!failure.quoted) {
      // Everything that is not a guard refusal is either a fault of ours or a
      // refusal phrased in someone else's words. Wrapping it in a 400 would
      // hide the status the SaaS needs to retry, and quoting it would put
      // internal text (`connect ECONNREFUSED …`, a driver's `table`/`detail`)
      // in front of a customer reading it as a permanent refusal — so the cause
      // is logged and the response carries only our own wording.
      logUnquotedStepFailure(
        logger,
        "auto-renew toggle",
        failure
      )
    }

    throw new MedusaError(failure.type, failure.message)
  }

  const updated = (result ?? {}) as {
    subscription_id?: string
    payment_mode?: SubscriptionPaymentMode
  }

  if (!updated.subscription_id || !updated.payment_mode) {
    // Same shape as `/store/saas/redeem`: a workflow that reports neither an
    // error nor a usable result must not answer 200 with an empty body.
    throw new MedusaError(
      MedusaError.Types.UNEXPECTED_STATE,
      "auto-renewal toggle returned no payment mode"
    )
  }

  res.json({
    subscription_id: updated.subscription_id,
    payment_mode: updated.payment_mode,
  })
}
