/**
 * The binding-capability discriminator (spec
 * `.agents/specs/2026-10-08-binding-capability-discriminator.md`).
 *
 * The bug this pins down: the capability used to be gated on
 * `startBinding.length >= 2`, but Medusa resolves module services through a
 * wrapper whose methods report `length === 0` — so the guard rejected every
 * version, including the installed 0.3.0, and the whole binding surface was
 * silently dead in production.
 *
 * The first test below is the one that would have caught it: a wrapped service
 * whose methods report `length === 0` must still resolve to a capability.
 */
import { createRequire } from "node:module"

import {
  resolvePaymentMethodBindingCapability,
  PAYMENT_METHODS_BINDING_MODULE_KEY,
} from "../payment-method-binding"

jest.mock("node:module", () => ({
  createRequire: jest.fn(),
}))

const mockCreateRequire = createRequire as unknown as jest.Mock

/**
 * A stand-in for what the container actually returns: a service whose methods
 * report arity 0 because Medusa wrapped them.
 */
/**
 * `Function.length` is non-writable, so it cannot be set with `Object.assign`
 * or an object literal — `defineProperty` is the only way to build a function
 * that takes arguments but reports arity 0, which is exactly what the wrapper
 * does.
 */
const withArity = <T extends (...args: never[]) => unknown>(
  fn: T,
  arity: number
): T => Object.defineProperty(fn, "length", { value: arity })

const wrappedService = () => ({
  bindRateLimiter_: {},
  // The real methods take (container, input) — the wrapper reports 0.
  startBinding: withArity(
    async () => ({ approvalUrl: "https://example.test", state: "s" }),
    0
  ),
  completeBinding: withArity(
    async () => ({ method: { id: "pm_1", provider_id: "paypal" } }),
    0
  ),
})

const containerReturning = (value: unknown) => ({
  resolve: (key: string) => {
    if (key !== PAYMENT_METHODS_BINDING_MODULE_KEY) {
      throw new Error(`unexpected key ${key}`)
    }
    return value
  },
})

/** Make `createRequire(...)("…/package.json")` report the given version. */
const withInstalledVersion = (version: string | null) => {
  mockCreateRequire.mockReturnValue((specifier: string) => {
    if (specifier !== "@mengyyy369/medusa-payment-methods/package.json") {
      throw new Error(`unexpected specifier ${specifier}`)
    }
    if (version === null) {
      const err = new Error("Cannot find module") as Error & { code: string }
      err.code = "MODULE_NOT_FOUND"
      throw err
    }
    return { version }
  })
}

describe("resolvePaymentMethodBindingCapability", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("resolves a wrapped service whose methods report arity 0", () => {
    // 🔴 The regression: this is what the container really returns, and the
    //    old arity guard rejected it.
    withInstalledVersion("0.3.0")

    const capability = resolvePaymentMethodBindingCapability(
      containerReturning(wrappedService())
    )

    expect(capability).not.toBeNull()
    expect(typeof capability?.startBinding).toBe("function")
    expect(typeof capability?.completeBinding).toBe("function")
  })

  it("accepts 0.2.0 — the first version with the container-first signature", () => {
    withInstalledVersion("0.2.0")
    expect(
      resolvePaymentMethodBindingCapability(
        containerReturning(wrappedService())
      )
    ).not.toBeNull()
  })

  it("refuses a known pre-0.2.0 plugin", () => {
    withInstalledVersion("0.1.4")
    expect(
      resolvePaymentMethodBindingCapability(
        containerReturning(wrappedService())
      )
    ).toBeNull()
  })

  it("accepts any 1.x and above regardless of minor", () => {
    withInstalledVersion("1.0.0")
    expect(
      resolvePaymentMethodBindingCapability(
        containerReturning(wrappedService())
      )
    ).not.toBeNull()
  })

  it("fails open when the version cannot be determined", () => {
    // User decision (Q1 in the spec): a false negative here disables the whole
    // binding surface with no signal, which is how the arity bug survived.
    withInstalledVersion(null)
    expect(
      resolvePaymentMethodBindingCapability(
        containerReturning(wrappedService())
      )
    ).not.toBeNull()
  })

  it("fails open when the version string is not parseable", () => {
    withInstalledVersion("not-a-version")
    expect(
      resolvePaymentMethodBindingCapability(
        containerReturning(wrappedService())
      )
    ).not.toBeNull()
  })

  it("returns null when the module is not registered", () => {
    withInstalledVersion("0.3.0")
    const container = {
      resolve: () => {
        throw new Error("paymentMethods is not registered")
      },
    }
    expect(resolvePaymentMethodBindingCapability(container)).toBeNull()
  })

  it("returns null when the binding methods are missing", () => {
    withInstalledVersion("0.3.0")
    expect(
      resolvePaymentMethodBindingCapability(
        containerReturning({ bindRateLimiter_: {} })
      )
    ).toBeNull()
  })

  it("returns null when resolve yields a non-object", () => {
    withInstalledVersion("0.3.0")
    expect(resolvePaymentMethodBindingCapability(containerReturning(42))).toBeNull()
  })
})
