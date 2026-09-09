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
