/**
 * The two facts about a subscription row's `payment_context` that more than one
 * rule reads: whether it already holds a reusable method, and which provider it
 * charges through. Kept in one place so the checkout gate's foldability
 * predicate (`reorder-rail-exclusivity.ts`) and the repeat-purchase extension
 * (`create-subscription-record.ts`) cannot drift about what "the row can already
 * charge" means.
 *
 * `payment_context` is a nullable jsonb column, so every read is total: a row
 * written before the plugin stored a context reads back as null, and a
 * half-written value is treated as absent rather than as a provider.
 */

/** Whether the context already carries a non-blank reusable method reference. */
export function hasStoredPaymentMethod(
  context: Record<string, unknown> | null | undefined
): boolean {
  const reference = context?.payment_method_reference

  return typeof reference === "string" ? reference.trim().length > 0 : false
}

/** The context's provider id, or null when it is absent or blank. */
export function readPaymentProviderId(
  context: Record<string, unknown> | null | undefined
): string | null {
  const providerId = context?.payment_provider_id

  return typeof providerId === "string" && providerId.trim().length > 0
    ? providerId
    : null
}
