import { model } from "@medusajs/framework/utils"
import {
  RedemptionBatchStatus,
  RedemptionFrequencyInterval,
} from "../types"

const RedemptionBatch = model.define("redemption_batch", {
  id: model.id().primaryKey(),
  name: model.text(),
  variant_id: model.text(),
  frequency_interval: model.enum(RedemptionFrequencyInterval),
  frequency_value: model.number().default(1),
  free_cycles: model.number().default(1),
  status: model
    .enum(RedemptionBatchStatus)
    .default(RedemptionBatchStatus.ACTIVE),
  code_prefix: model.text().default("RDM"),
  max_redemptions_per_code: model.number().default(1),
  /**
   * The batch's own trial configuration (ticket 14 / D14), default off. Trial
   * semantics used to be inherited from the target variant's plan-offer rules,
   * which made every code batch on a trial-enabled variant a new-user-only
   * trial grant. Decoupling the two lets a normal batch and a trial offer live
   * on the same variant.
   */
  trial_enabled: model.boolean().default(false),
  trial_days: model.number().nullable(),
  trial_bonus_days: model.number().nullable(),
  trial_requires_payment_method: model.boolean().default(false),
  starts_at: model.dateTime().nullable(),
  expires_at: model.dateTime().nullable(),
  metadata: model.json().nullable(),
}).indexes([
  {
    on: ["variant_id"],
  },
  {
    on: ["status"],
  },
  {
    on: ["name"],
  },
])

export default RedemptionBatch
