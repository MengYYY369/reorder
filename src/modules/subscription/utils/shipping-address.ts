import type { SubscriptionShippingAddress } from "../types"
import { subscriptionErrors } from "./errors"

/**
 * Fields that make a shipping address a real, fulfillable snapshot. A cart can
 * carry a region-seeded stub (Medusa seeds an address holding only
 * `country_code`), and digital/SaaS carts can carry no address at all; neither
 * should fail subscription checkout, so completeness is what selects between the
 * strict snapshot and the placeholder.
 *
 * `postal_code: "00000"` mirrors the placeholder this plugin already writes for
 * SaaS carts in `src/api/store/saas/carts/route.ts`.
 */
const REQUIRED_ADDRESS_FIELDS = [
  "first_name",
  "last_name",
  "address_1",
  "city",
  "postal_code",
  "country_code",
] as const

const PLACEHOLDER = {
  first_name: "Digital",
  last_name: "Delivery",
  address_1: "N/A",
  city: "N/A",
  postal_code: "00000",
} as const

export type ShippingAddressSource = {
  shipping_address?: Record<string, unknown> | null
  customer?: {
    first_name?: string | null
    last_name?: string | null
  } | null
  /**
   * ISO 2 code of the first country configured on the cart region. Only used
   * when the cart address is missing or incomplete.
   */
  region_country_code?: string | null
}

export function isShippingAddressComplete(
  address?: Record<string, unknown> | null
): boolean {
  if (!address) {
    return false
  }

  return REQUIRED_ADDRESS_FIELDS.every((field) =>
    isFilled(address[field])
  )
}

/**
 * Resolve the address snapshot persisted on a subscription.
 *
 * - complete address → strict snapshot, every required field still validated
 * - stub or missing address → digital-goods placeholder built from the customer
 *   record and the cart region, keeping whatever optional fields the stub did
 *   carry (a region-seeded stub at least pins the country)
 *
 * @throws when neither the address nor the region can supply a country code,
 * because the snapshot would then be unusable for tax and renewal ordering.
 */
export function resolveShippingAddress(
  source: ShippingAddressSource
): SubscriptionShippingAddress {
  const address = source.shipping_address ?? null

  if (address && isShippingAddressComplete(address)) {
    return {
      first_name: readRequired(address.first_name, "first_name"),
      last_name: readRequired(address.last_name, "last_name"),
      company: readOptional(address.company),
      address_1: readRequired(address.address_1, "address_1"),
      address_2: readOptional(address.address_2),
      city: readRequired(address.city, "city"),
      postal_code: readRequired(address.postal_code, "postal_code"),
      province: readOptional(address.province),
      country_code: readRequired(address.country_code, "country_code").toUpperCase(),
      phone: readOptional(address.phone),
    }
  }

  const countryCode =
    readOptional(address?.country_code)?.toUpperCase() ??
    readOptional(source.region_country_code)?.toUpperCase()

  if (!countryCode) {
    throw subscriptionErrors.invalidData(
      "Subscription checkout requires a region country code when no shipping address is provided"
    )
  }

  return {
    first_name:
      readOptional(source.customer?.first_name) ?? PLACEHOLDER.first_name,
    last_name:
      readOptional(source.customer?.last_name) ?? PLACEHOLDER.last_name,
    company: readOptional(address?.company),
    address_1: readOptional(address?.address_1) ?? PLACEHOLDER.address_1,
    address_2: readOptional(address?.address_2),
    city: readOptional(address?.city) ?? PLACEHOLDER.city,
    postal_code: readOptional(address?.postal_code) ?? PLACEHOLDER.postal_code,
    province: readOptional(address?.province),
    country_code: countryCode,
    phone: readOptional(address?.phone),
  }
}

function isFilled(value: unknown) {
  return typeof value === "string" && !!value.trim()
}

function readOptional(value: unknown): string | null {
  return isFilled(value) ? (value as string).trim() : null
}

function readRequired(value: unknown, field: string): string {
  const text = readOptional(value)

  if (!text) {
    throw subscriptionErrors.invalidData(
      `Subscription checkout requires complete address data, '${field}' is missing`
    )
  }

  return text
}
