import { defineRouteConfig } from "@medusajs/admin-sdk"
import { Beaker } from "@medusajs/icons"
import { translate } from "../../../i18n/translate"
import { TrialPageView } from "./page-view"

export const config = defineRouteConfig({
  label: "menuItems.trial",
  translationNs: "reorder",
  rank: 6,
  icon: Beaker,
})

export const handle = {
  breadcrumb: () => translate("menuItems.trial"),
}

export default TrialPageView
