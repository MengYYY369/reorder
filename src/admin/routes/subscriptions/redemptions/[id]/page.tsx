import { defineRouteConfig } from "@medusajs/admin-sdk"
import { translate } from "../../../../i18n/translate"
import { useParams } from "react-router-dom"
import { RedemptionBatchDetailPageView } from "./detail-view"

export default function RedemptionBatchDetailPage() {
  const { id } = useParams()

  return <RedemptionBatchDetailPageView id={id!} />
}

export const handle = {
  breadcrumb: () => translate("menuItems.redemptions"),
}
