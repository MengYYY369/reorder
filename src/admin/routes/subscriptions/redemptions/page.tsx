import { defineRouteConfig } from "@medusajs/admin-sdk";
import { ReceiptPercent } from "@medusajs/icons";
import { translate } from "../../../i18n/translate";
import { TicketsRedemptionPage } from "./page-view";

export const config = defineRouteConfig({
  label: "menuItems.redemptions",
  translationNs: "reorder",
  icon: ReceiptPercent,
});

export const handle = {
  breadcrumb: () => translate("menuItems.redemptions"),
};

export default TicketsRedemptionPage;
