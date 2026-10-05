import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework"
import { Modules } from "@medusajs/framework/utils"
import type { MedusaContainer } from "@medusajs/framework/types"
import {
  PAYMENT_METHODS_MODULE,
  listCustomerAccountHolders,
  listCustomerPaymentMethods,
} from "@mengyyy369/medusa-payment-methods"
import { SUBSCRIPTION_MODULE } from "../modules/subscription"
import type SubscriptionModuleService from "../modules/subscription/service"
import {
  hardDeleteCustomerPaymentLinks,
  hardDeleteSubscriptionChain,
  type CustomerPaymentLinkDeletionCounts,
  type SubscriptionChainDeletionCounts,
} from "../modules/subscription/utils/subscription-chain-delete"
import {
  cancelNativeProviderSubscription,
  type NativeProviderCancelOutcome,
} from "../workflows/utils/native-provider-cancel"

type Logger = {
  info: (message: string, payload?: unknown) => void
  warn: (message: string, payload?: unknown) => void
  error: (message: string, payload?: unknown) => void
}

type SubscriptionCascadeRow = {
  id: string
  reference: string
  status: string
  customer_id: string
}

export type CustomerDeletedCascadeOutcome = {
  subscriptions_deleted: number
  provider_cancels: NativeProviderCancelOutcome[]
  vault_tokens_deleted: number
  payment_links: CustomerPaymentLinkDeletionCounts | null
  failures: string[]
}

/**
 * `customer.deleted` cascade (ticket 13): when Medusa removes a customer,
 * everything reorder owns for that customer has to go with it, because the
 * plugin's rows key on a plain `customer_id` column and nothing else cleans
 * them up.
 *
 * The order is deliberate:
 *
 * 1. **Provider protocol cancels first** — a live native mirror row (a PayPal
 *    subscription PayPal itself charges) is cancelled at the provider before
 *    any local row disappears, so the cancel carries the provider subscription
 *    id the mirror row still holds. Best-effort: a failed cancel is recorded
 *    and never blocks the cascade (the operator can retry from the PayPal
 *    admin page, exactly like the local cancellation path).
 * 2. **Per-subscription chain hard delete** —
 *    `hardDeleteSubscriptionChain` removes renewal cycles/attempts, dunning,
 *    cancellation, activity log, metrics and trial-claim rows, then the
 *    subscription row. One stubborn subscription does not stop the others;
 *    the subscriber may fire twice, and a second run finds nothing.
 * 3. **Vault token deletion, then the holder links** — the plugin's account
 *    holders are read before `hardDeleteCustomerPaymentLinks` dismisses the
 *    customer links and deletes the holders, because the provider-side token
 *    delete needs the holder context. Deleting the holder alone would orphan
 *    the wallet at the provider.
 *
 * Every failure is contained and logged — a customer whose deletion Medusa
 * already committed must never fail the event because a provider hiccuped.
 * Idempotent by construction: every step answers "nothing left" on a replay.
 */
export default async function customerDeletedCascadeHandler({
  event,
  container,
}: SubscriberArgs<{ id?: string }>) {
  const customerId = event.data?.id

  if (typeof customerId !== "string" || !customerId) {
    // Nothing to key the cascade on; the payload contract is `{ id }`.
    return
  }

  const logger = container.resolve<Logger>("logger")
  const outcome = await runCustomerDeletedCascade(container, customerId)

  logger.info(
    `[reorder] customer.deleted cascade for '${customerId}': ` +
      `${outcome.subscriptions_deleted} subscription chain(s) deleted, ` +
      `${outcome.vault_tokens_deleted} vault token(s) deleted, ` +
      `${outcome.payment_links?.customer_payment_preferences ?? 0} preference row(s) and ` +
      `${outcome.payment_links?.account_holders ?? 0} account holder(s) removed, ` +
      `${outcome.failures.length} failure(s)`,
    {
      event: "customer.deleted.cascade",
      customer_id: customerId,
      outcome,
    }
  )
}

/**
 * The cascade body, exported for the integration test: it is the only place
 * the delete ordering above lives.
 */
export async function runCustomerDeletedCascade(
  container: MedusaContainer,
  customerId: string
): Promise<CustomerDeletedCascadeOutcome> {
  const logger = container.resolve<Logger>("logger")
  const outcome: CustomerDeletedCascadeOutcome = {
    subscriptions_deleted: 0,
    provider_cancels: [],
    vault_tokens_deleted: 0,
    payment_links: null,
    failures: [],
  }

  const subscriptionModule = container.resolve<SubscriptionModuleService>(
    SUBSCRIPTION_MODULE
  )
  const subscriptions = (await subscriptionModule.listSubscriptions({
    customer_id: customerId,
  })) as unknown as SubscriptionCascadeRow[]

  // 1. Protocol cancels for the live provider-owned recurrences, while the
  //    mirror rows still carry the provider subscription ids.
  for (const subscription of subscriptions) {
    const cancelOutcome = await cancelNativeProviderSubscription(
      container,
      subscription.reference
    )

    outcome.provider_cancels.push(cancelOutcome)

    if (cancelOutcome.status === "failed") {
      const message = `provider cancel failed for subscription '${subscription.id}' (${cancelOutcome.paypal_subscription_id}): ${cancelOutcome.error}`
      outcome.failures.push(message)
      logger.warn(`[reorder] customer.deleted cascade: ${message}`)
    }
  }

  // 2. The local chain, one subscription at a time.
  for (const subscription of subscriptions) {
    try {
      const counts: SubscriptionChainDeletionCounts =
        await hardDeleteSubscriptionChain(container, {
          subscription_id: subscription.id,
        })

      if (counts.subscription > 0) {
        outcome.subscriptions_deleted += 1
      }
    } catch (error) {
      // A subscription that is already gone (replayed event) is not a
      // failure; anything else is recorded and the cascade moves on.
      const message =
        error instanceof Error ? error.message : String(error ?? "unknown")

      if (!message.includes("was not found")) {
        outcome.failures.push(
          `subscription chain delete failed for '${subscription.id}': ${message}`
        )
        logger.error(
          `[reorder] customer.deleted cascade: subscription chain delete failed for '${subscription.id}'`,
          error
        )
      }
    }
  }

  // 3. Vault tokens before the holders that give them context, then the
  //    plugin-owned customer rows. Both are best-effort.
  outcome.vault_tokens_deleted = await deleteCustomerVaultTokens(
    container,
    customerId,
    outcome.failures,
    logger
  )

  try {
    outcome.payment_links = await hardDeleteCustomerPaymentLinks(container, {
      customer_id: customerId,
    })
  } catch (error) {
    outcome.failures.push(
      `customer payment link delete failed: ${
        error instanceof Error ? error.message : String(error ?? "unknown")
      }`
    )
  }

  return outcome
}

/**
 * Deletes every vaulted method the provider still holds for the customer's
 * account holders. This is deliberately NOT the plugin's `unbind` (whose
 * in-use gate would refuse a method a live subscription still references —
 * and by this point the caller is a deleted customer), but it uses the same
 * provider delete shape so the vault-sanitizing semantics stay in one place.
 */
async function deleteCustomerVaultTokens(
  container: MedusaContainer,
  customerId: string,
  failures: string[],
  logger: Logger
): Promise<number> {
  if (!container.hasRegistration(PAYMENT_METHODS_MODULE)) {
    return 0
  }

  let methods

  try {
    methods = await listCustomerPaymentMethods(container, {
      customer_id: customerId,
    })
  } catch (error) {
    logger.warn(
      "[reorder] customer.deleted cascade: could not list the customer's vaulted methods for cleanup",
      error
    )
    return 0
  }

  if (!methods.length) {
    return 0
  }

  const paymentModule = container.resolve(Modules.PAYMENT) as {
    deletePaymentMethods: (input: {
      id: string
      provider_id: string
      context: Record<string, unknown>
    }) => Promise<unknown>
  }

  let deleted = 0

  for (const method of methods) {
    // The provider delete is scoped by the account holder the same way the
    // plugin's unbind scopes it: never by the bare id.
    const holders = await listCustomerAccountHolders(
      container,
      customerId,
      method.provider_id
    )
    const holder = holders[0]

    if (!holder?.id) {
      continue
    }

    try {
      await paymentModule.deletePaymentMethods({
        id: method.id,
        provider_id: method.provider_id,
        context: {
          account_holder: {
            ...holder,
            data: holder.data ?? {},
          },
        },
      })
      deleted += 1
    } catch (error) {
      failures.push(
        `vault token delete failed for '${method.provider_id}' method: ${
          error instanceof Error ? error.message : String(error ?? "unknown")
        }`
      )
      logger.warn(
        `[reorder] customer.deleted cascade: vault token delete failed for a '${method.provider_id}' method`,
        error
      )
    }
  }

  return deleted
}

export const config: SubscriberConfig = {
  event: "customer.deleted",
}
