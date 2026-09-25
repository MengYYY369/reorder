/**
 * One source of truth for keys that must never be stored in an activity-log row.
 *
 * Two independent writers sanitize before persistence and both consume this set:
 *
 * - `normalize-log-event.ts` drops the key from `previous_state`, `new_state` and
 *   the allow-listed `metadata` payload.
 * - `serialize-error-chain.ts` replaces the value with `REDACTION_PLACEHOLDER`
 *   wherever an error object leaks its own fields into the human readable
 *   `reason` that the admin activity-log screen renders.
 *
 * Before this module the two writers each kept a private list and the lists had
 * drifted apart: the error serializer masked `api_key`/`secret`/`token`, while
 * the normalizer masked `address_1`/`address_2`/`postal_code`/`phone`/
 * `payment_reference`/`raw_error`. Adding a key here masks it on both paths at
 * once; keeping a local copy in either writer is the regression this module
 * exists to prevent.
 *
 * ## Adding a member is a security change, and the pins that go red are routine
 *
 * Widening this set hides one more field from the Admin timeline; the only
 * question is whether that field can carry something a merchant should not see
 * there. Whether the specs happen to know the key yet is not a reason to add
 * fewer members, so do not shrink a justified addition to keep a test green.
 *
 * Both specs spell the union out a second time as their own `SENSITIVE_KEY_UNION`
 * list and pin the mask exactly, in both directions — `redacts every key of the
 * shared set, and nothing outside it, when an error dumps its own fields`
 * (`__tests__/serialize-error-chain.spec.ts`) and `drops every key of the shared
 * set, and nothing outside it, from both states and changed_fields`
 * (`__tests__/normalize-log-event.spec.ts`). Mirror a new member into both copies
 * in the same change; that is the step the addition needs, because those payloads
 * decide what the pins check. Measured against the current 27 cases:
 *
 * - a member added here alone, absent from the spec copies, reddens nothing —
 *   no payload carries a key they have never heard of. Silence here is not
 *   approval of the change; it means the mirror is still owed.
 * - a set and a spec copy that disagree reddens exactly those pins and their
 *   sibling cases (`-token` fails 3, all of them key-set pins). Once mirrored, a
 *   red there says a writer misses the key on some path: fix the writer, never
 *   drop the key or mask it in one writer only.
 * - a red that spreads past the key-set pins means the name collides with a
 *   field ordinary payloads carry (`+status` fails 5, among them `keeps checkout
 *   metadata for subscription creation events`). Over-masking quietly empties the
 *   log, so that red is a real defect and the answer is a narrower key.
 */
export const REDACTION_PLACEHOLDER = "[redacted]"

export const ACTIVITY_LOG_SENSITIVE_KEYS: ReadonlySet<string> = new Set([
  // Shipping and contact material
  "address_1",
  "address_2",
  "postal_code",
  "phone",
  // Payment material
  "payment_context",
  "payment_reference",
  "payment_method_reference",
  "customer_payment_reference",
  "source_payment_collection_id",
  "source_payment_session_id",
  "payment_session",
  "payment_sessions",
  "provider_payload",
  "provider_response",
  // Provider and API credentials
  "api_key",
  "secret",
  "token",
  // Raw failure payloads that carry upstream request bodies
  "raw_error",
  "stack",
  "stacktrace",
  "error_stack",
])
