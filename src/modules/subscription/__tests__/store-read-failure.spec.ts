import { MedusaError } from "@medusajs/framework/utils"
import { classifyStoreReadFailure } from "../utils/store-read-failure"

const COPY = { notFound: "subscription not found" }

describe("classifyStoreReadFailure", () => {
  it("answers a driver-shaped fault with the route's own text", () => {
    const fault = new MedusaError(
      MedusaError.Types.INVALID_DATA,
      "column subscription.next_renewal__canary does not exist"
    )

    const result = classifyStoreReadFailure(fault, COPY)

    expect(result).toEqual({ type: "not_found", message: COPY.notFound })
    expect(JSON.stringify(result)).not.toContain("next_renewal__")
  })

  it("answers a non-MedusaError the same way, without leaking its code", () => {
    const driver = Object.assign(new Error("connection terminated"), {
      code: "57P01",
      table: "subscription_canary",
    })

    const result = classifyStoreReadFailure(driver, COPY)

    expect(result).toEqual({ type: "not_found", message: COPY.notFound })
    expect(JSON.stringify(result)).not.toContain("57P01")
    expect(JSON.stringify(result)).not.toContain("subscription_canary")
  })

  it("answers undefined without inventing anything", () => {
    expect(classifyStoreReadFailure(undefined, COPY)).toEqual({
      type: "not_found",
      message: COPY.notFound,
    })
  })
})
