import { model } from "@medusajs/framework/utils"
import RedemptionBatch from "./redemption-batch"
import { RedemptionCodeStatus } from "../types"

const RedemptionCode = model.define("redemption_code", {
  id: model.id().primaryKey(),
  batch: model.belongsTo(() => RedemptionBatch, {
    mappedBy: "codes",
  }),
  code: model.text(),
  status: model
    .enum(RedemptionCodeStatus)
    .default(RedemptionCodeStatus.ACTIVE),
  max_redemptions: model.number().default(1),
  redemption_count: model.number().default(0),
}).indexes([
  {
    name: "IDX_redemption_code_code_unique",
    on: ["code"],
    unique: true,
  },
  {
    on: ["batch_id"],
  },
  {
    on: ["status"],
  },
])

export default RedemptionCode
