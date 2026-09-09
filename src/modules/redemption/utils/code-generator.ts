/**
 * Unambiguous charset: no 0/O, no 1/I/L — codes stay readable when shared
 * verbally or in print.
 */
const CODE_CHARSET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"

const CODE_GROUP_LENGTH = 4
const CODE_GROUP_COUNT = 3

export interface GenerateCodeOptions {
  prefix?: string
  random?: () => number
}

/**
 * Generates a code in the shape `PREFIX-XXXX-XXXX-XXXX` using the
 * unambiguous charset. The default `random` is `Math.random`; tests inject a
 * deterministic sequence.
 */
export function generateRedemptionCode(
  options: GenerateCodeOptions = {},
): string {
  const prefix = (options.prefix ?? "RDM").toUpperCase()
  const random = options.random ?? Math.random

  const groups: string[] = []
  for (let group = 0; group < CODE_GROUP_COUNT; group++) {
    let chars = ""
    for (let index = 0; index < CODE_GROUP_LENGTH; index++) {
      chars += CODE_CHARSET[Math.floor(random() * CODE_CHARSET.length)]
    }
    groups.push(chars)
  }

  return [prefix, ...groups].join("-")
}

/**
 * Codes are stored uppercase; redemption lookups normalize the same way so
 * customer input is matched case-insensitively.
 */
export function normalizeRedemptionCode(rawCode: string): string {
  return rawCode.trim().toUpperCase()
}

const CUSTOM_CODE_PATTERN = /^[A-Z0-9][A-Z0-9-]*[A-Z0-9]$/

/**
 * Custom codes must be alphanumeric with optional inner hyphens, at least two
 * characters, and no leading/trailing hyphen. Returns the normalized code or
 * null when invalid.
 */
export function normalizeCustomRedemptionCode(
  rawCode: string,
): string | null {
  const normalized = normalizeRedemptionCode(rawCode)
  if (!CUSTOM_CODE_PATTERN.test(normalized)) {
    return null
  }
  return normalized
}

/**
 * Generates `count` unique codes that do not collide with each other or with
 * the provided existing codes (compared case-insensitively). Uses rejection
 * sampling against the occupied set; the charset provides enough entropy that
 * the loop terminates in practice. Bounded retries surface an error rather
 * than looping forever on a pathological prefix.
 */
export function generateUniqueRedemptionCodes(
  count: number,
  existingCodes: Iterable<string>,
  options: GenerateCodeOptions = {},
): string[] {
  const prefix = (options.prefix ?? "RDM").toUpperCase()
  const occupied = new Set< string>()
  for (const code of existingCodes) {
    occupied.add(normalizeRedemptionCode(code))
  }

  const generated: string[] = []
  const maxAttempts = count * 100 + 100

  for (let attempt = 0; attempt < maxAttempts && generated.length < count; attempt++) {
    const candidate = generateRedemptionCode({ prefix, random: options.random })
    if (occupied.has(candidate)) {
      continue
    }
    occupied.add(candidate)
    generated.push(candidate)
  }

  if (generated.length < count) {
    throw new Error(
      `Unable to generate ${count} unique redemption codes with prefix "${prefix}"`,
    )
  }

  return generated
}
