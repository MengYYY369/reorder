import { Module } from "@medusajs/framework/utils"
import RedemptionModuleService from "./service"

export const REDEMPTION_MODULE = "redemption"

export default Module(REDEMPTION_MODULE, {
  service: RedemptionModuleService,
})
