import { defineRouteConfig } from "@medusajs/admin-sdk";
import { translate, type ReorderTranslate } from "../../../../i18n/translate";
import { useTranslation } from "react-i18next";
import {
  Alert,
  Button,
  Container,
  Drawer,
  DropdownMenu,
  Heading,
  IconButton,
  Label,
  Select,
  StatusBadge,
  Table,
  Text,
  Textarea,
  toast,
  usePrompt,
} from "@medusajs/ui";
import {
  CheckCircle,
  EllipsisHorizontal,
  ShoppingBag,
  Spinner,
  Trash,
  TriangleRightMini,
  XCircle,
} from "@medusajs/icons";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ReactNode, useMemo, useState } from "react";
import { Link, UIMatch, useNavigate, useParams } from "react-router-dom";
import { sdk } from "../../../../lib/client";
import {
  invalidateAdminRenewalsQueries,
  useAdminRenewalDetailQuery,
} from "../data-loading";
import {
  ApproveRenewalChangesAdminRequest,
  ForceRenewalAdminRequest,
  RejectRenewalChangesAdminRequest,
  RenewalAdminApprovalSummary,
  RenewalApprovalStatus,
  RenewalAttemptAdminStatus,
  RenewalCycleAdminDetail,
  RenewalCycleAdminDetailResponse,
  RenewalCycleAdminStatus,
  RenewalStuckResolutionOutcome,
  ResolveStuckRenewalAdminRequest,
} from "../../../../types/renewal";

const forceableStatuses = new Set<RenewalCycleAdminStatus>([
  RenewalCycleAdminStatus.SCHEDULED,
  RenewalCycleAdminStatus.FAILED,
]);

// Cycles a stuck-resolution can act on: a crashed `processing` run and a cycle
// the reconciliation parked for a human. Mirrors the workflow's own accepted
// statuses; the route refuses everything else.
const stuckResolvableStatuses = new Set<RenewalCycleAdminStatus>([
  RenewalCycleAdminStatus.PROCESSING,
  RenewalCycleAdminStatus.AWAITING_MANUAL_RESOLUTION,
]);

// Cycles nothing will ever run again for; mirrors the delete workflow's own
// accepted statuses. Attempts are deletable on the same split.
const deletableStatuses = new Set<RenewalCycleAdminStatus>([
  RenewalCycleAdminStatus.SUCCEEDED,
  RenewalCycleAdminStatus.FAILED,
  RenewalCycleAdminStatus.ABANDONED,
]);

const deletableAttemptStatuses = new Set<RenewalAttemptAdminStatus>([
  RenewalAttemptAdminStatus.SUCCEEDED,
  RenewalAttemptAdminStatus.FAILED,
]);

const STUCK_RESOLUTION_OUTCOME_KEYS: Record<
  RenewalStuckResolutionOutcome,
  string
> = {
  succeeded: "renewals.detail.outcome.succeeded",
  failed: "renewals.detail.outcome.failed",
  abandoned: "renewals.detail.outcome.abandoned",
};

type DecisionDrawerMode = "approve" | "reject";

const RENEWAL_CYCLE_STATUS_KEYS = {
  [RenewalCycleAdminStatus.SCHEDULED]: "renewals.status.scheduled",
  [RenewalCycleAdminStatus.PROCESSING]: "renewals.status.processing",
  [RenewalCycleAdminStatus.SUCCEEDED]: "renewals.status.succeeded",
  [RenewalCycleAdminStatus.FAILED]: "renewals.status.failed",
  [RenewalCycleAdminStatus.ABANDONED]: "renewals.status.abandoned",
  [RenewalCycleAdminStatus.AWAITING_MANUAL_RESOLUTION]:
    "renewals.status.awaitingManualResolution",
} as const;

const RENEWAL_ATTEMPT_STATUS_KEYS = {
  [RenewalAttemptAdminStatus.PROCESSING]: "renewals.attemptStatus.processing",
  [RenewalAttemptAdminStatus.SUCCEEDED]: "renewals.attemptStatus.succeeded",
  [RenewalAttemptAdminStatus.FAILED]: "renewals.attemptStatus.failed",
} as const;

const SUBSCRIPTION_STATUS_KEYS: Record<string, string> = {
  active: "subscriptions.status.active",
  paused: "subscriptions.status.paused",
  cancelled: "subscriptions.status.cancelled",
  past_due: "subscriptions.status.pastDue",
};

const RENEWAL_INTERVAL_KEYS: Record<string, string> = {
  week: "common.intervals.week",
  month: "common.intervals.month",
  year: "common.intervals.year",
};

const RenewalDetailPage = () => {
  const { t } = useTranslation("reorder");
  const { id } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const prompt = usePrompt();
  const [decisionDrawerOpen, setDecisionDrawerOpen] = useState(false);
  const [decisionMode, setDecisionMode] = useState<DecisionDrawerMode>("approve");
  const [decisionReason, setDecisionReason] = useState("");
  const [decisionError, setDecisionError] = useState<string | null>(null);
  const [resolveDrawerOpen, setResolveDrawerOpen] = useState(false);
  const [resolveOutcome, setResolveOutcome] =
    useState<RenewalStuckResolutionOutcome>("succeeded");
  const [resolveReason, setResolveReason] = useState("");
  const [resolveError, setResolveError] = useState<string | null>(null);

  const { data, isLoading, isError, error } = useAdminRenewalDetailQuery(id);
  const renewal = data?.renewal;

  const forceMutation = useMutation({
    mutationFn: async (body: ForceRenewalAdminRequest) =>
      sdk.client.fetch<RenewalCycleAdminDetailResponse>(
        `/admin/renewals/${id}/force`,
        {
          method: "POST",
          body,
        }
      ),
    onSuccess: async () => {
      await invalidateAdminRenewalsQueries(
        queryClient,
        id,
        renewal?.subscription.subscription_id
      );
      toast.success(t("renewals.detail.toast.forced"));
    },
    onError: (mutationError) => {
      toast.error(
        getAdminErrorMessage(mutationError, t("renewals.detail.errors.forceFailed"))
      );
    },
  });

  const approveMutation = useMutation({
    mutationFn: async (body: ApproveRenewalChangesAdminRequest) =>
      sdk.client.fetch<RenewalCycleAdminDetailResponse>(
        `/admin/renewals/${id}/approve-changes`,
        {
          method: "POST",
          body,
        }
      ),
    onSuccess: async () => {
      await invalidateAdminRenewalsQueries(
        queryClient,
        id,
        renewal?.subscription.subscription_id
      );
      toast.success(t("renewals.detail.toast.approved"));
      setDecisionDrawerOpen(false);
      setDecisionReason("");
      setDecisionError(null);
    },
    onError: (mutationError) => {
      const message = getAdminErrorMessage(
        mutationError,
        t("renewals.detail.errors.approveFailed")
      );

      setDecisionError(message);
      toast.error(message);
    },
  });

  const rejectMutation = useMutation({
    mutationFn: async (body: RejectRenewalChangesAdminRequest) =>
      sdk.client.fetch<RenewalCycleAdminDetailResponse>(
        `/admin/renewals/${id}/reject-changes`,
        {
          method: "POST",
          body,
        }
      ),
    onSuccess: async () => {
      await invalidateAdminRenewalsQueries(
        queryClient,
        id,
        renewal?.subscription.subscription_id
      );
      toast.success(t("renewals.detail.toast.rejected"));
      setDecisionDrawerOpen(false);
      setDecisionReason("");
      setDecisionError(null);
    },
    onError: (mutationError) => {
      const message = getAdminErrorMessage(
        mutationError,
        t("renewals.detail.errors.rejectFailed")
      );

      setDecisionError(message);
      toast.error(message);
    },
  });

  const resolveStuckMutation = useMutation({
    mutationFn: async (body: ResolveStuckRenewalAdminRequest) =>
      sdk.client.fetch<RenewalCycleAdminDetailResponse>(
        `/admin/renewals/${id}/resolve-stuck`,
        {
          method: "POST",
          body,
        }
      ),
    onSuccess: async () => {
      await invalidateAdminRenewalsQueries(
        queryClient,
        id,
        renewal?.subscription.subscription_id
      );
      toast.success(t("renewals.detail.toast.resolved"));
      setResolveDrawerOpen(false);
      setResolveReason("");
      setResolveOutcome("succeeded");
      setResolveError(null);
    },
    onError: (mutationError) => {
      const message = getAdminErrorMessage(
        mutationError,
        t("renewals.detail.errors.resolveFailed")
      );

      setResolveError(message);
      toast.error(message);
    },
  });

  const deleteCycleMutation = useMutation({
    mutationFn: async () =>
      sdk.client.fetch(`/admin/renewals/${id}/delete`, {
        method: "POST",
        body: {},
      }),
    onSuccess: async () => {
      await invalidateAdminRenewalsQueries(queryClient);
      toast.success(t("renewals.detail.toast.deleted"));
      navigate("/subscriptions/renewals");
    },
    onError: (mutationError) => {
      toast.error(
        getAdminErrorMessage(
          mutationError,
          t("renewals.detail.errors.deleteFailed")
        )
      );
    },
  });

  const deleteAttemptMutation = useMutation({
    mutationFn: async (attemptId: string) =>
      sdk.client.fetch(`/admin/renewals/${id}/attempts/${attemptId}/delete`, {
        method: "POST",
        body: {},
      }),
    onSuccess: async () => {
      await invalidateAdminRenewalsQueries(
        queryClient,
        id,
        renewal?.subscription.subscription_id
      );
      toast.success(t("renewals.detail.toast.attemptDeleted"));
    },
    onError: (mutationError) => {
      toast.error(
        getAdminErrorMessage(
          mutationError,
          t("renewals.detail.errors.attemptDeleteFailed")
        )
      );
    },
  });

  const canForce = renewal ? forceableStatuses.has(renewal.status) : false;
  const canResolveStuck = renewal
    ? stuckResolvableStatuses.has(renewal.status)
    : false;
  const canDecideApproval = renewal
    ? renewal.approval.required &&
      renewal.approval.status === RenewalApprovalStatus.PENDING
    : false;
  const canDeleteCycle = renewal ? deletableStatuses.has(renewal.status) : false;
  const isActionPending =
    forceMutation.isPending ||
    approveMutation.isPending ||
    rejectMutation.isPending ||
    resolveStuckMutation.isPending ||
    deleteCycleMutation.isPending ||
    deleteAttemptMutation.isPending;

  const metadataRows = useMemo(() => {
    if (!renewal?.metadata) {
      return [];
    }

    return Object.entries(renewal.metadata).map(([key, value]) => ({
      key,
      value:
        typeof value === "string" ? value : JSON.stringify(value, null, 2),
    }));
  }, [renewal]);

  const handleForceRenewal = async () => {
    const confirmed = await prompt({
      title: t("renewals.detail.prompt.forceTitle"),
      description: t("renewals.detail.prompt.forceDescription"),
      confirmText: t("renewals.detail.actions.forceRenewal"),
      cancelText: t("common.actions.cancel"),
    });

    if (!confirmed) {
      return;
    }

    await forceMutation.mutateAsync({
      reason: undefined,
    });
  };

  const handleDeleteCycle = async () => {
    const confirmed = await prompt({
      title: t("renewals.detail.prompt.deleteTitle"),
      description: t("renewals.detail.prompt.deleteDescription"),
      confirmText: t("renewals.detail.actions.deleteCycle"),
      cancelText: t("common.actions.cancel"),
    });

    if (!confirmed) {
      return;
    }

    await deleteCycleMutation.mutateAsync();
  };

  const handleDeleteAttempt = async (attemptId: string) => {
    const confirmed = await prompt({
      title: t("renewals.detail.prompt.attemptDeleteTitle"),
      description: t("renewals.detail.prompt.attemptDeleteDescription"),
      confirmText: t("renewals.detail.actions.deleteAttempt"),
      cancelText: t("common.actions.cancel"),
    });

    if (!confirmed) {
      return;
    }

    await deleteAttemptMutation.mutateAsync(attemptId);
  };

  const openDecisionDrawer = (mode: DecisionDrawerMode) => {
    setDecisionMode(mode);
    setDecisionReason("");
    setDecisionError(null);
    setDecisionDrawerOpen(true);
  };

  const handleSubmitDecision = async () => {
    const normalizedReason = normalizeOptionalString(decisionReason);

    if (decisionMode === "reject" && !normalizedReason) {
      setDecisionError(t("renewals.detail.errors.reasonRequired"));
      toast.error(t("renewals.detail.errors.reasonRequired"));
      return;
    }

    setDecisionError(null);

    const confirmed = await prompt({
      title:
        decisionMode === "approve"
          ? t("renewals.detail.prompt.approveTitle")
          : t("renewals.detail.prompt.rejectTitle"),
      description:
        decisionMode === "approve"
          ? t("renewals.detail.prompt.approveDescription")
          : t("renewals.detail.prompt.rejectDescription"),
      confirmText:
        decisionMode === "approve"
          ? t("renewals.detail.actions.approve")
          : t("renewals.detail.actions.reject"),
      cancelText: t("common.actions.cancel"),
    });

    if (!confirmed) {
      return;
    }

    if (decisionMode === "approve") {
      await approveMutation.mutateAsync({
        reason: normalizedReason,
      });
      return;
    }

    await rejectMutation.mutateAsync({
      reason: normalizedReason!,
    });
  };

  const openResolveDrawer = () => {
    setResolveOutcome("succeeded");
    setResolveReason("");
    setResolveError(null);
    setResolveDrawerOpen(true);
  };

  const handleSubmitResolve = async () => {
    const normalizedReason = resolveReason.trim();

    if (!normalizedReason) {
      const message = t("renewals.detail.errors.reasonRequired");
      setResolveError(message);
      toast.error(message);
      return;
    }

    setResolveError(null);

    const confirmed = await prompt({
      title: t("renewals.detail.prompt.resolveTitle"),
      description: t("renewals.detail.prompt.resolveDescription"),
      confirmText: t("renewals.detail.actions.resolveStuck"),
      cancelText: t("common.actions.cancel"),
    });

    if (!confirmed) {
      return;
    }

    await resolveStuckMutation.mutateAsync({
      outcome: resolveOutcome,
      reason: normalizedReason,
    });
  };

  if (isLoading) {
    return (
      <Container className="divide-y p-0">
        <div className="px-6 py-4">
          <Heading level="h1">{t("renewals.detail.title")}</Heading>
        </div>
        <div className="flex items-center gap-x-2 px-6 py-6 text-ui-fg-subtle">
          <Spinner className="animate-spin" />
          <Text size="small" leading="compact" className="text-ui-fg-subtle">
            {t("renewals.detail.loading")}
          </Text>
        </div>
      </Container>
    );
  }

  if (isError) {
    return (
      <Container className="divide-y p-0">
        <div className="px-6 py-4">
          <Heading level="h1">{t("renewals.detail.title")}</Heading>
        </div>
        <div className="px-6 py-6">
          <Alert variant="error">
            {error instanceof Error
              ? error.message
              : t("renewals.detail.loadError")}
          </Alert>
        </div>
      </Container>
    );
  }

  if (!renewal) {
    return (
      <Container className="divide-y p-0">
        <div className="px-6 py-4">
          <Heading level="h1">{t("renewals.detail.title")}</Heading>
        </div>
        <div className="px-6 py-6">
          <Alert variant="warning">{t("renewals.detail.unavailable")}</Alert>
        </div>
      </Container>
    );
  }

  return (
    <div className="flex flex-col gap-y-4">
      <Container className="divide-y p-0">
        <div className="flex items-start justify-between px-6 py-4">
          <div className="flex flex-col gap-y-1">
            <Text size="small" leading="compact" className="text-ui-fg-subtle">
              {t("renewals.detail.header")}
            </Text>
            <Heading level="h1">{renewal.id}</Heading>
            <Text size="small" leading="compact" className="text-ui-fg-subtle">
              {t("renewals.detail.description")}
            </Text>
          </div>
          <div className="flex items-center gap-x-2">
            <StatusBadge color={getCycleStatusColor(renewal.status)}>
              {t(RENEWAL_CYCLE_STATUS_KEYS[renewal.status])}
            </StatusBadge>
            <DropdownMenu>
              <DropdownMenu.Trigger asChild>
                <IconButton size="small" variant="transparent" disabled={isActionPending}>
                  <EllipsisHorizontal />
                </IconButton>
              </DropdownMenu.Trigger>
              <DropdownMenu.Content align="end">
                {canForce ? (
                  <DropdownMenu.Item
                    className="flex items-center gap-x-2"
                    disabled={isActionPending}
                    onClick={() => {
                      void handleForceRenewal();
                    }}
                  >
                    <TriangleRightMini className="text-ui-fg-subtle" />
                    <span>
                      {forceMutation.isPending
                        ? t("renewals.detail.actions.forcing")
                        : t("renewals.detail.actions.forceRenewal")}
                    </span>
                  </DropdownMenu.Item>
                ) : null}
                {canResolveStuck ? (
                  <DropdownMenu.Item
                    className="flex items-center gap-x-2"
                    disabled={isActionPending}
                    onClick={openResolveDrawer}
                  >
                    <CheckCircle className="text-ui-fg-subtle" />
                    <span>
                      {resolveStuckMutation.isPending
                        ? t("renewals.detail.actions.resolving")
                        : t("renewals.detail.actions.resolveStuck")}
                    </span>
                  </DropdownMenu.Item>
                ) : null}
                {canDecideApproval ? (
                  <DropdownMenu.Item
                    className="flex items-center gap-x-2"
                    disabled={isActionPending}
                    onClick={() => openDecisionDrawer("approve")}
                  >
                    <CheckCircle className="text-ui-fg-subtle" />
                    <span>{t("renewals.detail.actions.approveChanges")}</span>
                  </DropdownMenu.Item>
                ) : null}
                {canDecideApproval ? (
                  <DropdownMenu.Item
                    className="flex items-center gap-x-2"
                    disabled={isActionPending}
                    onClick={() => openDecisionDrawer("reject")}
                  >
                    <XCircle className="text-ui-fg-subtle" />
                    <span>{t("renewals.detail.actions.rejectChanges")}</span>
                  </DropdownMenu.Item>
                ) : null}
                {canDeleteCycle ? (
                  <>
                    <DropdownMenu.Separator />
                    <DropdownMenu.Item
                      className="flex items-center gap-x-2"
                      disabled={isActionPending}
                      onClick={() => {
                        void handleDeleteCycle();
                      }}
                    >
                      <Trash className="text-ui-fg-subtle" />
                      <span>
                        {deleteCycleMutation.isPending
                          ? t("renewals.detail.actions.deleting")
                          : t("renewals.detail.actions.deleteCycle")}
                      </span>
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
              <Heading level="h2">{t("renewals.detail.sections.cycleOverview")}</Heading>
            </div>
            <div className="px-6 py-4">
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <DetailRow
                  label={t("common.fields.status")}
                  value={(
                    <StatusBadge color={getCycleStatusColor(renewal.status)}>
                      {t(RENEWAL_CYCLE_STATUS_KEYS[renewal.status])}
                    </StatusBadge>
                  )}
                />
                <DetailRow
                  label={t("renewals.detail.fields.projectedDelivery")}
                  value={formatDateTime(
                    renewal.effective_scheduled_for,
                    t("common.empty.noValue")
                  )}
                />
                <DetailRow
                  label={t("renewals.detail.fields.operationalCycle")}
                  value={formatDateTime(
                    renewal.scheduled_for,
                    t("common.empty.noValue")
                  )}
                />
                <DetailRow
                  label={t("renewals.detail.fields.processedAt")}
                  value={formatDateTime(
                    renewal.processed_at,
                    t("common.empty.noValue")
                  )}
                />
                <DetailRow
                  label={t("renewals.detail.fields.createdAt")}
                  value={formatDateTime(
                    renewal.created_at,
                    t("common.empty.noValue")
                  )}
                />
                <DetailRow
                  label={t("renewals.detail.fields.lastError")}
                  value={
                    renewal.last_error ||
                    t("renewals.detail.fields.noErrorRecorded")
                  }
                />
              </div>
            </div>
          </Container>

          <Container className="divide-y p-0">
            <div className="px-6 py-4">
              <Heading level="h2">
                {t("renewals.detail.sections.approvalSummary")}
              </Heading>
            </div>
            <div className="px-6 py-4">
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <DetailRow
                  label={t("renewals.columns.approval")}
                  value={(
                    <StatusBadge color={getApprovalStatusColor(renewal.approval)}>
                      {formatApprovalStatus(renewal.approval, t)}
                    </StatusBadge>
                  )}
                />
                <DetailRow
                  label={t("renewals.detail.fields.required")}
                  value={
                    renewal.approval.required
                      ? t("common.filters.yes")
                      : t("common.filters.no")
                  }
                />
                <DetailRow
                  label={t("renewals.detail.fields.decidedAt")}
                  value={formatDateTime(
                    renewal.approval.decided_at,
                    t("common.empty.noValue")
                  )}
                />
                <DetailRow
                  label={t("renewals.detail.fields.decidedBy")}
                  value={
                    renewal.approval.decided_by || t("common.empty.noValue")
                  }
                />
                <DetailRow
                  label={t("common.fields.reason")}
                  value={renewal.approval.reason || t("common.empty.noValue")}
                />
              </div>
            </div>
          </Container>

          <Container className="divide-y p-0">
            <div className="px-6 py-4">
              <Heading level="h2">{t("renewals.detail.sections.pendingChanges")}</Heading>
            </div>
            <div className="px-6 py-4">
              {renewal.pending_changes ? (
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                  <DetailRow
                    label={t("common.fields.variant")}
                    value={renewal.pending_changes.variant_title}
                  />
                  <DetailRow
                    label={t("common.fields.frequency")}
                    value={`${t(
                      RENEWAL_INTERVAL_KEYS[renewal.pending_changes.frequency_interval]
                    )} × ${renewal.pending_changes.frequency_value}`}
                  />
                  <DetailRow
                    label={t("renewals.detail.fields.effectiveAt")}
                    value={formatDateTime(
                      renewal.pending_changes.effective_at,
                      t("common.empty.noValue")
                    )}
                  />
                  <DetailRow
                    label={t("renewals.detail.fields.variantId")}
                    value={renewal.pending_changes.variant_id}
                  />
                </div>
              ) : (
                <Text size="small" leading="compact" className="text-ui-fg-subtle">
                  {t("renewals.detail.fields.noPendingChanges")}
                </Text>
              )}
            </div>
          </Container>

          <Container className="divide-y p-0">
            <div className="px-6 py-4">
              <Heading level="h2">{t("renewals.detail.sections.attemptHistory")}</Heading>
            </div>
            <div className="px-6 py-4">
              {renewal.attempts.length ? (
                <Table>
                  <Table.Header>
                    <Table.Row>
                      <Table.HeaderCell>
                        {t("renewals.detail.fields.attempt")}
                      </Table.HeaderCell>
                      <Table.HeaderCell>{t("common.fields.status")}</Table.HeaderCell>
                      <Table.HeaderCell>
                        {t("renewals.detail.fields.started")}
                      </Table.HeaderCell>
                      <Table.HeaderCell>
                        {t("renewals.detail.fields.finished")}
                      </Table.HeaderCell>
                      <Table.HeaderCell>
                        {t("renewals.detail.fields.error")}
                      </Table.HeaderCell>
                      <Table.HeaderCell>
                        {t("renewals.detail.fields.order")}
                      </Table.HeaderCell>
                      {canDeleteCycle ? <Table.HeaderCell /> : null}
                    </Table.Row>
                  </Table.Header>
                  <Table.Body>
                    {renewal.attempts.map((attempt) => (
                      <Table.Row key={attempt.id}>
                        <Table.Cell>
                          <Text size="small" leading="compact" weight="plus">
                            #{attempt.attempt_no}
                          </Text>
                        </Table.Cell>
                        <Table.Cell>
                          <StatusBadge color={getAttemptStatusColor(attempt.status)}>
                            {t(RENEWAL_ATTEMPT_STATUS_KEYS[attempt.status])}
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
                                t("renewals.detail.fields.noErrorMessage")}
                            </Text>
                          </div>
                        </Table.Cell>
                        <Table.Cell>
                          {attempt.order_id || t("common.empty.noValue")}
                        </Table.Cell>
                        {canDeleteCycle ? (
                          <Table.Cell>
                            {deletableAttemptStatuses.has(attempt.status) ? (
                              <Button
                                size="small"
                                variant="danger"
                                type="button"
                                isLoading={
                                  deleteAttemptMutation.isPending &&
                                  deleteAttemptMutation.variables === attempt.id
                                }
                                onClick={() => {
                                  void handleDeleteAttempt(attempt.id);
                                }}
                              >
                                {t("renewals.detail.actions.deleteAttempt")}
                              </Button>
                            ) : null}
                          </Table.Cell>
                        ) : null}
                      </Table.Row>
                    ))}
                  </Table.Body>
                </Table>
              ) : (
                <Text size="small" leading="compact" className="text-ui-fg-subtle">
                  {t("renewals.detail.fields.noAttempts")}
                </Text>
              )}
            </div>
          </Container>

          <Container className="divide-y p-0">
            <div className="px-6 py-4">
              <Heading level="h2">
                {t("renewals.detail.sections.technicalMetadata")}
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
                  {t("renewals.detail.fields.noMetadata")}
                </Text>
              )}
            </div>
          </Container>
        </div>

        <div className="flex min-w-0 flex-col gap-4">
          <Container className="divide-y p-0">
            <div className="px-6 py-4">
              <Heading level="h2">
                {t("renewals.detail.sections.subscriptionSummary")}
              </Heading>
            </div>
            <div className="px-6 py-4">
              <div className="grid gap-4">
                <Link
                  to={`/subscriptions/${renewal.subscription.subscription_id}`}
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
                          {renewal.subscription.reference}
                        </Text>
                        <Text
                          size="small"
                          leading="compact"
                          className="text-ui-fg-subtle"
                        >
                          {renewal.subscription.customer_name}
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
                  value={formatSubscriptionStatus(renewal.subscription.status, t)}
                />
                <DetailRow
                  label={t("common.fields.customer")}
                  value={renewal.subscription.customer_name}
                />
                <DetailRow
                  label={t("common.fields.product")}
                  value={renewal.subscription.product_title}
                />
                <DetailRow
                  label={t("common.fields.variant")}
                  value={renewal.subscription.variant_title}
                />
                <DetailRow
                  label={t("common.fields.sku")}
                  value={renewal.subscription.sku || t("common.empty.noValue")}
                />
              </div>
            </div>
          </Container>

          <Container className="divide-y p-0">
            <div className="px-6 py-4">
              <Heading level="h2">
                {t("renewals.detail.sections.generatedOrderSummary")}
              </Heading>
            </div>
            <div className="px-6 py-4">
              <div className="grid gap-4">
                {renewal.generated_order ? (
                  <Link
                    to={`/orders/${renewal.generated_order.order_id}`}
                    className="outline-none focus-within:shadow-borders-interactive-with-focus rounded-md [&:hover>div]:bg-ui-bg-component-hover"
                  >
                    <div className="shadow-elevation-card-rest bg-ui-bg-component rounded-md px-4 py-2 transition-colors">
                      <div className="flex items-center gap-3">
                        <div className="shadow-elevation-card-rest flex h-14 w-14 items-center justify-center rounded-md text-ui-fg-muted">
                          <ShoppingBag />
                        </div>
                        <div className="flex flex-1 flex-col">
                          <Text size="small" leading="compact" weight="plus">
                            #{renewal.generated_order.display_id}
                          </Text>
                          <Text
                            size="small"
                            leading="compact"
                            className="text-ui-fg-subtle"
                          >
                            {renewal.generated_order.status}
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
                    {t("renewals.detail.fields.noOrderGenerated")}
                  </Text>
                )}
                <DetailRow
                  label={t("common.fields.status")}
                  value={
                    renewal.generated_order?.status || t("common.empty.noValue")
                  }
                />
                <DetailRow
                  label={t("renewals.detail.fields.orderId")}
                  value={
                    renewal.generated_order?.order_id || t("common.empty.noValue")
                  }
                />
              </div>
            </div>
          </Container>
        </div>
      </div>

      <Drawer open={decisionDrawerOpen} onOpenChange={setDecisionDrawerOpen}>
        <Drawer.Content>
          <Drawer.Header>
            <Drawer.Title>
              {decisionMode === "approve"
                ? t("renewals.detail.drawer.approveTitle")
                : t("renewals.detail.drawer.rejectTitle")}
            </Drawer.Title>
          </Drawer.Header>
          <Drawer.Body className="flex flex-1 flex-col gap-y-4 p-4">
            {decisionError ? <Alert variant="error">{decisionError}</Alert> : null}
            <div className="flex flex-col gap-y-2">
              <Label htmlFor="decision-reason">
                {decisionMode === "approve"
                  ? t("common.fields.reason")
                  : t("renewals.detail.drawer.reasonRequired")}
              </Label>
              <Textarea
                id="decision-reason"
                value={decisionReason}
                onChange={(event) => setDecisionReason(event.target.value)}
                placeholder={
                  decisionMode === "approve"
                    ? t("renewals.detail.drawer.optionalNote")
                    : t("renewals.detail.drawer.requiredRejectionReason")
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
                  disabled={approveMutation.isPending || rejectMutation.isPending}
                >
                  {t("common.actions.cancel")}
                </Button>
              </Drawer.Close>
              <Button
                size="small"
                type="button"
                isLoading={
                  decisionMode === "approve"
                    ? approveMutation.isPending
                    : rejectMutation.isPending
                }
                disabled={approveMutation.isPending || rejectMutation.isPending}
                onClick={() => {
                  void handleSubmitDecision();
                }}
              >
                {decisionMode === "approve"
                  ? t("renewals.detail.actions.approve")
                  : t("renewals.detail.actions.reject")}
              </Button>
            </div>
          </Drawer.Footer>
        </Drawer.Content>
      </Drawer>

      <Drawer open={resolveDrawerOpen} onOpenChange={setResolveDrawerOpen}>
        <Drawer.Content>
          <Drawer.Header>
            <Drawer.Title>{t("renewals.detail.drawer.resolveTitle")}</Drawer.Title>
          </Drawer.Header>
          <Drawer.Body className="flex flex-1 flex-col gap-y-4 p-4">
            {resolveError ? <Alert variant="error">{resolveError}</Alert> : null}
            <div className="flex flex-col gap-y-2">
              <Label htmlFor="resolve-outcome">
                {t("renewals.detail.drawer.resolveOutcome")}
              </Label>
              <Select
                value={resolveOutcome}
                onValueChange={(value) =>
                  setResolveOutcome(value as RenewalStuckResolutionOutcome)
                }
              >
                <Select.Trigger id="resolve-outcome">
                  <Select.Value />
                </Select.Trigger>
                <Select.Content>
                  {(
                    Object.keys(STUCK_RESOLUTION_OUTCOME_KEYS) as RenewalStuckResolutionOutcome[]
                  ).map((outcome) => (
                    <Select.Item key={outcome} value={outcome}>
                      {t(STUCK_RESOLUTION_OUTCOME_KEYS[outcome])}
                    </Select.Item>
                  ))}
                </Select.Content>
              </Select>
            </div>
            <div className="flex flex-col gap-y-2">
              <Label htmlFor="resolve-reason">
                {t("renewals.detail.drawer.resolveReasonRequired")}
              </Label>
              <Textarea
                id="resolve-reason"
                value={resolveReason}
                onChange={(event) => setResolveReason(event.target.value)}
                placeholder={t("renewals.detail.drawer.resolveReasonPlaceholder")}
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
                  disabled={resolveStuckMutation.isPending}
                >
                  {t("common.actions.cancel")}
                </Button>
              </Drawer.Close>
              <Button
                size="small"
                type="button"
                isLoading={resolveStuckMutation.isPending}
                disabled={resolveStuckMutation.isPending}
                onClick={() => {
                  void handleSubmitResolve();
                }}
              >
                {t("renewals.detail.actions.resolveStuck")}
              </Button>
            </div>
          </Drawer.Footer>
        </Drawer.Content>
      </Drawer>
    </div>
  );
};

export default RenewalDetailPage;

export const handle = {
  breadcrumb: ({ params, loaderData }: UIMatch<RenewalCycleAdminDetailResponse>) =>
    params?.id || loaderData?.renewal?.id || translate("renewals.breadcrumb"),
};

const DetailRow = ({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: ReactNode;
  mono?: boolean;
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
  );
};

function normalizeOptionalString(value: string) {
  const trimmed = value.trim();
  return trimmed.length ? trimmed : undefined;
}

function formatDateTime(value: string | null, emptyValue: string) {
  if (!value) {
    return emptyValue;
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function formatApprovalStatus(
  approval: RenewalAdminApprovalSummary,
  t: ReorderTranslate
) {
  if (!approval.required || !approval.status) {
    return t("renewals.approval.notRequired");
  }

  switch (approval.status) {
    case RenewalApprovalStatus.PENDING:
      return t("renewals.approval.pendingApproval");
    case RenewalApprovalStatus.APPROVED:
      return t("renewals.approval.approved");
    case RenewalApprovalStatus.REJECTED:
      return t("renewals.approval.rejected");
  }
}

function formatSubscriptionStatus(status: string, t: ReorderTranslate) {
  return t(SUBSCRIPTION_STATUS_KEYS[status] ?? status);
}

function getCycleStatusColor(status: RenewalCycleAdminStatus) {
  switch (status) {
    case RenewalCycleAdminStatus.SCHEDULED:
      return "blue";
    case RenewalCycleAdminStatus.PROCESSING:
      return "orange";
    case RenewalCycleAdminStatus.SUCCEEDED:
      return "green";
    case RenewalCycleAdminStatus.FAILED:
      return "red";
    case RenewalCycleAdminStatus.ABANDONED:
      return "grey";
    case RenewalCycleAdminStatus.AWAITING_MANUAL_RESOLUTION:
      return "orange";
  }
}

function getAttemptStatusColor(status: RenewalAttemptAdminStatus) {
  switch (status) {
    case RenewalAttemptAdminStatus.PROCESSING:
      return "orange";
    case RenewalAttemptAdminStatus.SUCCEEDED:
      return "green";
    case RenewalAttemptAdminStatus.FAILED:
      return "red";
  }
}

function getApprovalStatusColor(approval: RenewalAdminApprovalSummary) {
  if (!approval.required || !approval.status) {
    return "grey";
  }

  switch (approval.status) {
    case RenewalApprovalStatus.PENDING:
      return "orange";
    case RenewalApprovalStatus.APPROVED:
      return "green";
    case RenewalApprovalStatus.REJECTED:
      return "red";
  }
}

function getAdminErrorMessage(error: unknown, fallback: string) {
  return getNestedErrorMessage(error) ?? fallback;
}

function getNestedErrorMessage(value: unknown): string | null {
  if (!value) {
    return null;
  }

  if (typeof value === "string") {
    return value;
  }

  if (value instanceof Error) {
    return (
      getNestedErrorMessage((value as Error & { cause?: unknown }).cause) ??
      value.message
    );
  }

  if (typeof value !== "object") {
    return null;
  }

  const record = value as Record<string, unknown>;

  return (
    getNestedErrorMessage(record.message) ??
    getNestedErrorMessage(record.error) ??
    getNestedErrorMessage(record.details) ??
    getNestedErrorMessage(record.response) ??
    getNestedErrorMessage(record.data) ??
    getNestedErrorMessage(record.body) ??
    getNestedErrorMessage(record.cause) ??
    null
  );
}
