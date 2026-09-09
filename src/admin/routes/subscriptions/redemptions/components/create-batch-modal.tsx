import { zodResolver } from "@hookform/resolvers/zod"
import { Plus, Trash } from "@medusajs/icons"
import {
  Button,
  Container,
  FocusModal,
  Heading,
  Input,
  Label,
  Select,
  Switch,
  Text,
  toast,
} from "@medusajs/ui"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { useFieldArray, useForm, Controller } from "react-hook-form"
import { z } from "zod"
import { sdk } from "../../../../lib/client"
import {
  AdminRedemptionBatchDetailResponse,
  CreateRedemptionBatchAdminRequest,
  RedemptionFrequencyInterval,
} from "../../../../types/redemption"
import { adminRedemptionsQueryKeys } from "../data-loading"
import {
  PlanOfferProductPickerModal,
  PlanOfferVariantPickerModal,
} from "../../plans-offers/components/selection-modals"

const customCodeSchema = z
  .string()
  .trim()
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9-]*[A-Za-z0-9]$/,
    "redemptions.validation.customCodeFormat"
  )

const createBatchSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    variant_id: z.string().trim().min(1),
    variant_title: z.string().trim().optional(),
    frequency_interval: z.enum(RedemptionFrequencyInterval),
    frequency_value: z.number().int().positive(),
    free_cycles: z.number().int().positive(),
    code_prefix: z
      .string()
      .trim()
      .regex(/^[A-Z0-9]{1,8}$/i, "redemptions.validation.codePrefixFormat")
      .optional(),
    max_redemptions_per_code: z.number().int().positive(),
    has_window: z.boolean(),
    starts_at: z.string().trim().optional(),
    expires_at: z.string().trim().optional(),
    generated_code_count: z.number().int().min(0).max(10000),
    custom_codes: z.array(customCodeSchema).max(10000),
  })
  .superRefine((values, ctx) => {
    if (values.generated_code_count + values.custom_codes.length === 0) {
      ctx.addIssue({
        code: "custom",
        message: "redemptions.validation.atLeastOneCode",
        path: ["generated_code_count"],
      })
    }

    if (
      values.has_window &&
      values.starts_at &&
      values.expires_at &&
      values.starts_at >= values.expires_at
    ) {
      ctx.addIssue({
        code: "custom",
        message: "redemptions.validation.windowOrder",
        path: ["starts_at"],
      })
    }
  })

type CreateBatchFormValues = z.infer<typeof createBatchSchema>

type CreateBatchModalProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
}

const defaultValues: CreateBatchFormValues = {
  name: "",
  variant_id: "",
  variant_title: undefined,
  frequency_interval: RedemptionFrequencyInterval.MONTH,
  frequency_value: 1,
  free_cycles: 1,
  code_prefix: "RDM",
  max_redemptions_per_code: 1,
  has_window: false,
  starts_at: "",
  expires_at: "",
  generated_code_count: 10,
  custom_codes: [],
}

export const CreateBatchModal = ({ open, onOpenChange }: CreateBatchModalProps) => {
  const { t } = useTranslation("reorder")
  const queryClient = useQueryClient()
  const [productPickerOpen, setProductPickerOpen] = useState(false)
  const [variantPickerOpen, setVariantPickerOpen] = useState(false)
  const [selectedProductId, setSelectedProductId] = useState<string | null>(
    null
  )

  const form = useForm<CreateBatchFormValues>({
    resolver: zodResolver(createBatchSchema),
    defaultValues,
  })

  const { fields, append, remove } = useFieldArray({
    control: form.control,
    name: "custom_codes",
  })

  const productId = form.watch("variant_id")
  const hasWindow = form.watch("has_window")

  useEffect(() => {
    if (open) {
      return
    }
    form.reset(defaultValues)
    setSelectedProductId(null)
    setProductPickerOpen(false)
    setVariantPickerOpen(false)
  }, [form, open])

  const createMutation = useMutation({
    mutationFn: async (payload: CreateRedemptionBatchAdminRequest) =>
      sdk.client.fetch<AdminRedemptionBatchDetailResponse>(
        "/admin/redemptions/batches",
        {
          method: "POST",
          body: payload,
        }
      ),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: adminRedemptionsQueryKeys.all,
      })
      toast.success(t("redemptions.toast.created"))
      form.reset(defaultValues)
      onOpenChange(false)
    },
    onError: (error) => {
      toast.error(
        error instanceof Error ? error.message : t("redemptions.errors.createFailed")
      )
    },
  })

  const handleSubmit = form.handleSubmit((values) => {
    const payload: CreateRedemptionBatchAdminRequest = {
      name: values.name,
      variant_id: values.variant_id,
      frequency_interval: values.frequency_interval,
      frequency_value: values.frequency_value,
      free_cycles: values.free_cycles,
      code_prefix: values.code_prefix || undefined,
      max_redemptions_per_code: values.max_redemptions_per_code,
      starts_at: values.has_window && values.starts_at
        ? new Date(values.starts_at).toISOString()
        : null,
      expires_at: values.has_window && values.expires_at
        ? new Date(values.expires_at).toISOString()
        : null,
      generated_code_count: values.generated_code_count,
      custom_codes: values.custom_codes,
    }

    createMutation.mutate(payload)
  })

  return (
    <FocusModal open={open} onOpenChange={onOpenChange}>
      <FocusModal.Content>
        <FocusModal.Header>
          <Button
            type="submit"
            form="create-redemption-batch-form"
            isLoading={createMutation.isPending}
          >
            {t("redemptions.actions.create")}
          </Button>
        </FocusModal.Header>
        <FocusModal.Body>
          <form
            id="create-redemption-batch-form"
            onSubmit={handleSubmit}
            className="mx-auto flex w-full max-w-[720px] flex-col gap-y-8 py-10"
          >
            <div className="flex flex-col gap-y-4">
              <Heading>{t("redemptions.create.title")}</Heading>
              <Text size="small" className="text-ui-fg-subtle">
                {t("redemptions.create.description")}
              </Text>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="flex flex-col gap-y-2">
                <Label htmlFor="batch-name" weight="plus">
                  {t("redemptions.fields.name")}
                </Label>
                <Input
                  id="batch-name"
                  {...form.register("name")}
                  placeholder={t("redemptions.placeholders.batchName")}
                />
                {form.formState.errors.name ? (
                  <Text size="small" className="text-ui-fg-error">
                    {t("redemptions.errors.required")}
                  </Text>
                ) : null}
              </div>

              <div className="flex flex-col gap-y-2">
                <Label weight="plus">{t("common.fields.variant")}</Label>
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => setProductPickerOpen(true)}
                >
                  {productId
                    ? form.watch("variant_title") || productId
                    : t("redemptions.actions.selectVariant")}
                </Button>
                {form.formState.errors.variant_id ? (
                  <Text size="small" className="text-ui-fg-error">
                    {t("redemptions.validation.selectVariant")}
                  </Text>
                ) : null}
              </div>

              <div className="flex flex-col gap-y-2">
                <Label htmlFor="batch-interval" weight="plus">
                  {t("common.fields.interval")}
                </Label>
                <Controller
                  control={form.control}
                  name="frequency_interval"
                  render={({ field }) => (
                    <Select onValueChange={field.onChange} value={field.value}>
                      <Select.Trigger ref={field.ref}>
                        <Select.Value />
                      </Select.Trigger>
                      <Select.Content>
                        {Object.values(RedemptionFrequencyInterval).map(
                          (interval) => (
                            <Select.Item key={interval} value={interval}>
                              {t(`common.intervals.${interval}`)}
                            </Select.Item>
                          )
                        )}
                      </Select.Content>
                    </Select>
                  )}
                />
              </div>

              <div className="flex flex-col gap-y-2">
                <Label htmlFor="batch-frequency-value" weight="plus">
                  {t("redemptions.fields.frequencyValue")}
                </Label>
                <Input
                  id="batch-frequency-value"
                  type="number"
                  min={1}
                  {...form.register("frequency_value", { valueAsNumber: true })}
                />
              </div>

              <div className="flex flex-col gap-y-2">
                <Label htmlFor="batch-free-cycles" weight="plus">
                  {t("redemptions.fields.freeCycles")}
                </Label>
                <Input
                  id="batch-free-cycles"
                  type="number"
                  min={1}
                  {...form.register("free_cycles", { valueAsNumber: true })}
                />
              </div>

              <div className="flex flex-col gap-y-2">
                <Label htmlFor="batch-max-redemptions" weight="plus">
                  {t("redemptions.fields.maxRedemptionsPerCode")}
                </Label>
                <Input
                  id="batch-max-redemptions"
                  type="number"
                  min={1}
                  {...form.register("max_redemptions_per_code", {
                    valueAsNumber: true,
                  })}
                />
              </div>

              <div className="flex flex-col gap-y-2">
                <Label htmlFor="batch-prefix" weight="plus">
                  {t("redemptions.fields.codePrefix")}
                </Label>
                <Input id="batch-prefix" {...form.register("code_prefix")} />
              </div>

              <div className="flex flex-col gap-y-2">
                <Label htmlFor="batch-generated-count" weight="plus">
                  {t("redemptions.fields.generatedCodeCount")}
                </Label>
                <Input
                  id="batch-generated-count"
                  type="number"
                  min={0}
                  {...form.register("generated_code_count", {
                    valueAsNumber: true,
                  })}
                />
              </div>
            </div>

            <div className="flex flex-col gap-y-4">
              <div className="flex items-center justify-between">
                <div className="flex flex-col">
                  <Label weight="plus" htmlFor="batch-has-window">
                    {t("redemptions.fields.validityWindow")}
                  </Label>
                  <Text size="small" className="text-ui-fg-subtle">
                    {t("redemptions.fields.validityWindowHint")}
                  </Text>
                </div>
                <Controller
                  control={form.control}
                  name="has_window"
                  render={({ field }) => (
                    <Switch
                      id="batch-has-window"
                      checked={field.value}
                      onCheckedChange={field.onChange}
                    />
                  )}
                />
              </div>

              {hasWindow ? (
                <div className="grid grid-cols-2 gap-4">
                  <div className="flex flex-col gap-y-2">
                    <Label htmlFor="batch-starts-at" weight="plus">
                      {t("redemptions.fields.startsAt")}
                    </Label>
                    <Input id="batch-starts-at" type="date" {...form.register("starts_at")} />
                  </div>
                  <div className="flex flex-col gap-y-2">
                    <Label htmlFor="batch-expires-at" weight="plus">
                      {t("redemptions.fields.expiresAt")}
                    </Label>
                    <Input id="batch-expires-at" type="date" {...form.register("expires_at")} />
                  </div>
                </div>
              ) : null}
            </div>

            <div className="flex flex-col gap-y-4">
              <div className="flex items-center justify-between">
                <div className="flex flex-col">
                  <Label weight="plus">{t("redemptions.fields.customCodes")}</Label>
                  <Text size="small" className="text-ui-fg-subtle">
                    {t("redemptions.fields.customCodesHint")}
                  </Text>
                </div>
                <Button
                  type="button"
                  variant="secondary"
                  size="small"
                  onClick={() => append("")}
                >
                  <Plus />
                  {t("redemptions.actions.addCustomCode")}
                </Button>
              </div>

              {fields.length ? (
                <div className="flex flex-col gap-y-2">
                  {fields.map((field, index) => (
                    <div key={field.id} className="flex items-center gap-x-2">
                      <Input
                        {...form.register(`custom_codes.${index}` as const)}
                        placeholder="BLACKFRIDAY2026"
                      />
                      <Button
                        type="button"
                        variant="danger"
                        size="small"
                        onClick={() => remove(index)}
                      >
                        <Trash />
                      </Button>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          </form>
        </FocusModal.Body>
      </FocusModal.Content>

      <PlanOfferProductPickerModal
        open={productPickerOpen}
        onOpenChange={setProductPickerOpen}
        selectedProductId={selectedProductId}
        onSelect={(product) => {
          setSelectedProductId(product.id)
          form.setValue("variant_id", "", { shouldValidate: false })
          form.setValue("variant_title", undefined)
          setProductPickerOpen(false)
          setVariantPickerOpen(true)
        }}
      />
      <PlanOfferVariantPickerModal
        open={variantPickerOpen}
        onOpenChange={setVariantPickerOpen}
        productId={selectedProductId}
        onSelect={(variant) => {
          form.setValue("variant_id", variant.id, { shouldValidate: true })
          form.setValue("variant_title", variant.title ?? variant.id)
          setVariantPickerOpen(false)
        }}
      />
    </FocusModal>
  )
}
