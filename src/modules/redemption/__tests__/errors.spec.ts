import { RedemptionError, redemptionErrors } from "../utils/errors"

describe("redemption errors", () => {
  describe("customerNotFound", () => {
    it("names the missing customer, not a variant", () => {
      const error = redemptionErrors.customerNotFound("cus_gone")
      expect(error.type).toBe("not_found")
      expect(error.message).toBe("Redemption customer cus_gone not found")
    })

    it("is a RedemptionError, so the store routes classify it as a refusal", () => {
      expect(redemptionErrors.customerNotFound("cus_gone")).toBeInstanceOf(
        RedemptionError
      )
    })
  })
})
