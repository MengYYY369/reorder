import type { ExecArgs } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { SUBSCRIPTION_MODULE } from "../modules/subscription"
import type SubscriptionModuleService from "../modules/subscription/service"
import { SubscriptionStatus } from "../modules/subscription/types"
import { resolveProviderCapabilities } from "../modules/subscription/utils/provider-capabilities"
import {
  NATIVE_SUBSCRIPTION_REFERENCE_PREFIX,
  isNativeSubscriptionReference,
} from "../modules/subscription/utils/native-subscription"
import { asSubscriptionUpdateInput } from "../modules/subscription/utils/subscription-write-input"

/**
 * One-time rewrite of the native mirror references into the kind-scoped format.
 *
 * **What changes.** A mirror row's `reference` used to be
 * `NATIVE-{providerSubscriptionId}`. It is now
 * `NATIVE-{kind}-{providerSubscriptionId}` (`NATIVE-paypal-I-XXXX`), so the
 * reference says which rail a row belongs to without a join. The prefix is
 * unchanged, so every `NATIVE-%` query (the checkout exclusivity gates, the
 * backfill) keeps working; only the middle token is new.
 *
 * **Why it has to run before the reorder 1.12.0 deploy.** The mirror upserts on
 * the unique `reference`. A legacy row that receives an event under the new code
 * would be looked up as `NATIVE-paypal-I-XXXX`, missed, and re-created — two
 * rows for one provider subscription, and the exclusivity gates would then see
 * whichever one they happened to read. Run this in the same maintenance window,
 * with the backend stopped (or the hourly backfill job disabled): while old code
 * is live, `upsertNativeMirrorSubscription` looks rows up by the *old* reference
 * and would re-create a legacy row right after the rewrite.
 *
 * **Safety.**
 *
 * - Dry run by default; writes only with `--apply`.
 * - Idempotent: a row already in the new format is counted, not touched, so a
 *   second run after the deploy is a no-op (which is what the release checklist
 *   asks for).
 * - Aborts **without writing anything** when any row cannot be resolved to a
 *   provider kind: a half-migrated mirror set is worse than an un-migrated one.
 * - Dedupe-safe: when both formats exist for one provider subscription id, the
 *   new-format row survives and takes the legacy row's live fields if the legacy
 *   row was updated more recently, then the legacy row is deleted. (This is the
 *   state the old code creates if it runs between the rewrite and the deploy.)
 *
 * Usage:
 *
 *     # from the host project (the one that installed this package):
 *     npx medusa exec ./node_modules/@mengyyy369/reorder/.medusa/server/src/scripts/backfill-native-reference-format.js
 *     NATIVE_REFERENCE_BACKFILL_APPLY=1 npx medusa exec ./node_modules/@mengyyy369/reorder/.medusa/server/src/scripts/backfill-native-reference-format.js
 *
 * The flag form (`… --apply`) only works where the runner forwards it; Medusa's
 * own `exec` does not (`--apply` is rejected as an unknown argument, and
 * `-- --apply` reaches the script as a dry run, which is the dangerous version of
 * the two). The environment variable is the form that works everywhere, so it is
 * the one to use and the one the release notes name.
 */

/**
 * The one provider that existed while the old format was being written, used
 * only when the capability view cannot answer (the plugin is absent, or a row's
 * `payment_context.payment_provider_id` predates the field).
 */
const LEGACY_KIND_BY_PROVIDER_ID: Record<string, string> = {
  pp_paypal_paypal: "paypal",
}

export type MirrorRow = {
  id: string
  reference: string
  status?: string | null
  next_renewal_at?: Date | string | null
  last_renewal_at?: Date | string | null
  updated_at?: Date | string | null
  payment_context?: Record<string, unknown> | null
}

export type Rewrite = { id: string; from: string; to: string }

export type Merge = {
  survivor: MirrorRow
  legacy: MirrorRow
  target: string
}

export type Plan = {
  rewrites: Rewrite[]
  merges: Merge[]
  alreadyCurrent: number
  unresolved: Array<{ id: string; reference: string; reason: string }>
}

export default async function backfillNativeReferenceFormat({
  container,
  args,
}: ExecArgs) {
  const apply =
    (args ?? []).includes("--apply") ||
    /^(1|true|yes)$/i.test(process.env.NATIVE_REFERENCE_BACKFILL_APPLY ?? "")
  const logger = container.resolve<{
    info: (msg: string) => void
    warn: (msg: string) => void
    error: (msg: string) => void
  }>(ContainerRegistrationKeys.LOGGER)
  const subscriptionModule = container.resolve<SubscriptionModuleService>(
    SUBSCRIPTION_MODULE
  )

  const kindByProviderId = await readKindByProviderId(container)
  const rows = (await subscriptionModule.listSubscriptions({
    reference: { $like: `${NATIVE_SUBSCRIPTION_REFERENCE_PREFIX}%` },
  })) as unknown as MirrorRow[]

  const plan = buildPlan(rows, kindByProviderId)

  logger.info(
    `[native-reference-backfill] ${apply ? "APPLY" : "DRY RUN"} — ${rows.length} mirror row(s): ` +
      `${plan.alreadyCurrent} already current, ${plan.rewrites.length} to rewrite, ` +
      `${plan.merges.length} to merge, ${plan.unresolved.length} unresolved`
  )

  for (const rewrite of plan.rewrites) {
    logger.info(`[native-reference-backfill] rewrite ${rewrite.from} -> ${rewrite.to}`)
  }

  for (const merge of plan.merges) {
    logger.info(
      `[native-reference-backfill] merge ${merge.legacy.reference} into ${merge.target} (keeping the new-format row)`
    )
  }

  if (plan.unresolved.length) {
    for (const entry of plan.unresolved) {
      logger.error(
        `[native-reference-backfill] unresolved ${entry.reference} (${entry.id}): ${entry.reason}`
      )
    }

    logger.error(
      "[native-reference-backfill] aborting without writing: every row has to resolve to a provider kind first"
    )
    return
  }

  if (!apply) {
    logger.info(
      "[native-reference-backfill] dry run — nothing was written. Re-run with `--apply` to write."
    )
    return
  }

  for (const merge of plan.merges) {
    const patch = mergePatch(merge.survivor, merge.legacy)

    if (patch) {
      await subscriptionModule.updateSubscriptions(
        asSubscriptionUpdateInput({ id: merge.survivor.id, ...patch })
      )
    }

    await subscriptionModule.deleteSubscriptions([merge.legacy.id])
  }

  for (const rewrite of plan.rewrites) {
    await subscriptionModule.updateSubscriptions(
      asSubscriptionUpdateInput({ id: rewrite.id, reference: rewrite.to })
    )
  }

  logger.info(
    `[native-reference-backfill] done — ${plan.rewrites.length} rewritten, ` +
      `${plan.merges.length} merged, ${plan.alreadyCurrent} left as they were`
  )
}

/**
 * provider_id -> kind, from the capability view, with the legacy map as the
 * fallback for a row whose provider is no longer registered.
 */
async function readKindByProviderId(
  container: ExecArgs["container"]
): Promise<Map<string, string>> {
  const map = new Map<string, string>()

  for (const capability of await resolveProviderCapabilities(container)) {
    map.set(capability.provider_id, capability.kind)
  }

  return map
}

export function buildPlan(
  rows: MirrorRow[],
  kindByProviderId: Map<string, string>
): Plan {
  const byReference = new Map(rows.map((row) => [row.reference, row]))
  const plan: Plan = {
    rewrites: [],
    merges: [],
    alreadyCurrent: 0,
    unresolved: [],
  }

  for (const row of rows) {
    if (!isNativeSubscriptionReference(row.reference)) {
      continue
    }

    const providerId = readText(row.payment_context?.payment_provider_id)
    const kind =
      (providerId ? kindByProviderId.get(providerId) : null) ??
      (providerId ? LEGACY_KIND_BY_PROVIDER_ID[providerId] : null)

    if (!kind) {
      plan.unresolved.push({
        id: row.id,
        reference: row.reference,
        reason: `no kind for provider '${providerId ?? "unknown"}'`,
      })
      continue
    }

    const providerSubscriptionId = readProviderSubscriptionId(row, kind)

    if (!providerSubscriptionId) {
      plan.unresolved.push({
        id: row.id,
        reference: row.reference,
        reason: "the reference carries no provider subscription id",
      })
      continue
    }

    const target = `${NATIVE_SUBSCRIPTION_REFERENCE_PREFIX}${kind}-${providerSubscriptionId}`

    if (row.reference === target) {
      plan.alreadyCurrent += 1
      continue
    }

    const existing = byReference.get(target)

    if (existing && existing.id !== row.id) {
      plan.merges.push({ survivor: existing, legacy: row, target })
      continue
    }

    plan.rewrites.push({ id: row.id, from: row.reference, to: target })
  }

  return plan
}

/**
 * The provider subscription id inside a mirror reference.
 *
 * The raw id is authoritative in `payment_context.customer_payment_reference`
 * (written on every mirror upsert since 1.12.0), so a row that carries it is
 * resolved from there and the reference is only *compared*, never parsed. That
 * is what makes a second run a no-op: after the rewrite the reference reads
 * `NATIVE-paypal-I-XXXX`, and slicing the prefix off *that* yields
 * `paypal-I-XXXX` and mints `NATIVE-paypal-paypal-I-XXXX` on every run.
 *
 * Only rows that predate the field are parsed, and only by removing a prefix
 * this script knows: the new format's `NATIVE-{kind}-` when it matches, else the
 * legacy `NATIVE-`.
 */
function readProviderSubscriptionId(row: MirrorRow, kind: string): string {
  const fromContext = readText(row.payment_context?.customer_payment_reference)

  if (fromContext) {
    return fromContext
  }

  const body = row.reference
    .slice(NATIVE_SUBSCRIPTION_REFERENCE_PREFIX.length)
    .trim()
  const kindPrefix = `${kind}-`

  return body.startsWith(kindPrefix) ? body.slice(kindPrefix.length) : body
}

/**
 * The fields the legacy row wins on, or `null` when the survivor is already the
 * newer of the two (in which case the merge is just the delete).
 */
function mergePatch(
  survivor: MirrorRow,
  legacy: MirrorRow
): {
  status?: SubscriptionStatus
  next_renewal_at?: Date | null
  last_renewal_at?: Date | null
} | null {
  if (toTime(legacy.updated_at) <= toTime(survivor.updated_at)) {
    return null
  }

  return {
    ...(legacy.status
      ? { status: legacy.status as SubscriptionStatus }
      : {}),
    next_renewal_at: toDate(legacy.next_renewal_at),
    last_renewal_at: toDate(legacy.last_renewal_at),
  }
}

function readText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null
}

function toTime(value: unknown): number {
  const date = toDate(value)

  return date ? date.getTime() : 0
}

function toDate(value: unknown): Date | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value
  }

  if (typeof value === "string" && value.trim()) {
    const date = new Date(value)

    return Number.isNaN(date.getTime()) ? null : date
  }

  return null
}
