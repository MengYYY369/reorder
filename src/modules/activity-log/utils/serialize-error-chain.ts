/**
 * Workflow failures reaching a subscriber are not always `Error` instances: the
 * engine reports a nested `{ message, errors }` chain, and steps re-throw plain
 * objects often enough that `String(error)` prints `[object Object]`. These
 * helpers flatten whatever arrives into a JSON-safe string that still names the
 * step that failed, so a support agent can locate the break in the chain.
 */

const MAX_DEPTH = 6
const MAX_SIBLINGS = 12
const MAX_MESSAGE_CHARS = 1500

const NO_MESSAGE = "(no message)"

const REDACTED_KEYS = new Set([
  "payment_context",
  "payment_method_reference",
  "customer_payment_reference",
  "source_payment_session_id",
  "provider_payload",
  "provider_response",
  "stack",
  "stacktrace",
  "error_stack",
  "api_key",
  "secret",
  "token",
])

const CHILD_KEYS = new Set(["errors", "error", "err", "cause"])
const STEP_KEYS = new Set(["action", "step", "step_id", "handler_type"])

export type SerializedErrorNode = {
  message: string
  step: string | null
  errors?: SerializedErrorNode[]
}

/**
 * Flatten a workflow failure (thrown error, `run()` result, or `errors` array)
 * into an ordered list of `{ message, step }` nodes.
 */
export function collectErrorNodes(source: unknown): SerializedErrorNode[] {
  const nodes = toNodes(source, 0, new Set())

  return nodes.length ? nodes : [{ message: describeValue(source), step: null }]
}

/**
 * JSON string of the whole failure chain. Never throws: an unserializable value
 * degrades to its string form.
 */
export function serializeErrorChain(source: unknown): string {
  try {
    return JSON.stringify(collectErrorNodes(source))
  } catch {
    return JSON.stringify([{ message: stringifyFallback(source), step: null }])
  }
}

/**
 * Name of the first failing step found in a depth-first walk.
 */
export function extractFailedStep(source: unknown): string | null {
  for (const node of collectErrorNodes(source)) {
    const step = firstStep(node)

    if (step) {
      return step
    }
  }

  return null
}

/**
 * Steps are joined into `dedupe_key` with `:` as the separator, so anything
 * that is not a plain identifier character is collapsed to `-`.
 */
export function toDedupeQualifier(step: string | null): string {
  if (!step) {
    return "unknown-step"
  }

  const cleaned = step.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "")

  return cleaned || "unknown-step"
}

function firstStep(node: SerializedErrorNode): string | null {
  if (node.step) {
    return node.step
  }

  for (const child of node.errors ?? []) {
    const step = firstStep(child)

    if (step) {
      return step
    }
  }

  return null
}

function toNodes(
  value: unknown,
  depth: number,
  seen: Set<object>
): SerializedErrorNode[] {
  if (value === undefined) {
    return []
  }

  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_SIBLINGS)
      .flatMap((entry) => toNodes(entry, depth, seen))
  }

  if (value === null || typeof value !== "object") {
    return [{ message: describeValue(value), step: null }]
  }

  if (seen.has(value) || depth >= MAX_DEPTH) {
    return [{ message: describeCircular(value), step: null }]
  }

  seen.add(value)

  try {
    return [toNode(value, depth, seen)]
  } finally {
    seen.delete(value)
  }
}

function toNode(
  value: object,
  depth: number,
  seen: Set<object>
): SerializedErrorNode {
  const record = value as Record<string, unknown>
  const children: SerializedErrorNode[] = []

  for (const key of CHILD_KEYS) {
    children.push(...toNodes(record[key], depth + 1, seen))
  }

  const rawMessage =
    typeof record.message === "string" ? record.message.trim() : ""

  const node: SerializedErrorNode = {
    message: truncate(rawMessage || describeOwnFields(record)),
    step: readStep(value, record),
  }

  if (children.length) {
    node.errors = children
  }

  return node
}

function readStep(value: object, record: Record<string, unknown>): string | null {
  // `Error.name` is the exception class, not a step identifier.
  if (value instanceof Error) {
    return null
  }

  for (const key of STEP_KEYS) {
    const candidate = record[key]

    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim()
    }
  }

  if (typeof record.name === "string" && record.name.trim()) {
    return record.name.trim()
  }

  return null
}

function describeOwnFields(record: Record<string, unknown>): string {
  const own: Record<string, unknown> = {}

  for (const [key, nested] of Object.entries(record)) {
    if (CHILD_KEYS.has(key) || STEP_KEYS.has(key)) {
      continue
    }

    if (key === "message" && typeof nested === "string") {
      continue
    }

    own[key] = nested
  }

  if (!Object.keys(own).length) {
    return NO_MESSAGE
  }

  return describeObject(own)
}

function describeValue(value: unknown): string {
  if (value === undefined) {
    return "undefined"
  }

  if (value === null) {
    return "null"
  }

  if (typeof value === "string") {
    return truncate(value)
  }

  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return String(value)
  }

  if (value instanceof Error) {
    return truncate(value.message || value.name || "Error")
  }

  return truncate(describeObject(value))
}

function describeCircular(value: object): string {
  return value instanceof Error
    ? `${value.name}: ${value.message} [repeated]`
    : "[repeated]"
}

function describeObject(value: unknown): string {
  try {
    const json = JSON.stringify(value, redactingReplacer(new Set()))

    if (json && json !== "{}") {
      return json
    }
  } catch {
    // Circular or otherwise unserializable: fall through to the string form.
  }

  return stringifyFallback(value)
}

function stringifyFallback(value: unknown): string {
  try {
    return String(value)
  } catch {
    return "[unserializable error]"
  }
}

function redactingReplacer(seen: Set<object>) {
  return (key: string, value: unknown): unknown => {
    if (REDACTED_KEYS.has(key)) {
      return "[redacted]"
    }

    if (typeof value === "function" || typeof value === "symbol") {
      return String(value)
    }

    if (typeof value === "bigint") {
      return String(value)
    }

    if (typeof value !== "object" || value === null) {
      return value
    }

    if (seen.has(value)) {
      return "[Circular]"
    }

    seen.add(value)

    if (value instanceof Error) {
      return { name: value.name, message: value.message }
    }

    return value
  }
}

function truncate(value: string): string {
  return value.length > MAX_MESSAGE_CHARS
    ? `${value.slice(0, MAX_MESSAGE_CHARS)}…[truncated]`
    : value
}
