import { defineMiddlewares } from "@medusajs/framework/http"
import { adminSubscriptionsMiddlewares } from "./admin/subscriptions/middlewares"
import { adminSubscriptionOffersMiddlewares } from "./admin/subscription-offers/middlewares"
import { adminRenewalsMiddlewares } from "./admin/renewals/middlewares"
import { adminDunningMiddlewares } from "./admin/dunning/middlewares"
import { adminCancellationsMiddlewares } from "./admin/cancellations/middlewares"
import { adminRedemptionsMiddlewares } from "./admin/redemptions/middlewares"
import { adminSubscriptionLogsMiddlewares } from "./admin/subscription-logs/middlewares"
import { adminSubscriptionAnalyticsMiddlewares } from "./admin/subscription-analytics/middlewares"
import { adminSubscriptionSettingsMiddlewares } from "./admin/subscription-settings/middlewares"
import { storeCustomerSubscriptionsMiddlewares } from "./store/customers/me/subscriptions/middlewares"
import { storeCustomerRedemptionsMiddlewares } from "./store/customers/me/redemptions/middlewares"
import { storeProductMiddlewares } from "./store/products/middlewares"
import { saasBridgeMiddlewares } from "../modules/saas-bridge/auth"
import { rejectConflictingPurchase } from "./store/carts/completion-gate"

export default defineMiddlewares({
  routes: [
    ...adminSubscriptionsMiddlewares,
    ...adminSubscriptionSettingsMiddlewares,
    ...adminSubscriptionAnalyticsMiddlewares,
    ...adminSubscriptionLogsMiddlewares,
    ...adminSubscriptionOffersMiddlewares,
    ...adminRenewalsMiddlewares,
    ...adminDunningMiddlewares,
    ...adminCancellationsMiddlewares,
    ...adminRedemptionsMiddlewares,
    ...storeCustomerSubscriptionsMiddlewares,
    ...storeCustomerRedemptionsMiddlewares,
    ...storeProductMiddlewares,
    ...saasBridgeMiddlewares,
    {
      // Guard on a core route, appended after the plugin's own groups so the
      // existing 13 matcher sets stay untouched. Method-scoped middlewares are
      // registered ahead of the route for the same path, so this runs before
      // the core cart-completion handler and can refuse the order.
      matcher: "/store/carts/:id/complete",
      methods: ["POST"],
      middlewares: [rejectConflictingPurchase],
    },
  ],
})
