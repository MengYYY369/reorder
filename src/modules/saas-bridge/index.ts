import { Module } from "@medusajs/framework/utils"
import SaasBridgeModuleService from "./service"

export const SAAS_BRIDGE_MODULE = "saas_bridge"

export default Module(SAAS_BRIDGE_MODULE, {
  service: SaasBridgeModuleService,
})
