import type { MedusaContainer } from "@medusajs/framework/types"
import { PAYMENT_METHODS_MODULE } from "@mengyyy369/medusa-payment-methods/modules/payment-methods"
import {
  isPaymentMethodsModuleRegistered,
  resolveRenewalPaymentContext,
} from "../utils/preferred-payment-method"

type ReaderStub = {
  listCustomerMethods: jest.Mock
}

function buildContainer(input: { reader?: ReaderStub; moduleThrows?: boolean }) {
  const container = {
    resolve: (key: string, options?: { allowUnregistered?: boolean }) => {
      if (key !== PAYMENT_METHODS_MODULE) {
        throw new Error(`Unexpected container key '${key}'`)
      }

      if (input.moduleThrows) {
        throw new Error("payment-methods module failed to load")
      }

      if (options?.allowUnregistered) {
        return input.reader
      }

      if (!input.reader) {
        throw new Error("payment-methods module is not registered")
      }

      return input.reader
    },
  } as unknown as MedusaContainer

  return container
}

const rowFallback = {
  payment_provider_id: "pp_paypal_paypal",
  payment_method_reference: "row-vault-token",
}

describe("isPaymentMethodsModuleRegistered", () => {
  it("is false when the module is not registered", () => {
    expect(
      isPaymentMethodsModuleRegistered(buildContainer({ reader: undefined }))
    ).toBe(false)
  })

  it("is true when the module exposes its customer reader", () => {
    expect(
      isPaymentMethodsModuleRegistered(
        buildContainer({ reader: { listCustomerMethods: jest.fn() } })
      )
    ).toBe(true)
  })
})

describe("resolveRenewalPaymentContext", () => {
  it("charges the plugin's preferred method for the subscription's product", async () => {
    const listCustomerMethods = jest.fn().mockResolvedValue({
      methods: [],
      scopes: [{ id: "prod_1", label: "Coffee" }],
      preferredByScope: {
        prod_1: {
          provider_id: "pp_stripe_stripe",
          payment_method_reference: "pm_preferred",
        },
      },
    })

    const resolved = await resolveRenewalPaymentContext(
      buildContainer({ reader: { listCustomerMethods } }),
      { customerId: "cus_1", scope: "prod_1", fallback: rowFallback }
    )

    expect(resolved).toEqual({
      providerId: "pp_stripe_stripe",
      reference: "pm_preferred",
    })
    expect(listCustomerMethods).toHaveBeenCalledTimes(1)
  })

  it("falls back to the subscription row when the module is not registered", async () => {
    const resolved = await resolveRenewalPaymentContext(
      buildContainer({ reader: undefined }),
      { customerId: "cus_1", scope: "prod_1", fallback: rowFallback }
    )

    expect(resolved).toEqual({
      providerId: "pp_paypal_paypal",
      reference: "row-vault-token",
    })
  })

  it("falls back to the subscription row when the plugin read throws", async () => {
    const listCustomerMethods = jest
      .fn()
      .mockRejectedValue(new Error("adapter blew up"))

    const resolved = await resolveRenewalPaymentContext(
      buildContainer({ reader: { listCustomerMethods } }),
      { customerId: "cus_1", scope: "prod_1", fallback: rowFallback }
    )

    expect(resolved).toEqual({
      providerId: "pp_paypal_paypal",
      reference: "row-vault-token",
    })
  })

  it("falls back to the subscription row when the scope has no preference", async () => {
    const listCustomerMethods = jest.fn().mockResolvedValue({
      methods: [],
      scopes: [],
      preferredByScope: {},
    })

    const resolved = await resolveRenewalPaymentContext(
      buildContainer({ reader: { listCustomerMethods } }),
      { customerId: "cus_1", scope: "prod_1", fallback: rowFallback }
    )

    expect(resolved).toEqual({
      providerId: "pp_paypal_paypal",
      reference: "row-vault-token",
    })
  })

  it("never reads the plugin when the subscription has no product scope", async () => {
    const listCustomerMethods = jest.fn()

    const resolved = await resolveRenewalPaymentContext(
      buildContainer({ reader: { listCustomerMethods } }),
      { customerId: "cus_1", scope: null, fallback: rowFallback }
    )

    expect(resolved).toEqual({
      providerId: "pp_paypal_paypal",
      reference: "row-vault-token",
    })
    expect(listCustomerMethods).not.toHaveBeenCalled()
  })
})
