import { getI18n, useTranslation } from "react-i18next"

const NAMESPACE = "reorder"

/** The `t` function bound to the reorder namespace. Plans 2-6 use this type for
 * helper-function parameters instead of importing `TFunction` from `i18next`
 * (which is an undeclared transitive dependency). */
export type ReorderTranslate = ReturnType<typeof useTranslation>["t"]

/**
 * Reads a translation outside a React component, where hooks are unavailable.
 * Falls back to the key itself if the dashboard i18n instance is not ready yet.
 */
export function translate(
  key: string,
  options?: Record<string, unknown>
): string {
  const i18n = getI18n()

  if (!i18n) {
    return key
  }

  return i18n.t(key, { ns: NAMESPACE, ...options })
}
