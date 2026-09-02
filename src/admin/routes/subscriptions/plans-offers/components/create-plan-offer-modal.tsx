import { zodResolver } from "@hookform/resolvers/zod"
import { HttpTypes } from "@medusajs/framework/types"
import { Plus, Trash } from "@medusajs/icons"
import {
  Button,
  FocusModal,
  Heading,
  Input,
  Label,
  Select,
  Switch,
  Text,
  toast,
  usePrompt,
} from "@medusajs/ui"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { useFieldArray, useForm, Controller } from "react-hook-form"
import { z } from "zod"
import { sdk } from "../../../../lib/client"
import {
  CreatePlanOfferAdminRequest,
  PlanOfferAdminDetailResponse,
  PlanOfferDiscountType,
  PlanOfferFrequencyInterval,
  PlanOfferScope,
} from "../../../../types/plan-offer"
import { adminPlanOffersQueryKeys } from "../data-loading"
import {
  PlanOfferProductPickerModal,
  PlanOfferVariantPickerModal,
} from "./selection-modals"

const frequencyRowSchema = z.object({
  interval: z.nativeEnum(PlanOfferFrequencyInterval),
  value: z.number().int().positive(),
  has_discount: z.boolean(),
  discount_type: z.nativeEnum(PlanOfferDiscountType),
  discount_value: z.number().positive().nullable(),
})

const createPlanOfferSchema = z
  .object({
    name: z.string().trim().min(1).max(255),
    scope: z.nativeEnum(PlanOfferScope),
    product_id: z.string().trim().min(1),
    product_title: z.string().trim().min(1),
    variant_id: z.string().trim().optional().nullable(),
    variant_title: z.string().trim().optional().nullable(),
    is_enabled: z.boolean(),
    minimum_cycles: z.number().int().positive().nullable(),
    trial_enabled: z.boolean(),
    trial_days: z.number().int().nullable(),
    stacking_policy: z.enum([
      "allowed",
      "disallow_all",
      "disallow_subscription_discounts",
    ]),
    frequency_rows: z.array(frequencyRowSchema).min(1),
  })
  .superRefine((values, ctx) => {
    if (values.scope === PlanOfferScope.VARIANT && !values.variant_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "planOffers.validation.selectVariant",
        path: ["variant_id"],
      })
    }

    const seen = new Set<string>()

    values.frequency_rows.forEach((row, index) => {
      const key = `${row.interval}:${row.value}`

      if (seen.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "planOffers.validation.frequencyUnique",
          path: ["frequency_rows", index, "value"],
        })
      }

      seen.add(key)

      if (row.has_discount && row.discount_value === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "planOffers.validation.discountValueRequired",
          path: ["frequency_rows", index, "discount_value"],
        })
      }
    })

    if (values.trial_enabled && values.trial_days === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "planOffers.validation.trialDaysRequired",
        path: ["trial_days"],
      })
    }

    if (
      values.trial_enabled &&
      values.trial_days !== null &&
      values.trial_days <= 0
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "planOffers.validation.trialDaysPositive",
        path: ["trial_days"],
      })
    }
  })

type CreatePlanOfferFormValues = z.infer<typeof createPlanOfferSchema>

type CreatePlanOfferModalProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
}

const defaultValues: CreatePlanOfferFormValues = {
  name: "",
  scope: PlanOfferScope.PRODUCT,
  product_id: "",
  product_title: "",
  variant_id: null,
  variant_title: null,
  is_enabled: true,
  minimum_cycles: null,
  trial_enabled: false,
  trial_days: null,
  stacking_policy: "allowed",
  frequency_rows: [
    {
      interval: PlanOfferFrequencyInterval.MONTH,
      value: 1,
      has_discount: false,
      discount_type: PlanOfferDiscountType.PERCENTAGE,
      discount_value: null,
    },
  ],
}

export const CreatePlanOfferModal = ({
  open,
  onOpenChange,
}: CreatePlanOfferModalProps) => {
  const { t } = useTranslation("reorder")
  const queryClient = useQueryClient()
  const prompt = usePrompt()
  const [productPickerOpen, setProductPickerOpen] = useState(false)
  const [variantPickerOpen, setVariantPickerOpen] = useState(false)

  const form = useForm<CreatePlanOfferFormValues>({
    resolver: zodResolver(createPlanOfferSchema),
    defaultValues,
  })

  const { fields, append, remove } = useFieldArray({
    control: form.control,
    name: "frequency_rows",
  })

  const scope = form.watch("scope")
  const productId = form.watch("product_id")
  const productTitle = form.watch("product_title")
  const variantId = form.watch("variant_id")
  const variantTitle = form.watch("variant_title")
  const trialEnabled = form.watch("trial_enabled")

  useEffect(() => {
    if (trialEnabled) {
      return
    }

    form.setValue("trial_days", null, {
      shouldValidate: false,
      shouldDirty: true,
    })
    form.clearErrors("trial_days")
  }, [form, trialEnabled])

  useEffect(() => {
    if (open) {
      return
    }

    form.reset(defaultValues)
    setProductPickerOpen(false)
    setVariantPickerOpen(false)
  }, [form, open])

  const createMutation = useMutation({
    mutationFn: async (payload: CreatePlanOfferAdminRequest) =>
      sdk.client.fetch<PlanOfferAdminDetailResponse>("/admin/subscription-offers", {
        method: "POST",
        body: payload,
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: adminPlanOffersQueryKeys.all,
      })
      toast.success(t("planOffers.toast.created"))
      form.reset(defaultValues)
      onOpenChange(false)
    },
    onError: (error) => {
      toast.error(
        error instanceof Error
          ? error.message
          : t("planOffers.errors.createFailed")
      )
    },
  })

  const handleSubmit = form.handleSubmit((values) => {
    const payload: CreatePlanOfferAdminRequest = {
      name: values.name,
      scope: values.scope,
      product_id: values.product_id,
      variant_id:
        values.scope === PlanOfferScope.VARIANT ? values.variant_id ?? null : null,
      is_enabled: values.is_enabled,
      allowed_frequencies: values.frequency_rows.map((row) => ({
        interval: row.interval,
        value: row.value,
      })),
      discounts: values.frequency_rows
        .filter((row) => row.has_discount && row.discount_value !== null)
        .map((row) => ({
          interval: row.interval,
          frequency_value: row.value,
          type: row.discount_type,
          value: row.discount_value!,
        })),
      rules: {
        minimum_cycles: values.minimum_cycles,
        trial_enabled: values.trial_enabled,
        trial_days: values.trial_enabled ? values.trial_days : null,
        stacking_policy: values.stacking_policy,
      },
    }

    createMutation.mutate(payload)
  })

  const handleRemoveFrequency = async (index: number) => {
    if (fields.length === 1) {
      return
    }

    const confirmed = await prompt({
      title: t("planOffers.prompt.removeFrequencyTitle"),
      description: t("planOffers.prompt.removeFrequencyDescription"),
      confirmText: t("planOffers.prompt.remove"),
      cancelText: t("common.actions.cancel"),
    })

    if (!confirmed) {
      return
    }

    remove(index)
  }

  return (
    <>
      <PlanOfferProductPickerModal
        open={productPickerOpen}
        onOpenChange={setProductPickerOpen}
        selectedProductId={productId || undefined}
        onSelect={(product: HttpTypes.AdminProduct) => {
          form.setValue("product_id", product.id, { shouldValidate: true })
          form.setValue("product_title", product.title, { shouldValidate: true })
          form.setValue("variant_id", null)
          form.setValue("variant_title", null)
        }}
      />
      <PlanOfferVariantPickerModal
        open={variantPickerOpen}
        onOpenChange={setVariantPickerOpen}
        productId={productId || undefined}
        productTitle={productTitle || undefined}
        selectedVariantId={variantId || undefined}
        onSelect={(variant: HttpTypes.AdminProductVariant) => {
          form.setValue("variant_id", variant.id, { shouldValidate: true })
          form.setValue("variant_title", variant.title, { shouldValidate: true })
        }}
      />
      <FocusModal open={open} onOpenChange={onOpenChange}>
        <FocusModal.Content>
          <form
            onSubmit={handleSubmit}
            className="flex h-full flex-col overflow-hidden"
          >
            <FocusModal.Header>
              <div className="flex items-center justify-end gap-x-2">
                <FocusModal.Close asChild>
                  <Button
                    size="small"
                    variant="secondary"
                    disabled={createMutation.isPending}
                  >
                    {t("common.actions.cancel")}
                  </Button>
                </FocusModal.Close>
                <Button
                  type="submit"
                  size="small"
                  isLoading={createMutation.isPending}
                >
                  {t("planOffers.actions.create")}
                </Button>
              </div>
            </FocusModal.Header>
            <FocusModal.Body className="flex-1 overflow-y-auto">
              <div className="flex flex-1 flex-col items-center overflow-y-auto">
                <div className="mx-auto flex w-full max-w-[720px] flex-col gap-y-8 px-2 py-16">
                  <div className="flex flex-col gap-y-1">
                    <Heading>{t("planOffers.form.createTitle")}</Heading>
                    <Text
                      size="small"
                      leading="compact"
                      className="text-ui-fg-subtle"
                    >
                      {t("planOffers.form.createDescription")}
                    </Text>
                  </div>

                  <div className="grid gap-4">
                    <div className="grid gap-2">
                      <Label htmlFor="create-name">{t("planOffers.form.name")}</Label>
                      <Input id="create-name" {...form.register("name")} />
                      <FieldError message={form.formState.errors.name?.message} />
                    </div>

                    <div className="grid gap-2">
                      <Label htmlFor="create-scope">{t("planOffers.form.scope")}</Label>
                      <Controller
                        control={form.control}
                        name="scope"
                        render={({ field }) => (
                          <Select
                            value={field.value}
                            onValueChange={(value) => {
                              field.onChange(value)
                              if (value === PlanOfferScope.PRODUCT) {
                                form.setValue("variant_id", null)
                                form.setValue("variant_title", null)
                              }
                            }}
                          >
                            <Select.Trigger id="create-scope">
                              <Select.Value />
                            </Select.Trigger>
                            <Select.Content>
                              <Select.Item value={PlanOfferScope.PRODUCT}>
                                {t("planOffers.scope.product")}
                              </Select.Item>
                              <Select.Item value={PlanOfferScope.VARIANT}>
                                {t("planOffers.scope.variant")}
                              </Select.Item>
                            </Select.Content>
                          </Select>
                        )}
                      />
                    </div>

                    <div className="grid gap-3 rounded-lg border border-ui-border-base p-4">
                      <div className="flex items-center justify-between">
                        <div className="flex flex-col">
                          <Text size="small" leading="compact" weight="plus">
                            {t("common.fields.product")}
                          </Text>
                          <Text
                            size="small"
                            leading="compact"
                            className="text-ui-fg-subtle"
                          >
                            {productTitle || t("planOffers.form.noProductSelected")}
                          </Text>
                        </div>
                        <Button
                          type="button"
                          size="small"
                          variant="secondary"
                          onClick={() => setProductPickerOpen(true)}
                        >
                          {productId
                            ? t("planOffers.form.change")
                            : t("planOffers.form.select")}
                        </Button>
                      </div>
                      <FieldError
                        message={
                          form.formState.errors.product_id?.message ||
                          form.formState.errors.product_title?.message
                        }
                      />
                    </div>

                    {scope === PlanOfferScope.VARIANT ? (
                      <div className="grid gap-3 rounded-lg border border-ui-border-base p-4">
                        <div className="flex items-center justify-between">
                          <div className="flex flex-col">
                            <Text size="small" leading="compact" weight="plus">
                              {t("common.fields.variant")}
                            </Text>
                            <Text
                              size="small"
                              leading="compact"
                              className="text-ui-fg-subtle"
                            >
                              {variantTitle ||
                                t("planOffers.form.noVariantSelected")}
                            </Text>
                          </div>
                          <Button
                            type="button"
                            size="small"
                            variant="secondary"
                            disabled={!productId}
                            onClick={() => setVariantPickerOpen(true)}
                          >
                            {variantId
                              ? t("planOffers.form.change")
                              : t("planOffers.form.select")}
                          </Button>
                        </div>
                        <FieldError message={form.formState.errors.variant_id?.message} />
                      </div>
                    ) : null}

                    <div className="grid gap-2">
                      <div className="flex items-center justify-between rounded-lg border border-ui-border-base px-4 py-3">
                        <div className="flex flex-col">
                          <Text size="small" leading="compact" weight="plus">
                            {t("planOffers.form.offerEnabled")}
                          </Text>
                          <Text
                            size="small"
                            leading="compact"
                            className="text-ui-fg-subtle"
                          >
                            {t("planOffers.form.offerEnabledHint")}
                          </Text>
                        </div>
                        <Controller
                          control={form.control}
                          name="is_enabled"
                          render={({ field }) => (
                            <Switch
                              checked={field.value}
                              onCheckedChange={field.onChange}
                            />
                          )}
                        />
                      </div>
                    </div>

                    <div className="grid gap-4 rounded-lg border border-ui-border-base p-4">
                      <div className="flex flex-col gap-y-1">
                        <Heading level="h2">{t("planOffers.form.offerRules")}</Heading>
                        <Text
                          size="small"
                          leading="compact"
                          className="text-ui-fg-subtle"
                        >
                          {t("planOffers.form.offerRulesHint")}
                        </Text>
                      </div>

                      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                        <div className="grid gap-2">
                          <Label htmlFor="minimum-cycles">
                            {t("planOffers.form.minimumCycles")}
                          </Label>
                          <Input
                            id="minimum-cycles"
                            type="number"
                            min={1}
                            step={1}
                            {...form.register("minimum_cycles", {
                              setValueAs: (value) =>
                                value === "" ? null : Number(value),
                            })}
                          />
                          <Text
                            size="small"
                            leading="compact"
                            className="text-ui-fg-subtle"
                          >
                            {t("planOffers.form.minimumCyclesHint")}
                          </Text>
                          <FieldError
                            message={form.formState.errors.minimum_cycles?.message}
                          />
                        </div>
                        <div className="grid gap-2">
                          <Label htmlFor="stacking-policy">
                            {t("planOffers.form.stackingPolicy")}
                          </Label>
                          <Controller
                            control={form.control}
                            name="stacking_policy"
                            render={({ field }) => (
                              <Select
                                value={field.value}
                                onValueChange={field.onChange}
                              >
                                <Select.Trigger id="stacking-policy">
                                  <Select.Value />
                                </Select.Trigger>
                                <Select.Content>
                                  <Select.Item value="allowed">
                                    {t("planOffers.form.stackingAllowed")}
                                  </Select.Item>
                                  <Select.Item value="disallow_all">
                                    {t("planOffers.form.stackingDisallowAll")}
                                  </Select.Item>
                                  <Select.Item value="disallow_subscription_discounts">
                                    {t(
                                      "planOffers.form.stackingDisallowSubscriptionDiscounts"
                                    )}
                                  </Select.Item>
                                </Select.Content>
                              </Select>
                            )}
                          />
                          <Text
                            size="small"
                            leading="compact"
                            className="text-ui-fg-subtle"
                          >
                            {t("planOffers.form.stackingPolicyHint")}
                          </Text>
                        </div>
                      </div>

                      <div className="grid gap-3">
                        <div className="flex items-center justify-between rounded-lg border border-ui-border-base px-4 py-3">
                        <div className="flex flex-col">
                          <Text size="small" leading="compact" weight="plus">
                            {t("planOffers.form.trialEnabled")}
                          </Text>
                          <Text
                            size="small"
                            leading="compact"
                            className="text-ui-fg-subtle"
                          >
                            {t("planOffers.form.trialEnabledHint")}
                          </Text>
                        </div>
                          <Controller
                            control={form.control}
                            name="trial_enabled"
                            render={({ field }) => (
                              <Switch
                                checked={field.value}
                                onCheckedChange={(checked) => {
                                  field.onChange(checked)

                                  if (!checked) {
                                    form.setValue("trial_days", null, {
                                      shouldValidate: true,
                                    })
                                  }
                                }}
                              />
                            )}
                          />
                        </div>

                        <div className="grid gap-2">
                          <Label htmlFor="trial-days">
                            {t("planOffers.form.trialDays")}
                          </Label>
                          <Input
                            id="trial-days"
                            type="number"
                            min={1}
                            step={1}
                            disabled={!trialEnabled}
                            {...form.register("trial_days", {
                              setValueAs: (value) => {
                                if (value === "" || value === undefined) {
                                  return null
                                }

                                const parsed = Number(value)

                                return Number.isNaN(parsed) ? null : parsed
                              },
                            })}
                          />
                          <FieldError
                            message={form.formState.errors.trial_days?.message}
                          />
                        </div>
                      </div>
                    </div>

                    <div className="grid gap-4">
                      <div className="flex items-center justify-between">
                        <div className="flex flex-col">
                          <Heading level="h2">
                            {t("planOffers.form.frequencies")}
                          </Heading>
                          <Text
                            size="small"
                            leading="compact"
                            className="text-ui-fg-subtle"
                          >
                            {t("planOffers.form.frequenciesHint")}
                          </Text>
                        </div>
                        <Button
                          type="button"
                          size="small"
                          variant="secondary"
                          onClick={() =>
                            append({
                              interval: PlanOfferFrequencyInterval.MONTH,
                              value: 1,
                              has_discount: false,
                              discount_type: PlanOfferDiscountType.PERCENTAGE,
                              discount_value: null,
                            })
                          }
                        >
                          <Plus />
                          {t("planOffers.form.addFrequency")}
                        </Button>
                      </div>

                      <div className="grid gap-4">
                        {fields.map((field, index) => (
                          <div
                            key={field.id}
                            className="grid gap-4 rounded-lg border border-ui-border-base p-4"
                          >
                            <div className="grid grid-cols-1 gap-4 md:grid-cols-[1fr_140px_auto]">
                              <div className="grid gap-2">
                                <Label>{t("planOffers.form.interval")}</Label>
                                <Controller
                                  control={form.control}
                                  name={`frequency_rows.${index}.interval`}
                                  render={({ field: controllerField }) => (
                                    <Select
                                      value={controllerField.value}
                                      onValueChange={controllerField.onChange}
                                    >
                                      <Select.Trigger>
                                        <Select.Value />
                                      </Select.Trigger>
                                      <Select.Content>
                                        <Select.Item value={PlanOfferFrequencyInterval.WEEK}>
                                          {t("common.intervals.week")}
                                        </Select.Item>
                                        <Select.Item value={PlanOfferFrequencyInterval.MONTH}>
                                          {t("common.intervals.month")}
                                        </Select.Item>
                                        <Select.Item value={PlanOfferFrequencyInterval.YEAR}>
                                          {t("common.intervals.year")}
                                        </Select.Item>
                                      </Select.Content>
                                    </Select>
                                  )}
                                />
                              </div>
                              <div className="grid gap-2">
                                <Label>{t("planOffers.form.value")}</Label>
                                <Input
                                  type="number"
                                  min={1}
                                  step={1}
                                  {...form.register(`frequency_rows.${index}.value`, {
                                    valueAsNumber: true,
                                  })}
                                />
                              </div>
                              <div className="flex items-end">
                                <Button
                                  type="button"
                                  size="small"
                                  variant="secondary"
                                  disabled={fields.length === 1}
                                  onClick={() => {
                                    void handleRemoveFrequency(index)
                                  }}
                                >
                                  <Trash />
                                </Button>
                              </div>
                            </div>

                            <div className="grid gap-3">
                              <div className="flex items-center justify-between rounded-lg border border-ui-border-base px-4 py-3">
                                <div className="flex flex-col">
                                  <Text size="small" leading="compact" weight="plus">
                                    {t("planOffers.form.discountForFrequency")}
                                  </Text>
                                  <Text
                                    size="small"
                                    leading="compact"
                                    className="text-ui-fg-subtle"
                                  >
                                    {t("planOffers.form.discountForFrequencyHint")}
                                  </Text>
                                </div>
                                <Controller
                                  control={form.control}
                                  name={`frequency_rows.${index}.has_discount`}
                                  render={({ field: controllerField }) => (
                                    <Switch
                                      checked={controllerField.value}
                                      onCheckedChange={controllerField.onChange}
                                    />
                                  )}
                                />
                              </div>

                              {form.watch(`frequency_rows.${index}.has_discount`) ? (
                                <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                                  <div className="grid gap-2">
                                    <Label>{t("planOffers.form.discountType")}</Label>
                                    <Controller
                                      control={form.control}
                                      name={`frequency_rows.${index}.discount_type`}
                                      render={({ field: controllerField }) => (
                                        <Select
                                          value={controllerField.value}
                                          onValueChange={controllerField.onChange}
                                        >
                                          <Select.Trigger>
                                            <Select.Value />
                                          </Select.Trigger>
                                          <Select.Content>
                                            <Select.Item
                                              value={PlanOfferDiscountType.PERCENTAGE}
                                            >
                                              {t("planOffers.form.percentage")}
                                            </Select.Item>
                                            <Select.Item
                                              value={PlanOfferDiscountType.FIXED}
                                            >
                                              {t("planOffers.form.fixed")}
                                            </Select.Item>
                                          </Select.Content>
                                        </Select>
                                      )}
                                    />
                                  </div>
                                  <div className="grid gap-2">
                                    <Label>{t("planOffers.form.discountValue")}</Label>
                                    <Input
                                      type="number"
                                      min={0}
                                      step={0.01}
                                      {...form.register(
                                        `frequency_rows.${index}.discount_value`,
                                        {
                                          setValueAs: (value) =>
                                            value === "" ? null : Number(value),
                                        }
                                      )}
                                    />
                                  </div>
                                </div>
                              ) : null}
                            </div>

                            <FieldError
                              message={
                                form.formState.errors.frequency_rows?.[index]?.value
                                  ?.message ||
                                form.formState.errors.frequency_rows?.[index]?.discount_value
                                  ?.message
                              }
                            />
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </FocusModal.Body>
          </form>
        </FocusModal.Content>
      </FocusModal>
    </>
  )
}

const FieldError = ({ message }: { message?: string }) => {
  const { t } = useTranslation("reorder")

  if (!message) {
    return null
  }

  return (
    <Text size="small" leading="compact" className="text-ui-fg-error">
      {t(message)}
    </Text>
  )
}
