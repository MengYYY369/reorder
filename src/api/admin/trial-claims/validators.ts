import { createFindParams } from "@medusajs/medusa/api/utils/validators"
import { z } from "@medusajs/framework/zod"

/**
 * Read-only list filters for the trial-claim ledger. `direction` is declared
 * explicitly because the Admin DataTable always sends `order` and `direction`
 * alongside `limit`/`offset`, and a validator built only with
 * `createFindParams()` rejects `direction` with a 400.
 */
export const GetAdminTrialClaimsSchema = createFindParams({
  offset: 0,
  limit: 20,
}).extend({
  customer_id: z.string().optional(),
  product_id: z.string().optional(),
  source: z.enum(["self_service", "redemption", "admin"]).optional(),
  direction: z.enum(["asc", "desc"]).optional(),
})

export type GetAdminTrialClaimsSchemaType = z.infer<
  typeof GetAdminTrialClaimsSchema
>
