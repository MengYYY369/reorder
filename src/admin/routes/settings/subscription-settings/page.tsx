import { zodResolver } from "@hookform/resolvers/zod"
import { defineRouteConfig } from "@medusajs/admin-sdk"
import { PlusMini, Trash } from "@medusajs/icons"
import {
  Alert,
  Button,
  Container,
  Heading,
  Input,
  Label,
  Select,
  Text,
  toast,
} from "@medusajs/ui"
import type { ReactNode } from "react"
import { useEffect, useMemo } from "react"
import { Controller, useFieldArray, useForm } from "react-hook-form"
import { useTranslation } from "react-i18next"
import { z } from "zod"
import type {
  AdminSubscriptionCancellationBehavior,
  AdminSubscriptionRenewalBehavior,
  SubscriptionSettingsAdminResponse,
} from "../../../types/settings"
import {
  adminSubscriptionSettingsCapabilities,
  useAdminSubscriptionSettingsUpdateMutation,
  useAdminSubscriptionSettingsQuery,
} from "./data-loading"

const settingsSchema = z
  .object({
    default_trial_days: z.number().int().min(0),
    dunning_retry_intervals: z
      .array(
        z.object({
          value: z.number().int().positive(),
        })
      )
      .min(1),
    max_dunning_attempts: z.number().int().positive(),
    default_renewal_behavior: z.enum([
      "process_immediately",
      "require_review_for_pending_changes",
    ]),
    default_cancellation_behavior: z.enum([
      "recommend_retention_first",
      "allow_direct_cancellation",
    ]),
  })
  .superRefine((values, ctx) => {
    const intervals = values.dunning_retry_intervals.map((item) => item.value)

    intervals.forEach((interval, index) => {
      if (!Number.isInteger(interval) || interval <= 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "settings.validation.retryIntervalPositive",
          path: ["dunning_retry_intervals", index, "value"],
        })
      }

      if (index > 0 && interval <= intervals[index - 1]) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "settings.validation.retryIntervalsStrictlyIncreasing",
          path: ["dunning_retry_intervals", index, "value"],
        })
      }
    })

    if (values.max_dunning_attempts !== intervals.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "settings.validation.maxAttemptsMatchIntervals",
        path: ["max_dunning_attempts"],
      })
    }
  })

type SubscriptionSettingsFormValues = z.infer<typeof settingsSchema>

type ChangedSection = "trial" | "dunning" | "renewals" | "cancellation"

const SECTION_LABEL_KEYS: Record<ChangedSection, string> = {
  trial: "settings.changedSections.trial",
  dunning: "settings.changedSections.dunning",
  renewals: "settings.changedSections.renewals",
  cancellation: "settings.changedSections.cancellation",
}

const defaultFormValues: SubscriptionSettingsFormValues = {
  default_trial_days: 0,
  dunning_retry_intervals: [{ value: 1440 }, { value: 4320 }, { value: 10080 }],
  max_dunning_attempts: 3,
  default_renewal_behavior: "process_immediately",
  default_cancellation_behavior: "recommend_retention_first",
}

function getChangedSections(
  dirtyFields: Partial<Record<keyof SubscriptionSettingsFormValues, unknown>>
): ChangedSection[] {
  const sections: ChangedSection[] = []

  if (dirtyFields.default_trial_days) {
    sections.push("trial")
  }

  if (
    dirtyFields.dunning_retry_intervals ||
    dirtyFields.max_dunning_attempts
  ) {
    sections.push("dunning")
  }

  if (dirtyFields.default_renewal_behavior) {
    sections.push("renewals")
  }

  if (dirtyFields.default_cancellation_behavior) {
    sections.push("cancellation")
  }

  return sections
}

const SubscriptionSettingsPage = () => {
  const { t } = useTranslation("reorder")
  const {
    data,
    isLoading,
    isError,
    error,
  } = useAdminSubscriptionSettingsQuery()

  const form = useForm<SubscriptionSettingsFormValues>({
    resolver: zodResolver(settingsSchema),
    defaultValues: defaultFormValues,
  })

  const { fields, append, remove, replace } = useFieldArray({
    control: form.control,
    name: "dunning_retry_intervals",
  })

  useEffect(() => {
    const settings = data?.subscription_settings

    if (!settings) {
      return
    }

    const nextValues: SubscriptionSettingsFormValues = {
      default_trial_days: settings.default_trial_days,
      dunning_retry_intervals: settings.dunning_retry_intervals.map((value) => ({
        value,
      })),
      max_dunning_attempts: settings.max_dunning_attempts,
      default_renewal_behavior: settings.default_renewal_behavior,
      default_cancellation_behavior: settings.default_cancellation_behavior,
    }

    form.reset(nextValues)
    replace(nextValues.dunning_retry_intervals)
  }, [data, form, replace])

  const saveMutation = useAdminSubscriptionSettingsUpdateMutation()

  const renewalBehaviorOptions = useMemo<
    Array<{
      value: AdminSubscriptionRenewalBehavior
      label: string
      hint: string
    }>
  >(
    () => [
      {
        value: "process_immediately",
        label: t("settings.behaviorOptions.renewal.process_immediately.label"),
        hint: t(
          "settings.behaviorOptions.renewal.process_immediately.hint"
        ),
      },
      {
        value: "require_review_for_pending_changes",
        label: t(
          "settings.behaviorOptions.renewal.require_review_for_pending_changes.label"
        ),
        hint: t(
          "settings.behaviorOptions.renewal.require_review_for_pending_changes.hint"
        ),
      },
    ],
    [t]
  )

  const cancellationBehaviorOptions = useMemo<
    Array<{
      value: AdminSubscriptionCancellationBehavior
      label: string
      hint: string
    }>
  >(
    () => [
      {
        value: "recommend_retention_first",
        label: t(
          "settings.behaviorOptions.cancellation.recommend_retention_first.label"
        ),
        hint: t(
          "settings.behaviorOptions.cancellation.recommend_retention_first.hint"
        ),
      },
      {
        value: "allow_direct_cancellation",
        label: t(
          "settings.behaviorOptions.cancellation.allow_direct_cancellation.label"
        ),
        hint: t(
          "settings.behaviorOptions.cancellation.allow_direct_cancellation.hint"
        ),
      },
    ],
    [t]
  )

  const handleSuccessfulSave = (response: SubscriptionSettingsAdminResponse) => {
    form.reset({
      default_trial_days: response.subscription_settings.default_trial_days,
      dunning_retry_intervals:
        response.subscription_settings.dunning_retry_intervals.map((value) => ({
          value,
        })),
      max_dunning_attempts: response.subscription_settings.max_dunning_attempts,
      default_renewal_behavior:
        response.subscription_settings.default_renewal_behavior,
      default_cancellation_behavior:
        response.subscription_settings.default_cancellation_behavior,
    })

    toast.success(t("settings.toast.updated"))
  }

  const handleFailedSave = (mutationError: unknown) => {
    const message =
      mutationError instanceof Error
        ? mutationError.message
        : t("settings.toast.updateFailed")

    if (
      message.toLowerCase().includes("version") ||
      message.toLowerCase().includes("conflict")
    ) {
      toast.error(t("settings.toast.versionConflict"))
      return
    }

    toast.error(message)
  }

  const handleSubmit = form.handleSubmit((values) => {
    saveMutation.mutate(
      {
        default_trial_days: values.default_trial_days,
        dunning_retry_intervals: values.dunning_retry_intervals.map(
          (item) => item.value
        ),
        max_dunning_attempts: values.max_dunning_attempts,
        default_renewal_behavior: values.default_renewal_behavior,
        default_cancellation_behavior: values.default_cancellation_behavior,
        expected_version: data?.subscription_settings.version ?? 0,
      },
      {
        onSuccess: handleSuccessfulSave,
        onError: handleFailedSave,
      }
    )
  })

  if (isLoading) {
    return (
      <Container className="divide-y p-0">
        <div className="px-6 py-4">
          <Heading level="h1">{t("settings.list.title")}</Heading>
          <Text
            size="small"
            leading="compact"
            className="text-ui-fg-subtle"
          >
            {t("settings.list.loading")}
          </Text>
        </div>
      </Container>
    )
  }

  if (isError) {
    return (
      <Container className="divide-y p-0">
        <div className="px-6 py-4">
          <Heading level="h1">{t("settings.list.title")}</Heading>
        </div>
        <div className="px-6 py-4">
          <Alert variant="error">
            <Text size="small" leading="compact">
              {error instanceof Error
                ? error.message
                : t("settings.list.loadError")}
            </Text>
          </Alert>
        </div>
      </Container>
    )
  }

  const currentSettings = data?.subscription_settings
  const changedSections = getChangedSections(form.formState.dirtyFields)
  const hasWideImpactChanges = changedSections.some((section) =>
    ["dunning", "renewals", "cancellation"].includes(section)
  )

  return (
    <form onSubmit={handleSubmit}>
      <Container className="divide-y p-0">
        <div className="flex items-start justify-between px-6 py-4">
          <div className="flex flex-col">
            <Heading level="h1">{t("settings.list.title")}</Heading>
            <Text
              size="small"
              leading="compact"
              className="text-ui-fg-subtle"
            >
              {t("settings.list.description")}
            </Text>
            <Text
              size="small"
              leading="compact"
              className="mt-2 text-ui-fg-subtle"
            >
              {t("settings.intro.futureOperations")}{" "}
              {t("settings.intro.existingCases")}
            </Text>
          </div>
          <div className="flex flex-col items-end gap-2">
            <Button
              size="small"
              type="submit"
              isLoading={saveMutation.isPending}
              disabled={saveMutation.isPending || !form.formState.isDirty}
            >
              {t("common.actions.save")}
            </Button>
            <Text
              size="small"
              leading="compact"
              className="text-ui-fg-subtle"
            >
              {saveMutation.isPending
                ? t("settings.alerts.saving")
                : form.formState.isDirty
                  ? t("settings.alerts.applyAfterSave")
                  : t("settings.alerts.noUnsavedChanges")}
            </Text>
          </div>
        </div>

        <div className="flex flex-col gap-4 px-6 py-4">
          {currentSettings && (
            <Alert variant="info">
              <div className="flex flex-col gap-1">
                <Text size="small" leading="compact">
                  {currentSettings.is_persisted
                    ? t("settings.status.persistedVersion", {
                        version: currentSettings.version,
                      })
                    : t("settings.status.fallbackDefaults")}
                </Text>
                <Text
                  size="small"
                  leading="compact"
                  className="text-ui-fg-subtle"
                >
                  {currentSettings.updated_at
                    ? t("settings.status.lastUpdatedAt", {
                        date: new Date(
                          currentSettings.updated_at
                        ).toLocaleString(),
                      })
                    : t("settings.status.noRecord")}
                </Text>
                <Text
                  size="small"
                  leading="compact"
                  className="text-ui-fg-subtle"
                >
                  {currentSettings.updated_by
                    ? t("settings.status.updatedBy", {
                        actor: currentSettings.updated_by,
                      })
                    : t("settings.status.bootstrapNoActor")}
                </Text>
                {!adminSubscriptionSettingsCapabilities.supportsReset && (
                  <Text
                    size="small"
                    leading="compact"
                    className="text-ui-fg-subtle"
                  >
                    {t("settings.alerts.resetUnsupported")}
                  </Text>
                )}
              </div>
            </Alert>
          )}

          {form.formState.isDirty && (
            <Alert variant="warning">
              <div className="flex flex-col gap-1">
                <Text size="small" leading="compact" weight="plus">
                  {t("settings.alerts.unsavedChanges", {
                    sections: changedSections
                      .map((section) => t(SECTION_LABEL_KEYS[section]))
                      .join(", "),
                  })}
                </Text>
                <Text size="small" leading="compact">
                  {hasWideImpactChanges
                    ? t("settings.alerts.wideImpact")
                    : t("settings.alerts.narrowImpact")}
                </Text>
              </div>
            </Alert>
          )}

          <fieldset
            disabled={saveMutation.isPending}
            className="flex flex-col gap-4 disabled:cursor-not-allowed disabled:opacity-70"
          >
            <SettingsSection
              title={t("settings.sections.trial")}
              description={t("settings.sections.trialDescription")}
            >
              <div className="flex flex-col gap-y-2">
                <Label htmlFor="default_trial_days">
                  {t("settings.fields.defaultTrialDays")}
                </Label>
                <Input
                  id="default_trial_days"
                  type="number"
                  min={0}
                  step={1}
                  {...form.register("default_trial_days", {
                    valueAsNumber: true,
                  })}
                />
                <FieldError message={form.formState.errors.default_trial_days?.message} />
              </div>
            </SettingsSection>

            <SettingsSection
              title={t("settings.sections.dunning")}
              description={t("settings.sections.dunningDescription")}
            >
              <div className="flex flex-col gap-3">
                <div className="flex items-center justify-between">
                  <div className="flex flex-col">
                    <Label>{t("settings.fields.retryIntervals")}</Label>
                    <Text
                      size="small"
                      leading="compact"
                      className="text-ui-fg-subtle"
                    >
                      {t("settings.fields.retryIntervalsHint")}
                    </Text>
                  </div>
                  <Button
                    size="small"
                    variant="secondary"
                    type="button"
                    onClick={() => {
                      const lastValue =
                        fields[fields.length - 1]?.value ?? 10080

                      append({ value: Number(lastValue) + 1440 })
                    }}
                  >
                    <PlusMini />
                    {t("settings.fields.addInterval")}
                  </Button>
                </div>

                <div className="flex flex-col gap-3">
                  {fields.map((field, index) => (
                    <div
                      key={field.id}
                      className="grid grid-cols-[1fr_auto] items-start gap-2"
                    >
                      <div className="flex flex-col gap-y-2">
                        <Input
                          type="number"
                          min={1}
                          step={1}
                          {...form.register(
                            `dunning_retry_intervals.${index}.value`,
                            {
                              valueAsNumber: true,
                            }
                          )}
                        />
                        <FieldError
                          message={
                            form.formState.errors.dunning_retry_intervals?.[index]
                              ?.value?.message
                          }
                        />
                      </div>
                      <Button
                        size="small"
                        variant="secondary"
                        type="button"
                        disabled={fields.length === 1}
                        onClick={() => remove(index)}
                      >
                        <Trash />
                      </Button>
                    </div>
                  ))}
                </div>

                <div className="flex flex-col gap-y-2">
                  <Label htmlFor="max_dunning_attempts">
                    {t("settings.fields.maxDunningAttempts")}
                  </Label>
                  <Input
                    id="max_dunning_attempts"
                    type="number"
                    min={1}
                    step={1}
                    {...form.register("max_dunning_attempts", {
                      valueAsNumber: true,
                    })}
                  />
                  <FieldError
                    message={form.formState.errors.max_dunning_attempts?.message}
                  />
                </div>
              </div>
            </SettingsSection>

            <SettingsSection
              title={t("settings.sections.renewals")}
              description={t("settings.sections.renewalsDescription")}
            >
              <div className="flex flex-col gap-y-2">
                <Label htmlFor="default_renewal_behavior">
                  {t("settings.fields.defaultRenewalBehavior")}
                </Label>
                <Controller
                  control={form.control}
                  name="default_renewal_behavior"
                  render={({ field }) => (
                    <Select
                      value={field.value}
                      onValueChange={field.onChange}
                    >
                      <Select.Trigger id="default_renewal_behavior">
                        <Select.Value />
                      </Select.Trigger>
                      <Select.Content>
                        {renewalBehaviorOptions.map((option) => (
                          <Select.Item key={option.value} value={option.value}>
                            {option.label}
                          </Select.Item>
                        ))}
                      </Select.Content>
                    </Select>
                  )}
                />
                <Text
                  size="small"
                  leading="compact"
                  className="text-ui-fg-subtle"
                >
                  {
                    renewalBehaviorOptions.find(
                      (option) =>
                        option.value ===
                        form.watch("default_renewal_behavior")
                    )?.hint
                  }
                </Text>
                <FieldError
                  message={form.formState.errors.default_renewal_behavior?.message}
                />
              </div>
            </SettingsSection>

            <SettingsSection
              title={t("settings.sections.cancellation")}
              description={t("settings.sections.cancellationDescription")}
            >
              <div className="flex flex-col gap-y-2">
                <Label htmlFor="default_cancellation_behavior">
                  {t("settings.fields.defaultCancellationBehavior")}
                </Label>
                <Controller
                  control={form.control}
                  name="default_cancellation_behavior"
                  render={({ field }) => (
                    <Select
                      value={field.value}
                      onValueChange={field.onChange}
                    >
                      <Select.Trigger id="default_cancellation_behavior">
                        <Select.Value />
                      </Select.Trigger>
                      <Select.Content>
                        {cancellationBehaviorOptions.map((option) => (
                          <Select.Item key={option.value} value={option.value}>
                            {option.label}
                          </Select.Item>
                        ))}
                      </Select.Content>
                    </Select>
                  )}
                />
                <Text
                  size="small"
                  leading="compact"
                  className="text-ui-fg-subtle"
                >
                  {
                    cancellationBehaviorOptions.find(
                      (option) =>
                        option.value ===
                        form.watch("default_cancellation_behavior")
                    )?.hint
                  }
                </Text>
                <FieldError
                  message={
                    form.formState.errors.default_cancellation_behavior?.message
                  }
                />
              </div>
            </SettingsSection>
          </fieldset>
        </div>
      </Container>
    </form>
  )
}

type SettingsSectionProps = {
  title: string
  description: string
  children: ReactNode
}

const SettingsSection = ({
  title,
  description,
  children,
}: SettingsSectionProps) => {
  return (
    <div className="rounded-lg border border-ui-border-base bg-ui-bg-subtle p-4">
      <div className="mb-4 flex flex-col gap-1">
        <Text size="small" leading="compact" weight="plus">
          {title}
        </Text>
        <Text
          size="small"
          leading="compact"
          className="text-ui-fg-subtle"
        >
          {description}
        </Text>
      </div>
      <div className="flex flex-col gap-4">{children}</div>
    </div>
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

export const config = defineRouteConfig({
  label: "menuItems.settings",
  translationNs: "reorder",
})

export default SubscriptionSettingsPage
