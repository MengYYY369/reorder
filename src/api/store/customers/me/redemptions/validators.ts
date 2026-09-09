import { z } from "@medusajs/framework/zod"

export const PostStoreRedeemCodeSchema = z
  .object({
    code: z.string().trim().min(1).max(100),
    subscription_id: z.string().trim().min(1).optional().nullable(),
  })
  .strict()

export type PostStoreRedeemCodeSchemaType = z.infer<
  typeof PostStoreRedeemCodeSchema
>

export const PostStorePreviewRedeemCodeSchema = z
  .object({
    code: z.string().trim().min(1).max(100),
    subscription_id: z.string().trim().min(1).optional().nullable(),
  })
  .strict()

export type PostStorePreviewRedeemCodeSchemaType = z.infer<
  typeof PostStorePreviewRedeemCodeSchema
>

export const GetStoreRedemptionsSchema = z.object({}).strict()

export type GetStoreRedemptionsSchemaType = z.infer<
  typeof GetStoreRedemptionsSchema
>
