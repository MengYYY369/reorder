import type { MedusaContainer } from "@medusajs/framework/types"
import {
  ContainerRegistrationKeys,
  Modules,
} from "@medusajs/framework/utils"
import {
  PAYMENT_METHODS_MODULE,
  listCustomerAccountHolders,
} from "@mengyyy369/medusa-payment-methods"
import { ACTIVITY_LOG_MODULE } from "../../activity-log"
import { ANALYTICS_MODULE } from "../../analytics"
import { CANCELLATION_MODULE } from "../../cancellation"
import { DUNNING_MODULE } from "../../dunning"
import { RENEWAL_MODULE } from "../../renewal"
import { TRIAL_CLAIM_MODULE } from "../../trial-claim"
import { SUBSCRIPTION_MODULE } from "../index"
import { subscriptionErrors } from "./errors"

/**
 * Hard-delete of one subscription's full row chain, shared by the admin
 * "delete cancelled subscription" action and the `customer.deleted` cascade.
 *
 * Every row deleted here is keyed by `subscription_id` in its own module
 * (plain text columns, no cross-module FKs), except the three belong-to
 * children (renewal attempts, dunning attempts, retention offer events) which
 * go before their parents so no foreign key dangles. The subscription row
 * itself is deleted last.
 *
 * Nothing here is compensable: the rows are gone. Callers gate reachability
 * (the admin workflow refuses anything but a cancelled subscription; the
 * cascade runs on a customer that Medusa is already removing).
 *
 * The plugin-owned rows (`customer_payment_preference`, the customer ↔
 * account holder links) are per CUSTOMER, not per subscription, so they are
 * not part of `hardDeleteSubscriptionChain`; the cascade composes
 * `hardDeleteCustomerPaymentLinks` once per customer instead.
 */

export type SubscriptionChainDeletionCounts = {
  subscription: number
  renewal_cycles: number
  renewal_attempts: number
  subscription_logs: number
  metrics_daily: number
  trial_claims: number
  cancellation_cases: number
  retention_offer_events: number
  dunning_cases: number
  dunning_attempts: number
}

export type CustomerPaymentLinkDeletionCounts = {
  customer_payment_preferences: number
  account_holders: number
}

/** Minimal shape of the plugin module's generated preference CRUD. */
type PaymentMethodsServiceLike = {
  listCustomerPaymentPreferences: (
    selector: Record<string, unknown>,
    config?: Record<string, unknown>
  ) => Promise<Array<{ id: string }>>
  deleteCustomerPaymentPreferences: (ids: string | string[]) => Promise<void>
}

/** Minimal shape of Medusa's remote link for the customer ↔ holder pair. */
type RemoteLinkLike = {
  dismiss: (input: Record<string, Record<string, string>>) => Promise<void>
}

async function deleteRows(
  deleteFn: (ids: string[]) => Promise<unknown>,
  rows: Array<{ id: string }>
): Promise<number> {
  if (rows.length === 0) {
    return 0
  }
  await deleteFn(rows.map((row) => row.id))
  return rows.length
}

/**
 * Deletes every reorder-owned row tied to the subscription, then the
 * subscription row. Throws not_found when the subscription does not exist.
 * Returns the per-table counts so the caller can audit and test the cascade.
 */
export async function hardDeleteSubscriptionChain(
  container: MedusaContainer,
  input: { subscription_id: string }
): Promise<SubscriptionChainDeletionCounts> {
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const subscriptionModule = container.resolve(SUBSCRIPTION_MODULE) as {
    retrieveSubscription: (
      id: string,
      config?: Record<string, unknown>
    ) => Promise<{ id: string }>
    deleteSubscriptions: (ids: string | string[]) => Promise<unknown>
  }

  const subscription = await subscriptionModule
    .retrieveSubscription(input.subscription_id)
    .catch(() => {
      throw subscriptionErrors.notFound("Subscription", input.subscription_id)
    })

  const counts: SubscriptionChainDeletionCounts = {
    subscription: 0,
    renewal_cycles: 0,
    renewal_attempts: 0,
    subscription_logs: 0,
    metrics_daily: 0,
    trial_claims: 0,
    cancellation_cases: 0,
    retention_offer_events: 0,
    dunning_cases: 0,
    dunning_attempts: 0,
  }

  // Renewal cycles and their attempts (attempts belong to cycles, so the
  // attempts go first).
  const renewalModule = container.resolve(RENEWAL_MODULE) as {
    listRenewalCycles: (
      selector: Record<string, unknown>,
      config?: Record<string, unknown>
    ) => Promise<Array<{ id: string }>>
    deleteRenewalCycles: (ids: string | string[]) => Promise<unknown>
    listRenewalAttempts: (
      selector: Record<string, unknown>,
      config?: Record<string, unknown>
    ) => Promise<Array<{ id: string }>>
    deleteRenewalAttempts: (ids: string | string[]) => Promise<unknown>
  }
  const renewalCycles = await renewalModule.listRenewalCycles({
    subscription_id: subscription.id,
  })
  if (renewalCycles.length > 0) {
    const cycleIds = renewalCycles.map((cycle) => cycle.id)
    const renewalAttempts = await renewalModule.listRenewalAttempts({
      renewal_cycle_id: cycleIds,
    })
    counts.renewal_attempts = await deleteRows(
      (ids) => renewalModule.deleteRenewalAttempts(ids),
      renewalAttempts
    )
    counts.renewal_cycles = await deleteRows(
      (ids) => renewalModule.deleteRenewalCycles(ids),
      renewalCycles
    )
  }

  // Dunning cases and their attempts (attempts belong to cases).
  const dunningModule = container.resolve(DUNNING_MODULE) as {
    listDunningCases: (
      selector: Record<string, unknown>,
      config?: Record<string, unknown>
    ) => Promise<Array<{ id: string }>>
    deleteDunningCases: (ids: string | string[]) => Promise<unknown>
    listDunningAttempts: (
      selector: Record<string, unknown>,
      config?: Record<string, unknown>
    ) => Promise<Array<{ id: string }>>
    deleteDunningAttempts: (ids: string | string[]) => Promise<unknown>
  }
  const dunningCases = await dunningModule.listDunningCases({
    subscription_id: subscription.id,
  })
  if (dunningCases.length > 0) {
    const caseIds = dunningCases.map((dunningCase) => dunningCase.id)
    const dunningAttempts = await dunningModule.listDunningAttempts({
      dunning_case_id: caseIds,
    })
    counts.dunning_attempts = await deleteRows(
      (ids) => dunningModule.deleteDunningAttempts(ids),
      dunningAttempts
    )
    counts.dunning_cases = await deleteRows(
      (ids) => dunningModule.deleteDunningCases(ids),
      dunningCases
    )
  }

  // Cancellation cases and their retention offer events (events belong to
  // cases).
  const cancellationModule = container.resolve(CANCELLATION_MODULE) as {
    listCancellationCases: (
      selector: Record<string, unknown>,
      config?: Record<string, unknown>
    ) => Promise<Array<{ id: string }>>
    deleteCancellationCases: (ids: string | string[]) => Promise<unknown>
    listRetentionOfferEvents: (
      selector: Record<string, unknown>,
      config?: Record<string, unknown>
    ) => Promise<Array<{ id: string }>>
    deleteRetentionOfferEvents: (ids: string | string[]) => Promise<unknown>
  }
  const cancellationCases = await cancellationModule.listCancellationCases({
    subscription_id: subscription.id,
  })
  if (cancellationCases.length > 0) {
    const caseIds = cancellationCases.map((cancellationCase) => cancellationCase.id)
    const offerEvents = await cancellationModule.listRetentionOfferEvents({
      cancellation_case_id: caseIds,
    })
    counts.retention_offer_events = await deleteRows(
      (ids) => cancellationModule.deleteRetentionOfferEvents(ids),
      offerEvents
    )
    counts.cancellation_cases = await deleteRows(
      (ids) => cancellationModule.deleteCancellationCases(ids),
      cancellationCases
    )
  }

  // Activity log rows: subscription_id is nullable, but the filter matches
  // only the rows tied to this subscription.
  const activityLogModule = container.resolve(ACTIVITY_LOG_MODULE) as {
    listSubscriptionLogs: (
      selector: Record<string, unknown>,
      config?: Record<string, unknown>
    ) => Promise<Array<{ id: string }>>
    deleteSubscriptionLogs: (ids: string | string[]) => Promise<unknown>
  }
  const logs = await activityLogModule.listSubscriptionLogs({
    subscription_id: subscription.id,
  })
  counts.subscription_logs = await deleteRows(
    (ids) => activityLogModule.deleteSubscriptionLogs(ids),
    logs
  )

  // Analytics snapshots: one row per day the subscription was alive.
  const analyticsModule = container.resolve(ANALYTICS_MODULE) as {
    listSubscriptionMetricsDailies: (
      selector: Record<string, unknown>,
      config?: Record<string, unknown>
    ) => Promise<Array<{ id: string }>>
    deleteSubscriptionMetricsDailies: (
      ids: string | string[]
    ) => Promise<unknown>
  }
  const metricsRows = await analyticsModule.listSubscriptionMetricsDailies({
    subscription_id: subscription.id,
  })
  counts.metrics_daily = await deleteRows(
    (ids) => analyticsModule.deleteSubscriptionMetricsDailies(ids),
    metricsRows
  )

  // Trial ledger: the claim that pointed at this subscription, so deleting a
  // trial subscription frees the (customer, product) slot again.
  const trialClaimModule = container.resolve(TRIAL_CLAIM_MODULE) as {
    listTrialClaims: (
      selector: Record<string, unknown>,
      config?: Record<string, unknown>
    ) => Promise<Array<{ id: string }>>
    deleteTrialClaims: (ids: string | string[]) => Promise<unknown>
  }
  const claims = await trialClaimModule.listTrialClaims({
    subscription_id: subscription.id,
  })
  counts.trial_claims = await deleteRows(
    (ids) => trialClaimModule.deleteTrialClaims(ids),
    claims
  )

  // The subscription row itself, last.
  await subscriptionModule.deleteSubscriptions(subscription.id)
  counts.subscription = 1

  // Sanity guard: the graph should no longer resolve the row. Cheap, and it
  // turns a missed child table into a visible error instead of silent residue.
  const { data: leftovers } = await query.graph({
    entity: "subscription",
    fields: ["id"],
    filters: { id: subscription.id },
  })
  if (leftovers.length > 0) {
    throw subscriptionErrors.conflict(
      `Subscription chain deletion left residue for '${subscription.id}'`
    )
  }

  return counts
}

/**
 * Deletes the customer-level payment-method rows that the `customer.deleted`
 * cascade needs gone but a single subscription cannot own: the plugin's
 * `customer_payment_preference` rows and the customer ↔ account holder links
 * with the holder rows behind them.
 *
 * Best-effort by design: the plugin module is optional at runtime, and losing
 * one holder row to a provider hiccup must not block the cascade. Callers get
 * the counts of what actually left. Provider-side vault tokens are NOT
 * touched here; that cleanup belongs to the cascade's provider protocol step.
 */
export async function hardDeleteCustomerPaymentLinks(
  container: MedusaContainer,
  input: { customer_id: string }
): Promise<CustomerPaymentLinkDeletionCounts> {
  const counts: CustomerPaymentLinkDeletionCounts = {
    customer_payment_preferences: 0,
    account_holders: 0,
  }

  if (!container.hasRegistration(PAYMENT_METHODS_MODULE)) {
    return counts
  }

  const paymentMethodsModule = container.resolve(
    PAYMENT_METHODS_MODULE
  ) as PaymentMethodsServiceLike
  try {
    const preferences =
      await paymentMethodsModule.listCustomerPaymentPreferences({
        customer_id: input.customer_id,
      })
    if (preferences.length > 0) {
      await paymentMethodsModule.deleteCustomerPaymentPreferences(
        preferences.map((preference) => preference.id)
      )
      counts.customer_payment_preferences = preferences.length
    }
  } catch {
    // Preferences are convenience rows; their absence never blocks a delete.
  }

  // Holder rows live in the payment module and the customer link in the link
  // table; both go, one holder at a time.
  try {
    const holders = await listCustomerAccountHolders(
      container,
      input.customer_id,
      null
    )
    const link = container.resolve<RemoteLinkLike>(
      ContainerRegistrationKeys.LINK
    )
    const paymentModule = container.resolve(Modules.PAYMENT) as {
      deleteAccountHolder: (id: string) => Promise<void>
    }
    for (const holder of holders) {
      if (!holder.id) {
        continue
      }
      try {
        await link.dismiss({
          [Modules.CUSTOMER]: { customer_id: input.customer_id },
          [Modules.PAYMENT]: { account_holder_id: holder.id },
        })
        await paymentModule.deleteAccountHolder(holder.id)
        counts.account_holders += 1
      } catch {
        // One stubborn holder must not block the rest of the cascade.
      }
    }
  } catch {
    // No readable holders means nothing to clean here.
  }

  return counts
}
