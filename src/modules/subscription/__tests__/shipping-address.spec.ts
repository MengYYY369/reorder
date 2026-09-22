import {
  isShippingAddressComplete,
  resolveShippingAddress,
} from "../utils/shipping-address"

const COMPLETE_ADDRESS = {
  id: "address_1",
  first_name: " Jane ",
  last_name: "Doe",
  company: "Acme",
  address_1: "1 Test Way",
  address_2: "Apt 2",
  city: "Testville",
  postal_code: "00001",
  province: "Zhejiang",
  country_code: "us",
  phone: "12345",
}

describe("isShippingAddressComplete", () => {
  it("accepts an address carrying every required field", () => {
    expect(isShippingAddressComplete(COMPLETE_ADDRESS)).toBe(true)
  })

  it("rejects the region-seeded country-only stub", () => {
    expect(isShippingAddressComplete({ country_code: "cn" })).toBe(false)
  })

  it("rejects whitespace-only required fields", () => {
    expect(
      isShippingAddressComplete({
        ...COMPLETE_ADDRESS,
        postal_code: "   ",
      })
    ).toBe(false)
  })

  it("rejects a missing address", () => {
    expect(isShippingAddressComplete(null)).toBe(false)
    expect(isShippingAddressComplete(undefined)).toBe(false)
  })
})

describe("resolveShippingAddress", () => {
  it("keeps the strict snapshot for a complete address", () => {
    expect(resolveShippingAddress({ shipping_address: COMPLETE_ADDRESS })).toEqual({
      first_name: "Jane",
      last_name: "Doe",
      company: "Acme",
      address_1: "1 Test Way",
      address_2: "Apt 2",
      city: "Testville",
      postal_code: "00001",
      province: "Zhejiang",
      country_code: "US",
      phone: "12345",
    })
  })

  it("falls back to the placeholder for a country-only stub", () => {
    expect(
      resolveShippingAddress({
        shipping_address: { country_code: "cn" },
        customer: { first_name: "Meng", last_name: null },
      })
    ).toEqual({
      first_name: "Meng",
      last_name: "Delivery",
      company: null,
      address_1: "N/A",
      address_2: null,
      city: "N/A",
      postal_code: "00000",
      province: null,
      country_code: "CN",
      phone: null,
    })
  })

  it("builds a placeholder from the customer and region when no address exists", () => {
    expect(
      resolveShippingAddress({
        shipping_address: null,
        customer: { first_name: "Ada", last_name: "Lovelace" },
        region_country_code: "de",
      })
    ).toEqual({
      first_name: "Ada",
      last_name: "Lovelace",
      company: null,
      address_1: "N/A",
      address_2: null,
      city: "N/A",
      postal_code: "00000",
      province: null,
      country_code: "DE",
      phone: null,
    })
  })

  it("keeps partial values the stub already carried", () => {
    const resolved = resolveShippingAddress({
      shipping_address: {
        country_code: "cn",
        address_1: "42 Harbor Rd",
        phone: "+86 138 0000 0000",
      },
      region_country_code: "us",
    })

    expect(resolved.address_1).toBe("42 Harbor Rd")
    expect(resolved.phone).toBe("+86 138 0000 0000")
    expect(resolved.country_code).toBe("CN")
    expect(resolved.first_name).toBe("Digital")
  })

  it("throws when no country can be resolved", () => {
    expect(() =>
      resolveShippingAddress({
        shipping_address: null,
        customer: null,
        region_country_code: null,
      })
    ).toThrow(/region country code/)
  })
})
