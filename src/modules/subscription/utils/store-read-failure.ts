import { MedusaError } from "@medusajs/framework/utils"

/**
 * The copy a caller offers for a read that failed. The route owns the wording:
 * it is the same text the route already answers when the row is genuinely
 * missing, so a failure cannot be told apart from an absence by anyone reading
 * the response.
 */
export type StoreReadFailureCopy = {
  notFound: string
}

/**
 * What the caller may put in the response body — and nothing else.
 */
export type StoreReadFailure = {
  type: string
  message: string
}

/**
 * Decide what a failed store read may disclose.
 *
 * `error` is accepted as `unknown` and deliberately never read. That is the
 * whole point: a tenant-scoping store route cannot distinguish, from the outside,
 * between "this row is not yours" and "the database faulted while answering", and
 * the faults it gets are driver-shaped — `@medusajs/utils`'s `db-error-mapper`
 * turns an `undefined_column` into an `invalid_data` whose message names the
 * table and column, and core's error handler passes `invalid_data` bodies
 * through. Quoting that text to a customer discloses schema internals, and
 * picking a status from it (or trusting a `code`/`table`/`detail` property) would
 * let the fault itself decide what the customer learns. So the input's shape is
 * not consulted: whatever arrives, the answer is `not_found` with the caller's
 * own copy.
 *
 * Pure and silent by design. Logging the raw error is the caller's job — it has
 * the logger and the request context; this function has neither, so it cannot
 * become the thing that swallows a cause.
 *
 * @param error the failure the read threw, in whatever shape it arrived
 * @param copy the caller's fixed text for "this is not visible to you"
 */
export function classifyStoreReadFailure(
  error: unknown,
  copy: StoreReadFailureCopy
): StoreReadFailure {
  void error

  return {
    type: MedusaError.Types.NOT_FOUND,
    message: copy.notFound,
  }
}
