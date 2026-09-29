import { model } from "@medusajs/framework/utils"
import {
  TrialClaimBindingMethod,
  TrialClaimSource,
} from "../types"

/**
 * One row per trial claim. The pair (`customer_id`, `product_id`) is unique
 * (`trial_claim_customer_product_unique`, created by the module's migration):
 * it is the race-safe anchor that keeps a customer to a single trial of a
 * product no matter which door they come through or how two doors race.
 */
const TrialClaim = model.define("trial_claim", {
  id: model.id().primaryKey(),
  customer_id: model.text(),
  product_id: model.text(),
  variant_id: model.text(),
  claimed_at: model.dateTime(),
  trial_ends_at: model.dateTime().nullable(),
  source: model.enum(TrialClaimSource),
  subscription_id: model.text(),
  binding_method: model
    .enum(TrialClaimBindingMethod)
    .default(TrialClaimBindingMethod.NONE),
}).indexes([
  {
    on: ["customer_id"],
  },
  {
    on: ["product_id"],
  },
  {
    on: ["subscription_id"],
  },
  {
    name: "trial_claim_customer_product_unique",
    on: ["customer_id", "product_id"],
    unique: true,
  },
])

export default TrialClaim
