import { defineRouteConfig } from "@medusajs/admin-sdk"
import { translate, type ReorderTranslate } from "../../../../i18n/translate"
import { useTranslation } from "react-i18next"
import {
  Alert,
  Button,
  Container,
  Drawer,
  DropdownMenu,
  Heading,
  IconButton,
  Input,
  Label,
  StatusBadge,
  Table,
  Text,
  Textarea,
  toast,
  usePrompt,
} from "@medusajs/ui"
import {
  CheckCircle,
  EllipsisHorizontal,
  ShoppingBag,
  Spinner,
  TriangleRightMini,
  XCircle,
} from "@medusajs/icons"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { ReactNode, useEffect, useMemo, useState } from "react"
import { Link, UIMatch, useParams } from "react-router-dom"
import { sdk } from "../../../../lib/client"
import {
  invalidateAdminDunningQueries,
  useAdminDunningDetailQuery,
  useAdminDunningRetryScheduleFormQuery,
} from "../data-loading"
import {
  DunningAttemptAdminStatus,
  DunningCaseAdminDetail,
  DunningCaseAdminDetailResponse,
  DunningCaseAdminStatus,
  MarkRecoveredDunningAdminRequest,
  MarkUnrecoveredDunningAdminRequest,
  RetryNowDunningAdminRequest,
  UpdateDunningRetryScheduleAdminRequest,
} from "../../../../types/dunning"

type ActionDrawerMode = "mark_recovered" | "mark_unrecovered" | "retry_schedule"

const terminalStatuses = new Set<DunningCaseAdminStatus>([
  DunningCaseAdminStatus.RECOVERED,
  DunningCaseAdminStatus.UNRECOVERED,
])

const DUNNING_CASE_STATUS_KEYS = {
  [DunningCaseAdminStatus.OPEN]: "dunning.status.open",
  [DunningCaseAdminStatus.RETRY_SCHEDULED]: "dunning.status.retryScheduled",
  [DunningCaseAdminStatus.RETRYING]: "dunning.status.retrying",
  [DunningCaseAdminStatus.AWAITING_MANUAL_RESOLUTION]:
    "dunning.status.awaitingManualResolution",
  [DunningCaseAdminStatus.RECOVERED]: "dunning.status.recovered",
  [DunningCaseAdminStatus.UNRECOVERED]: "dunning.status.unrecovered",
} as const

const DUNNING_ATTEMPT_STATUS_KEYS = {
  [DunningAttemptAdminStatus.PROCESSING]: "dunning.attemptStatus.processing",
  [DunningAttemptAdminStatus.SUCCEEDED]: "dunning.attemptStatus.succeeded",
  [DunningAttemptAdminStatus.FAILED]: "dunning.attemptStatus.failed",
} as const

const SUBSCRIPTION_STATUS_KEYS: Record<string, string> = {
  active: "subscriptions.status.active",
  paused: "subscriptions.status.paused",
  cancelled: "subscriptions.status.cancelled",
  past_due: "subscriptions.status.pastDue",
}

const RENEWAL_STATUS_KEYS: Record<string, string> = {
  scheduled: "renewals.status.scheduled",
  processing: "renewals.status.processing",
  succeeded: "renewals.status.succeeded",
  failed: "renewals.status.failed",
}

const DunningDetailPage = () => {
  const { t } = useTranslation("reorder")
  const { id } = useParams()
  const queryClient = useQueryClient()
  const prompt = usePrompt()
  const [actionDrawerOpen, setActionDrawerOpen] = useState(false)
  const [actionDrawerMode, setActionDrawerMode] =
    useState<ActionDrawerMode>("retry_schedule")
  const [reason, setReason] = useState("")
  const [intervals, setIntervals] = useState("1440, 4320, 10080")
  const [maxAttempts, setMaxAttempts] = useState("3")
  const [formError, setFormError] = useState<string | null>(null)

  const { data, isLoading, isError, error } = useAdminDunningDetailQuery(id)
  const dunningCase = data?.dunning_case
  const { data: retryScheduleFormData } = useAdminDunningRetryScheduleFormQuery(
    id,
    actionDrawerOpen && actionDrawerMode === "retry_schedule",
    data
  )

  const retryNowMutation = useMutation({
    mutationFn: async (body: RetryNowDunningAdminRequest) =>
      sdk.client.fetch<DunningCaseAdminDetailResponse>(
        `/admin/dunning/${id}/retry-now`,
        {
          method: "POST",
          body,
        }
      ),
    onSuccess: async () => {
      await invalidateAdminDunningQueries(
        queryClient,
        id,
        dunningCase?.subscription.subscription_id
      )
      toast.success(t("dunning.detail.toast.retryStarted"))
    },
    onError: (mutationError) => {
      toast.error(
        getAdminErrorMessage(
          mutationError,
          t("dunning.detail.errors.retryNowFailed")
        )
      )
    },
  })

  const markRecoveredMutation = useMutation({
    mutationFn: async (body: MarkRecoveredDunningAdminRequest) =>
      sdk.client.fetch<DunningCaseAdminDetailResponse>(
        `/admin/dunning/${id}/mark-recovered`,
        {
          method: "POST",
          body,
        }
      ),
    onSuccess: async () => {
      await invalidateAdminDunningQueries(
        queryClient,
        id,
        dunningCase?.subscription.subscription_id
      )
      toast.success(t("dunning.detail.toast.markedRecovered"))
      closeDrawer()
    },
    onError: (mutationError) => {
      const message = getAdminErrorMessage(
        mutationError,
        t("dunning.detail.errors.markRecoveredFailed")
      )
      setFormError(message)
      toast.error(message)
    },
  })

  const markUnrecoveredMutation = useMutation({
    mutationFn: async (body: MarkUnrecoveredDunningAdminRequest) =>
      sdk.client.fetch<DunningCaseAdminDetailResponse>(
        `/admin/dunning/${id}/mark-unrecovered`,
        {
          method: "POST",
          body,
        }
      ),
    onSuccess: async () => {
      await invalidateAdminDunningQueries(
        queryClient,
        id,
        dunningCase?.subscription.subscription_id
      )
      toast.success(t("dunning.detail.toast.markedUnrecovered"))
      closeDrawer()
    },
    onError: (mutationError) => {
      const message = getAdminErrorMessage(
        mutationError,
        t("dunning.detail.errors.markUnrecoveredFailed")
      )
      setFormError(message)
      toast.error(message)
    },
  })

  const retryScheduleMutation = useMutation({
    mutationFn: async (body: UpdateDunningRetryScheduleAdminRequest) =>
      sdk.client.fetch<DunningCaseAdminDetailResponse>(
        `/admin/dunning/${id}/retry-schedule`,
        {
          method: "POST",
          body,
        }
      ),
    onSuccess: async () => {
      await invalidateAdminDunningQueries(
        queryClient,
        id,
        dunningCase?.subscription.subscription_id
      )
      toast.success(t("dunning.detail.toast.retryScheduleUpdated"))
      closeDrawer()
    },
    onError: (mutationError) => {
      const message = getAdminErrorMessage(
        mutationError,
        t("dunning.detail.errors.retryScheduleFailed")
      )
      setFormError(message)
      toast.error(message)
    },
  })

  const metadataRows = useMemo(() => {
    if (!dunningCase?.metadata) {
      return []
    }

    return Object.entries(dunningCase.metadata).map(([key, value]) => ({
      key,
      value:
        typeof value === "string" ? value : JSON.stringify(value, null, 2),
    }))
  }, [dunningCase])

  const canRetryNow = dunningCase
    ? !terminalStatuses.has(dunningCase.status) &&
      dunningCase.status !== DunningCaseAdminStatus.RETRYING
    : false
  const canMarkRecovered = canRetryNow
  const canMarkUnrecovered = canRetryNow
  const canEditRetrySchedule = canRetryNow
  const isActionPending =
    retryNowMutation.isPending ||
    markRecoveredMutation.isPending ||
    markUnrecoveredMutation.isPending ||
    retryScheduleMutation.isPending

  useEffect(() => {
    if (!actionDrawerOpen || actionDrawerMode !== "retry_schedule") {
      return
    }

    const retrySchedule = retryScheduleFormData?.dunning_case.retry_schedule
    const retryScheduleMaxAttempts =
      retryScheduleFormData?.dunning_case.max_attempts

    setIntervals(retrySchedule?.intervals.join(", ") ?? "1440, 4320, 10080")
    setMaxAttempts(
      retryScheduleMaxAttempts?.toString() ??
        retrySchedule?.intervals.length.toString() ??
        "3"
    )
  }, [actionDrawerOpen, actionDrawerMode, retryScheduleFormData])

  const openDrawer = (mode: ActionDrawerMode) => {
    setActionDrawerMode(mode)
    setReason("")
    setFormError(null)

    setActionDrawerOpen(true)
  }

  const closeDrawer = () => {
    setActionDrawerOpen(false)
    setReason("")
    setFormError(null)
  }

  const handleRetryNow = async () => {
    const confirmed = await prompt({
      title: t("dunning.detail.prompt.retryNowTitle"),
      description: t("dunning.detail.prompt.retryNowDescription"),
      confirmText: t("dunning.detail.actions.retryNow"),
      cancelText: t("common.actions.cancel"),
    })

    if (!confirmed) {
      return
    }

    await retryNowMutation.mutateAsync({
      reason: undefined,
    })
  }

  const handleSubmitDrawer = async () => {
    const normalizedReason = normalizeOptionalString(reason)

    if (actionDrawerMode === "mark_unrecovered" && !normalizedReason) {
      setFormError(t("dunning.detail.errors.reasonRequired"))
      toast.error(t("dunning.detail.errors.reasonRequired"))
      return
    }

    if (actionDrawerMode === "retry_schedule") {
      const normalizedIntervals = parseIntervals(intervals)
      const normalizedMaxAttempts = Number(maxAttempts)

      if (!normalizedIntervals.length) {
        setFormError(t("dunning.detail.errors.intervalsRequired"))
        toast.error(t("dunning.detail.errors.intervalsRequired"))
        return
      }

      if (!Number.isInteger(normalizedMaxAttempts) || normalizedMaxAttempts <= 0) {
        setFormError(t("dunning.detail.errors.maxAttemptsPositive"))
        toast.error(t("dunning.detail.errors.maxAttemptsPositive"))
        return
      }

      if (normalizedIntervals.length !== normalizedMaxAttempts) {
        setFormError(t("dunning.detail.errors.maxAttemptsMismatch"))
        toast.error(t("dunning.detail.errors.maxAttemptsMismatch"))
        return
      }

      const confirmed = await prompt({
        title: t("dunning.detail.prompt.overrideTitle"),
        description: t("dunning.detail.prompt.overrideDescription"),
        confirmText: t("dunning.detail.actions.saveSchedule"),
        cancelText: t("common.actions.cancel"),
      })

      if (!confirmed) {
        return
      }

      await retryScheduleMutation.mutateAsync({
        reason: normalizedReason,
        intervals: normalizedIntervals,
        max_attempts: normalizedMaxAttempts,
      })
      return
    }

    const confirmed = await prompt({
      title:
        actionDrawerMode === "mark_recovered"
          ? t("dunning.detail.prompt.markRecoveredTitle")
          : t("dunning.detail.prompt.markUnrecoveredTitle"),
      description:
        actionDrawerMode === "mark_recovered"
          ? t("dunning.detail.prompt.markRecoveredDescription")
          : t("dunning.detail.prompt.markUnrecoveredDescription"),
      confirmText:
        actionDrawerMode === "mark_recovered"
          ? t("dunning.detail.actions.markRecovered")
          : t("dunning.detail.actions.markUnrecovered"),
      cancelText: t("common.actions.cancel"),
    })

    if (!confirmed) {
      return
    }

    if (actionDrawerMode === "mark_recovered") {
      await markRecoveredMutation.mutateAsync({
        reason: normalizedReason,
      })
      return
    }

    await markUnrecoveredMutation.mutateAsync({
      reason: normalizedReason!,
    })
  }

  if (isLoading) {
    return (
      <Container className="divide-y p-0">
        <div className="px-6 py-4">
          <Heading level="h1">{t("dunning.detail.title")}</Heading>
        </div>
        <div className="flex items-center gap-x-2 px-6 py-6 text-ui-fg-subtle">
          <Spinner className="animate-spin" />
          <Text size="small" leading="compact" className="text-ui-fg-subtle">
            {t("dunning.detail.loading")}
          </Text>
        </div>
      </Container>
    )
  }

  if (isError) {
    return (
      <Container className="divide-y p-0">
        <div className="px-6 py-4">
          <Heading level="h1">{t("dunning.detail.title")}</Heading>
        </div>
        <div className="px-6 py-6">
          <Alert variant="error">
            {error instanceof Error
              ? error.message
              : t("dunning.detail.loadError")}
          </Alert>
        </div>
      </Container>
    )
  }

  if (!dunningCase) {
    return (
      <Container className="divide-y p-0">
        <div className="px-6 py-4">
          <Heading level="h1">{t("dunning.detail.title")}</Heading>
        </div>
        <div className="px-6 py-6">
          <Alert variant="warning">{t("dunning.detail.unavailable")}</Alert>
        </div>
      </Container>
    )
  }

  return (
    <div className="flex flex-col gap-y-4">
      <Container className="divide-y p-0">
        <div className="flex items-start justify-between px-6 py-4">
          <div className="flex flex-col gap-y-1">
            <Text size="small" leading="compact" className="text-ui-fg-subtle">
              {t("dunning.detail.header")}
            </Text>
            <Heading level="h1">{dunningCase.id}</Heading>
            <Text size="small" leading="compact" className="text-ui-fg-subtle">
              {t("dunning.detail.description")}
            </Text>
          </div>
          <div className="flex items-center gap-x-2">
            <StatusBadge color={getCaseStatusColor(dunningCase.status)}>
              {t(DUNNING_CASE_STATUS_KEYS[dunningCase.status])}
            </StatusBadge>
            <DropdownMenu>
              <DropdownMenu.Trigger asChild>
                <IconButton size="small" variant="transparent" disabled={isActionPending}>
                  <EllipsisHorizontal />
                </IconButton>
              </DropdownMenu.Trigger>
              <DropdownMenu.Content align="end">
                {canRetryNow ? (
                  <DropdownMenu.Item
                    className="flex items-center gap-x-2"
                    disabled={isActionPending}
                    onClick={() => {
                      void handleRetryNow()
                    }}
                  >
                    <TriangleRightMini className="text-ui-fg-subtle" />
                    <span>
                      {retryNowMutation.isPending
                        ? t("dunning.detail.actions.retrying")
                        : t("dunning.detail.actions.retryNow")}
                    </span>
                  </DropdownMenu.Item>
                ) : null}
                {canMarkRecovered ? (
                  <DropdownMenu.Item
                    className="flex items-center gap-x-2"
                    disabled={isActionPending}
                    onClick={() => openDrawer("mark_recovered")}
                  >
                    <CheckCircle className="text-ui-fg-subtle" />
                    <span>{t("dunning.detail.actions.markRecovered")}</span>
                  </DropdownMenu.Item>
                ) : null}
                {canMarkUnrecovered ? (
                  <DropdownMenu.Item
                    className="flex items-center gap-x-2"
                    disabled={isActionPending}
                    onClick={() => openDrawer("mark_unrecovered")}
                  >
                    <XCircle className="text-ui-fg-subtle" />
                    <span>{t("dunning.detail.actions.markUnrecovered")}</span>
                  </DropdownMenu.Item>
                ) : null}
                {canEditRetrySchedule ? (
                  <DropdownMenu.Item
                    className="flex items-center gap-x-2"
                    disabled={isActionPending}
                    onClick={() => openDrawer("retry_schedule")}
                  >
                    <EllipsisHorizontal className="text-ui-fg-subtle" />
                    <span>{t("dunning.detail.actions.editRetrySchedule")}</span>
                  </DropdownMenu.Item>
                ) : null}
              </DropdownMenu.Content>
            </DropdownMenu>
          </div>
        </div>
      </Container>
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="flex min-w-0 flex-col gap-4">
          <Container className="divide-y p-0">
            <div className="px-6 py-4">
              <Heading level="h2">{t("dunning.detail.sections.overview")}</Heading>
            </div>
            <div className="px-6 py-4">
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <DetailRow
                  label={t("common.fields.status")}
                  value={(
                    <StatusBadge color={getCaseStatusColor(dunningCase.status)}>
                      {t(DUNNING_CASE_STATUS_KEYS[dunningCase.status])}
                    </StatusBadge>
                  )}
                />
                <DetailRow
                  label={t("dunning.detail.fields.attemptCount")}
                  value={`${dunningCase.attempt_count} / ${dunningCase.max_attempts}`}
                />
                <DetailRow
                  label={t("dunning.detail.fields.nextRetry")}
                  value={formatDateTime(
                    dunningCase.next_retry_at,
                    t("common.empty.noValue")
                  )}
                />
                <DetailRow
                  label={t("dunning.detail.fields.lastAttempt")}
                  value={formatDateTime(
                    dunningCase.last_attempt_at,
                    t("common.empty.noValue")
                  )}
                />
                <DetailRow
                  label={t("dunning.detail.fields.recoveredAt")}
                  value={formatDateTime(
                    dunningCase.recovered_at,
                    t("common.empty.noValue")
                  )}
                />
                <DetailRow
                  label={t("dunning.detail.fields.closedAt")}
                  value={formatDateTime(
                    dunningCase.closed_at,
                    t("common.empty.noValue")
                  )}
                />
                <DetailRow
                  label={t("dunning.detail.fields.createdAt")}
                  value={formatDateTime(
                    dunningCase.created_at,
                    t("common.empty.noValue")
                  )}
                />
                <DetailRow
                  label={t("dunning.detail.fields.updatedAt")}
                  value={formatDateTime(
                    dunningCase.updated_at,
                    t("common.empty.noValue")
                  )}
                />
              </div>
            </div>
          </Container>

          <Container className="divide-y p-0">
            <div className="px-6 py-4">
              <Heading level="h2">{t("dunning.detail.sections.payment")}</Heading>
            </div>
            <div className="px-6 py-4">
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <DetailRow
                  label={t("dunning.detail.fields.lastErrorCode")}
                  value={
                    dunningCase.last_payment_error_code ||
                    t("common.empty.noValue")
                  }
                />
                <DetailRow
                  label={t("dunning.detail.fields.provider")}
                  value={
                    dunningCase.subscription.payment_provider_id ||
                    t("common.empty.noValue")
                  }
                />
                <DetailRow
                  label={t("dunning.detail.fields.lastErrorMessage")}
                  value={
                    dunningCase.last_payment_error_message ||
                    t("dunning.detail.fields.noPaymentErrorMessage")
                  }
                />
                <DetailRow
                  label={t("dunning.detail.fields.latestPaymentReference")}
                  value={
                    dunningCase.attempts[dunningCase.attempts.length - 1]
                      ?.payment_reference || t("common.empty.noValue")
                  }
                />
                <DetailRow
                  label={t("dunning.detail.fields.recoveryReason")}
                  value={
                    dunningCase.recovery_reason || t("common.empty.noValue")
                  }
                />
              </div>
            </div>
          </Container>

          <Container className="divide-y p-0">
            <div className="px-6 py-4">
              <Heading level="h2">{t("dunning.detail.sections.retrySchedule")}</Heading>
            </div>
            <div className="px-6 py-4">
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <DetailRow
                  label={t("dunning.detail.fields.strategy")}
                  value={
                    dunningCase.retry_schedule?.strategy ||
                    t("common.empty.noValue")
                  }
                />
                <DetailRow
                  label={t("dunning.detail.fields.timezone")}
                  value={
                    dunningCase.retry_schedule?.timezone ||
                    t("common.empty.noValue")
                  }
                />
                <DetailRow
                  label={t("dunning.detail.fields.intervals")}
                  value={
                    dunningCase.retry_schedule
                      ? formatIntervals(dunningCase.retry_schedule.intervals, t)
                      : t("common.empty.noValue")
                  }
                />
                <DetailRow
                  label={t("dunning.detail.fields.source")}
                  value={
                    dunningCase.retry_schedule?.source ||
                    t("common.empty.noValue")
                  }
                />
              </div>
            </div>
          </Container>

          <Container className="divide-y p-0">
            <div className="px-6 py-4">
              <Heading level="h2">{t("dunning.detail.sections.attempts")}</Heading>
            </div>
            <div className="px-6 py-4">
              {dunningCase.attempts.length ? (
                <Table>
                  <Table.Header>
                    <Table.Row>
                      <Table.HeaderCell>
                        {t("dunning.detail.fields.attempt")}
                      </Table.HeaderCell>
                      <Table.HeaderCell>{t("common.fields.status")}</Table.HeaderCell>
                      <Table.HeaderCell>
                        {t("dunning.detail.fields.started")}
                      </Table.HeaderCell>
                      <Table.HeaderCell>
                        {t("dunning.detail.fields.finished")}
                      </Table.HeaderCell>
                      <Table.HeaderCell>
                        {t("dunning.detail.fields.error")}
                      </Table.HeaderCell>
                      <Table.HeaderCell>
                        {t("dunning.detail.fields.paymentReference")}
                      </Table.HeaderCell>
                    </Table.Row>
                  </Table.Header>
                  <Table.Body>
                    {dunningCase.attempts.map((attempt) => (
                      <Table.Row key={attempt.id}>
                        <Table.Cell>
                          <Text size="small" leading="compact" weight="plus">
                            #{attempt.attempt_no}
                          </Text>
                        </Table.Cell>
                        <Table.Cell>
                          <StatusBadge color={getAttemptStatusColor(attempt.status)}>
                            {t(DUNNING_ATTEMPT_STATUS_KEYS[attempt.status])}
                          </StatusBadge>
                        </Table.Cell>
                        <Table.Cell>
                          {formatDateTime(
                            attempt.started_at,
                            t("common.empty.noValue")
                          )}
                        </Table.Cell>
                        <Table.Cell>
                          {formatDateTime(
                            attempt.finished_at,
                            t("common.empty.noValue")
                          )}
                        </Table.Cell>
                        <Table.Cell>
                          <div className="flex flex-col gap-y-0.5">
                            <Text size="small" leading="compact">
                              {attempt.error_code || t("common.empty.noValue")}
                            </Text>
                            <Text
                              size="small"
                              leading="compact"
                              className="text-ui-fg-subtle"
                            >
                              {attempt.error_message ||
                                t("dunning.detail.empty.noError")}
                            </Text>
                          </div>
                        </Table.Cell>
                        <Table.Cell>
                          {attempt.payment_reference || t("common.empty.noValue")}
                        </Table.Cell>
                      </Table.Row>
                    ))}
                  </Table.Body>
                </Table>
              ) : (
                <Text size="small" leading="compact" className="text-ui-fg-subtle">
                  {t("dunning.detail.empty.noAttempts")}
                </Text>
              )}
            </div>
          </Container>

          <Container className="divide-y p-0">
            <div className="px-6 py-4">
              <Heading level="h2">{t("dunning.detail.sections.metadata")}</Heading>
            </div>
            <div className="px-6 py-4">
              {metadataRows.length ? (
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                  {metadataRows.map((row) => (
                    <DetailRow key={row.key} label={row.key} value={row.value} mono />
                  ))}
                </div>
              ) : (
                <Text size="small" leading="compact" className="text-ui-fg-subtle">
                  {t("dunning.detail.empty.noMetadata")}
                </Text>
              )}
            </div>
          </Container>
        </div>

        <div className="flex min-w-0 flex-col gap-4">
          <Container className="divide-y p-0">
            <div className="px-6 py-4">
              <Heading level="h2">
                {t("dunning.detail.sections.subscription")}
              </Heading>
            </div>
            <div className="px-6 py-4">
              <div className="grid gap-4">
                <Link
                  to={`/subscriptions/${dunningCase.subscription.subscription_id}`}
                  className="outline-none focus-within:shadow-borders-interactive-with-focus rounded-md [&:hover>div]:bg-ui-bg-component-hover"
                >
                  <div className="shadow-elevation-card-rest bg-ui-bg-component rounded-md px-4 py-2 transition-colors">
                    <div className="flex items-center gap-3">
                      <div className="shadow-elevation-card-rest flex h-14 w-14 items-center justify-center rounded-md text-ui-fg-muted">
                        <Text size="small" leading="compact" weight="plus">
                          SUB
                        </Text>
                      </div>
                      <div className="flex flex-1 flex-col">
                        <Text size="small" leading="compact" weight="plus">
                          {dunningCase.subscription.reference}
                        </Text>
                        <Text
                          size="small"
                          leading="compact"
                          className="text-ui-fg-subtle"
                        >
                          {dunningCase.subscription.customer_name}
                        </Text>
                      </div>
                      <div className="size-7 flex items-center justify-center">
                        <TriangleRightMini className="text-ui-fg-muted rtl:rotate-180" />
                      </div>
                    </div>
                  </div>
                </Link>
                <DetailRow
                  label={t("common.fields.status")}
                  value={formatSubscriptionStatus(dunningCase.subscription.status, t)}
                />
                <DetailRow
                  label={t("common.fields.customer")}
                  value={dunningCase.subscription.customer_name}
                />
                <DetailRow
                  label={t("common.fields.product")}
                  value={dunningCase.subscription.product_title}
                />
                <DetailRow
                  label={t("common.fields.variant")}
                  value={dunningCase.subscription.variant_title}
                />
                <DetailRow
                  label={t("common.fields.sku")}
                  value={dunningCase.subscription.sku || t("common.empty.noValue")}
                />
              </div>
            </div>
          </Container>

          <Container className="divide-y p-0">
            <div className="px-6 py-4">
              <Heading level="h2">{t("dunning.detail.sections.renewal")}</Heading>
            </div>
            <div className="px-6 py-4">
              <div className="grid gap-4">
                {dunningCase.renewal ? (
                  <Link
                    to={`/subscriptions/renewals/${dunningCase.renewal.renewal_cycle_id}`}
                    className="outline-none focus-within:shadow-borders-interactive-with-focus rounded-md [&:hover>div]:bg-ui-bg-component-hover"
                  >
                    <div className="shadow-elevation-card-rest bg-ui-bg-component rounded-md px-4 py-2 transition-colors">
                      <div className="flex items-center gap-3">
                        <div className="shadow-elevation-card-rest flex h-14 w-14 items-center justify-center rounded-md text-ui-fg-muted">
                          <Text size="small" leading="compact" weight="plus">
                            REN
                          </Text>
                        </div>
                        <div className="flex flex-1 flex-col">
                          <Text size="small" leading="compact" weight="plus">
                            {dunningCase.renewal.renewal_cycle_id}
                          </Text>
                          <Text
                            size="small"
                            leading="compact"
                            className="text-ui-fg-subtle"
                          >
                            {formatRenewalStatus(dunningCase.renewal.status, t)}
                          </Text>
                        </div>
                        <div className="size-7 flex items-center justify-center">
                          <TriangleRightMini className="text-ui-fg-muted rtl:rotate-180" />
                        </div>
                      </div>
                    </div>
                  </Link>
                ) : (
                  <Text size="small" leading="compact" className="text-ui-fg-subtle">
                    {t("dunning.detail.empty.noLinkedRenewal")}
                  </Text>
                )}
                <DetailRow
                  label={t("dunning.detail.fields.renewalStatus")}
                  value={
                    dunningCase.renewal
                      ? formatRenewalStatus(dunningCase.renewal.status, t)
                      : t("common.empty.noValue")
                  }
                />
                <DetailRow
                  label={t("dunning.detail.fields.scheduledFor")}
                  value={formatDateTime(
                    dunningCase.renewal?.scheduled_for ?? null,
                    t("common.empty.noValue")
                  )}
                />
                <DetailRow
                  label={t("dunning.detail.fields.generatedOrderId")}
                  value={
                    dunningCase.renewal?.generated_order_id ||
                    t("common.empty.noValue")
                  }
                />
              </div>
            </div>
          </Container>

          <Container className="divide-y p-0">
            <div className="px-6 py-4">
              <Heading level="h2">{t("dunning.detail.sections.order")}</Heading>
            </div>
            <div className="px-6 py-4">
              <div className="grid gap-4">
                {dunningCase.order ? (
                  <Link
                    to={`/orders/${dunningCase.order.order_id}`}
                    className="outline-none focus-within:shadow-borders-interactive-with-focus rounded-md [&:hover>div]:bg-ui-bg-component-hover"
                  >
                    <div className="shadow-elevation-card-rest bg-ui-bg-component rounded-md px-4 py-2 transition-colors">
                      <div className="flex items-center gap-3">
                        <div className="shadow-elevation-card-rest flex h-14 w-14 items-center justify-center rounded-md text-ui-fg-muted">
                          <ShoppingBag />
                        </div>
                        <div className="flex flex-1 flex-col">
                          <Text size="small" leading="compact" weight="plus">
                            #{dunningCase.order.display_id}
                          </Text>
                          <Text
                            size="small"
                            leading="compact"
                            className="text-ui-fg-subtle"
                          >
                            {dunningCase.order.status}
                          </Text>
                        </div>
                        <div className="size-7 flex items-center justify-center">
                          <TriangleRightMini className="text-ui-fg-muted rtl:rotate-180" />
                        </div>
                      </div>
                    </div>
                  </Link>
                ) : (
                  <Text size="small" leading="compact" className="text-ui-fg-subtle">
                    {t("dunning.detail.empty.noLinkedOrder")}
                  </Text>
                )}
                <DetailRow
                  label={t("dunning.detail.fields.orderStatus")}
                  value={
                    dunningCase.order?.status || t("common.empty.noValue")
                  }
                />
                <DetailRow
                  label={t("dunning.detail.fields.orderId")}
                  value={
                    dunningCase.order?.order_id || t("common.empty.noValue")
                  }
                />
              </div>
            </div>
          </Container>
        </div>
      </div>

      <Drawer open={actionDrawerOpen} onOpenChange={setActionDrawerOpen}>
        <Drawer.Content>
          <Drawer.Header>
            <Drawer.Title>{getDrawerTitle(actionDrawerMode, t)}</Drawer.Title>
          </Drawer.Header>
          <Drawer.Body className="flex flex-1 flex-col gap-y-4 p-4">
            {formError ? <Alert variant="error">{formError}</Alert> : null}
            {actionDrawerMode === "retry_schedule" ? (
              <Alert variant="warning">
                {t("dunning.detail.drawer.warning")}
              </Alert>
            ) : null}
            {actionDrawerMode === "retry_schedule" ? (
              <>
                <div className="flex flex-col gap-y-2">
                  <Label htmlFor="retry-intervals">
                    {t("dunning.detail.drawer.intervals")}
                  </Label>
                  <Input
                    id="retry-intervals"
                    value={intervals}
                    onChange={(event) => setIntervals(event.target.value)}
                    placeholder={t("dunning.detail.drawer.intervalsPlaceholder")}
                  />
                </div>
                <div className="flex flex-col gap-y-2">
                  <Label htmlFor="retry-max-attempts">
                    {t("dunning.detail.drawer.maxAttempts")}
                  </Label>
                  <Input
                    id="retry-max-attempts"
                    type="number"
                    min={1}
                    value={maxAttempts}
                    onChange={(event) => setMaxAttempts(event.target.value)}
                  />
                </div>
              </>
            ) : null}
            <div className="flex flex-col gap-y-2">
              <Label htmlFor="dunning-reason">
                {actionDrawerMode === "mark_unrecovered"
                  ? t("dunning.detail.drawer.reasonRequired")
                  : t("common.fields.reason")}
              </Label>
              <Textarea
                id="dunning-reason"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                placeholder={
                  actionDrawerMode === "retry_schedule"
                    ? t("dunning.detail.drawer.retryScheduleNote")
                    : actionDrawerMode === "mark_recovered"
                      ? t("dunning.detail.drawer.recoveredNote")
                      : t("dunning.detail.drawer.unrecoveredReason")
                }
              />
            </div>
          </Drawer.Body>
          <Drawer.Footer>
            <div className="flex items-center justify-end gap-x-2">
              <Drawer.Close asChild>
                <Button
                  size="small"
                  variant="secondary"
                  type="button"
                  disabled={isActionPending}
                >
                  {t("common.actions.cancel")}
                </Button>
              </Drawer.Close>
              <Button
                size="small"
                type="button"
                isLoading={isActionPending}
                disabled={isActionPending}
                onClick={() => {
                  void handleSubmitDrawer()
                }}
              >
                {getDrawerSubmitLabel(actionDrawerMode, isActionPending, t)}
              </Button>
            </div>
          </Drawer.Footer>
        </Drawer.Content>
      </Drawer>
    </div>
  )
}

export default DunningDetailPage

export const handle = {
  breadcrumb: ({ params, data }: UIMatch<DunningCaseAdminDetailResponse>) =>
    params?.id || data?.dunning_case?.id || translate("dunning.breadcrumb"),
}

const DetailRow = ({
  label,
  value,
  mono = false,
}: {
  label: string
  value: ReactNode
  mono?: boolean
}) => {
  return (
    <div className="flex flex-col gap-y-1">
      <Text size="small" leading="compact" className="text-ui-fg-subtle">
        {label}
      </Text>
      <Text
        size="small"
        leading="compact"
        className={mono ? "font-mono whitespace-pre-wrap" : undefined}
      >
        {value}
      </Text>
    </div>
  )
}

function normalizeOptionalString(value: string) {
  const trimmed = value.trim()
  return trimmed.length ? trimmed : undefined
}

function parseIntervals(value: string) {
  return value
    .split(",")
    .map((part) => Number(part.trim()))
    .filter((part) => Number.isInteger(part) && part > 0)
}

function getDrawerTitle(mode: ActionDrawerMode, t: ReorderTranslate) {
  switch (mode) {
    case "mark_recovered":
      return t("dunning.detail.actions.markRecovered")
    case "mark_unrecovered":
      return t("dunning.detail.actions.markUnrecovered")
    case "retry_schedule":
      return t("dunning.detail.actions.editRetrySchedule")
  }
}

function getDrawerSubmitLabel(
  mode: ActionDrawerMode,
  pending: boolean,
  t: ReorderTranslate
) {
  switch (mode) {
    case "mark_recovered":
      return pending
        ? t("dunning.detail.actions.markingRecovered")
        : t("dunning.detail.actions.markRecovered")
    case "mark_unrecovered":
      return pending
        ? t("dunning.detail.actions.markingUnrecovered")
        : t("dunning.detail.actions.markUnrecovered")
    case "retry_schedule":
      return pending
        ? t("dunning.detail.actions.savingSchedule")
        : t("dunning.detail.actions.saveSchedule")
  }
}

function formatDateTime(value: string | null, emptyValue: string) {
  if (!value) {
    return emptyValue
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value))
}

function getCaseStatusColor(status: DunningCaseAdminStatus) {
  switch (status) {
    case DunningCaseAdminStatus.OPEN:
      return "orange"
    case DunningCaseAdminStatus.RETRY_SCHEDULED:
      return "orange"
    case DunningCaseAdminStatus.RETRYING:
      return "blue"
    case DunningCaseAdminStatus.AWAITING_MANUAL_RESOLUTION:
      return "grey"
    case DunningCaseAdminStatus.RECOVERED:
      return "green"
    case DunningCaseAdminStatus.UNRECOVERED:
      return "red"
  }
}

function getAttemptStatusColor(status: DunningAttemptAdminStatus) {
  switch (status) {
    case DunningAttemptAdminStatus.PROCESSING:
      return "blue"
    case DunningAttemptAdminStatus.SUCCEEDED:
      return "green"
    case DunningAttemptAdminStatus.FAILED:
      return "red"
  }
}

function formatSubscriptionStatus(status: string, t: ReorderTranslate) {
  return t(SUBSCRIPTION_STATUS_KEYS[status] ?? status)
}

function formatRenewalStatus(status: string, t: ReorderTranslate) {
  return t(RENEWAL_STATUS_KEYS[status] ?? status)
}

function formatIntervals(intervals: number[], t: ReorderTranslate) {
  return intervals
    .map((interval) => t("dunning.intervals.minuteUnit", { value: interval }))
    .join(", ")
}

function getAdminErrorMessage(error: unknown, fallback: string) {
  if (error instanceof Error) {
    return error.message
  }

  return fallback
}
