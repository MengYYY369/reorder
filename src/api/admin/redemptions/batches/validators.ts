import { createFindParams } from "@medusajs/medusa/api/utils/validators"
import { z } from "@medusajs/framework/zod"

const redemptionFrequencyIntervalSchema = z.enum(["week", "month", "year"])

const customCodeSchema = z
  .string()
  .trim()
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9-]*[A-Za-z0-9]$/,
    "Custom codes must be at least two characters of letters/digits, optionally joined by hyphens"
  )

export const GetAdminRedemptionBatchesSchema = createFindParams({
  offset: 0,
  limit: 20,
}).extend({
  q: z.string().optional(),
  status: z.enum(["active", "disabled"]).optional(),
  variant_id: z.string().optional(),
  direction: z.enum(["asc", "desc"]).optional(),
})

export type GetAdminRedemptionBatchesSchemaType = z.infer<
  typeof GetAdminRedemptionBatchesSchema
>

export const GetAdminRedemptionBatchSchema = createFindParams().extend({})

export type GetAdminRedemptionBatchSchemaType = z.infer<
  typeof GetAdminRedemptionBatchSchema
>

export const PostAdminCreateRedemptionBatchSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    variant_id: z.string().trim().min(1),
    frequency_interval: redemptionFrequencyIntervalSchema,
    frequency_value: z.number().int().positive(),
    free_cycles: z.number().int().positive(),
    code_prefix: z
      .string()
      .trim()
      .regex(/^[A-Z0-9]{1,8}$/i, "code_prefix must be 1-8 letters/digits")
      .transform((value) => value.toUpperCase())
      .optional(),
    max_redemptions_per_code: z.number().int().positive().optional(),
    starts_at: z.coerce.date().optional().nullable(),
    expires_at: z.coerce.date().optional().nullable(),
    generated_code_count: z.number().int().min(0).max(10000).optional(),
    custom_codes: z.array(customCodeSchema).max(10000).optional(),
    metadata: z.record(z.string(), z.unknown()).optional().nullable(),
  })
  .superRefine((data, ctx) => {
    const generated = data.generated_code_count ?? 0
    const custom = data.custom_codes?.length ?? 0
    if (generated + custom === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "A batch requires at least one code (generated_code_count or custom_codes)",
        path: ["generated_code_count"],
      })
    }

    if (data.starts_at && data.expires_at && data.starts_at >= data.expires_at) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "'starts_at' must be before 'expires_at'",
        path: ["starts_at"],
      })
    }
  })

export type PostAdminCreateRedemptionBatchSchemaType = z.infer<
  typeof PostAdminCreateRedemptionBatchSchema
>

export const PostAdminDisableRedemptionBatchSchema = z.object({}).strict()

export type PostAdminDisableRedemptionBatchSchemaType = z.infer<
  typeof PostAdminDisableRedemptionBatchSchema
>

export const PostAdminDisableRedemptionCodeSchema = z.object({}).strict()

export type PostAdminDisableRedemptionCodeSchemaType = z.infer<
  typeof PostAdminDisableRedemptionCodeSchema
>
