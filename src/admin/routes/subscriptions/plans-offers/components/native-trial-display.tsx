import { Container, Text } from "@medusajs/ui"
import { useTranslation } from "react-i18next"
import {
  useAdminProductVariantsMetadataQuery,
  type ProductVariantMetadataRow,
} from "../data-loading"

type NativeTrialMetadata = {
  trial_periods?: unknown
  setup_fee?: unknown
}

function readNativeTrialMetadata(
  metadata: Record<string, unknown> | null
): NativeTrialMetadata | null {
  const raw = metadata?.paypal_subscription

  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return null
  }

  return raw as NativeTrialMetadata
}

function formatTrialPeriods(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null
  }

  if (Array.isArray(value)) {
    return value
      .map((period) => {
        if (typeof period === "object" && period !== null) {
          const record = period as Record<string, unknown>
          const days = record.trial_days ?? record.trial ?? record.days

          return days !== undefined && days !== null ? String(days) : null
        }

        return String(period)
      })
      .filter((entry): entry is string => entry !== null)
      .join(", ")
  }

  return String(value)
}

/**
 * Read-only display of the native rail's own trial facts, beside the offer's
 * trial inputs. The native trial's length lives in the variant's
 * `paypal_subscription` metadata (a plan is immutable and cached by a hash
 * including `trial_periods`, so the offer must never become its source —
 * Q14), and `setup_fee` is charged at approval — hiding it while showing a
 * zero-price trial would leave the operator blind to the one field that
 * actually charges. A product-scoped offer covers every native variant of the
 * product, so all of them are listed.
 */
export const NativeTrialVariantDisplay = ({
  productId,
}: {
  productId?: string | null
}) => {
  const { t } = useTranslation("reorder")
  const { data: variants } = useAdminProductVariantsMetadataQuery(productId)

  const nativeVariants = (variants ?? []).filter(
    (variant: ProductVariantMetadataRow) =>
      readNativeTrialMetadata(variant.metadata) !== null
  )

  if (!nativeVariants.length) {
    return null
  }

  return (
    <Container className="divide-y divide-ui-border-base p-0">
      <div className="px-6 py-4">
        <Text size="small" leading="compact" weight="plus">
          {t("planOffers.form.nativeTrialTitle")}
        </Text>
        <Text size="small" leading="compact" className="text-ui-fg-subtle">
          {t("planOffers.form.nativeTrialHint")}
        </Text>
      </div>
      {nativeVariants.map((variant) => {
        const metadata = readNativeTrialMetadata(variant.metadata)!
        const trialPeriods = formatTrialPeriods(metadata.trial_periods)
        const setupFee = metadata.setup_fee

        return (
          <div
            key={variant.id}
            className="grid grid-cols-3 gap-3 px-6 py-3 text-ui-fg-subtle"
          >
            <Text size="small" leading="compact" weight="plus">
              {variant.title ?? variant.id}
            </Text>
            <Text size="small" leading="compact">
              {trialPeriods !== null
                ? t("planOffers.form.nativeTrialPeriods", {
                    value: trialPeriods,
                  })
                : t("planOffers.form.nativeTrialPeriodsMissing")}
            </Text>
            <Text size="small" leading="compact">
              {setupFee !== undefined && setupFee !== null
                ? t("planOffers.form.nativeTrialSetupFee", {
                    value: String(setupFee),
                  })
                : t("planOffers.form.nativeTrialSetupFeeMissing")}
            </Text>
          </div>
        )
      })}
    </Container>
  )
}
