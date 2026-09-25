import { MedusaError } from "@medusajs/framework/utils"

type RedemptionErrorType = "invalid_data" | "not_found" | "conflict"

export class RedemptionError extends MedusaError {
  constructor(type: RedemptionErrorType, message: string) {
    super(type, message)
  }
}

export const redemptionErrors = {
  batchNotFound: (id: string) =>
    new RedemptionError("not_found", `Redemption batch ${id} not found`),
  codeNotFound: (id: string) =>
    new RedemptionError("not_found", `Redemption code ${id} not found`),
  batchDisabled: (id: string) =>
    new RedemptionError("invalid_data", `Redemption batch ${id} is disabled`),
  codeDisabled: (id: string) =>
    new RedemptionError("invalid_data", `Redemption code ${id} is disabled`),
  codeExhausted: (id: string) =>
    new RedemptionError(
      "invalid_data",
      `Redemption code ${id} has no redemptions left`
    ),
  outsideWindow: (id: string) =>
    new RedemptionError(
      "invalid_data",
      `Redemption code ${id} is outside its validity window`
    ),
  alreadyRedeemedByCustomer: (code: string) =>
    new RedemptionError(
      "invalid_data",
      `Redemption code ${code} has already been redeemed by this customer`
    ),
  invalidCode: (code: string) =>
    new RedemptionError("not_found", `Redemption code "${code}" is invalid`),
  customerNotFound: (id: string) =>
    new RedemptionError("not_found", `Redemption customer ${id} not found`),
  noMatchingSubscription: (variantId: string) =>
    new RedemptionError(
      "invalid_data",
      `Redemption requires an active subscription of variant ${variantId}, but none was found`
    ),
  ambiguousTarget: () =>
    new RedemptionError(
      "invalid_data",
      "Multiple matching subscriptions found; pass subscription_id to disambiguate"
    ),
  extensionNotYetSupported: () =>
    new RedemptionError(
      "invalid_data",
      "Extending an existing subscription via redemption is not yet supported"
    ),
  trialOnlyForNewUsers: () =>
    new RedemptionError(
      "invalid_data",
      "Trial codes are for new users only"
    ),
}
