import { model } from "@medusajs/framework/utils"
import RedemptionBatch from "./redemption-batch"
import RedemptionCode from "./redemption-code"
import {
  RedemptionFrequencyInterval,
  RedemptionOutcome,
} from "../types"

const RedemptionRecord = model.define("redemption_record", {
  id: model.id().primaryKey(),
  batch: model.belongsTo(() => RedemptionBatch, {
    mappedBy: "records",
  }),
  code: model.belongsTo(() => RedemptionCode, {
    mappedBy: "records",
  }),
  customer_id: model.text(),
  subscription_id: model.text(),
  outcome: model.enum(RedemptionOutcome),
  free_cycles_applied: model.number().default(0),
  frequency_interval: model.enum(RedemptionFrequencyInterval),
  frequency_value: model.number().default(1),
  metadata: model.json().nullable(),
}).indexes([
  {
    on: ["batch_id"],
  },
  {
    on: ["code_id"],
  },
  {
    on: ["customer_id"],
  },
  {
    on: ["subscription_id"],
  },
  {
    name: "IDX_redemption_record_code_customer_unique",
    on: ["code_id", "customer_id"],
    unique: true,
  },
])

export default RedemptionRecord
