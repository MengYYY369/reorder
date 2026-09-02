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
  Select,
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
  PencilSquare,
  Spinner,
  TriangleRightMini,
  XCircle,
} from "@medusajs/icons"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { ReactNode, useEffect, useMemo, useState } from "react"
import { Link, UIMatch, useParams } from "react-router-dom"
import { sdk } from "../../../../lib/client"
import {
  invalidateAdminCancellationQueries,
  useAdminCancellationActionFormQuery,
  useAdminCancellationDetailQuery,
} from "../data-loading"
import {
  CancellationCaseAdminStatus,
  CancellationFinalOutcomeAdmin,
} from "../../../../types/cancellation"
import type {
  ApplyRetentionOfferAdminRequest,
  CancellationAdminOfferEventRecord,
  CancellationCaseAdminDetail,
  CancellationCaseAdminDetailResponse,
  FinalizeCancellationAdminRequest,
  UpdateCancellationReasonAdminRequest,
} from "../../../../types/cancellation"

type ActionDrawerMode = "apply_offer" | "finalize" | "reason"
type OfferType = "pause_offer" | "discount_offer" | "bonus_offer"
type ReasonCategory =
  | "price"
  | "product_fit"
  | "delivery"
  | "billing"
  | "temporary_pause"
  | "switched_competitor"
  | "other"

const terminalStatuses = new Set<CancellationCaseAdminStatus>([
  CancellationCaseAdminStatus.RETAINED,
  CancellationCaseAdminStatus.PAUSED,
  CancellationCaseAdminStatus.CANCELED,
])

const activeDunningStatuses = new Set([
  "open",
  "retry_scheduled",
  "retrying",
  "awaiting_manual_resolution",
])

const CANCELLATION_CASE_STATUS_KEYS: Record<string, string> = {
  requested: "cancellations.caseStatus.requested",
  evaluating_retention: "cancellations.caseStatus.evaluatingRetention",
  retention_offered: "cancellations.caseStatus.retentionOffered",
  retained: "cancellations.caseStatus.retained",
  paused: "cancellations.caseStatus.paused",
  canceled: "cancellations.caseStatus.canceled",
}

const CANCELLATION_OUTCOME_KEYS: Record<string, string> = {
  retained: "cancellations.outcome.retained",
  paused: "cancellations.outcome.paused",
  canceled: "cancellations.outcome.canceled",
}

const CANCELLATION_REASON_CATEGORY_KEYS: Record<string, string> = {
  price: "cancellations.reasonCategory.price",
  product_fit: "cancellations.reasonCategory.productFit",
  delivery: "cancellations.reasonCategory.delivery",
  billing: "cancellations.reasonCategory.billing",
  temporary_pause: "cancellations.reasonCategory.temporaryPause",
  switched_competitor: "cancellations.reasonCategory.switchedCompetitor",
  other: "cancellations.reasonCategory.other",
}

const CANCELLATION_OFFER_TYPE_KEYS: Record<string, string> = {
  pause_offer: "cancellations.offerType.pauseOffer",
  discount_offer: "cancellations.offerType.discountOffer",
  bonus_offer: "cancellations.offerType.bonusOffer",
}

const CANCELLATION_DECISION_STATUS_KEYS: Record<string, string> = {
  proposed: "cancellations.decisionStatus.proposed",
  accepted: "cancellations.decisionStatus.accepted",
  rejected: "cancellations.decisionStatus.rejected",
  applied: "cancellations.decisionStatus.applied",
  expired: "cancellations.decisionStatus.expired",
}

const SUBSCRIPTION_STATUS_KEYS: Record<string, string> = {
  active: "subscriptions.status.active",
  paused: "subscriptions.status.paused",
  cancelled: "subscriptions.status.cancelled",
  past_due: "subscriptions.status.pastDue",
}

const DUNNING_STATUS_KEYS: Record<string, string> = {
  open: "dunning.status.open",
  retry_scheduled: "dunning.status.retryScheduled",
  retrying: "dunning.status.retrying",
  awaiting_manual_resolution: "dunning.status.awaitingManualResolution",
  recovered: "dunning.status.recovered",
  unrecovered: "dunning.status.unrecovered",
}

const RENEWAL_STATUS_KEYS: Record<string, string> = {
  scheduled: "renewals.status.scheduled",
  processing: "renewals.status.processing",
  succeeded: "renewals.status.succeeded",
  failed: "renewals.status.failed",
}

const RENEWAL_APPROVAL_KEYS: Record<string, string> = {
  pending: "renewals.approval.pending",
  approved: "renewals.approval.approved",
  rejected: "renewals.approval.rejected",
}

const CancellationDetailPage = () => {
  const { t } = useTranslation("reorder")
  const { id } = useParams()
  const queryClient = useQueryClient()
  const prompt = usePrompt()
  const [actionDrawerOpen, setActionDrawerOpen] = useState(false)
  const [actionDrawerMode, setActionDrawerMode] =
    useState<ActionDrawerMode>("apply_offer")
  const [formError, setFormError] = useState<string | null>(null)

  const [offerType, setOfferType] = useState<OfferType>("pause_offer")
  const [decisionReason, setDecisionReason] = useState("")
  const [pauseCycles, setPauseCycles] = useState("2")
  const [resumeAt, setResumeAt] = useState("")
  const [discountType, setDiscountType] = useState<"percentage" | "fixed">(
    "percentage"
  )
  const [discountValue, setDiscountValue] = useState("10")
  const [discountDurationCycles, setDiscountDurationCycles] = useState("2")
  const [bonusType, setBonusType] = useState<"free_cycle" | "gift" | "credit">(
    "free_cycle"
  )
  const [bonusValue, setBonusValue] = useState("1")
  const [bonusLabel, setBonusLabel] = useState("")
  const [bonusDurationCycles, setBonusDurationCycles] = useState("1")
  const [offerNote, setOfferNote] = useState("")

  const [reason, setReason] = useState("")
  const [reasonCategory, setReasonCategory] = useState<ReasonCategory | "">("")
  const [notes, setNotes] = useState("")
  const [updateReasonExplanation, setUpdateReasonExplanation] = useState("")
  const [effectiveAt, setEffectiveAt] = useState<"immediately" | "end_of_cycle">(
    "immediately"
  )

  const { data, isLoading, isError, error } = useAdminCancellationDetailQuery(id)
  const cancellation = data?.cancellation
  const { data: actionFormData } = useAdminCancellationActionFormQuery(
    id,
    actionDrawerOpen,
    data
  )
  const actionFormCancellation = actionFormData?.cancellation ?? cancellation
  const isActionFormLoading = actionDrawerOpen && !actionFormData && Boolean(id)
  const eligibleOfferTypes = useMemo(() => {
    const subscriptionStatus = actionFormCancellation?.subscription.status
    const hasActiveDunning = actionFormCancellation?.dunning
      ? activeDunningStatuses.has(actionFormCancellation.dunning.status)
      : false

    if (!subscriptionStatus || subscriptionStatus === "paused") {
      return [] as OfferType[]
    }

    if (subscriptionStatus === "past_due" || hasActiveDunning) {
      return ["pause_offer", "bonus_offer"] as OfferType[]
    }

    return ["pause_offer", "discount_offer", "bonus_offer"] as OfferType[]
  }, [actionFormCancellation])

  const applyOfferMutation = useMutation({
    mutationFn: async (body: ApplyRetentionOfferAdminRequest) =>
      sdk.client.fetch<CancellationCaseAdminDetailResponse>(
        `/admin/cancellations/${id}/apply-offer`,
        {
          method: "POST",
          body,
        }
      ),
    onSuccess: async () => {
      await invalidateAdminCancellationQueries(
        queryClient,
        id,
        cancellation?.subscription.subscription_id
      )
      toast.success(t("cancellations.toast.offerApplied"))
      closeDrawer()
    },
    onError: (mutationError) => {
      const message = getAdminErrorMessage(
        mutationError,
        t("cancellations.errors.applyOfferFailed")
      )
      setFormError(message)
      toast.error(message)
    },
  })

  const finalizeMutation = useMutation({
    mutationFn: async (body: FinalizeCancellationAdminRequest) =>
      sdk.client.fetch<CancellationCaseAdminDetailResponse>(
        `/admin/cancellations/${id}/finalize`,
        {
          method: "POST",
          body,
        }
      ),
    onSuccess: async () => {
      await invalidateAdminCancellationQueries(
        queryClient,
        id,
        cancellation?.subscription.subscription_id
      )
      toast.success(t("cancellations.toast.finalized"))
      closeDrawer()
    },
    onError: (mutationError) => {
      const message = getAdminErrorMessage(
        mutationError,
        t("cancellations.errors.finalizeFailed")
      )
      setFormError(message)
      toast.error(message)
    },
  })

  const updateReasonMutation = useMutation({
    mutationFn: async (body: UpdateCancellationReasonAdminRequest) =>
      sdk.client.fetch<CancellationCaseAdminDetailResponse>(
        `/admin/cancellations/${id}/reason`,
        {
          method: "POST",
          body,
        }
      ),
    onSuccess: async () => {
      await invalidateAdminCancellationQueries(
        queryClient,
        id,
        cancellation?.subscription.subscription_id
      )
      toast.success(t("cancellations.toast.reasonUpdated"))
      closeDrawer()
    },
    onError: (mutationError) => {
      const message = getAdminErrorMessage(
        mutationError,
        t("cancellations.errors.reasonUpdateFailed")
      )
      setFormError(message)
      toast.error(message)
    },
  })

  const metadataRows = useMemo(() => {
    if (!cancellation?.metadata) {
      return []
    }

    return Object.entries(cancellation.metadata).map(([key, value]) => ({
      key,
      value:
        typeof value === "string" ? value : JSON.stringify(value, null, 2),
    }))
  }, [cancellation])

  const canApplyOffer = cancellation
    ? !terminalStatuses.has(cancellation.status)
    : false
  const canFinalize = canApplyOffer
  const canEditReason = canApplyOffer
  const isActionPending =
    applyOfferMutation.isPending ||
    finalizeMutation.isPending ||
    updateReasonMutation.isPending

  const timelineItems = useMemo(() => {
    if (!cancellation) {
      return []
    }

    const items: Array<{
      id: string
      title: string
      date: string | null
      status: string
      color: "grey" | "blue" | "orange" | "green" | "red"
      description: string
    }> = cancellation.offers.map((offer) => ({
      id: offer.id,
      title: formatOfferType(offer.offer_type, t),
      date: offer.applied_at ?? offer.decided_at ?? offer.created_at,
      status: formatOfferDecisionStatus(offer.decision_status, t),
      color: getOfferDecisionColor(offer.decision_status),
      description:
        offer.decision_reason ||
        describeOfferPayload(offer, t) ||
        t("cancellations.detail.timeline.offerEventRecorded"),
    }))

    if (cancellation.final_outcome) {
      items.push({
        id: `${cancellation.id}-final-outcome`,
        title: t("cancellations.detail.timeline.finalOutcome"),
        date: cancellation.finalized_at,
        status: formatFinalOutcome(cancellation.final_outcome, t),
        color: getFinalOutcomeColor(cancellation.final_outcome),
        description:
          cancellation.cancellation_effective_at &&
          cancellation.final_outcome === CancellationFinalOutcomeAdmin.CANCELED
            ? t("cancellations.detail.timeline.effectiveAt", {
                date: formatDateTime(
                  cancellation.cancellation_effective_at,
                  t("common.empty.noValue")
                ),
              })
            : cancellation.notes ||
              t("cancellations.detail.timeline.terminalOutcome"),
      })
    }

    return items.sort((left, right) => {
      const leftValue = left.date ? new Date(left.date).getTime() : 0
      const rightValue = right.date ? new Date(right.date).getTime() : 0
      return leftValue - rightValue
    })
  }, [cancellation, t])

  useEffect(() => {
    if (!actionDrawerOpen || !actionFormCancellation) {
      return
    }

    setFormError(null)

    if (actionDrawerMode === "apply_offer") {
      setOfferType(eligibleOfferTypes[0] ?? "pause_offer")
      setDecisionReason("")
      setPauseCycles("2")
      setResumeAt("")
      setDiscountType("percentage")
      setDiscountValue("10")
      setDiscountDurationCycles("2")
      setBonusType("free_cycle")
      setBonusValue("1")
      setBonusLabel("")
      setBonusDurationCycles("1")
      setOfferNote("")
    }

    if (actionDrawerMode === "finalize") {
      setReason(actionFormCancellation.reason || "")
      setReasonCategory(
        (actionFormCancellation.reason_category as ReasonCategory | null) || ""
      )
      setNotes(actionFormCancellation.notes || "")
      setEffectiveAt("immediately")
    }

    if (actionDrawerMode === "reason") {
      setReason(actionFormCancellation.reason || "")
      setReasonCategory(
        (actionFormCancellation.reason_category as ReasonCategory | null) || ""
      )
      setNotes(actionFormCancellation.notes || "")
      setUpdateReasonExplanation("")
    }
  }, [actionDrawerMode, actionDrawerOpen, actionFormCancellation, eligibleOfferTypes])

  useEffect(() => {
    if (!eligibleOfferTypes.length) {
      return
    }

    if (!eligibleOfferTypes.includes(offerType)) {
      setOfferType(eligibleOfferTypes[0])
    }
  }, [eligibleOfferTypes, offerType])

  const openDrawer = (mode: ActionDrawerMode) => {
    setActionDrawerMode(mode)
    setActionDrawerOpen(true)
  }

  const closeDrawer = () => {
    setActionDrawerOpen(false)
    setFormError(null)
  }

  const handleSubmitDrawer = async () => {
    if (actionDrawerMode === "reason") {
      const normalizedReason = normalizeRequiredString(reason)

      if (!normalizedReason) {
        setFormError(t("cancellations.errors.reasonRequired"))
        toast.error(t("cancellations.errors.reasonRequired"))
        return
      }

      await updateReasonMutation.mutateAsync({
        reason: normalizedReason,
        reason_category: (reasonCategory || undefined) as ReasonCategory | undefined,
        notes: normalizeOptionalString(notes) ?? undefined,
        update_reason: normalizeOptionalString(updateReasonExplanation) ?? undefined,
      })
      return
    }

    if (actionDrawerMode === "apply_offer") {
      if (!eligibleOfferTypes.includes(offerType)) {
        setFormError(t("cancellations.errors.offerNotAllowed"))
        toast.error(t("cancellations.errors.offerNotAllowed"))
        return
      }

      const normalizedDecisionReason = normalizeOptionalString(decisionReason)

      if (offerType === "pause_offer") {
        const normalizedPauseCycles = parseNullablePositiveInt(pauseCycles)
        const normalizedResumeAt = normalizeOptionalString(resumeAt)

        if (normalizedPauseCycles === null && !normalizedResumeAt) {
          setFormError(t("cancellations.errors.pauseOfferRequiresCyclesOrResume"))
          toast.error(t("cancellations.errors.pauseOfferRequiresCyclesOrResume"))
          return
        }

        const confirmed = await prompt({
          title: t("cancellations.prompt.applyPauseTitle"),
          description: t("cancellations.prompt.applyPauseDescription"),
          confirmText: t("cancellations.actions.applyPauseOffer"),
          cancelText: t("common.actions.cancel"),
        })

        if (!confirmed) {
          return
        }

        await applyOfferMutation.mutateAsync({
          offer_type: "pause_offer",
          offer_payload: {
            pause_offer: {
              pause_cycles: normalizedPauseCycles,
              resume_at: normalizedResumeAt
                ? new Date(normalizedResumeAt).toISOString()
                : null,
              note: normalizeOptionalString(offerNote),
            },
          },
          decision_reason: normalizedDecisionReason ?? undefined,
        })
        return
      }

      if (offerType === "discount_offer") {
        const normalizedDiscountValue = parsePositiveNumber(discountValue)
        const normalizedDurationCycles =
          parseNullablePositiveInt(discountDurationCycles)

        if (!normalizedDiscountValue) {
          setFormError(t("cancellations.errors.discountValuePositive"))
          toast.error(t("cancellations.errors.discountValuePositive"))
          return
        }

        const confirmed = await prompt({
          title: t("cancellations.prompt.applyDiscountTitle"),
          description: t("cancellations.prompt.applyDiscountDescription"),
          confirmText: t("cancellations.drawer.applyOfferFooter"),
          cancelText: t("common.actions.cancel"),
        })

        if (!confirmed) {
          return
        }

        await applyOfferMutation.mutateAsync({
          offer_type: "discount_offer",
          offer_payload: {
            discount_offer: {
              discount_type: discountType,
              discount_value: normalizedDiscountValue,
              duration_cycles: normalizedDurationCycles,
              note: normalizeOptionalString(offerNote),
            },
          },
          decision_reason: normalizedDecisionReason ?? undefined,
        })
        return
      }

      const normalizedBonusValue = parseNullableNonNegativeNumber(bonusValue)
      const normalizedBonusDuration =
        parseNullablePositiveInt(bonusDurationCycles)

      if (
        (bonusType === "free_cycle" || bonusType === "credit") &&
        normalizedBonusValue === null
      ) {
        setFormError(t("cancellations.errors.bonusValueRequired"))
        toast.error(t("cancellations.errors.bonusValueRequired"))
        return
      }

      const confirmed = await prompt({
        title: t("cancellations.prompt.applyBonusTitle"),
        description: t("cancellations.prompt.applyBonusDescription"),
        confirmText: t("cancellations.drawer.applyOfferFooter"),
        cancelText: t("common.actions.cancel"),
      })

      if (!confirmed) {
        return
      }

      await applyOfferMutation.mutateAsync({
        offer_type: "bonus_offer",
        offer_payload: {
          bonus_offer: {
            bonus_type: bonusType,
            value: normalizedBonusValue,
            label: normalizeOptionalString(bonusLabel),
            duration_cycles: normalizedBonusDuration,
            note: normalizeOptionalString(offerNote),
          },
        },
        decision_reason: normalizedDecisionReason ?? undefined,
      })
      return
    }

    const normalizedReason = normalizeRequiredString(reason)

    if (!normalizedReason) {
      setFormError(t("cancellations.errors.reasonRequired"))
      toast.error(t("cancellations.errors.reasonRequired"))
      return
    }

    const confirmed = await prompt({
      title: t("cancellations.prompt.finalizeTitle"),
      description: t("cancellations.prompt.finalizeDescription"),
      confirmText: t("cancellations.actions.finalize"),
      cancelText: t("common.actions.cancel"),
    })

    if (!confirmed) {
      return
    }

    await finalizeMutation.mutateAsync({
      reason: normalizedReason,
      reason_category: (reasonCategory || undefined) as ReasonCategory | undefined,
      notes: normalizeOptionalString(notes) ?? undefined,
      effective_at: effectiveAt,
    })
  }

  if (isLoading) {
    return (
      <Container className="divide-y p-0">
        <div className="px-6 py-4">
          <Heading level="h1">{t("cancellations.detail.title")}</Heading>
        </div>
        <div className="flex items-center gap-x-2 px-6 py-6 text-ui-fg-subtle">
          <Spinner className="animate-spin" />
          <Text size="small" leading="compact" className="text-ui-fg-subtle">
            {t("cancellations.detail.loading")}
          </Text>
        </div>
      </Container>
    )
  }

  if (isError) {
    return (
      <Container className="divide-y p-0">
        <div className="px-6 py-4">
          <Heading level="h1">{t("cancellations.detail.title")}</Heading>
        </div>
        <div className="px-6 py-6">
          <Alert variant="error">
            {error instanceof Error
              ? error.message
              : t("cancellations.detail.loadError")}
          </Alert>
        </div>
      </Container>
    )
  }

  if (!cancellation) {
    return (
      <Container className="divide-y p-0">
        <div className="px-6 py-4">
          <Heading level="h1">{t("cancellations.detail.title")}</Heading>
        </div>
        <div className="px-6 py-6">
          <Alert variant="warning">
            {t("cancellations.detail.unavailable")}
          </Alert>
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
              {t("cancellations.detail.header")}
            </Text>
            <Heading level="h1">{cancellation.id}</Heading>
            <Text size="small" leading="compact" className="text-ui-fg-subtle">
              {t("cancellations.detail.description")}
            </Text>
          </div>
          <div className="flex items-center gap-x-2">
            <StatusBadge color={getCaseStatusColor(cancellation.status)}>
              {formatCaseStatus(cancellation.status, t)}
            </StatusBadge>
            <DropdownMenu>
              <DropdownMenu.Trigger asChild>
                <IconButton size="small" variant="transparent" disabled={isActionPending}>
                  <EllipsisHorizontal />
                </IconButton>
              </DropdownMenu.Trigger>
              <DropdownMenu.Content align="end">
                {canApplyOffer ? (
                  <DropdownMenu.Item
                    className="flex items-center gap-x-2"
                    disabled={isActionPending}
                    onClick={() => openDrawer("apply_offer")}
                  >
                    <CheckCircle className="text-ui-fg-subtle" />
                    <span>{t("cancellations.actions.applyOffer")}</span>
                  </DropdownMenu.Item>
                ) : null}
                {canEditReason ? (
                  <DropdownMenu.Item
                    className="flex items-center gap-x-2"
                    disabled={isActionPending}
                    onClick={() => openDrawer("reason")}
                  >
                    <PencilSquare className="text-ui-fg-subtle" />
                    <span>{t("cancellations.actions.editReason")}</span>
                  </DropdownMenu.Item>
                ) : null}
                {canFinalize ? (
                  <>
                    <DropdownMenu.Separator />
                    <DropdownMenu.Item
                      className="flex items-center gap-x-2"
                      disabled={isActionPending}
                      onClick={() => openDrawer("finalize")}
                    >
                      <XCircle className="text-ui-fg-subtle" />
                      <span>{t("cancellations.actions.finalize")}</span>
                    </DropdownMenu.Item>
                  </>
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
              <Heading level="h2">
                {t("cancellations.detail.sections.caseOverview")}
              </Heading>
            </div>
            <div className="px-6 py-4">
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <DetailRow
                  label={t("common.fields.status")}
                  value={(
                    <StatusBadge color={getCaseStatusColor(cancellation.status)}>
                      {formatCaseStatus(cancellation.status, t)}
                    </StatusBadge>
                  )}
                />
                <DetailRow
                  label={t("cancellations.columns.outcome")}
                  value={
                    cancellation.final_outcome
                      ? formatFinalOutcome(cancellation.final_outcome, t)
                      : t("cancellations.detail.empty.noOutcome")
                  }
                />
                <DetailRow
                  label={t("cancellations.columns.reasonCategory")}
                  value={formatReasonCategory(cancellation.reason_category, t)}
                />
                <DetailRow
                  label={t("common.fields.reason")}
                  value={
                    cancellation.reason || t("cancellations.detail.empty.noReason")
                  }
                />
                <DetailRow
                  label={t("cancellations.fields.finalizedBy")}
                  value={
                    cancellation.finalized_by || t("common.empty.noValue")
                  }
                />
                <DetailRow
                  label={t("cancellations.fields.finalizedAt")}
                  value={formatDateTime(
                    cancellation.finalized_at,
                    t("common.empty.noValue")
                  )}
                />
                <DetailRow
                  label={t("cancellations.fields.cancellationEffectiveAt")}
                  value={formatDateTime(
                    cancellation.cancellation_effective_at,
                    t("common.empty.noValue")
                  )}
                />
              </div>
            </div>
          </Container>

          <Container className="divide-y p-0">
            <div className="px-6 py-4">
              <Heading level="h2">
                {t("cancellations.detail.sections.timeline")}
              </Heading>
            </div>
            <div className="px-6 py-4">
              {timelineItems.length ? (
                <div className="flex flex-col gap-y-3">
                  {timelineItems.map((item) => (
                    <div
                      key={item.id}
                      className="rounded-lg border border-ui-border-base p-4"
                    >
                      <div className="flex flex-col gap-y-2 md:flex-row md:items-start md:justify-between">
                        <div className="flex flex-col gap-y-1">
                          <Text size="small" leading="compact" weight="plus">
                            {item.title}
                          </Text>
                          <Text
                            size="small"
                            leading="compact"
                            className="text-ui-fg-subtle"
                          >
                            {item.description}
                          </Text>
                        </div>
                        <div className="flex flex-col items-start gap-y-2 md:items-end">
                          <StatusBadge color={item.color}>{item.status}</StatusBadge>
                          <Text
                            size="small"
                            leading="compact"
                            className="text-ui-fg-subtle"
                          >
                            {formatDateTime(item.date, t("common.empty.noValue"))}
                          </Text>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <Alert variant="info">
                  <Text size="small" leading="compact">
                    {t("cancellations.detail.empty.noTimelineEntries")}
                  </Text>
                </Alert>
              )}
            </div>
          </Container>

          <Container className="divide-y p-0">
            <div className="px-6 py-4">
              <Heading level="h2">
                {t("cancellations.detail.sections.offerHistory")}
              </Heading>
            </div>
            <div className="px-6 py-4">
              {cancellation.offers.length ? (
                <Table>
                  <Table.Header>
                    <Table.Row>
                      <Table.HeaderCell>
                        {t("cancellations.detail.fields.offer")}
                      </Table.HeaderCell>
                      <Table.HeaderCell>
                        {t("common.fields.status")}
                      </Table.HeaderCell>
                      <Table.HeaderCell>
                        {t("cancellations.detail.fields.decided")}
                      </Table.HeaderCell>
                      <Table.HeaderCell>
                        {t("cancellations.detail.fields.applied")}
                      </Table.HeaderCell>
                      <Table.HeaderCell>
                        {t("common.fields.reason")}
                      </Table.HeaderCell>
                    </Table.Row>
                  </Table.Header>
                  <Table.Body>
                    {cancellation.offers.map((offer) => (
                      <Table.Row key={offer.id}>
                        <Table.Cell>
                          <div className="flex flex-col gap-y-1">
                            <Text size="small" leading="compact" weight="plus">
                              {formatOfferType(offer.offer_type, t)}
                            </Text>
                            <Text
                              size="small"
                              leading="compact"
                              className="text-ui-fg-subtle"
                            >
                              {describeOfferPayload(offer, t) ||
                                t("cancellations.detail.empty.noPayloadSummary")}
                            </Text>
                          </div>
                        </Table.Cell>
                        <Table.Cell>
                          <StatusBadge color={getOfferDecisionColor(offer.decision_status)}>
                            {formatOfferDecisionStatus(offer.decision_status, t)}
                          </StatusBadge>
                        </Table.Cell>
                        <Table.Cell>
                          {formatDateTime(
                            offer.decided_at,
                            t("common.empty.noValue")
                          )}
                        </Table.Cell>
                        <Table.Cell>
                          {formatDateTime(
                            offer.applied_at,
                            t("common.empty.noValue")
                          )}
                        </Table.Cell>
                        <Table.Cell>
                          {offer.decision_reason || t("common.empty.noValue")}
                        </Table.Cell>
                      </Table.Row>
                    ))}
                  </Table.Body>
                </Table>
              ) : (
                <Alert variant="info">
                  <Text size="small" leading="compact">
                    {t("cancellations.detail.empty.noOffers")}
                  </Text>
                </Alert>
              )}
            </div>
          </Container>

          <Container className="divide-y p-0">
            <div className="px-6 py-4">
              <Heading level="h2">
                {t("cancellations.detail.sections.metadata")}
              </Heading>
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
                  {t("cancellations.detail.empty.noMetadata")}
                </Text>
              )}
            </div>
          </Container>
        </div>

        <div className="flex min-w-0 flex-col gap-4">
          <Container className="divide-y p-0">
            <div className="px-6 py-4">
              <Heading level="h2">
                {t("cancellations.detail.sections.subscriptionSummary")}
              </Heading>
            </div>
            <div className="px-6 py-4">
              <div className="grid gap-4">
                <Link
                  to={`/subscriptions/${cancellation.subscription.subscription_id}`}
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
                          {cancellation.subscription.reference}
                        </Text>
                        <Text
                          size="small"
                          leading="compact"
                          className="text-ui-fg-subtle"
                        >
                          {cancellation.subscription.customer_name}
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
                  value={formatSubscriptionStatus(
                    cancellation.subscription.status,
                    t
                  )}
                />
                <DetailRow
                  label={t("common.fields.customer")}
                  value={cancellation.subscription.customer_name}
                />
                <DetailRow
                  label={t("common.fields.product")}
                  value={cancellation.subscription.product_title}
                />
                <DetailRow
                  label={t("common.fields.variant")}
                  value={cancellation.subscription.variant_title}
                />
                <DetailRow
                  label={t("common.fields.sku")}
                  value={cancellation.subscription.sku || t("common.empty.noValue")}
                />
                <DetailRow
                  label={t("common.fields.nextRenewal")}
                  value={formatDateTime(
                    cancellation.subscription.next_renewal_at,
                    t("common.empty.noValue")
                  )}
                />
                <DetailRow
                  label={t("cancellations.fields.cancelledAt")}
                  value={formatDateTime(
                    cancellation.subscription.cancelled_at,
                    t("common.empty.noValue")
                  )}
                />
              </div>
            </div>
          </Container>

          <Container className="divide-y p-0">
            <div className="px-6 py-4">
              <Heading level="h2">
                {t("cancellations.detail.sections.linkedDunning")}
              </Heading>
            </div>
            <div className="px-6 py-4">
              <div className="grid gap-4">
                {cancellation.dunning ? (
                  <Link
                    to={`/subscriptions/dunning/${cancellation.dunning.dunning_case_id}`}
                    className="outline-none focus-within:shadow-borders-interactive-with-focus rounded-md [&:hover>div]:bg-ui-bg-component-hover"
                  >
                    <div className="shadow-elevation-card-rest bg-ui-bg-component rounded-md px-4 py-2 transition-colors">
                      <div className="flex items-center gap-3">
                        <div className="shadow-elevation-card-rest flex h-14 w-14 items-center justify-center rounded-md text-ui-fg-muted">
                          <Text size="small" leading="compact" weight="plus">
                            DUN
                          </Text>
                        </div>
                        <div className="flex flex-1 flex-col">
                          <Text size="small" leading="compact" weight="plus">
                            {cancellation.dunning.dunning_case_id}
                          </Text>
                          <Text
                            size="small"
                            leading="compact"
                            className="text-ui-fg-subtle"
                          >
                            {formatDunningStatus(cancellation.dunning.status, t)}
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
                    {t("cancellations.detail.empty.noLinkedDunning")}
                  </Text>
                )}
                <DetailRow
                  label={t("common.fields.status")}
                  value={
                    cancellation.dunning
                      ? formatDunningStatus(cancellation.dunning.status, t)
                      : t("common.empty.noValue")
                  }
                />
                <DetailRow
                  label={t("cancellations.detail.fields.attemptCount")}
                  value={
                    cancellation.dunning?.attempt_count.toString() ||
                    t("common.empty.noValue")
                  }
                />
                <DetailRow
                  label={t("cancellations.detail.fields.nextRetry")}
                  value={formatDateTime(
                    cancellation.dunning?.next_retry_at ?? null,
                    t("common.empty.noValue")
                  )}
                />
                <DetailRow
                  label={t("cancellations.detail.fields.lastError")}
                  value={
                    cancellation.dunning?.last_payment_error_message ||
                    t("common.empty.noValue")
                  }
                />
              </div>
            </div>
          </Container>

          <Container className="divide-y p-0">
            <div className="px-6 py-4">
              <Heading level="h2">
                {t("cancellations.detail.sections.linkedRenewal")}
              </Heading>
            </div>
            <div className="px-6 py-4">
              <div className="grid gap-4">
                {cancellation.renewal ? (
                  <Link
                    to={`/subscriptions/renewals/${cancellation.renewal.renewal_cycle_id}`}
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
                            {cancellation.renewal.renewal_cycle_id}
                          </Text>
                          <Text
                            size="small"
                            leading="compact"
                            className="text-ui-fg-subtle"
                          >
                            {formatRenewalStatus(cancellation.renewal.status, t)}
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
                    {t("cancellations.detail.empty.noLinkedRenewal")}
                  </Text>
                )}
                <DetailRow
                  label={t("common.fields.status")}
                  value={
                    cancellation.renewal
                      ? formatRenewalStatus(cancellation.renewal.status, t)
                      : t("common.empty.noValue")
                  }
                />
                <DetailRow
                  label={t("cancellations.detail.fields.scheduledFor")}
                  value={formatDateTime(
                    cancellation.renewal?.scheduled_for ?? null,
                    t("common.empty.noValue")
                  )}
                />
                <DetailRow
                  label={t("cancellations.detail.fields.approval")}
                  value={
                    cancellation.renewal?.approval_status
                      ? formatApprovalStatus(
                          cancellation.renewal.approval_status,
                          t
                        )
                      : t("common.empty.noValue")
                  }
                />
                <DetailRow
                  label={t("cancellations.detail.fields.generatedOrder")}
                  value={
                    cancellation.renewal?.generated_order_id ||
                    t("common.empty.noValue")
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
            {isActionFormLoading ? (
              <div className="flex items-center gap-x-2 text-ui-fg-subtle">
                <Spinner className="animate-spin" />
                <Text size="small" leading="compact" className="text-ui-fg-subtle">
                  {t("cancellations.drawer.loadingLatest")}
                </Text>
              </div>
            ) : null}
            {formError ? <Alert variant="error">{formError}</Alert> : null}

            {!isActionFormLoading && actionDrawerMode === "reason" ? (
              <ReasonDrawerBody
                reason={reason}
                onReasonChange={setReason}
                reasonCategory={reasonCategory}
                onReasonCategoryChange={setReasonCategory}
                notes={notes}
                onNotesChange={setNotes}
                updateReasonExplanation={updateReasonExplanation}
                onUpdateReasonExplanationChange={setUpdateReasonExplanation}
              />
            ) : null}

            {!isActionFormLoading && actionDrawerMode === "apply_offer" ? (
              <ApplyOfferDrawerBody
                offerType={offerType}
                onOfferTypeChange={setOfferType}
                eligibleOfferTypes={eligibleOfferTypes}
                pauseCycles={pauseCycles}
                onPauseCyclesChange={setPauseCycles}
                resumeAt={resumeAt}
                onResumeAtChange={setResumeAt}
                discountType={discountType}
                onDiscountTypeChange={setDiscountType}
                discountValue={discountValue}
                onDiscountValueChange={setDiscountValue}
                discountDurationCycles={discountDurationCycles}
                onDiscountDurationCyclesChange={setDiscountDurationCycles}
                bonusType={bonusType}
                onBonusTypeChange={setBonusType}
                bonusValue={bonusValue}
                onBonusValueChange={setBonusValue}
                bonusLabel={bonusLabel}
                onBonusLabelChange={setBonusLabel}
                bonusDurationCycles={bonusDurationCycles}
                onBonusDurationCyclesChange={setBonusDurationCycles}
                offerNote={offerNote}
                onOfferNoteChange={setOfferNote}
                decisionReason={decisionReason}
                onDecisionReasonChange={setDecisionReason}
              />
            ) : null}

            {!isActionFormLoading && actionDrawerMode === "finalize" ? (
              <FinalizeDrawerBody
                reason={reason}
                onReasonChange={setReason}
                reasonCategory={reasonCategory}
                onReasonCategoryChange={setReasonCategory}
                notes={notes}
                onNotesChange={setNotes}
                effectiveAt={effectiveAt}
                onEffectiveAtChange={setEffectiveAt}
              />
            ) : null}
          </Drawer.Body>
          <Drawer.Footer>
            <div className="flex items-center justify-end gap-x-2">
              <Drawer.Close asChild>
                <Button
                  size="small"
                  variant="secondary"
                  type="button"
                  disabled={
                    isActionFormLoading ||
                    applyOfferMutation.isPending ||
                    finalizeMutation.isPending ||
                    updateReasonMutation.isPending
                  }
                >
                  {t("common.actions.cancel")}
                </Button>
              </Drawer.Close>
              <Button
                size="small"
                type="button"
                onClick={() => {
                  void handleSubmitDrawer()
                }}
                isLoading={
                  actionDrawerMode === "apply_offer"
                    ? applyOfferMutation.isPending
                    : actionDrawerMode === "finalize"
                      ? finalizeMutation.isPending
                      : updateReasonMutation.isPending
                }
                disabled={
                  isActionFormLoading ||
                  applyOfferMutation.isPending ||
                  finalizeMutation.isPending ||
                  updateReasonMutation.isPending
                }
              >
                {actionDrawerMode === "apply_offer"
                  ? t("cancellations.drawer.applyOfferFooter")
                  : actionDrawerMode === "finalize"
                    ? t("cancellations.drawer.continueFooter")
                    : t("common.actions.save")}
              </Button>
            </div>
          </Drawer.Footer>
        </Drawer.Content>
      </Drawer>
    </div>
  )
}

export default CancellationDetailPage

export const handle = {
  breadcrumb: ({ params, data }: UIMatch<CancellationCaseAdminDetailResponse>) =>
    params?.id || data?.cancellation?.id || translate("cancellations.breadcrumb"),
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

const ReasonDrawerBody = ({
  reason,
  onReasonChange,
  reasonCategory,
  onReasonCategoryChange,
  notes,
  onNotesChange,
  updateReasonExplanation,
  onUpdateReasonExplanationChange,
}: {
  reason: string
  onReasonChange: (value: string) => void
  reasonCategory: ReasonCategory | ""
  onReasonCategoryChange: (value: ReasonCategory) => void
  notes: string
  onNotesChange: (value: string) => void
  updateReasonExplanation: string
  onUpdateReasonExplanationChange: (value: string) => void
}) => {
  const { t } = useTranslation("reorder")
  const reasonCategoryOptions = buildReasonCategoryOptions(t)

  return (
    <div className="grid gap-4">
      <div className="grid gap-2">
        <Label htmlFor="cancellation-reason">{t("common.fields.reason")}</Label>
        <Textarea
          id="cancellation-reason"
          value={reason}
          onChange={(event) => onReasonChange(event.target.value)}
          placeholder={t("cancellations.drawer.captureChurnReason")}
        />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="cancellation-reason-category">
          {t("cancellations.columns.reasonCategory")}
        </Label>
        <Select
          value={reasonCategory}
          onValueChange={(value) => onReasonCategoryChange(value as ReasonCategory)}
        >
          <Select.Trigger id="cancellation-reason-category">
            <Select.Value placeholder={t("cancellations.drawer.selectCategory")} />
          </Select.Trigger>
          <Select.Content>
            {reasonCategoryOptions.map((option) => (
              <Select.Item key={option.value} value={option.value}>
                {option.label}
              </Select.Item>
            ))}
          </Select.Content>
        </Select>
      </div>
      <div className="grid gap-2">
        <Label htmlFor="cancellation-notes">
          {t("cancellations.drawer.notes")}
        </Label>
        <Textarea
          id="cancellation-notes"
          value={notes}
          onChange={(event) => onNotesChange(event.target.value)}
          placeholder={t("cancellations.drawer.optionalOperatorNotes")}
        />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="reason-update-explanation">
          {t("cancellations.drawer.changeReason")}
        </Label>
        <Input
          id="reason-update-explanation"
          value={updateReasonExplanation}
          onChange={(event) => onUpdateReasonExplanationChange(event.target.value)}
          placeholder={t("cancellations.drawer.optionalUpdateExplanation")}
        />
      </div>
    </div>
  )
}

const ApplyOfferDrawerBody = ({
  offerType,
  onOfferTypeChange,
  eligibleOfferTypes,
  pauseCycles,
  onPauseCyclesChange,
  resumeAt,
  onResumeAtChange,
  discountType,
  onDiscountTypeChange,
  discountValue,
  onDiscountValueChange,
  discountDurationCycles,
  onDiscountDurationCyclesChange,
  bonusType,
  onBonusTypeChange,
  bonusValue,
  onBonusValueChange,
  bonusLabel,
  onBonusLabelChange,
  bonusDurationCycles,
  onBonusDurationCyclesChange,
  offerNote,
  onOfferNoteChange,
  decisionReason,
  onDecisionReasonChange,
}: {
  offerType: OfferType
  onOfferTypeChange: (value: OfferType) => void
  eligibleOfferTypes: OfferType[]
  pauseCycles: string
  onPauseCyclesChange: (value: string) => void
  resumeAt: string
  onResumeAtChange: (value: string) => void
  discountType: "percentage" | "fixed"
  onDiscountTypeChange: (value: "percentage" | "fixed") => void
  discountValue: string
  onDiscountValueChange: (value: string) => void
  discountDurationCycles: string
  onDiscountDurationCyclesChange: (value: string) => void
  bonusType: "free_cycle" | "gift" | "credit"
  onBonusTypeChange: (value: "free_cycle" | "gift" | "credit") => void
  bonusValue: string
  onBonusValueChange: (value: string) => void
  bonusLabel: string
  onBonusLabelChange: (value: string) => void
  bonusDurationCycles: string
  onBonusDurationCyclesChange: (value: string) => void
  offerNote: string
  onOfferNoteChange: (value: string) => void
  decisionReason: string
  onDecisionReasonChange: (value: string) => void
}) => {
  const { t } = useTranslation("reorder")
  const offerTypeOptions = buildOfferTypeOptions(t).filter((option) =>
    eligibleOfferTypes.includes(option.value)
  )
  const discountTypeOptions = [
    { label: t("cancellations.drawer.percentage"), value: "percentage" },
    { label: t("cancellations.drawer.fixed"), value: "fixed" },
  ] as const
  const bonusTypeOptions = [
    { label: t("cancellations.drawer.freeCycle"), value: "free_cycle" },
    { label: t("cancellations.drawer.gift"), value: "gift" },
    { label: t("cancellations.drawer.credit"), value: "credit" },
  ] as const

  return (
    <div className="grid gap-4">
      <div className="grid gap-2">
        <Label htmlFor="offer-type">{t("cancellations.fields.offerType")}</Label>
        <Select
          value={offerType}
          onValueChange={(value) => onOfferTypeChange(value as OfferType)}
        >
          <Select.Trigger id="offer-type">
            <Select.Value placeholder={t("cancellations.drawer.selectOfferType")} />
          </Select.Trigger>
          <Select.Content>
            {offerTypeOptions.map((option) => (
              <Select.Item key={option.value} value={option.value}>
                {option.label}
              </Select.Item>
            ))}
          </Select.Content>
        </Select>
        {!offerTypeOptions.length ? (
          <Text size="small" leading="compact" className="text-ui-fg-subtle">
            {t("cancellations.drawer.noOffersAvailable")}
          </Text>
        ) : null}
      </div>

      {offerType === "pause_offer" ? (
        <div className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="pause-cycles">
              {t("cancellations.drawer.pauseCycles")}
            </Label>
            <Input
              id="pause-cycles"
              type="number"
              min={1}
              step={1}
              value={pauseCycles}
              onChange={(event) => onPauseCyclesChange(event.target.value)}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="resume-at">{t("cancellations.drawer.resumeAt")}</Label>
            <Input
              id="resume-at"
              type="datetime-local"
              value={resumeAt}
              onChange={(event) => onResumeAtChange(event.target.value)}
            />
          </div>
        </div>
      ) : null}

      {offerType === "discount_offer" ? (
        <div className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="discount-type">
              {t("cancellations.drawer.discountType")}
            </Label>
            <Select
              value={discountType}
              onValueChange={(value) =>
                onDiscountTypeChange(value as "percentage" | "fixed")
              }
            >
              <Select.Trigger id="discount-type">
                <Select.Value />
              </Select.Trigger>
              <Select.Content>
                {discountTypeOptions.map((option) => (
                  <Select.Item key={option.value} value={option.value}>
                    {option.label}
                  </Select.Item>
                ))}
              </Select.Content>
            </Select>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="discount-value">
              {t("cancellations.drawer.discountValue")}
            </Label>
            <Input
              id="discount-value"
              type="number"
              min={0}
              step="0.01"
              value={discountValue}
              onChange={(event) => onDiscountValueChange(event.target.value)}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="discount-duration-cycles">
              {t("cancellations.drawer.durationCycles")}
            </Label>
            <Input
              id="discount-duration-cycles"
              type="number"
              min={1}
              step={1}
              value={discountDurationCycles}
              onChange={(event) =>
                onDiscountDurationCyclesChange(event.target.value)
              }
            />
          </div>
        </div>
      ) : null}

      {offerType === "bonus_offer" ? (
        <div className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="bonus-type">
              {t("cancellations.drawer.bonusType")}
            </Label>
            <Select
              value={bonusType}
              onValueChange={(value) =>
                onBonusTypeChange(value as "free_cycle" | "gift" | "credit")
              }
            >
              <Select.Trigger id="bonus-type">
                <Select.Value />
              </Select.Trigger>
              <Select.Content>
                {bonusTypeOptions.map((option) => (
                  <Select.Item key={option.value} value={option.value}>
                    {option.label}
                  </Select.Item>
                ))}
              </Select.Content>
            </Select>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="bonus-value">
              {t("cancellations.drawer.bonusValue")}
            </Label>
            <Input
              id="bonus-value"
              type="number"
              min={0}
              step="0.01"
              value={bonusValue}
              onChange={(event) => onBonusValueChange(event.target.value)}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="bonus-label">{t("cancellations.drawer.label")}</Label>
            <Input
              id="bonus-label"
              value={bonusLabel}
              onChange={(event) => onBonusLabelChange(event.target.value)}
              placeholder={t("cancellations.drawer.optionalLabel")}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="bonus-duration-cycles">
              {t("cancellations.drawer.durationCycles")}
            </Label>
            <Input
              id="bonus-duration-cycles"
              type="number"
              min={1}
              step={1}
              value={bonusDurationCycles}
              onChange={(event) => onBonusDurationCyclesChange(event.target.value)}
            />
          </div>
        </div>
      ) : null}

      <div className="grid gap-2">
        <Label htmlFor="offer-note">{t("cancellations.drawer.offerNote")}</Label>
        <Textarea
          id="offer-note"
          value={offerNote}
          onChange={(event) => onOfferNoteChange(event.target.value)}
          placeholder={t("cancellations.drawer.offerNotePlaceholder")}
        />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="decision-reason">
          {t("cancellations.drawer.decisionReason")}
        </Label>
        <Textarea
          id="decision-reason"
          value={decisionReason}
          onChange={(event) => onDecisionReasonChange(event.target.value)}
          placeholder={t("cancellations.drawer.decisionReasonPlaceholder")}
        />
      </div>
    </div>
  )
}

const FinalizeDrawerBody = ({
  reason,
  onReasonChange,
  reasonCategory,
  onReasonCategoryChange,
  notes,
  onNotesChange,
  effectiveAt,
  onEffectiveAtChange,
}: {
  reason: string
  onReasonChange: (value: string) => void
  reasonCategory: ReasonCategory | ""
  onReasonCategoryChange: (value: ReasonCategory) => void
  notes: string
  onNotesChange: (value: string) => void
  effectiveAt: "immediately" | "end_of_cycle"
  onEffectiveAtChange: (value: "immediately" | "end_of_cycle") => void
}) => {
  const { t } = useTranslation("reorder")
  const reasonCategoryOptions = buildReasonCategoryOptions(t)
  const effectiveAtOptions = [
    { label: t("cancellations.drawer.immediately"), value: "immediately" },
    { label: t("cancellations.drawer.endOfCycle"), value: "end_of_cycle" },
  ] as const

  return (
    <div className="grid gap-4">
      <div className="grid gap-2">
        <Label htmlFor="finalize-reason">{t("common.fields.reason")}</Label>
        <Textarea
          id="finalize-reason"
          value={reason}
          onChange={(event) => onReasonChange(event.target.value)}
          placeholder={t("cancellations.drawer.reasonRequiredHint")}
        />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="finalize-reason-category">
          {t("cancellations.columns.reasonCategory")}
        </Label>
        <Select
          value={reasonCategory}
          onValueChange={(value) => onReasonCategoryChange(value as ReasonCategory)}
        >
          <Select.Trigger id="finalize-reason-category">
            <Select.Value placeholder={t("cancellations.drawer.selectCategory")} />
          </Select.Trigger>
          <Select.Content>
            {reasonCategoryOptions.map((option) => (
              <Select.Item key={option.value} value={option.value}>
                {option.label}
              </Select.Item>
            ))}
          </Select.Content>
        </Select>
      </div>
      <div className="grid gap-2">
        <Label htmlFor="finalize-notes">
          {t("cancellations.drawer.notes")}
        </Label>
        <Textarea
          id="finalize-notes"
          value={notes}
          onChange={(event) => onNotesChange(event.target.value)}
          placeholder={t("cancellations.drawer.optionalFinalNotes")}
        />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="effective-at">
          {t("cancellations.drawer.effectiveAt")}
        </Label>
        <Select
          value={effectiveAt}
          onValueChange={(value) =>
            onEffectiveAtChange(value as "immediately" | "end_of_cycle")
          }
        >
          <Select.Trigger id="effective-at">
            <Select.Value />
          </Select.Trigger>
          <Select.Content>
            {effectiveAtOptions.map((option) => (
              <Select.Item key={option.value} value={option.value}>
                {option.label}
              </Select.Item>
            ))}
          </Select.Content>
        </Select>
      </div>
    </div>
  )
}

function buildReasonCategoryOptions(t: ReorderTranslate) {
  return Object.entries(CANCELLATION_REASON_CATEGORY_KEYS).map(
    ([value, key]) => ({
      value: value as ReasonCategory,
      label: t(key),
    })
  )
}

function buildOfferTypeOptions(t: ReorderTranslate) {
  return Object.entries(CANCELLATION_OFFER_TYPE_KEYS).map(([value, key]) => ({
    value: value as OfferType,
    label: t(key),
  }))
}

function normalizeOptionalString(value: string) {
  const trimmed = value.trim()
  return trimmed.length ? trimmed : null
}

function normalizeRequiredString(value: string) {
  const trimmed = value.trim()
  return trimmed.length ? trimmed : null
}

function parseNullablePositiveInt(value: string) {
  const normalized = normalizeOptionalString(value)

  if (!normalized) {
    return null
  }

  const parsed = Number(normalized)

  if (!Number.isInteger(parsed) || parsed <= 0) {
    return null
  }

  return parsed
}

function parsePositiveNumber(value: string) {
  const normalized = normalizeOptionalString(value)

  if (!normalized) {
    return null
  }

  const parsed = Number(normalized)

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null
  }

  return parsed
}

function parseNullableNonNegativeNumber(value: string) {
  const normalized = normalizeOptionalString(value)

  if (!normalized) {
    return null
  }

  const parsed = Number(normalized)

  if (!Number.isFinite(parsed) || parsed < 0) {
    return null
  }

  return parsed
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

function getDrawerTitle(mode: ActionDrawerMode, t: ReorderTranslate) {
  switch (mode) {
    case "apply_offer":
      return t("cancellations.actions.applyOffer")
    case "finalize":
      return t("cancellations.actions.finalize")
    case "reason":
      return t("cancellations.drawer.updateReason")
  }
}

function formatCaseStatus(
  status: CancellationCaseAdminStatus,
  t: ReorderTranslate
) {
  return t(CANCELLATION_CASE_STATUS_KEYS[status] ?? status)
}

function getCaseStatusColor(status: CancellationCaseAdminStatus) {
  switch (status) {
    case "requested":
      return "grey"
    case "evaluating_retention":
      return "blue"
    case "retention_offered":
      return "orange"
    case "retained":
      return "green"
    case "paused":
      return "orange"
    case "canceled":
      return "red"
  }
}

function formatFinalOutcome(
  value: CancellationFinalOutcomeAdmin,
  t: ReorderTranslate
) {
  return t(CANCELLATION_OUTCOME_KEYS[value] ?? value)
}

function getFinalOutcomeColor(value: CancellationFinalOutcomeAdmin) {
  switch (value) {
    case "retained":
      return "green"
    case "paused":
      return "orange"
    case "canceled":
      return "red"
  }
}

function formatReasonCategory(value: string | null, t: ReorderTranslate) {
  if (!value) {
    return t("cancellations.reasonCategory.unclassified")
  }

  return t(CANCELLATION_REASON_CATEGORY_KEYS[value] ?? titleCaseIdentifier(value))
}

function titleCaseIdentifier(value: string) {
  return value
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ")
}

function formatSubscriptionStatus(
  status: CancellationCaseAdminDetail["subscription"]["status"],
  t: ReorderTranslate
) {
  return t(SUBSCRIPTION_STATUS_KEYS[status] ?? status)
}

function formatDunningStatus(
  status: NonNullable<CancellationCaseAdminDetail["dunning"]>["status"],
  t: ReorderTranslate
) {
  return t(DUNNING_STATUS_KEYS[status] ?? status)
}

function formatRenewalStatus(
  status: NonNullable<CancellationCaseAdminDetail["renewal"]>["status"],
  t: ReorderTranslate
) {
  return t(RENEWAL_STATUS_KEYS[status] ?? status)
}

function formatApprovalStatus(
  status: NonNullable<CancellationCaseAdminDetail["renewal"]>["approval_status"],
  t: ReorderTranslate
) {
  return t(RENEWAL_APPROVAL_KEYS[status] ?? status)
}

function formatOfferType(
  offerType: CancellationAdminOfferEventRecord["offer_type"],
  t: ReorderTranslate
) {
  return t(CANCELLATION_OFFER_TYPE_KEYS[offerType] ?? offerType)
}

function formatOfferDecisionStatus(
  status: CancellationAdminOfferEventRecord["decision_status"],
  t: ReorderTranslate
) {
  return t(CANCELLATION_DECISION_STATUS_KEYS[status] ?? status)
}

function getOfferDecisionColor(
  status: CancellationAdminOfferEventRecord["decision_status"]
) {
  switch (status) {
    case "proposed":
      return "grey"
    case "accepted":
      return "blue"
    case "rejected":
      return "red"
    case "applied":
      return "green"
    case "expired":
      return "orange"
  }
}

// Documented i18n exception: offer payload summary fragments intentionally
// remain in English. Only the empty-value placeholder for the embedded
// datetime formatting is localized via `t`.
function describeOfferPayload(
  offer: CancellationAdminOfferEventRecord,
  t: ReorderTranslate
) {
  const payload = offer.offer_payload

  if (!payload) {
    return null
  }

  if ("pause_offer" in payload && payload.pause_offer) {
    const value = payload.pause_offer as {
      pause_cycles?: number | null
      resume_at?: string | null
      note?: string | null
    }

    return [
      value.pause_cycles ? `${value.pause_cycles} cycles` : null,
      value.resume_at
        ? `resume ${formatDateTime(value.resume_at, t("common.empty.noValue"))}`
        : null,
      value.note ?? null,
    ]
      .filter(Boolean)
      .join(" · ")
  }

  if ("discount_offer" in payload && payload.discount_offer) {
    const value = payload.discount_offer as {
      discount_type?: string
      discount_value?: number
      duration_cycles?: number | null
      note?: string | null
    }

    return [
      value.discount_value !== undefined
        ? `${value.discount_value} ${value.discount_type === "percentage" ? "%" : "fixed"}`
        : null,
      value.duration_cycles ? `${value.duration_cycles} cycles` : null,
      value.note ?? null,
    ]
      .filter(Boolean)
      .join(" · ")
  }

  if ("bonus_offer" in payload && payload.bonus_offer) {
    const value = payload.bonus_offer as {
      bonus_type?: string
      value?: number | null
      label?: string | null
      duration_cycles?: number | null
      note?: string | null
    }

    return [
      value.bonus_type ?? null,
      value.value !== null && value.value !== undefined ? `${value.value}` : null,
      value.label ?? null,
      value.duration_cycles ? `${value.duration_cycles} cycles` : null,
      value.note ?? null,
    ]
      .filter(Boolean)
      .join(" · ")
  }

  return null
}

function getAdminErrorMessage(error: unknown, fallback: string) {
  if (error instanceof Error) {
    return error.message
  }

  return fallback
}
