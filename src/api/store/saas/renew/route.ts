import {
  ContainerRegistrationKeys,
  MedusaError,
} from "@medusajs/framework/utils"
import { Modules } from "@medusajs/framework/utils"
import type {
  MedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http"
import { assertTenantVisible } from "../lib/tenant-ownership"
import {
  createManualRenewalWorkflow,
  RENEW_CUSTOMER_REFUSALS,
} from "../../../../workflows/create-manual-renewal"
import type { CreateManualRenewalStepOutput } from "../../../../workflows/steps/create-manual-renewal"
import {
  classifyStepFailure,
  logUnquotedStepFailure,
  type StepFailureCopy,
  type StepFailureLogger,
} from "../../../../workflows/utils/store-step-failure"
import { SUBSCRIPTION_MODULE } from "../../../../modules/subscription"
import type SubscriptionModuleService from "../../../../modules/subscription/service"

type CustomerModule = {
  retrieveCustomer: (
    id: string,
    config?: Record<string, unknown>
  ) => Promise<{ metadata?: Record<string, unknown> | null }>
}

// Named on the service rather than restated here: a resolved-by-string module
// gives the compiler nothing to check against, so a restated signature turns a
// rename into a runtime `TypeError` instead of a build failure
// (`.agents/lessons.md`).
type SubscriptionModule = Pick<SubscriptionModuleService, "listSubscriptions">

/**
 * Our own texts for every other failure. Fixed strings — none of them is built
 * from a failure, so no internal message, table or column name can reach the
 * customer through this route. `failed` doubles as the answer for a run that
 * reports neither an error nor a usable result.
 *
 * Which step may speak, and in which words, is the workflow's decision:
 * `RENEW_CUSTOMER_REFUSALS` comes from
 * `src/workflows/create-manual-renewal.ts`.
 */
const RENEW_FAILURE_COPY: StepFailureCopy = {
  notFound: "subscription not found",
  refused: "manual renewal was refused",
  failed: "manual renewal failed",
}

/**
 * POST /store/saas/renew
 * Body: { subscription_id, triggered_by?, reason? }
 * → { order_id, redirect_url, total, currency_code, reused }
 *
 * Manual renewal entry: runs the create-manual-renewal workflow via direct
 * typed import and returns the cashier link. Payment completion is handled
 * by the reorder payment.captured subscriber; /renew itself never confirms
 * payment.
 *
 * FAILURE DISCLOSURE: only the refusals the workflow declares
 * (`RENEW_CUSTOMER_REFUSALS`) are repeated, each as a 400 in its own words.
 * Every other failure keeps the HTTP semantics of the `MedusaError` it was
 * thrown as (404 / 409 / 422), or answers 500, and in all of those cases the
 * response text is one of ours while the cause is logged.
 *
 * TENANT ISOLATION: the subscription's customer metadata.tenant_id must
 * match the calling tenant, else 404.
 */
export async function POST(
  req: MedusaRequest,
  res: MedusaResponse
) {
  const { subscription_id, triggered_by, reason } = (req.body ?? {}) as {
    subscription_id?: string
    triggered_by?: string | null
    reason?: string | null
  }

  // reorder mints subscription ids without a prefix — accept any non-empty
  // string; existence + tenant ownership are checked below.
  if (typeof subscription_id !== "string" || !subscription_id.trim()) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      "body.subscription_id must be a subscription id"
    )
  }

  // TENANT ISOLATION: subscription → customer → metadata.tenant_id must
  // match the calling tenant (404 — existence is not leaked).
  const customerModule = req.scope.resolve<CustomerModule>(Modules.CUSTOMER)
  const subscriptionModule = req.scope.resolve<SubscriptionModule>(
    SUBSCRIPTION_MODULE
  )

  const subscriptions = await subscriptionModule.listSubscriptions({
    id: [subscription_id],
  })
  const customerId = subscriptions[0]?.customer_id ?? null

  if (!customerId) {
    throw new MedusaError(
      MedusaError.Types.NOT_FOUND,
      "subscription not found"
    )
  }

  const customer = await customerModule.retrieveCustomer(customerId)

  assertTenantVisible(req, customer?.metadata, "subscription")

  const { result, errors } = await createManualRenewalWorkflow(
    req.scope
  ).run({
    input: {
      subscription_id,
      triggered_by: triggered_by ?? "saas-bridge",
      reason: reason ?? null,
    },
    throwOnError: false,
  })

  if (errors?.length) {
    const failure = classifyStepFailure({
      errors,
      refusals: RENEW_CUSTOMER_REFUSALS,
      copy: RENEW_FAILURE_COPY,
    })

    if (!failure.quoted) {
      logUnquotedStepFailure(
        req.scope.resolve<StepFailureLogger>(ContainerRegistrationKeys.LOGGER),
        "manual renewal",
        failure
      )
    }

    throw new MedusaError(failure.type, failure.message)
  }

  const renewal = result as CreateManualRenewalStepOutput | null | undefined

  if (!renewal?.renewal_order_id) {
    // Same shape as `/store/saas/redeem`: a workflow that reports neither an
    // error nor a usable result must not answer 200 with an empty body.
    throw new MedusaError(
      MedusaError.Types.UNEXPECTED_STATE,
      RENEW_FAILURE_COPY.failed
    )
  }

  res.json({
    order_id: renewal.renewal_order_id,
    redirect_url: renewal.redirect_url,
    total: renewal.total,
    currency_code: renewal.currency_code,
    reused: renewal.reused ?? false,
  })
}
