import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import type { MedusaContainer, RemoteQueryFunction } from "@medusajs/framework/types"
import { SUBSCRIPTION_MODULE } from ".."
import type SubscriptionModuleService from "../service"
import {
  TRACK_OCCUPYING_NATIVE_STATUSES,
  findBlockingNativeRow,
  nativeSubscriptionReferenceFilter,
  type NativeRowCandidate,
} from "./native-subscription"

/**
 * Every live provider-owned recurrence this customer holds.
 *
 * The one place the three-condition pushdown is written. Ticket 09's single
 * product guard goes through it via `findBlockingNativeSubscription` below,
 * and ticket 12's checkout-completion gate reads the whole list to match it
 * against the cart. Keeping it in one place is what stops the two gates from
 * disagreeing about what "already subscribed" means.
 *
 * The query pushes all three conditions down — `customer_id`, `status` and the
 * `NATIVE-%` reference pattern are all indexed on the subscription model — so a
 * customer with no mirror rows costs one indexed read. Errors propagate on
 * purpose: failing open is a decision, and it belongs to the caller
 * (`resolveCheckoutGate`), not to this read.
 */
export async function findLiveNativeRecurrences(
  container: MedusaContainer,
  input: { customer_id: string }
): Promise<NativeRowCandidate[]> {
  const subscriptionModule = container.resolve<SubscriptionModuleService>(
    SUBSCRIPTION_MODULE
  )

  return (await subscriptionModule.listSubscriptions({
    customer_id: input.customer_id,
    status: [...TRACK_OCCUPYING_NATIVE_STATUSES],
    ...nativeSubscriptionReferenceFilter(),
  } as never)) as unknown as NativeRowCandidate[]
}

/**
 * The shared "is a provider recurrence already occupying this product" lookup
 * used by the subscription track (`validate-subscription-cart`'s
 * `assertNoNativeRecurrence`).
 */
export async function findBlockingNativeSubscription(
  container: MedusaContainer,
  input: { customer_id: string; product_id: string }
): Promise<NativeRowCandidate | null> {
  const rows = await findLiveNativeRecurrences(container, {
    customer_id: input.customer_id,
  })

  return findBlockingNativeRow(rows, [input.product_id])
}

/**
 * Title for the rejection message. Read lazily through QUERY so the guard does
 * not need the product module when there is nothing to report.
 *
 * Total by construction: every failure — an unresolvable container entry as well
 * as a failed read or a product with no title — falls back to the product id.
 *
 * The caller that depends on that totality is the subscription track, not the
 * checkout gate: `assertNoNativeRecurrence`
 * (`src/workflows/steps/validate-subscription-cart.ts`) interpolates this result
 * straight into the error it throws and guards nothing of its own, so a throwing
 * reader here would swap a domain rejection for an unclassified step failure.
 * The gate no longer relies on it — `checkout-gate.ts` asks for the title only
 * after its verdict is final and behind `readBlockingProductTitle`'s own guard,
 * which performs the same fallback. There this function decides the wording only,
 * and the gate keeps blocking even if this guarantee were ever broken.
 *
 * Keep that boundary when extending either caller, and keep it accurate: "the
 * failure was answered with a pass" covers more than one `catch`. Three doors let
 * a checkout through the gate — `rejectConflictingPurchase` returns before any
 * read when the request carries no acting customer, `readCartProductIds` in
 * `checkout-gate.ts` reports an unreadable cart as an empty product list (so "no
 * collision" arrives there as an ordinary answer rather than as a failure to
 * handle), and `decideBlockingRow`'s catch answers everything the two rule reads
 * do with "let it through". All three are deliberate, because none of them can
 * tell a real absence of collision from a read that failed, and
 * `docs/architecture/subscriptions.md` lists them together.
 *
 * What follows for a new read is therefore about position, not about how many
 * guards exist: only reads inside `decideBlockingRow` may change the verdict, and
 * anything that merely decorates it has to wait until that function has
 * returned — behind its own guard, never inside it. Past that `return` the
 * outcome is fixed, so a failure there can still reach the wording but never the
 * choice; read earlier, a cosmetic failure would be answered exactly like a rule
 * read's, by letting a real collision through. That is why the gate asks for this
 * title through `readBlockingProductTitle`, on its way out of the decision.
 */
export async function readProductTitle(
  container: MedusaContainer,
  productId: string
): Promise<string> {
  try {
    const query = container.resolve<RemoteQueryFunction>(
      ContainerRegistrationKeys.QUERY
    )
    const { data } = await query.graph({
      entity: "product",
      fields: ["id", "title"],
      filters: { id: [productId] },
    })

    return (data as Array<{ title?: string }>)[0]?.title ?? productId
  } catch {
    return productId
  }
}
