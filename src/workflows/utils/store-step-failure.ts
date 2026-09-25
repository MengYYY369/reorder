import { MedusaError } from "@medusajs/framework/utils"

/**
 * Failure disclosure for the workflow-backed Store API routes.
 *
 * A Store API route that runs a workflow with `throwOnError: false` gets the
 * engine's `errors` array back, and each entry is `{ action, handlerType,
 * error }` where `action` is the name the failing step was created with and
 * `error` is a *serialized* copy of whatever was thrown — `serializeError`
 * (`@medusajs/utils/dist/common/serialize-error.js`) builds a plain object from
 * `{ message, name, stack }` plus every own enumerable property, and the
 * orchestration transaction handler stores exactly that. So a `MedusaError`
 * arrives with `__isMedusaError` and `type`, and a database driver error
 * arrives with `code`, `table`, `detail`. Nothing on this path is an `Error`
 * instance: no caller may rely on `instanceof` (`.agents/lessons.md`).
 *
 * That shape forces two decisions, and this module makes them once:
 *
 *  1. **What text a customer may see.** Only a refusal the plugin authors as
 *     customer copy may be repeated, and only when the route declares it in
 *     full: the step that raises it, the `MedusaError` type it carries, and its
 *     exact text. Everything else gets one of the route's own fixed texts.
 *  2. **What status a caller gets.** A failure that is not a declared refusal
 *     keeps the HTTP semantics of the `MedusaError` it was thrown as, so a
 *     future 404/409 business rejection is never silently demoted to a
 *     permanent 500 — and never promoted to a 400 that quotes internals
 *     either. Non-`MedusaError` faults (driver, connection, deserialized
 *     Postgres errors) are 500s.
 *
 * The deserialized value is never rethrown as it stands: `formatException`
 * (`@medusajs/framework/dist/http/middlewares/exception-formatter.js`) switches
 * on `err.code`, so an object that survives with `code: "23505"` would be
 * rewritten into a 422 whose body embeds `err.table` and `err.detail`. The
 * routes always throw a freshly constructed `MedusaError`, whose own `code` is
 * `undefined` unless we pass one.
 */

/**
 * One entry of the `errors` array the engine returns for `throwOnError: false`.
 */
export type SerializedStepFailure = {
  action?: unknown
  handlerType?: unknown
  error?: unknown
}

/**
 * A refusal that is allowed to be repeated to the caller verbatim.
 *
 * `step` is the name the step was created with — read it from the step itself
 * (`someStep.__step__`, typed by the workflow SDK) or from the step module's
 * exported constant, so the declaration cannot drift from the registration.
 *
 * `copy` is the refusal's exact text and it is required, because step identity
 * alone authorizes nothing: the `action` the engine reports tags everything that
 * ran inside the step, not only the refusals it authors. Two kinds of step prove
 * that, and they are every kind this repo has:
 *
 *  - a step that goes on to call core workflows and module reads after deciding
 *    its own policy (`create-manual-renewal`, `resolve-redemption-code`) — a
 *    `MedusaError` raised in there carries the very same `action`;
 *  - a guard that reads as a pure predicate over its input but loads the row
 *    first (`assert-subscription-auto-renew-not-native` resolves the
 *    subscription module and calls `retrieveSubscription`). There the DAL's
 *    error mapper turns a driver fault into a `MedusaError` carrying the
 *    driver's own words —
 *    `@medusajs/utils/dist/dal/mikro-orm/db-error-mapper.js` maps SQLSTATE 42703
 *    (`undefined_column`) to `INVALID_DATA` with the original message
 *    (`:36-37`), and its other `invalid_data` branches interpolate `err.table`
 *    and `err.column` into theirs (`:26`, `:32`) — on a plain **read**, so a
 *    schema drift reaches a route as an `invalid_data` wearing a guard step's
 *    name.
 *
 * Declaring the full text is what keeps either message from being quoted as if
 * it were our own refusal. Patterns are anchored at both ends and interpolate
 * only a slot the plugin itself formatted (`[^']*` around an id, `\S+` around an
 * internal id), so a declared pattern cannot match anything but our own wording.
 */
export type CustomerRefusal = {
  step: string
  type: string
  copy: RegExp
}

/**
 * The route's own texts, one per status class the disclosure below can answer
 * with. They are fixed strings: none of them is built from a failure.
 */
export type StepFailureCopy = {
  /** a preserved `not_found` (404) */
  notFound: string
  /** a preserved business refusal (400 / 409 / 422) */
  refused: string
  /** everything that is a fault of ours, or whose type is not preserved (500) */
  failed: string
}

/**
 * What a route should answer for one failed run.
 */
export type ClassifiedStepFailure = {
  /** `MedusaError` type to throw — it decides the HTTP status */
  type: string
  /** the text to answer with; a refusal's own text only when `quoted` */
  message: string
  /** the step the engine reported, for the log line */
  step: string
  /** true when `message` is a declared refusal's own text */
  quoted: boolean
  /** the serialized error, for the log — never for the response */
  raw: unknown
}

/**
 * `MedusaError` types whose HTTP semantics are preserved for a failure that is
 * not a declared refusal, mapped to the class of fixed text they answer with.
 *
 * The statuses are the core error handler's own mapping
 * (`@medusajs/framework/dist/http/middlewares/error-handler.js`): `not_found`
 * 404, `invalid_data` and `not_allowed` 400, `conflict` 409, `duplicate_error`
 * and `payment_authorization_error` 422.
 *
 * Deliberately absent:
 * - `database_error` — core answers 500 *and keeps its message*, which is where
 *   `dbErrorMapper` puts table and column names. It collapses to the 500 below.
 * - `unauthorized` / `forbidden` — on these routes the caller's identity is the
 *   middleware's question, never a step's, so a step reporting one is our fault
 *   and a 401 would only send the bridge to re-authenticate in a loop.
 * - `unexpected_state`, `invalid_argument` and every unknown type — already 500
 *   in core; they collapse to the same fixed internal text.
 */
const PRESERVED_TYPES: Record<string, "notFound" | "refused"> = {
  [MedusaError.Types.NOT_FOUND]: "notFound",
  [MedusaError.Types.INVALID_DATA]: "refused",
  [MedusaError.Types.NOT_ALLOWED]: "refused",
  [MedusaError.Types.CONFLICT]: "refused",
  [MedusaError.Types.DUPLICATE_ERROR]: "refused",
  [MedusaError.Types.PAYMENT_AUTHORIZATION_ERROR]: "refused",
}

function serializedType(value: unknown): string | null {
  if (!value || typeof value !== "object") {
    return null
  }

  const candidate = value as Record<string, unknown>

  if (candidate.__isMedusaError !== true) {
    return null
  }

  return typeof candidate.type === "string" ? candidate.type : null
}

function serializedMessage(value: unknown): string | null {
  if (!value || typeof value !== "object") {
    return null
  }

  const message = (value as Record<string, unknown>).message

  return typeof message === "string" ? message : null
}

/**
 * Turn the engine's `errors` array into an answer: the declared refusals are
 * the only thing that may be quoted, everything else keeps its status and gets
 * one of the route's fixed texts.
 *
 * `preserveQuotedStatus` decides what a quoted refusal answers *as*. The three
 * bridge routes have always answered a refusal with 400, so they force
 * `invalid_data` even for a refusal the step throws as `not_found` — the SaaS
 * bridge's byte-compatibility promise is built on that. A customer-scoped route
 * has no such promise and its refusals were never re-labelled, so it passes
 * `true` and a quoted refusal keeps the type the step threw it with; forcing
 * 400 there would turn its 404s into 400s for no security reason.
 *
 * Pure: it never logs and never throws, so a caller decides what to do with
 * `raw` (see `logUnquotedStepFailure`) and always constructs its own
 * `MedusaError`.
 */
export function classifyStepFailure(params: {
  errors: unknown
  refusals: readonly CustomerRefusal[]
  copy: StepFailureCopy
  preserveQuotedStatus?: boolean
}): ClassifiedStepFailure {
  const { errors, refusals, copy, preserveQuotedStatus } = params

  const entries = Array.isArray(errors) ? errors : []
  const first = (entries[0] ?? {}) as SerializedStepFailure
  const raw = first.error ?? null
  const step =
    typeof first.action === "string" && first.action ? first.action : "unknown"
  const type = serializedType(raw)
  const message = serializedMessage(raw)

  if (type !== null && message !== null) {
    const declared = refusals.find(
      (refusal) =>
        refusal.step === step &&
        refusal.type === type &&
        refusal.copy.test(message)
    )

    if (declared) {
      // A refusal of the caller's request, authored as its answer. It keeps its
      // own text, because the SaaS shows it to the end customer, and answers
      // with the status the route promises for a refusal.
      return {
        type:
          preserveQuotedStatus === true ? type : MedusaError.Types.INVALID_DATA,
        message,
        step,
        quoted: true,
        raw,
      }
    }
  }

  if (type !== null) {
    const preserved = PRESERVED_TYPES[type]

    if (preserved) {
      return {
        type,
        message: copy[preserved],
        step,
        quoted: false,
        raw,
      }
    }
  }

  return {
    type: MedusaError.Types.UNEXPECTED_STATE,
    message: copy.failed,
    step,
    quoted: false,
    raw,
  }
}

/**
 * The minimum the routes need from `ContainerRegistrationKeys.LOGGER`.
 */
export type StepFailureLogger = {
  error: (message: string, error?: unknown) => void
}

/**
 * Record the failure the caller is not being told about: which step failed and
 * the error exactly as the engine serialized it (message, `code`, `table`,
 * `detail` and all) — which is the only place that text may go.
 */
export function logUnquotedStepFailure(
  logger: StepFailureLogger,
  context: string,
  failure: ClassifiedStepFailure
): void {
  logger.error(
    `[reorder] ${context}: failure outside its declared customer refusals (step: ${failure.step})`,
    failure.raw
  )
}
