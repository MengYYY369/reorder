import type { MedusaContainer } from "@medusajs/framework/types"
import { MedusaService } from "@medusajs/framework/utils"
import { setSiteAdapterContainer } from "../../adapter/container"
import Subscription from "./models/subscription"

/**
 * The subscription module service.
 *
 * Medusa constructs a module service with the module's **own** container
 * (`localContainer.cradle`), and that container is the only place a
 * subscription reader is reachable from without the application container. The
 * service hands it to the site adapter at boot so
 * `@mengyyy369/medusa-payment-methods` can answer `listScopes` / `listExtraRows`
 * / `isInUse` at request time.
 */
class SubscriptionModuleService extends MedusaService({
  Subscription,
}) {
  constructor(container: MedusaContainer) {
    super(container)
    setSiteAdapterContainer(container)
  }
}

export default SubscriptionModuleService
