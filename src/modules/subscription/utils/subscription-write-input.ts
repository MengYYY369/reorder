import type SubscriptionModuleService from "../service"
import type {
  SubscriptionCustomerSnapshot,
  SubscriptionFrequencyInterval,
  SubscriptionPaymentContext,
  SubscriptionPendingUpdateData,
  SubscriptionPricingSnapshot,
  SubscriptionProductSnapshot,
  SubscriptionShippingAddress,
  SubscriptionStatus,
} from "../types"

/**
 * The one typed boundary between this plugin's subscription records and the
 * module service's write methods.
 *
 * Both layers need to hand a row to `SubscriptionModuleService`: the workflow
 * rollbacks re-submit the snapshot they took before the mutation, and the
 * native PayPal mirror creates and reconciles its own rows. The service's
 * generated input type is a `Partial` over the DML entity, so it cannot express
 * either "this object is a whole subscription record" or "a create must carry
 * every NOT NULL column" — and a caller that reaches for the entity type
 * directly has to cast to get there. That is what this module exists for: the
 * domain vocabulary is declared here once, both layers import it, and the only
 * place a cast survives is inside the boundary that documents it.
 */

/**
 * What `updateSubscriptions` accepts.
 *
 * `Parameters<...>` resolves against the *last* overload of the generated
 * method, which for update is the selector/bulk form, so this is the whole
 * union the service takes: one row, many rows, or `{ selector, data }`.
 */
export type SubscriptionUpdateServiceInput = Parameters<
  SubscriptionModuleService["updateSubscriptions"]
>[0]

/**
 * What `createSubscriptions` accepts for a single row.
 *
 * Here the last overload is the bulk one, so the element type is taken rather
 * than `Parameters<...>[0]`: an input typed as a plain array would let a
 * single-row create pass a list and change what the service returns.
 */
export type SubscriptionCreateServiceInput = Parameters<
  SubscriptionModuleService["createSubscriptions"]
>[0][number]

/**
 * The product snapshot as a write may carry it.
 *
 * A snapshot this plugin builds (`buildNativeMirrorProductSnapshot`,
 * `createSubscriptionRecordStep`) fills both titles, so
 * `SubscriptionProductSnapshot` types them as plain strings. The rows come back
 * through looser shapes that allow an explicit null
 * (`SubscriptionWorkflowRecord`, `SubscriptionStoreListItem`), and a workflow
 * rollback re-submits the record it read rather than one it built. Widening the
 * two titles here is what keeps those seven call sites checked instead of
 * reaching for a cast; `SubscriptionCreateWriteInput` still requires the strict
 * snapshot, so nothing new may be written with a null title.
 */
export type SubscriptionProductSnapshotWriteInput = {
  product_id?: string
  product_title?: string | null
  variant_id?: string
  variant_title?: string | null
  sku?: string | null
}

/**
 * A subscription row as a caller hands it to the write boundary.
 *
 * Optional throughout except `id`: an update addresses one row by id and every
 * other key is a column it chooses to touch. The json columns keep their domain
 * types rather than the entity's `Record<string, unknown>`, which is where a
 * mis-shaped snapshot or payment context becomes a type error instead of a row
 * that reads back differently than it was written.
 */
export type SubscriptionWriteInput = {
  id: string
  reference?: string
  status?: SubscriptionStatus
  customer_id?: string
  cart_id?: string | null
  product_id?: string
  variant_id?: string
  frequency_interval?: SubscriptionFrequencyInterval
  frequency_value?: number
  started_at?: Date
  next_renewal_at?: Date | null
  last_renewal_at?: Date | null
  paused_at?: Date | null
  cancelled_at?: Date | null
  cancel_effective_at?: Date | null
  skip_next_cycle?: boolean
  free_cycles_remaining?: number
  is_trial?: boolean
  trial_ends_at?: Date | null
  customer_snapshot?: Partial<SubscriptionCustomerSnapshot> | null
  product_snapshot?: SubscriptionProductSnapshotWriteInput | null
  pricing_snapshot?: Partial<SubscriptionPricingSnapshot> | null
  shipping_address?: SubscriptionShippingAddress | null
  payment_context?: Partial<SubscriptionPaymentContext> | null
  pending_update_data?: SubscriptionPendingUpdateData | null
  metadata?: Record<string, unknown> | null
}

/**
 * Columns the `subscription` model declares NOT NULL with no default
 * (`models/subscription.ts`): a create that omits one is rejected by the
 * database, not by the service, so the failure surfaces as a stack trace from a
 * write instead of a message at the call. The create input requires them.
 */
type SubscriptionRequiredColumns = {
  reference: string
  customer_id: string
  product_id: string
  variant_id: string
  frequency_interval: SubscriptionFrequencyInterval
  frequency_value: number
  started_at: Date
  product_snapshot: SubscriptionProductSnapshot
  shipping_address: SubscriptionShippingAddress
}

/**
 * A whole row as a caller hands it to be created. Same vocabulary as
 * `SubscriptionWriteInput`, with the NOT NULL columns required and the id left
 * optional (the service generates one when the caller does not pin it).
 */
export type SubscriptionCreateWriteInput = Omit<
  SubscriptionWriteInput,
  keyof SubscriptionRequiredColumns | "id"
> &
  SubscriptionRequiredColumns & {
    id?: string
  }

/**
 * Read a subscription record as the shape the module service updates with.
 *
 * The service types its results off the DML entity and its input off a
 * `Partial` of it, so a caller that wants its own record typed has to convert
 * somewhere. This is the one place that conversion lives, which is why both
 * layers import it instead of casting at their own call sites.
 *
 * The double assertion is the only place in the plugin where the typechecker is
 * asked to look away, and it is measured rather than decorative: of the 26
 * fields a write may carry, exactly two cannot cross without it. The model
 * declares `product_snapshot` and `shipping_address` NOT NULL, so the service
 * input admits no `null` for either, while a record read out of a step payload
 * declares both nullable (`SubscriptionWorkflowRecord` says so, and so do the
 * store list rows). Every other json column is nullable on the model and assigns
 * cleanly, the `Partial` domain shapes included. Nothing is constructed here
 * and no field is renamed: the value crosses unchanged, and the fields that do
 * carry the write are checked by `SubscriptionWriteInput` before they get here.
 */
export function asSubscriptionUpdateInput(
  input: SubscriptionWriteInput
): SubscriptionUpdateServiceInput {
  return input as unknown as SubscriptionUpdateServiceInput
}

/**
 * Read a whole row as the create input the service accepts.
 *
 * No cast: a create the caller can describe in this vocabulary is a value the
 * service already accepts, which is the point of requiring the NOT NULL columns
 * above instead of typing the call away.
 */
export function asSubscriptionCreateInput(
  input: SubscriptionCreateWriteInput
): SubscriptionCreateServiceInput {
  return input
}
