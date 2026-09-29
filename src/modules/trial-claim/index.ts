import { Module } from "@medusajs/framework/utils"
import TrialClaimModuleService from "./service"

/**
 * The registration key must be variable-safe (Medusa's
 * `validateModuleName` rejects hyphens — `@medusajs/utils/dist/common/validate-module-name.js`),
 * so it is camelCase while the module DIRECTORY stays `src/modules/trial-claim/`
 * and the migration snapshot stays `.snapshot-medusa-trial-claim.json`
 * (`defineMikroOrmCliConfig` kebab-cases the service name). Same split as the
 * settings module (`subscriptionSettings` in `src/modules/settings/`).
 */
export const TRIAL_CLAIM_MODULE = "trialClaim"

export default Module(TRIAL_CLAIM_MODULE, {
  service: TrialClaimModuleService,
})
