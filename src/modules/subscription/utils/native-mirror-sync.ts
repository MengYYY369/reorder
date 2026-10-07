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
} from "./native-mirror"
import {
  nativeCapabilities,
  resolveProviderCapabilities,
} from "./provider-capabilities"
import {
  asSubscriptionCreateInput,
  asSubscriptionUpdateInput,
} from "./subscription-write-input"

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
 * Shared by the neutral event subscriber and the backfill job so a replayed
 * event and a reconciliation pass cannot produce two rows for one provider
 * subscription.
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
    const createInput = asSubscriptionCreateInput({
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
        // The provider key the capability view resolved, never a literal: a
        // host that registers the provider under another declaration id gets
        // another key, and the checkout gates compare against this value.
        payment_provider_id: fields.provider_id,
        payment_mode: "manual",
        mechanism: "native",
        source_payment_collection_id: null,
        source_payment_session_id: null,
        payment_method_reference: null,
        // The provider's own subscription id — the one value its `cancel` takes.
        customer_payment_reference: fields.provider_subscription_id,
      },
      metadata: {
        source: "native_mirror",
        plan_id: fields.plan_id,
      },
    })

    await subscriptionModule.createSubscriptions(createInput)

    logger.info(
      `[reorder] mirrored native subscription '${fields.reference}'` +
        `${fields.next_renewal_at ? "" : " (no billing date yet)"}`
    )

    return "created"
  }

  const update = nativeMirrorReconcileFields(current.id, fields)
  const recordedPlanId = current.metadata?.plan_id

  if (fields.plan_id && recordedPlanId !== fields.plan_id) {
    // The provider revised the subscription onto a different plan. The neutral
    // event carries `plan_id` on every transition, so this is noticed as soon
    // as the provider reports it; the plan id itself is not a billing input
    // here (the provider charges its own plan), so it is recorded for support
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

  await subscriptionModule.updateSubscriptions(
    asSubscriptionUpdateInput(update)
  )

  return "updated"
}

export type BackfillResult = {
  scanned: number
  created: number
  updated: number
  skipped: Array<{ reference: string | null; reason: string }>
}

/**
 * One pass over every provider that has a native rail: mirror anything missing
 * and refresh anything already known.
 *
 * The records come from the capability view (`native.listRecords`), not from a
 * query over a provider's table — that is the whole point of the contract: this
 * plugin used to read `paypal_subscription` directly, which meant every
 * provider's schema had to be known here.
 *
 * Records whose variant cannot be resolved to a product are skipped rather than
 * written with a guessed product id, because a wrong product id would block the
 * wrong checkout.
 */
export async function backfillNativeMirrorSubscriptions(
  container: MedusaContainer,
  logger: MirrorLogger
): Promise<BackfillResult> {
  const capabilities = nativeCapabilities(
    await resolveProviderCapabilities(container)
  )
  const result: BackfillResult = {
    scanned: 0,
    created: 0,
    updated: 0,
    skipped: [],
  }

  if (!capabilities.length) {
    logger.info(
      "[reorder] native subscription backfill found no provider rail (medusa-payment-methods not installed, or no provider with a native rail)"
    )

    return result
  }

  for (const capability of capabilities) {
    let records

    try {
      records = await capability.native.listRecords(container)
    } catch (error) {
      // One provider failing must not stop the others from being reconciled.
      logger.warn(
        `[reorder] native subscription backfill could not list '${capability.provider_id}': ` +
          `${error instanceof Error ? error.message : String(error)}`
      )
      continue
    }

    result.scanned += records.length

    if (!records.length) {
      continue
    }

    const productIds = await readProductIdsForVariants(
      container,
      records
        .map((record) => record.variant_id)
        .filter((id): id is string => typeof id === "string" && !!id.trim())
    )

    for (const record of records) {
      const built = buildNativeMirrorFieldsFromRecord(
        {
          ...record,
          kind: capability.kind,
          provider_id: capability.provider_id,
        },
        record.variant_id ? productIds.get(record.variant_id) ?? null : null
      )

      if (!built.ok) {
        result.skipped.push({
          reference: record.provider_subscription_id ?? null,
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

/**
 * Variant id → product id, for the records a provider hands over: a provider
 * package knows the variant a merchant declared, never reorder's product graph.
 */
export async function readProductIdsForVariants(
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
