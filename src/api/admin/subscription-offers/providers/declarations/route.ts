import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import type { NativeDeclaration } from "@mengyyy369/medusa-payment-methods"
import type { GetAdminSubscriptionOfferProviderDeclarationsSchemaType } from "../../validators"
import type { PlanOfferAdminProviderDeclaration } from "../../../../../admin/types/plan-offer"
import {
  nativeCapabilities,
  resolveProviderCapabilities,
} from "../../../../../modules/subscription/utils/provider-capabilities"

type ProductVariantRecord = {
  id: string
  title: string | null
  metadata: Record<string, unknown> | null
  product_id: string | null
}

/**
 * The provider-side declarations of a product's variants, for the offer form's
 * read-only native card.
 *
 * The browser must not parse provider metadata (the old display did, and the
 * key was PayPal's): every native-capable provider is asked through the
 * capability view, and only the providers that recognise a variant answer.
 * A provider that throws is skipped — one broken provider must not blank the
 * card — and a product with no variants (or a deployment with no native rail)
 * is an empty list, never an error.
 */
export const GET = async (
  req: AuthenticatedMedusaRequest<
    unknown,
    GetAdminSubscriptionOfferProviderDeclarationsSchemaType
  >,
  res: MedusaResponse
) => {
  const productId = req.validatedQuery.product_id
  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)

  const { data } = await query.graph({
    entity: "product_variant",
    fields: ["id", "title", "metadata", "product_id"],
    filters: { product_id: productId },
  })

  const variants = (data ?? []) as ProductVariantRecord[]

  if (!variants.length) {
    return res.status(200).json({ declarations: [] })
  }

  const providers = nativeCapabilities(
    await resolveProviderCapabilities(req.scope)
  )

  const declarations: PlanOfferAdminProviderDeclaration[] = []

  for (const variant of variants) {
    for (const provider of providers) {
      let declaration: NativeDeclaration | null = null

      try {
        declaration = provider.native.readVariantDeclaration(
          variant.metadata ?? null
        )
      } catch {
        // The payment-methods plugin wraps provider failures; here one bad
        // provider only costs its own rows.
        continue
      }

      if (!declaration) {
        continue
      }

      declarations.push({
        product_id: variant.product_id ?? productId,
        variant_id: variant.id,
        variant_title: variant.title ?? null,
        provider_id: provider.provider_id,
        kind: provider.kind,
        display_name: provider.display_name,
        fields: declaration.fields.map((field) => ({
          key: field.key,
          label: field.label,
          value: field.value,
        })),
      })
    }
  }

  res.status(200).json({ declarations })
}
