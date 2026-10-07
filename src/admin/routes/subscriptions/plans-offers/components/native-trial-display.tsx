import { Container, Text } from "@medusajs/ui"
import { useTranslation } from "react-i18next"
import type { PlanOfferAdminProviderDeclaration } from "../../../../types/plan-offer"
import { useAdminProviderDeclarationsQuery } from "../data-loading"

/**
 * Read-only display of the native rail's own facts, beside the offer's trial
 * inputs.
 *
 * The facts come from the providers through the capability view — the browser
 * no longer parses a provider's metadata key itself. Every native-capable
 * provider that recognises a variant contributes a card titled with its own
 * display name, and field labels prefer the admin's own wording over the
 * descriptor's fallback.
 */
export const NativeTrialVariantDisplay = ({
  productId,
}: {
  productId?: string | null
}) => {
  const { t } = useTranslation("reorder")
  const { data } = useAdminProviderDeclarationsQuery(productId)

  const declarations = data?.declarations ?? []

  if (!declarations.length) {
    return null
  }

  const byProvider = new Map<string, PlanOfferAdminProviderDeclaration[]>()

  for (const declaration of declarations) {
    const group = byProvider.get(declaration.provider_id) ?? []

    group.push(declaration)
    byProvider.set(declaration.provider_id, group)
  }

  return (
    <>
      {Array.from(byProvider.values()).map((group) => {
        const provider = group[0]

        return (
          <Container
            key={provider.provider_id}
            className="divide-y divide-ui-border-base p-0"
          >
            <div className="px-6 py-4">
              <Text size="small" leading="compact" weight="plus">
                {t("planOffers.form.nativeTrialTitle", {
                  provider: provider.display_name,
                })}
              </Text>
              <Text
                size="small"
                leading="compact"
                className="text-ui-fg-subtle"
              >
                {t("planOffers.form.nativeTrialHint", {
                  provider: provider.display_name,
                })}
              </Text>
            </div>
            {group.map((declaration) => (
              <div
                key={declaration.variant_id}
                className="grid gap-2 px-6 py-3"
              >
                <Text size="small" leading="compact" weight="plus">
                  {declaration.variant_title ?? declaration.variant_id}
                </Text>
                <div className="grid gap-1">
                  {declaration.fields.map((field) => (
                    <div
                      key={field.key}
                      className="grid grid-cols-3 gap-3 text-ui-fg-subtle"
                    >
                      <Text size="small" leading="compact">
                        {t(`planOffers.form.nativeField.${field.key}`, {
                          defaultValue: field.label,
                        })}
                      </Text>
                      <Text
                        size="small"
                        leading="compact"
                        className="col-span-2"
                      >
                        {field.value ?? t("common.empty.noValue")}
                      </Text>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </Container>
        )
      })}
    </>
  )
}
