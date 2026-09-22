import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import type { MedusaContainer, RemoteQueryFunction } from "@medusajs/framework/types"
import { SUBSCRIPTION_MODULE } from ".."
import type SubscriptionModuleService from "../service"
import {
  NATIVE_MIRROR_SHIPPING_ADDRESS,
  buildNativeMirrorFieldsFromRecord,
  buildNativeMirrorProductSnapshot,
  nativeMirrorReconcileFields,
  type NativeMirrorFields,
  type ProviderSubscriptionRecord,
} from "./native-mirror"
import { nativeSubscriptionReferenceFilter } from "./native-subscription"

type MirrorLogger = {
  info: (msg: string) => void
  warn: (msg: string) => void
}

type ExistingMirrorRecord = {
  id: string
  reference: string
  status: string
  next_renewal_at: Date | null
  metadata: Record<string, unknown> | null
}

/**
 * Create-or-update for one mirror row, keyed on the unique `reference`.
 *
 * Shared by the event subscriber and the backfill job so a replayed event and a
 * reconciliation pass cannot produce two rows for one PayPal subscription.
 */
export async function upsertNativeMirrorSubscription(
  container: MedusaContainer,
  fields: NativeMirrorFields,
  logger: MirrorLogger
): Promise<"created" | "updated"> {
  const subscriptionModule = container.resolve<SubscriptionModuleService>(
    SUBSCRIPTION_MODULE
  )

  const existing = (await subscriptionModule.listSubscriptions({
    reference: [fields.reference],
  })) as unknown as ExistingMirrorRecord[]

  const current = existing[0]

  if (!current) {
    await subscriptionModule.createSubscriptions({
      reference: fields.reference,
      status: fields.status,
      customer_id: fields.customer_id,
      cart_id: null,
      product_id: fields.product_id,
      variant_id: fields.variant_id,
      frequency_interval: fields.frequency_interval,
      frequency_value: fields.frequency_value,
      started_at: new Date(),
      next_renewal_at: fields.next_renewal_at
        ? new Date(fields.next_renewal_at)
        : null,
      last_renewal_at: fields.last_renewal_at
        ? new Date(fields.last_renewal_at)
        : null,
      skip_next_cycle: false,
      is_trial: false,
      customer_snapshot: null,
      product_snapshot: buildNativeMirrorProductSnapshot({
        product_id: fields.product_id,
        variant_id: fields.variant_id,
        ...(await readVariantTitles(container, fields.variant_id)),
      }),
      pricing_snapshot: null,
      shipping_address: NATIVE_MIRROR_SHIPPING_ADDRESS,
      payment_context: {
        payment_provider_id: "pp_paypal_paypal",
        payment_mode: "manual",
        mechanism: "native",
        source_payment_collection_id: null,
        source_payment_session_id: null,
        payment_method_reference: null,
        customer_payment_reference: fields.paypal_subscription_id,
      },
      pending_update_data: null,
      metadata: {
        source: "paypal_native_mirror",
        plan_id: fields.plan_id,
      },
    } as never)

    logger.info(
      `[reorder] mirrored native subscription '${fields.reference}'` +
        `${fields.next_renewal_at ? "" : " (no billing date yet)"}`
    )

    return "created"
  }

  const update = nativeMirrorReconcileFields(current.id, fields)
  const recordedPlanId = current.metadata?.plan_id

  if (fields.plan_id && recordedPlanId !== fields.plan_id) {
    // The provider revised the subscription onto a different plan. Until
    // medusa-paypal 0.5.0 emits `paypal.subscription.revised`, this reconciliation
    // pass is the only thing that notices; the plan id itself is not a billing
    // input here (PayPal charges its own plan), so it is recorded for support
    // rather than acted on.
    update.metadata = {
      ...(current.metadata ?? {}),
      plan_id: fields.plan_id,
      plan_changed_at: new Date().toISOString(),
    }

    logger.warn(
      `[reorder] native mirror '${fields.reference}' changed plan ` +
        `'${String(recordedPlanId ?? "unknown")}' -> '${fields.plan_id}'`
    )
  }

  await subscriptionModule.updateSubscriptions(update as never)

  return "updated"
}

/**
 * Every mirror row currently in the table, by reference. Used by reconciliation
 * to spot provider subscriptions that have since been cancelled out-of-band.
 */
export async function listExistingMirrorReferences(
  container: MedusaContainer
): Promise<ExistingMirrorRecord[]> {
  const subscriptionModule = container.resolve<SubscriptionModuleService>(
    SUBSCRIPTION_MODULE
  )

  return (await subscriptionModule.listSubscriptions(
    nativeSubscriptionReferenceFilter() as never
  )) as unknown as ExistingMirrorRecord[]
}

/**
 * Read the provider's own subscription rows.
 *
 * Returns an empty list when medusa-paypal is not installed (or its entity is
 * not in the data model): the backfill then simply has nothing to reconcile, and
 * that is a normal state for this plugin, not an error.
 */
export async function loadProviderSubscriptionRecords(
  container: MedusaContainer
): Promise<ProviderSubscriptionRecord[]> {
  try {
    const query = container.resolve<RemoteQueryFunction>(
      ContainerRegistrationKeys.QUERY
    )
    const { data } = await query.graph({
      entity: "paypal_subscription",
      fields: [
        "id",
        "paypal_subscription_id",
        "paypal_plan_id",
        "status",
        "customer_id",
        "variant_id",
        "interval_unit",
        "interval_count",
        "next_billing_at",
        "last_billing_at",
      ],
    })

    return (data as ProviderSubscriptionRecord[]) ?? []
  } catch {
    return []
  }
}

export type BackfillResult = {
  scanned: number
  created: number
  updated: number
  skipped: Array<{ reference: string | null; reason: string }>
}

/**
 * One pass over the provider's subscriptions: mirror anything missing and
 * refresh anything already known. Records whose variant cannot be resolved to a
 * product are skipped rather than written with a guessed product id, because a
 * wrong product id would block the wrong checkout.
 */
export async function backfillNativeMirrorSubscriptions(
  container: MedusaContainer,
  logger: MirrorLogger
): Promise<BackfillResult> {
  const records = await loadProviderSubscriptionRecords(container)
  const result: BackfillResult = {
    scanned: records.length,
    created: 0,
    updated: 0,
    skipped: [],
  }

  if (!records.length) {
    logger.info(
      "[reorder] native subscription backfill found no provider rows (medusa-paypal not installed, or nothing to mirror yet)"
    )

    return result
  }

  const productIds = await readProductIdsForVariants(
    container,
    records.map((record) => record.variant_id).filter(Boolean) as string[]
  )

  for (const record of records) {
    const productId = record.variant_id
      ? productIds.get(record.variant_id) ?? null
      : null
    const built = buildNativeMirrorFieldsFromRecord(record, productId)

    if (!built.ok) {
      result.skipped.push({
        reference: record.paypal_subscription_id ?? null,
        reason: built.reason,
      })
      continue
    }

    const action = await upsertNativeMirrorSubscription(
      container,
      built.fields,
      logger
    )

    if (action === "created") {
      result.created += 1
    } else {
      result.updated += 1
    }
  }

  return result
}

async function readVariantTitles(
  container: MedusaContainer,
  variantId: string
): Promise<{ product_title: string | null; variant_title: string | null }> {
  const variants = await readVariants(container, [variantId])
  const variant = variants[0]

  return {
    product_title: variant?.product?.title ?? null,
    variant_title: variant?.title ?? null,
  }
}

async function readProductIdsForVariants(
  container: MedusaContainer,
  variantIds: string[]
): Promise<Map<string, string>> {
  const map = new Map<string, string>()

  if (!variantIds.length) {
    return map
  }

  for (const variant of await readVariants(container, variantIds)) {
    if (variant?.id && variant.product?.id) {
      map.set(variant.id, variant.product.id)
    }
  }

  return map
}

type VariantRecord = {
  id?: string
  title?: string | null
  product?: { id?: string; title?: string | null } | null
}

async function readVariants(
  container: MedusaContainer,
  variantIds: string[]
): Promise<VariantRecord[]> {
  try {
    const query = container.resolve<RemoteQueryFunction>(
      ContainerRegistrationKeys.QUERY
    )
    const { data } = await query.graph({
      entity: "product_variant",
      fields: ["id", "title", "product.id", "product.title"],
      filters: { id: variantIds },
    })

    return (data as VariantRecord[]) ?? []
  } catch {
    return []
  }
}
