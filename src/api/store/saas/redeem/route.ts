import { MedusaError } from "@medusajs/framework/utils"
import { Modules } from "@medusajs/framework/utils"
import type {
  MedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http"
import type { ICustomerModuleService } from "@medusajs/framework/types"
import {
  readFailureLogger,
  assertTenantVisible,
  readTenantScoped,
} from "../lib/tenant-ownership"
import {
  redeemRedemptionCodeWorkflow,
  REDEEM_CUSTOMER_REFUSALS,
} from "../../../../workflows/redeem-redemption-code"
import {
  classifyStepFailure,
  logUnquotedStepFailure,
  type StepFailureCopy,
} from "../../../../workflows/utils/store-step-failure"

// Derived from the real interface rather than restated here: a private
// structural copy checks nothing the container has to satisfy, so renaming
// `retrieveCustomer` upstream would degrade into a runtime `TypeError` instead
// of a build failure (`.agents/lessons.md`).
type CustomerModule = Pick<ICustomerModuleService, "retrieveCustomer">

/**
 * Our own texts for every other failure. Fixed strings — none of them is built
 * from a failure, so no internal message, table or column name can reach the
 * customer through this route.
 *
 * Which step may speak, and in which words, is the workflow's decision:
 * `REDEEM_CUSTOMER_REFUSALS` comes from
 * `src/workflows/redeem-redemption-code.ts`.
 */
const REDEEM_FAILURE_COPY: StepFailureCopy = {
  notFound: "redemption target not found",
  refused: "redemption was refused",
  failed: "redemption failed",
}

/**
 * POST /store/saas/redeem
 * Body: { code, customer_id, subscription_id? }
 * → { subscription_id, subscription_reference, redemption_record_id,
 *     outcome, free_cycles_remaining, dunning_recovered }
 *
 * Redemption-code entry for the SaaS site (bridge-secret callers cannot hold
 * a Medusa customer session): runs the redeem-redemption-code workflow via
 * direct typed import — the same workflow the customer-scoped store route
 * uses, so the code lock, per-customer dedup and quota checks all apply
 * unchanged.
 *
 * Auto-resolving on the reorder side: extends the customer's matching
 * ACTIVE/PAST_DUE subscription (free cycles) or creates a payment-free
 * subscription that expires at the end of its free period. Entitlement
 * mirroring stays on the SaaS side, keyed by the returned subscription.
 *
 * TENANT ISOLATION: the customer's metadata.tenant_id must match the
 * calling tenant, else 404.
 *
 * FAILURE DISCLOSURE: only the refusals the workflow declares
 * (`REDEEM_CUSTOMER_REFUSALS`) are repeated, each as a 400 in its own words —
 * the statuses this endpoint has always answered with, which the
 * byte-compatibility promise depends on. (The customer-scoped
 * `/store/customers/me/redemptions` route lets the domain error through
 * untouched, so an invalid code is a 404 there and a 400 here.) Every other
 * failure keeps the HTTP semantics of the `MedusaError` it was thrown as, or
 * answers 500, and in all of those cases the response text is one of ours while
 * the cause is logged.
 *
 * READ BOUNDARY: the customer read above is a `readTenantScoped` call, so a read
 * that fails answers the route's own 404 `redemption target not found` — the
 * text a vanished target already produces — instead of core's
 * `Customer with id '…' was not found` or a driver message, and the cause only
 * reaches the log. See `src/modules/subscription/utils/store-read-failure.ts`.
 */
export async function POST(
  req: MedusaRequest,
  res: MedusaResponse
) {
  const { code, customer_id, subscription_id } = (req.body ?? {}) as {
    code?: string
    customer_id?: string
    subscription_id?: string | null
  }

  if (typeof code !== "string" || !code.trim()) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      "body.code must be a redemption code"
    )
  }
  if (typeof customer_id !== "string" || !customer_id.trim()) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      "body.customer_id must be a Medusa customer id"
    )
  }

  // TENANT ISOLATION: the customer must belong to the calling tenant —
  // redeeming for a foreign customer would be a cross-tenant write.
  const customerModule = req.scope.resolve<CustomerModule>(Modules.CUSTOMER)
  const logger = readFailureLogger(req)

  const customer = await readTenantScoped(
    logger,
    "redemption tenant check",
    REDEEM_FAILURE_COPY,
    () => customerModule.retrieveCustomer(customer_id)
  )

  assertTenantVisible(req, customer?.metadata, "customer")

  const { result, errors } = await redeemRedemptionCodeWorkflow(
    req.scope
  ).run({
    input: {
      code,
      customer_id,
      subscription_id: subscription_id ?? null,
    },
    throwOnError: false,
  })

  if (errors?.length) {
    const failure = classifyStepFailure({
      errors,
      refusals: REDEEM_CUSTOMER_REFUSALS,
      copy: REDEEM_FAILURE_COPY,
    })

    if (!failure.quoted) {
      logUnquotedStepFailure(
        logger,
        "redemption",
        failure
      )
    }

    throw new MedusaError(failure.type, failure.message)
  }

  const redemption = (result ?? {}) as {
    subscription_id?: string
    subscription_reference?: string
    record_id?: string
    outcome?: string
    free_cycles_remaining?: number
    dunning_recovered?: boolean
    is_trial?: boolean
    trial_ends_at?: string | null
  }

  if (!redemption.subscription_id) {
    throw new MedusaError(
      MedusaError.Types.UNEXPECTED_STATE,
      "redemption workflow returned no subscription"
    )
  }

  res.json({
    subscription_id: redemption.subscription_id,
    subscription_reference: redemption.subscription_reference ?? null,
    redemption_record_id: redemption.record_id ?? null,
    outcome: redemption.outcome ?? null,
    free_cycles_remaining: redemption.free_cycles_remaining ?? null,
    dunning_recovered: redemption.dunning_recovered ?? false,
    is_trial: redemption.is_trial ?? false,
    trial_ends_at: redemption.trial_ends_at ?? null,
  })
}
