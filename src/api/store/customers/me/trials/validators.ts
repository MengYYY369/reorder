import { z } from "zod"

export const PostStoreTrialClaimSchema = z.object({
  variant_id: z.string().trim().min(1),
  region_id: z.string().trim().min(1),
  binding: z.enum(["none", "vault"]).optional(),
})

export type PostStoreTrialClaimSchemaType = z.infer<
  typeof PostStoreTrialClaimSchema
>

/**
 * The two phases of binding a payment method to a claimed trial (Phase 14):
 * `start` sends the customer to PayPal and needs the caller-owned return and
 * cancel routes; `complete` runs when the customer comes back and carries the
 * setup token id the approval is exchanged for. The URLs must be absolute —
 * PayPal redirects the buyer to them.
 */
export const PostStoreTrialBindSchema = z
  .object({
    action: z.enum(["start", "complete"]),
    return_url: z.string().trim().url().optional(),
    cancel_url: z.string().trim().url().optional(),
    setup_token_id: z.string().trim().min(1).optional(),
  })
  .refine(
    (value) =>
      value.action !== "start" ||
      (Boolean(value.return_url) && Boolean(value.cancel_url)),
    {
      message: "return_url and cancel_url are required to start the approval.",
    }
  )
  .refine(
    (value) => value.action !== "complete" || Boolean(value.setup_token_id),
    { message: "setup_token_id is required to complete the binding." }
  )

export type PostStoreTrialBindSchemaType = z.infer<
  typeof PostStoreTrialBindSchema
>
