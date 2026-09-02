import { translate, type ReorderTranslate } from "../../../i18n/translate";
import { useTranslation } from "react-i18next";
import {
  Alert,
  Container,
  createDataTableColumnHelper,
  Drawer,
  DataTable,
  DataTableFilteringState,
  DataTablePaginationState,
  DataTableSortingState,
  DropdownMenu,
  Heading,
  Button,
  Input,
  IconButton,
  Label,
  Select,
  StatusBadge,
  Table,
  Text,
  toast,
  useDataTable,
  usePrompt,
} from "@medusajs/ui";
import {
  EllipsisHorizontal,
  Pause,
  PencilSquare,
  ShoppingBag,
  Spinner,
  TriangleRightMini,
  Trash,
  User,
  XMarkMini,
} from "@medusajs/icons";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { flexRender } from "@tanstack/react-table";
import { ReactNode, useEffect, useMemo, useState } from "react";
import {
  LoaderFunctionArgs,
  Link,
  UIMatch,
  useLoaderData,
  useParams,
} from "react-router-dom";
import {
  invalidateSubscriptionDetailQueries,
  useAdminSubscriptionLogDetailQuery,
  useAdminSubscriptionTimelineQuery,
  useAdminSubscriptionDetailQuery,
  useAdminSubscriptionPlanOptionsQuery,
} from "../data-loading";
import { sdk } from "../../../lib/client";
import {
  ActivityLogAdminActorType,
  ActivityLogAdminDetail,
  ActivityLogAdminListItem,
} from "../../../types/activity-log";
import {
  SubscriptionAdminDetailResponse,
  SubscriptionAdminShippingAddress,
  SubscriptionAdminStatus,
  SubscriptionFrequencyInterval,
} from "../../../types/subscription";

const ACTIVITY_LOG_PAGE_SIZE = 10;

const scheduleableStatuses = new Set<SubscriptionAdminStatus>([
  SubscriptionAdminStatus.ACTIVE,
  SubscriptionAdminStatus.PAUSED,
  SubscriptionAdminStatus.PAST_DUE,
]);

const SUBSCRIPTION_STATUS_KEYS = {
  [SubscriptionAdminStatus.ACTIVE]: "subscriptions.status.active",
  [SubscriptionAdminStatus.PAUSED]: "subscriptions.status.paused",
  [SubscriptionAdminStatus.CANCELLED]: "subscriptions.status.cancelled",
  [SubscriptionAdminStatus.PAST_DUE]: "subscriptions.status.pastDue",
} as const;

const ACTIVITY_ACTOR_KEYS = {
  [ActivityLogAdminActorType.USER]: "subscriptions.timeline.actors.admin",
  [ActivityLogAdminActorType.CUSTOMER]: "subscriptions.timeline.actors.customer",
  [ActivityLogAdminActorType.SYSTEM]: "subscriptions.timeline.actors.system",
  [ActivityLogAdminActorType.SCHEDULER]: "subscriptions.timeline.actors.scheduler",
} as const;

const ACTIVITY_SUMMARY_FIELD_KEYS = {
  subscription_created: "subscriptions.timeline.summaryFields.subscriptionCreated",
  pending_update_data: "subscriptions.timeline.summaryFields.pendingUpdateData",
  status: "subscriptions.timeline.summaryFields.status",
  recipient: "subscriptions.timeline.summaryFields.recipient",
  address: "subscriptions.timeline.summaryFields.address",
  address_lines_changed: "subscriptions.timeline.summaryFields.addressLinesChanged",
  postal_code_changed: "subscriptions.timeline.summaryFields.postalCodeChanged",
  phone_changed: "subscriptions.timeline.summaryFields.phoneChanged",
  country_code: "subscriptions.timeline.summaryFields.countryCode",
  province: "subscriptions.timeline.summaryFields.province",
  city: "subscriptions.timeline.summaryFields.city",
} as const;

const INTERVAL_KEYS = {
  [SubscriptionFrequencyInterval.WEEK]: "common.intervals.week",
  [SubscriptionFrequencyInterval.MONTH]: "common.intervals.month",
  [SubscriptionFrequencyInterval.YEAR]: "common.intervals.year",
} as const;

const activityLogColumnHelper =
  createDataTableColumnHelper<ActivityLogAdminListItem>();

type SubscriptionActionType = "pause" | "resume" | "cancel";
type ShippingAddressFormState = {
  first_name: string;
  last_name: string;
  company: string;
  address_1: string;
  address_2: string;
  city: string;
  postal_code: string;
  province: string;
  country_code: string;
  phone: string;
};

const SubscriptionDetailPage = () => {
  const { t } = useTranslation("reorder");
  const { id } = useParams();
  const loaderData = useLoaderData() as Awaited<ReturnType<typeof loader>>;
  const queryClient = useQueryClient();
  const prompt = usePrompt();
  const [planDrawerOpen, setPlanDrawerOpen] = useState(false);
  const [shippingDrawerOpen, setShippingDrawerOpen] = useState(false);
  const [activityLogDrawerOpen, setActivityLogDrawerOpen] = useState(false);
  const [selectedLogId, setSelectedLogId] = useState<string | null>(null);
  const [activityLogFiltering, setActivityLogFiltering] =
    useState<DataTableFilteringState>({});
  const [activityLogSorting, setActivityLogSorting] =
    useState<DataTableSortingState | null>({
      id: "created_at",
      desc: true,
    });
  const [activityLogPagination, setActivityLogPagination] =
    useState<DataTablePaginationState>({
      pageIndex: 0,
      pageSize: ACTIVITY_LOG_PAGE_SIZE,
    });
  const [variantId, setVariantId] = useState("");
  const [frequencyInterval, setFrequencyInterval] =
    useState<SubscriptionFrequencyInterval>(SubscriptionFrequencyInterval.MONTH);
  const [frequencyValue, setFrequencyValue] = useState("1");
  const [effectiveAt, setEffectiveAt] = useState("");
  const [shippingAddressForm, setShippingAddressForm] =
    useState<ShippingAddressFormState>(getEmptyShippingAddressFormState());

  const intervalOptions = useMemo(() => {
    return [
      { label: t("common.intervals.week"), value: SubscriptionFrequencyInterval.WEEK },
      { label: t("common.intervals.month"), value: SubscriptionFrequencyInterval.MONTH },
      { label: t("common.intervals.year"), value: SubscriptionFrequencyInterval.YEAR },
    ] as const;
  }, [t]);

  const activityLogActorFilterOptions = useMemo(() => {
    return [
      { label: t("subscriptions.timeline.actors.admin"), value: ActivityLogAdminActorType.USER },
      {
        label: t("subscriptions.timeline.actors.customer"),
        value: ActivityLogAdminActorType.CUSTOMER,
      },
      {
        label: t("subscriptions.timeline.actors.system"),
        value: ActivityLogAdminActorType.SYSTEM,
      },
      {
        label: t("subscriptions.timeline.actors.scheduler"),
        value: ActivityLogAdminActorType.SCHEDULER,
      },
    ] as const;
  }, [t]);

  const activityLogDomainFilterOptions = useMemo(() => {
    return [
      {
        label: t("subscriptions.timeline.domains.subscriptions"),
        value: "subscriptions",
        eventTypes: [
          "subscription.created",
          "subscription.paused",
          "subscription.resumed",
          "subscription.canceled",
          "subscription.plan_change_scheduled",
          "subscription.shipping_address_updated",
          "subscription.next_delivery_skipped",
        ],
      },
      {
        label: t("subscriptions.timeline.domains.renewals"),
        value: "renewals",
        eventTypes: [
          "renewal.cycle_created",
          "renewal.approval_approved",
          "renewal.approval_rejected",
          "renewal.force_requested",
          "renewal.succeeded",
          "renewal.failed",
        ],
      },
      {
        label: t("subscriptions.timeline.domains.dunning"),
        value: "dunning",
        eventTypes: [
          "dunning.started",
          "dunning.retry_executed",
          "dunning.recovered",
          "dunning.unrecovered",
          "dunning.retry_schedule_updated",
        ],
      },
      {
        label: t("subscriptions.timeline.domains.cancellations"),
        value: "cancellation",
        eventTypes: [
          "cancellation.case_started",
          "cancellation.offer_applied",
          "cancellation.reason_updated",
          "cancellation.finalized",
        ],
      },
    ] as const;
  }, [t]);

  const { data, isLoading, isError, error } = useAdminSubscriptionDetailQuery(
    id,
    loaderData,
  );
  const subscription = data?.subscription;
  const customerLink = subscription?.customer.id
    ? `/customers/${subscription.customer.id}`
    : null;
  const productLink = subscription?.product.product_id
    ? `/products/${subscription.product.product_id}`
    : null;
  const variantLink =
    subscription?.product.product_id && subscription?.product.variant_id
      ? `/products/${subscription.product.product_id}/variants/${subscription.product.variant_id}`
      : null;
  const displayedRenewalOrders = subscription?.renewal_orders.slice(0, 3) ?? [];
  const {
    data: logsData,
    isLoading: isLogsLoading,
    isError: isLogsError,
    error: logsError,
  } = useAdminSubscriptionTimelineQuery({
    id,
    pagination: activityLogPagination,
    filtering: activityLogFiltering,
    sorting: activityLogSorting,
  });
  const {
    data: selectedLogData,
    isLoading: isSelectedLogLoading,
  } = useAdminSubscriptionLogDetailQuery(
    selectedLogId ?? undefined,
    activityLogDrawerOpen && Boolean(selectedLogId),
  );

  const {
    data: planOptionsData,
    isLoading: isLoadingPlanOptions,
    isError: isPlanOptionsError,
    error: planOptionsError,
  } = useAdminSubscriptionPlanOptionsQuery(
    subscription?.product.product_id,
    planDrawerOpen && Boolean(subscription?.product.product_id),
  );

  const planChangeMutation = useMutation({
    mutationFn: async (body: {
      variant_id: string;
      frequency_interval: SubscriptionFrequencyInterval;
      frequency_value: number;
      effective_at?: string;
    }) =>
      sdk.client.fetch<SubscriptionAdminDetailResponse>(
        `/admin/subscriptions/${id}/schedule-plan-change`,
        {
          method: "POST",
          body,
        },
      ),
    onSuccess: async () => {
      await invalidateSubscriptionDetailQueries(queryClient, id, selectedLogId ?? undefined);
      toast.success(t("subscriptions.errors.planChange"));
      setPlanDrawerOpen(false);
    },
    onError: (mutationError) => {
      toast.error(
        mutationError instanceof Error
          ? mutationError.message
          : t("subscriptions.errors.planChangeFailed"),
      );
    },
  });

  const pauseMutation = useMutation({
    mutationFn: async () =>
      sdk.client.fetch<SubscriptionAdminDetailResponse>(
        `/admin/subscriptions/${id}/pause`,
        {
          method: "POST",
          body: {},
        },
      ),
    onSuccess: async () => {
      await invalidateSubscriptionDetailQueries(queryClient, id, selectedLogId ?? undefined);
      toast.success(t("subscriptions.toast.paused"));
    },
    onError: (mutationError) => {
      toast.error(
        mutationError instanceof Error
          ? mutationError.message
          : t("subscriptions.errors.pauseFailed"),
      );
    },
  });

  const resumeMutation = useMutation({
    mutationFn: async () =>
      sdk.client.fetch<SubscriptionAdminDetailResponse>(
        `/admin/subscriptions/${id}/resume`,
        {
          method: "POST",
          body: {},
        },
      ),
    onSuccess: async () => {
      await invalidateSubscriptionDetailQueries(queryClient, id, selectedLogId ?? undefined);
      toast.success(t("subscriptions.toast.resumed"));
    },
    onError: (mutationError) => {
      toast.error(
        mutationError instanceof Error
          ? mutationError.message
          : t("subscriptions.errors.resumeFailed"),
      );
    },
  });

  const cancelMutation = useMutation({
    mutationFn: async () =>
      sdk.client.fetch<SubscriptionAdminDetailResponse>(
        `/admin/subscriptions/${id}/cancel`,
        {
          method: "POST",
          body: {},
        },
      ),
    onSuccess: async () => {
      await invalidateSubscriptionDetailQueries(queryClient, id, selectedLogId ?? undefined);
      toast.success(t("subscriptions.toast.cancelled"));
    },
    onError: (mutationError) => {
      toast.error(
        mutationError instanceof Error
          ? mutationError.message
          : t("subscriptions.errors.cancelFailed"),
      );
    },
  });

  const updateShippingAddressMutation = useMutation({
    mutationFn: async (body: SubscriptionAdminShippingAddress) =>
      sdk.client.fetch<SubscriptionAdminDetailResponse>(
        `/admin/subscriptions/${id}/update-shipping-address`,
        {
          method: "POST",
          body,
        },
      ),
    onSuccess: async () => {
      await invalidateSubscriptionDetailQueries(queryClient, id, selectedLogId ?? undefined);
      toast.success(t("subscriptions.errors.addressUpdated"));
      setShippingDrawerOpen(false);
    },
    onError: (mutationError) => {
      toast.error(
        mutationError instanceof Error
          ? mutationError.message
          : t("subscriptions.errors.addressFailed"),
      );
    },
  });

  useEffect(() => {
    if (!planDrawerOpen || !subscription) {
      return;
    }

    setVariantId(
      subscription.pending_update_data?.variant_id ?? subscription.product.variant_id,
    );
    setFrequencyInterval(
      subscription.pending_update_data?.frequency_interval ??
        subscription.frequency.interval,
    );
    setFrequencyValue(
      String(
        subscription.pending_update_data?.frequency_value ??
          subscription.frequency.value,
      ),
    );
    setEffectiveAt(
      toDateTimeLocalValue(subscription.pending_update_data?.effective_at ?? null),
    );
  }, [planDrawerOpen, subscription]);

  useEffect(() => {
    if (!shippingDrawerOpen || !subscription) {
      return;
    }

    setShippingAddressForm(
      getShippingAddressFormState(subscription.shipping_address),
    );
  }, [shippingDrawerOpen, subscription]);

  const variantOptions = useMemo(() => {
    return (
      planOptionsData?.variants.map((variant) => ({
        value: variant.id,
        label: [variant.title, variant.sku].filter(Boolean).join(" · "),
      })) ?? []
    );
  }, [planOptionsData]);

  const activityLogEventTypeFilters = useMemo(
    () =>
      Array.isArray(activityLogFiltering.event_type)
        ? (activityLogFiltering.event_type as string[])
        : [],
    [activityLogFiltering],
  );
  const activityLogActorTypeFilters = useMemo(
    () =>
      Array.isArray(activityLogFiltering.actor_type)
        ? (activityLogFiltering.actor_type as ActivityLogAdminActorType[])
        : [],
    [activityLogFiltering],
  );
  const activityLogDateFrom = useMemo(
    () =>
      typeof activityLogFiltering.date_from === "string"
        ? activityLogFiltering.date_from
        : "",
    [activityLogFiltering],
  );
  const activityLogDateTo = useMemo(
    () =>
      typeof activityLogFiltering.date_to === "string"
        ? activityLogFiltering.date_to
        : "",
    [activityLogFiltering],
  );
  const hasActivityLogDateFrom = useMemo(
    () => "date_from" in activityLogFiltering,
    [activityLogFiltering],
  );
  const hasActivityLogDateTo = useMemo(
    () => "date_to" in activityLogFiltering,
    [activityLogFiltering],
  );

  const activeActivityLogDomain = useMemo(() => {
    if (!activityLogEventTypeFilters.length) {
      return null;
    }

    return (
      activityLogDomainFilterOptions.find(
        (option) =>
          option.eventTypes.length === activityLogEventTypeFilters.length &&
          option.eventTypes.every((eventType) =>
            activityLogEventTypeFilters.includes(eventType),
          ),
      ) ?? null
    );
  }, [activityLogDomainFilterOptions, activityLogEventTypeFilters]);

  const activityLogActorLabels = useMemo(
    () =>
      activityLogActorFilterOptions
        .filter((option) => activityLogActorTypeFilters.includes(option.value))
        .map((option) => option.label),
    [activityLogActorFilterOptions, activityLogActorTypeFilters],
  );

  const hasActivityLogFilters =
    Boolean(activeActivityLogDomain) ||
    activityLogActorTypeFilters.length > 0 ||
    Boolean(activityLogDateFrom) ||
    Boolean(activityLogDateTo);

  const activityLogColumns = useMemo(
    () => [
      activityLogColumnHelper.accessor("created_at", {
        header: t("subscriptions.detail.fields.created"),
        enableSorting: true,
        sortLabel: t("subscriptions.detail.fields.created"),
        cell: ({ getValue }) => (
          <Text size="small" leading="compact">
            {formatDateTime(getValue(), t("common.empty.noValue"))}
          </Text>
        ),
      }),
      activityLogColumnHelper.accessor("event_type", {
        header: t("subscriptions.detail.fields.event"),
        enableSorting: true,
        sortLabel: t("subscriptions.detail.fields.event"),
        cell: ({ row }) => (
          <StatusBadge
            color={getActivityEventColor(row.original.event_type)}
            className="w-fit text-nowrap"
          >
            {formatActivityEventType(row.original.event_type)}
          </StatusBadge>
        ),
      }),
      activityLogColumnHelper.accessor("actor_type", {
        header: t("subscriptions.detail.fields.actor"),
        enableSorting: true,
        sortLabel: t("subscriptions.detail.fields.actor"),
        cell: ({ row }) => (
          <Text size="small" leading="compact">
            {getActivityActorDisplay(row.original, t)}
          </Text>
        ),
      }),
      activityLogColumnHelper.accessor("change_summary", {
        id: "reason",
        header: t("subscriptions.detail.fields.summary"),
        enableSorting: true,
        sortLabel: t("subscriptions.detail.fields.summary"),
        cell: ({ row }) => (
          <div className="flex flex-col gap-y-0.5">
            <Text size="small" leading="compact" weight="plus">
              {formatActivitySummary(row.original, t)}
            </Text>
            {row.original.reason ? (
              <Text size="small" leading="compact" className="text-ui-fg-subtle">
                {row.original.reason}
              </Text>
            ) : null}
          </div>
        ),
      }),
    ],
    [t],
  );

  const activityLogTable = useDataTable({
    columns: activityLogColumns,
    data: logsData?.subscription_logs || [],
    getRowId: (row) => row.id,
    rowCount: logsData?.count || 0,
    isLoading: isLogsLoading,
    sorting: {
      state: activityLogSorting,
      onSortingChange: setActivityLogSorting,
    },
    pagination: {
      state: activityLogPagination,
      onPaginationChange: setActivityLogPagination,
    },
    onRowClick: (_event, row) => {
      setSelectedLogId(row.id);
      setActivityLogDrawerOpen(true);
    },
  });
  const activityLogRows = activityLogTable.getRowModel().rows;

  if (isLoading) {
    return (
      <Container className="divide-y p-0">
        <div className="px-6 py-4">
          <Heading level="h1">{t("subscriptions.detail.title")}</Heading>
        </div>
        <div className="flex items-center gap-x-2 px-6 py-6 text-ui-fg-subtle">
          <Spinner className="animate-spin" />
          <Text size="small" leading="compact" className="text-ui-fg-subtle">
            {t("subscriptions.detail.loading")}
          </Text>
        </div>
      </Container>
    );
  }

  if (isError) {
    return (
      <Container className="divide-y p-0">
        <div className="px-6 py-4">
          <Heading level="h1">{t("subscriptions.detail.title")}</Heading>
        </div>
        <div className="px-6 py-6">
          <Alert variant="error">
            {error instanceof Error
              ? error.message
              : t("subscriptions.detail.loadError")}
          </Alert>
        </div>
      </Container>
    );
  }

  if (!subscription) {
    return (
      <Container className="divide-y p-0">
        <div className="px-6 py-4">
          <Heading level="h1">{t("subscriptions.detail.title")}</Heading>
        </div>
        <div className="px-6 py-6">
          <Alert variant="warning">
            {t("subscriptions.detail.unavailable")}
          </Alert>
        </div>
      </Container>
    );
  }

  const canSchedulePlanChange = scheduleableStatuses.has(subscription.status);
  const canPause = subscription.status === SubscriptionAdminStatus.ACTIVE;
  const canResume = subscription.status === SubscriptionAdminStatus.PAUSED;
  const canCancel = subscription.status !== SubscriptionAdminStatus.CANCELLED;
  const isActionPending =
    pauseMutation.isPending ||
    resumeMutation.isPending ||
    cancelMutation.isPending ||
    planChangeMutation.isPending ||
    updateShippingAddressMutation.isPending;

  const handleSubscriptionAction = async (action: SubscriptionActionType) => {
    const confirmed = await prompt(getSubscriptionActionPromptConfig(action, t));

    if (!confirmed) {
      return;
    }

    switch (action) {
      case "pause":
        await pauseMutation.mutateAsync();
        break;
      case "resume":
        await resumeMutation.mutateAsync();
        break;
      case "cancel":
        await cancelMutation.mutateAsync();
        break;
    }
  };

  const handleSubmit = async () => {
    const parsedFrequencyValue = Number(frequencyValue);

    if (!variantId) {
      toast.error(t("subscriptions.planChange.errors.variantRequired"));
      return;
    }

    if (!Number.isInteger(parsedFrequencyValue) || parsedFrequencyValue <= 0) {
      toast.error(t("subscriptions.planChange.errors.frequencyValueInvalid"));
      return;
    }

    await planChangeMutation.mutateAsync({
      variant_id: variantId,
      frequency_interval: frequencyInterval,
      frequency_value: parsedFrequencyValue,
      effective_at: effectiveAt ? new Date(effectiveAt).toISOString() : undefined,
    });
  };

  const handleShippingAddressChange = <
    TField extends keyof ShippingAddressFormState,
  >(
    field: TField,
    value: ShippingAddressFormState[TField],
  ) => {
    setShippingAddressForm((current) => ({
      ...current,
      [field]: value,
    }));
  };

  const handleShippingAddressSubmit = async () => {
    const body = {
      first_name: shippingAddressForm.first_name.trim(),
      last_name: shippingAddressForm.last_name.trim(),
      company: normalizeOptionalString(shippingAddressForm.company),
      address_1: shippingAddressForm.address_1.trim(),
      address_2: normalizeOptionalString(shippingAddressForm.address_2),
      city: shippingAddressForm.city.trim(),
      postal_code: shippingAddressForm.postal_code.trim(),
      province: normalizeOptionalString(shippingAddressForm.province),
      country_code: shippingAddressForm.country_code.trim().toLowerCase(),
      phone: normalizeOptionalString(shippingAddressForm.phone),
    };

    if (!body.first_name || !body.last_name || !body.address_1 || !body.city) {
      toast.error(t("subscriptions.detail.errors.addressRequired"));
      return;
    }

    if (!body.postal_code || body.country_code.length !== 2) {
      toast.error(t("subscriptions.detail.errors.postalCodeInvalid"));
      return;
    }

    await updateShippingAddressMutation.mutateAsync(body);
  };

  return (
    <div className="flex flex-col gap-y-4">
      <Container className="divide-y p-0">
        <div className="flex items-start justify-between px-6 py-4">
          <div>
            <Heading level="h1">{subscription.reference}</Heading>
            <Text size="small" leading="compact" className="text-ui-fg-subtle">
              {t("subscriptions.detail.description")}
            </Text>
          </div>
          <div className="flex items-center gap-x-2">
            <StatusBadge
              color={getStatusColor(subscription.status)}
              className="text-nowrap"
            >
              {t(SUBSCRIPTION_STATUS_KEYS[subscription.status])}
            </StatusBadge>
            <DropdownMenu>
              <DropdownMenu.Trigger asChild>
                <IconButton size="small" variant="transparent" disabled={isActionPending}>
                  <EllipsisHorizontal />
                </IconButton>
              </DropdownMenu.Trigger>
              <DropdownMenu.Content align="end">
                {canPause ? (
                  <DropdownMenu.Item
                    className="flex items-center gap-x-2"
                    disabled={isActionPending}
                    onClick={() => {
                      void handleSubscriptionAction("pause");
                    }}
                  >
                    <Pause className="text-ui-fg-subtle" />
                    <span>
                      {pauseMutation.isPending
                        ? t("subscriptions.actions.pausing")
                        : t("subscriptions.actions.pause")}
                    </span>
                  </DropdownMenu.Item>
                ) : null}
                {canResume ? (
                  <DropdownMenu.Item
                    className="flex items-center gap-x-2"
                    disabled={isActionPending}
                    onClick={() => {
                      void handleSubscriptionAction("resume");
                    }}
                  >
                    <TriangleRightMini className="text-ui-fg-subtle" />
                    <span>
                      {resumeMutation.isPending
                        ? t("subscriptions.actions.resuming")
                        : t("subscriptions.actions.resume")}
                    </span>
                  </DropdownMenu.Item>
                ) : null}
                {canSchedulePlanChange ? (
                  <DropdownMenu.Item
                    className="flex items-center gap-x-2"
                    disabled={isActionPending}
                    onClick={() => setPlanDrawerOpen(true)}
                  >
                    <TriangleRightMini className="text-ui-fg-subtle" />
                    <span>{t("subscriptions.planChange.title")}</span>
                  </DropdownMenu.Item>
                ) : null}
                <DropdownMenu.Item
                  className="flex items-center gap-x-2"
                  disabled={isActionPending}
                  onClick={() => setShippingDrawerOpen(true)}
                >
                  <PencilSquare className="text-ui-fg-subtle" />
                  <span>{t("subscriptions.detail.editShippingAddress")}</span>
                </DropdownMenu.Item>
                {canCancel ? (
                  <>
                    <DropdownMenu.Separator />
                    <DropdownMenu.Item
                      className="flex items-center gap-x-2"
                      disabled={isActionPending}
                      onClick={() => {
                        void handleSubscriptionAction("cancel");
                      }}
                    >
                      <Trash className="text-ui-fg-subtle" />
                      <span>
                        {cancelMutation.isPending
                          ? t("subscriptions.actions.cancelling")
                          : t("common.actions.cancel")}
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
            <div className="px-4 py-4">
              <Text size="small" leading="compact" weight="plus">
                {t("subscriptions.detail.sections.subscription")}
              </Text>
            </div>
            <div className="px-4 py-4">
              <div className="grid gap-3 md:grid-cols-2">
                <DetailRow
                  label={t("common.fields.status")}
                  value={(
                    <StatusBadge
                      color={getStatusColor(subscription.status)}
                      className="text-nowrap"
                    >
                      {t(SUBSCRIPTION_STATUS_KEYS[subscription.status])}
                    </StatusBadge>
                  )}
                />
                <DetailRow label={t("common.fields.frequency")} value={subscription.frequency.label} />
                <DetailRow
                  label={t("common.fields.nextRenewal")}
                  value={formatDateTime(
                    subscription.effective_next_renewal_at ??
                      subscription.next_renewal_at,
                    t("common.empty.noValue"),
                  )}
                />
                <DetailRow
                  label={t("subscriptions.detail.fields.startedAt")}
                  value={formatDateTime(
                    subscription.started_at,
                    t("common.empty.noValue"),
                  )}
                />
                <DetailRow
                  label={t("subscriptions.detail.fields.lastRenewal")}
                  value={formatDateTime(
                    subscription.last_renewal_at,
                    t("common.empty.noValue"),
                  )}
                />
              </div>
            </div>
          </Container>
          <Container className="divide-y p-0">
            <div className="px-4 py-4">
              <Text size="small" leading="compact" weight="plus">
                {t("subscriptions.detail.sections.shippingAddress")}
              </Text>
            </div>
            <div className="px-4 py-4">
              <div className="grid gap-3 md:grid-cols-2">
                <div className="flex flex-col gap-3">
                  <DetailRow
                    label={t("subscriptions.detail.fields.recipient")}
                    value={`${subscription.shipping_address.first_name} ${subscription.shipping_address.last_name}`}
                  />
                  <DetailRow
                    label={t("subscriptions.detail.fields.address")}
                    value={[
                      subscription.shipping_address.address_1,
                      subscription.shipping_address.address_2,
                    ]
                      .filter(Boolean)
                      .join(", ")}
                  />
                  <DetailRow
                    label={t("subscriptions.detail.fields.city")}
                    value={`${subscription.shipping_address.postal_code} ${subscription.shipping_address.city}`}
                  />
                </div>
                <div className="flex flex-col gap-3">
                  <DetailRow
                    label={t("subscriptions.detail.fields.phone")}
                    value={subscription.shipping_address.phone || t("common.empty.noValue")}
                  />
                  <DetailRow
                    label={t("subscriptions.detail.fields.country")}
                    value={subscription.shipping_address.country_code.toUpperCase()}
                  />
                </div>
              </div>
            </div>
          </Container>
          <Container className="divide-y p-0">
            <div className="px-6 py-4">
              <Heading level="h2">
                {t("subscriptions.detail.sections.pendingPlanChange")}
              </Heading>
            </div>
            <div className="px-6 py-4">
              {subscription.pending_update_data ? (
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                  <DetailRow
                    label={t("common.fields.variant")}
                    value={subscription.pending_update_data.variant_title}
                  />
                  <DetailRow
                    label={t("common.fields.frequency")}
                    value={`${t(INTERVAL_KEYS[subscription.pending_update_data.frequency_interval])} × ${subscription.pending_update_data.frequency_value}`}
                  />
                  <DetailRow
                    label={t("subscriptions.detail.fields.effectiveAt")}
                    value={formatDateTime(
                      subscription.pending_update_data.effective_at,
                      t("common.empty.noValue"),
                    )}
                  />
                  <DetailRow
                    label={t("subscriptions.detail.fields.variantId")}
                    value={subscription.pending_update_data.variant_id}
                  />
                </div>
              ) : (
                <Text size="small" leading="compact" className="text-ui-fg-subtle">
                  {t("subscriptions.detail.noPendingChange")}
                </Text>
              )}
            </div>
          </Container>
          <Container className="divide-y p-0">
            <div className="px-6 py-4">
              <Heading level="h2">
                {t("subscriptions.detail.sections.activityLog")}
              </Heading>
            </div>
            <DataTable instance={activityLogTable} className="min-h-0">
              <div className="flex flex-col gap-4 px-6 py-4">
                <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
                  <div className="flex flex-wrap items-center gap-2">
                    {activeActivityLogDomain ? (
                      <FilterChip
                        label={t("subscriptions.detail.fields.domain")}
                        value={activeActivityLogDomain.label}
                        onRemove={() => {
                          setActivityLogFiltering((current) =>
                            removeTimelineFilter(current, "event_type"),
                          );
                        }}
                      />
                    ) : null}
                    {activityLogActorTypeFilters.length ? (
                      <FilterChip
                        label={t("subscriptions.detail.fields.actor")}
                        value={activityLogActorLabels.join(", ")}
                        onRemove={() => {
                          setActivityLogFiltering((current) =>
                            removeTimelineFilter(current, "actor_type"),
                          );
                        }}
                      />
                    ) : null}
                    {activityLogDateFrom ? (
                      <FilterChip
                        label={t("subscriptions.detail.fields.createdFrom")}
                        value={formatDateTimeInputValue(activityLogDateFrom)}
                        onRemove={() => {
                          setActivityLogFiltering((current) =>
                            removeTimelineFilter(current, "date_from"),
                          );
                        }}
                      />
                    ) : null}
                    {activityLogDateTo ? (
                      <FilterChip
                        label={t("subscriptions.detail.fields.createdTo")}
                        value={formatDateTimeInputValue(activityLogDateTo)}
                        onRemove={() => {
                          setActivityLogFiltering((current) =>
                            removeTimelineFilter(current, "date_to"),
                          );
                        }}
                      />
                    ) : null}
                    <DropdownMenu>
                      <DropdownMenu.Trigger asChild>
                        <Button size="small" variant="secondary" type="button">
                          {t("common.filters.addFilter")}
                        </Button>
                      </DropdownMenu.Trigger>
                      <DropdownMenu.Content align="start">
                        <DropdownMenu.SubMenu>
                          <DropdownMenu.SubMenuTrigger>
                            {t("subscriptions.detail.fields.domain")}
                          </DropdownMenu.SubMenuTrigger>
                          <DropdownMenu.SubMenuContent>
                            {activityLogDomainFilterOptions.map((option) => (
                              <DropdownMenu.CheckboxItem
                                key={option.value}
                                checked={activeActivityLogDomain?.value === option.value}
                                onSelect={(event) => {
                                  event.preventDefault();
                                }}
                                onCheckedChange={(checked) => {
                                  setActivityLogFiltering((current) => {
                                    if (!checked) {
                                      return removeTimelineFilter(current, "event_type");
                                    }

                                    return {
                                      ...current,
                                      event_type: [...option.eventTypes],
                                    };
                                  });
                                }}
                              >
                                {option.label}
                              </DropdownMenu.CheckboxItem>
                            ))}
                          </DropdownMenu.SubMenuContent>
                        </DropdownMenu.SubMenu>
                        <DropdownMenu.SubMenu>
                          <DropdownMenu.SubMenuTrigger>
                            {t("subscriptions.detail.fields.actor")}
                          </DropdownMenu.SubMenuTrigger>
                          <DropdownMenu.SubMenuContent>
                            {activityLogActorFilterOptions.map((option) => {
                              const checked = activityLogActorTypeFilters.includes(
                                option.value,
                              );

                              return (
                                <DropdownMenu.CheckboxItem
                                  key={option.value}
                                  checked={checked}
                                  onSelect={(event) => {
                                    event.preventDefault();
                                  }}
                                  onCheckedChange={(nextChecked) => {
                                    setActivityLogFiltering((current) => {
                                      const currentValues = Array.isArray(
                                        current.actor_type,
                                      )
                                        ? (current.actor_type as ActivityLogAdminActorType[])
                                        : [];

                                      const nextValues = nextChecked
                                        ? currentValues.includes(option.value)
                                          ? currentValues
                                          : [...currentValues, option.value]
                                        : currentValues.filter(
                                            (currentValue) =>
                                              currentValue !== option.value,
                                          );

                                      if (!nextValues.length) {
                                        return removeTimelineFilter(
                                          current,
                                          "actor_type",
                                        );
                                      }

                                      return {
                                        ...current,
                                        actor_type: nextValues,
                                      };
                                    });
                                  }}
                                >
                                  {option.label}
                                </DropdownMenu.CheckboxItem>
                              );
                            })}
                          </DropdownMenu.SubMenuContent>
                        </DropdownMenu.SubMenu>
                        {!hasActivityLogDateFrom ? (
                          <DropdownMenu.Item
                            onClick={() => {
                              setActivityLogFiltering((current) => ({
                                ...current,
                                date_from: "",
                              }));
                            }}
                          >
                            {t("subscriptions.detail.fields.createdFrom")}
                          </DropdownMenu.Item>
                        ) : null}
                        {!hasActivityLogDateTo ? (
                          <DropdownMenu.Item
                            onClick={() => {
                              setActivityLogFiltering((current) => ({
                                ...current,
                                date_to: "",
                              }));
                            }}
                          >
                            {t("subscriptions.detail.fields.createdTo")}
                          </DropdownMenu.Item>
                        ) : null}
                      </DropdownMenu.Content>
                    </DropdownMenu>
                      {hasActivityLogFilters ? (
                      <Button
                        size="small"
                        variant="transparent"
                        type="button"
                        onClick={() => {
                          setActivityLogFiltering({});
                          setActivityLogPagination((current) => ({
                            ...current,
                            pageIndex: 0,
                          }));
                        }}
                      >
                        {t("common.filters.clearAll")}
                      </Button>
                    ) : null}
                  </div>
                  <DataTable.SortingMenu
                    direction={activityLogSorting?.desc ? "desc" : "asc"}
                    sortBy={activityLogSorting?.id ?? "created_at"}
                    onSort={(sort) => {
                      setActivityLogSorting({
                        id: sort.sortBy,
                        desc: sort.direction === "desc",
                      });
                      setActivityLogPagination((current) => ({
                        ...current,
                        pageIndex: 0,
                      }));
                    }}
                    fields={[
                      {
                        label: t("subscriptions.detail.fields.created"),
                        value: "created_at",
                      },
                      {
                        label: t("subscriptions.detail.fields.event"),
                        value: "event_type",
                      },
                      {
                        label: t("subscriptions.detail.fields.actor"),
                        value: "actor_display",
                      },
                    ]}
                  />
                </div>
                {hasActivityLogDateFrom || hasActivityLogDateTo ? (
                  <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                    {hasActivityLogDateFrom ? (
                      <div className="grid gap-2">
                        <Label>{t("subscriptions.detail.fields.createdFrom")}</Label>
                        <div className="relative">
                          <Input
                            type="datetime-local"
                            value={activityLogDateFrom}
                            onChange={(event) => {
                              const nextValue = event.target.value;

                              setActivityLogFiltering((current) => ({
                                ...current,
                                date_from: nextValue,
                              }));
                              setActivityLogPagination((current) => ({
                                ...current,
                                pageIndex: 0,
                              }));
                            }}
                          />
                          <button
                            type="button"
                            className="absolute right-2 top-1/2 -translate-y-1/2 text-ui-fg-subtle"
                            onClick={() => {
                              setActivityLogFiltering((current) =>
                                removeTimelineFilter(current, "date_from"),
                              );
                            }}
                          >
                            <XMarkMini />
                          </button>
                        </div>
                      </div>
                    ) : null}
                    {hasActivityLogDateTo ? (
                      <div className="grid gap-2">
                        <Label>{t("subscriptions.detail.fields.createdTo")}</Label>
                        <div className="relative">
                          <Input
                            type="datetime-local"
                            value={activityLogDateTo}
                            onChange={(event) => {
                              const nextValue = event.target.value;

                              setActivityLogFiltering((current) => ({
                                ...current,
                                date_to: nextValue,
                              }));
                              setActivityLogPagination((current) => ({
                                ...current,
                                pageIndex: 0,
                              }));
                            }}
                          />
                          <button
                            type="button"
                            className="absolute right-2 top-1/2 -translate-y-1/2 text-ui-fg-subtle"
                            onClick={() => {
                              setActivityLogFiltering((current) =>
                                removeTimelineFilter(current, "date_to"),
                              );
                            }}
                          >
                            <XMarkMini />
                          </button>
                        </div>
                      </div>
                    ) : null}
                  </div>
                ) : null}
                {isLogsLoading ? (
                  <div className="flex items-center gap-x-2 text-ui-fg-subtle">
                    <Spinner className="animate-spin" />
                    <Text size="small" leading="compact" className="text-ui-fg-subtle">
                      {t("subscriptions.timeline.loading")}
                    </Text>
                  </div>
                ) : isLogsError ? (
                  <Alert variant="error">
                    {logsError instanceof Error
                      ? logsError.message
                      : t("subscriptions.timeline.loadError")}
                  </Alert>
                ) : (
                  <>
                    <div className="overflow-x-auto border-y">
                      <Table>
                        <Table.Header>
                          {activityLogTable.getHeaderGroups().map((headerGroup) => (
                            <Table.Row key={headerGroup.id}>
                              {headerGroup.headers.map((header) => (
                                <Table.HeaderCell key={header.id}>
                                  {header.isPlaceholder
                                    ? null
                                    : flexRender(
                                        header.column.columnDef.header,
                                        header.getContext(),
                                      )}
                                </Table.HeaderCell>
                              ))}
                            </Table.Row>
                          ))}
                        </Table.Header>
                        <Table.Body>
                          {activityLogRows.length ? (
                            activityLogRows.map((row) => (
                              <Table.Row
                                key={row.id}
                                className="cursor-pointer"
                                onClick={() => {
                                  setSelectedLogId(row.original.id);
                                  setActivityLogDrawerOpen(true);
                                }}
                              >
                                {row.getVisibleCells().map((cell) => (
                                  <Table.Cell key={cell.id}>
                                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                                  </Table.Cell>
                                ))}
                              </Table.Row>
                            ))
                          ) : (
                            <Table.Row>
                              <Table.Cell colSpan={activityLogColumns.length}>
                                <Text
                                  size="small"
                                  leading="compact"
                                  className="text-ui-fg-subtle"
                                >
                                  {t("subscriptions.timeline.empty")}
                                </Text>
                              </Table.Cell>
                            </Table.Row>
                          )}
                        </Table.Body>
                      </Table>
                    </div>
                    <DataTable.Pagination
                      count={logsData?.count ?? 0}
                      pageSize={activityLogPagination.pageSize}
                      pageIndex={activityLogPagination.pageIndex}
                      pageCount={Math.max(
                        1,
                        Math.ceil((logsData?.count ?? 0) / activityLogPagination.pageSize),
                      )}
                      canNextPage={
                        (activityLogPagination.pageIndex + 1) *
                          activityLogPagination.pageSize <
                        (logsData?.count ?? 0)
                      }
                      canPreviousPage={activityLogPagination.pageIndex > 0}
                      nextPage={() =>
                        setActivityLogPagination((current) => ({
                          ...current,
                          pageIndex: current.pageIndex + 1,
                        }))
                      }
                      previousPage={() =>
                        setActivityLogPagination((current) => ({
                          ...current,
                          pageIndex: Math.max(0, current.pageIndex - 1),
                        }))
                      }
                    />
                  </>
                )}
              </div>
            </DataTable>
          </Container>
        </div>
        <div className="flex min-w-0 flex-col gap-4">
            <Container className="divide-y p-0">
              <div className="px-4 py-4">
                <Text size="small" leading="compact" weight="plus">
                  {t("subscriptions.detail.sections.customer")}
                </Text>
              </div>
              <div className="px-4 py-4">
                <div className="flex flex-col gap-3">
                  {customerLink ? (
                    <Link
                      to={customerLink}
                      className="outline-none focus-within:shadow-borders-interactive-with-focus rounded-md [&:hover>div]:bg-ui-bg-component-hover"
                    >
                      <div className="shadow-elevation-card-rest bg-ui-bg-component rounded-md px-4 py-2 transition-colors">
                        <div className="flex items-center gap-3">
                          <div className="shadow-elevation-card-rest flex h-14 w-14 items-center justify-center rounded-md text-ui-fg-muted">
                            <User />
                          </div>
                          <div className="flex flex-1 flex-col">
                            <Text size="small" leading="compact" weight="plus">
                              {subscription.customer.full_name}
                            </Text>
                            <Text
                              size="small"
                              leading="compact"
                              className="text-ui-fg-subtle"
                            >
                              {subscription.customer.email || subscription.customer.id}
                            </Text>
                          </div>
                          <div className="size-7 flex items-center justify-center">
                            <TriangleRightMini className="text-ui-fg-muted rtl:rotate-180" />
                          </div>
                        </div>
                      </div>
                    </Link>
                  ) : (
                    <div className="shadow-elevation-card-rest bg-ui-bg-component rounded-md px-4 py-2">
                      <div className="flex items-center gap-3">
                        <div className="shadow-elevation-card-rest flex h-14 w-14 items-center justify-center rounded-md text-ui-fg-muted">
                          <User />
                        </div>
                        <div className="flex flex-1 flex-col">
                          <Text size="small" leading="compact" weight="plus">
                            {subscription.customer.full_name}
                          </Text>
                          <Text
                            size="small"
                            leading="compact"
                            className="text-ui-fg-subtle"
                          >
                            {subscription.customer.email || subscription.customer.id}
                          </Text>
                        </div>
                      </div>
                    </div>
                  )}
                  <DetailRow
                    label={t("common.fields.email")}
                    value={subscription.customer.email || t("common.empty.noValue")}
                  />
                  <DetailRow
                    label={t("subscriptions.detail.fields.customerId")}
                    value={subscription.customer.id}
                  />
                </div>
              </div>
            </Container>
            <Container className="divide-y p-0">
              <div className="px-4 py-4">
                <Text size="small" leading="compact" weight="plus">
                  {t("subscriptions.detail.sections.product")}
                </Text>
              </div>
              <div className="px-4 py-4">
                <div className="flex flex-col gap-3">
                  {variantLink ? (
                    <Link
                      to={variantLink}
                      className="outline-none focus-within:shadow-borders-interactive-with-focus rounded-md [&:hover>div]:bg-ui-bg-component-hover"
                    >
                      <div className="shadow-elevation-card-rest bg-ui-bg-component rounded-md px-4 py-2 transition-colors">
                        <div className="flex items-center gap-3">
                          <div className="shadow-elevation-card-rest flex h-14 w-14 items-center justify-center rounded-md text-ui-fg-muted">
                            <ShoppingBag />
                          </div>
                          <div className="flex flex-1 flex-col">
                            <Text size="small" leading="compact" weight="plus">
                              {subscription.product.variant_title}
                            </Text>
                            <Text
                              size="small"
                              leading="compact"
                              className="text-ui-fg-subtle"
                            >
                              {subscription.product.product_title}
                            </Text>
                          </div>
                          <div className="size-7 flex items-center justify-center">
                            <TriangleRightMini className="text-ui-fg-muted rtl:rotate-180" />
                          </div>
                        </div>
                      </div>
                    </Link>
                  ) : productLink ? (
                    <Link
                      to={productLink}
                      className="outline-none focus-within:shadow-borders-interactive-with-focus rounded-md [&:hover>div]:bg-ui-bg-component-hover"
                    >
                      <div className="shadow-elevation-card-rest bg-ui-bg-component rounded-md px-4 py-2 transition-colors">
                        <div className="flex items-center gap-3">
                          <div className="shadow-elevation-card-rest flex h-14 w-14 items-center justify-center rounded-md text-ui-fg-muted">
                            <ShoppingBag />
                          </div>
                          <div className="flex flex-1 flex-col">
                            <Text size="small" leading="compact" weight="plus">
                              {subscription.product.product_title}
                            </Text>
                            <Text
                              size="small"
                              leading="compact"
                              className="text-ui-fg-subtle"
                            >
                              {subscription.product.variant_title}
                            </Text>
                          </div>
                          <div className="size-7 flex items-center justify-center">
                            <TriangleRightMini className="text-ui-fg-muted rtl:rotate-180" />
                          </div>
                        </div>
                      </div>
                    </Link>
                  ) : (
                    <div className="shadow-elevation-card-rest bg-ui-bg-component rounded-md px-4 py-2">
                      <div className="flex items-center gap-3">
                        <div className="shadow-elevation-card-rest flex h-14 w-14 items-center justify-center rounded-md text-ui-fg-muted">
                          <ShoppingBag />
                        </div>
                        <div className="flex flex-1 flex-col">
                          <Text size="small" leading="compact" weight="plus">
                            {subscription.product.variant_title}
                          </Text>
                          <Text
                            size="small"
                            leading="compact"
                            className="text-ui-fg-subtle"
                          >
                            {subscription.product.product_title}
                          </Text>
                        </div>
                      </div>
                    </div>
                  )}
                  <DetailRow
                    label={t("common.fields.sku")}
                    value={subscription.product.sku || t("common.empty.noValue")}
                  />
                </div>
              </div>
            </Container>
            <Container className="divide-y p-0">
              <div className="px-4 py-4">
                <Text size="small" leading="compact" weight="plus">
                  {t("subscriptions.detail.sections.orders")}
                </Text>
              </div>
              <div className="px-4 py-4">
                <div className="flex flex-col gap-3">
                  {subscription.initial_order ? (
                    <LinkedOrderCard
                      label={t("subscriptions.detail.initialOrder")}
                      orderId={subscription.initial_order.order_id}
                      title={formatOrderDisplayLabel(
                        subscription.initial_order.display_id,
                        subscription.initial_order.order_id
                      )}
                      subtitle={`${subscription.initial_order.status} · ${formatDateTime(subscription.initial_order.created_at, t("common.empty.noValue"))}`}
                    />
                  ) : null}
                  {displayedRenewalOrders.map((order, index) => (
                    <LinkedOrderCard
                      key={order.order_id}
                      label={
                        index === 0
                          ? t("subscriptions.detail.latestRenewal")
                          : t("subscriptions.detail.renewalNumbered", {
                              index: index + 1,
                            })
                      }
                      orderId={order.order_id}
                      title={formatOrderDisplayLabel(order.display_id, order.order_id)}
                      subtitle={`${order.status} · ${formatDateTime(order.created_at, t("common.empty.noValue"))}`}
                    />
                  ))}
                  {!subscription.initial_order && !displayedRenewalOrders.length ? (
                    <Text
                      size="small"
                      leading="compact"
                      className="text-ui-fg-subtle"
                    >
                      {t("subscriptions.detail.noLinkedOrders")}
                    </Text>
                  ) : null}
                </div>
              </div>
            </Container>
        </div>
      </div>


      <Drawer open={planDrawerOpen} onOpenChange={setPlanDrawerOpen}>
        <Drawer.Content>
          <Drawer.Header>
            <Drawer.Title>{t("subscriptions.planChange.title")}</Drawer.Title>
          </Drawer.Header>
          <Drawer.Body className="flex flex-1 flex-col gap-y-4 p-4">
            <div className="grid gap-4">
              <div className="grid gap-2">
                <Label htmlFor="variant">{t("common.fields.variant")}</Label>
                <Select value={variantId} onValueChange={setVariantId}>
                  <Select.Trigger id="variant">
                    <Select.Value
                      placeholder={t("subscriptions.planChange.selectVariant")}
                    />
                  </Select.Trigger>
                  <Select.Content>
                    {variantOptions.map((option) => (
                      <Select.Item key={option.value} value={option.value}>
                        {option.label}
                      </Select.Item>
                    ))}
                  </Select.Content>
                </Select>
                {isLoadingPlanOptions ? (
                  <div className="flex items-center gap-x-2 text-ui-fg-subtle">
                    <Spinner className="animate-spin" />
                    <Text size="small" leading="compact" className="text-ui-fg-subtle">
                      {t("subscriptions.planChange.loadingVariants")}
                    </Text>
                  </div>
                ) : null}
                {isPlanOptionsError ? (
                  <Alert variant="error">
                    {planOptionsError instanceof Error
                      ? planOptionsError.message
                      : t("subscriptions.planChange.variantLoadError")}
                  </Alert>
                ) : null}
                {!isLoadingPlanOptions && !isPlanOptionsError && !variantOptions.length ? (
                  <Text size="small" leading="compact" className="text-ui-fg-subtle">
                    {t("subscriptions.planChange.noVariants")}
                  </Text>
                ) : null}
              </div>
              <div className="grid gap-2">
                <Label htmlFor="frequency-interval">
                  {t("subscriptions.planChange.frequencyInterval")}
                </Label>
                <Select
                  value={frequencyInterval}
                  onValueChange={(value) =>
                    setFrequencyInterval(value as SubscriptionFrequencyInterval)
                  }
                >
                  <Select.Trigger id="frequency-interval">
                    <Select.Value
                      placeholder={t("subscriptions.planChange.selectInterval")}
                    />
                  </Select.Trigger>
                  <Select.Content>
                    {intervalOptions.map((option) => (
                      <Select.Item key={option.value} value={option.value}>
                        {option.label}
                      </Select.Item>
                    ))}
                  </Select.Content>
                </Select>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="frequency-value">
                  {t("subscriptions.planChange.frequencyValue")}
                </Label>
                <Input
                  id="frequency-value"
                  type="number"
                  min={1}
                  step={1}
                  value={frequencyValue}
                  onChange={(event) => setFrequencyValue(event.target.value)}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="effective-at">
                  {t("subscriptions.detail.fields.effectiveAt")}
                </Label>
                <Input
                  id="effective-at"
                  type="datetime-local"
                  value={effectiveAt}
                  onChange={(event) => setEffectiveAt(event.target.value)}
                />
                <Text size="small" leading="compact" className="text-ui-fg-subtle">
                  {t("subscriptions.addressHints.effectiveAtOptional")}
                </Text>
              </div>
            </div>
          </Drawer.Body>
          <Drawer.Footer>
            <div className="flex items-center justify-end gap-x-2">
              <Drawer.Close asChild>
                <Button size="small" variant="secondary" disabled={planChangeMutation.isPending}>
                  {t("common.actions.cancel")}
                </Button>
              </Drawer.Close>
              <Button
                size="small"
                onClick={handleSubmit}
                isLoading={planChangeMutation.isPending}
                disabled={
                  planChangeMutation.isPending ||
                  isLoadingPlanOptions ||
                  isPlanOptionsError ||
                  !variantOptions.length
                }
              >
                {t("common.actions.save")}
              </Button>
            </div>
          </Drawer.Footer>
        </Drawer.Content>
      </Drawer>

      <Drawer open={shippingDrawerOpen} onOpenChange={setShippingDrawerOpen}>
        <Drawer.Content>
          <Drawer.Header>
            <Drawer.Title>{t("subscriptions.detail.editShippingAddress")}</Drawer.Title>
          </Drawer.Header>
          <Drawer.Body className="flex flex-1 flex-col gap-y-4 p-4">
            <div className="grid gap-4">
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <div className="grid gap-2">
                  <Label htmlFor="first-name">
                    {t("subscriptions.detail.fields.firstName")}
                  </Label>
                  <Input
                    id="first-name"
                    value={shippingAddressForm.first_name}
                    onChange={(event) =>
                      handleShippingAddressChange("first_name", event.target.value)
                    }
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="last-name">
                    {t("subscriptions.detail.fields.lastName")}
                  </Label>
                  <Input
                    id="last-name"
                    value={shippingAddressForm.last_name}
                    onChange={(event) =>
                      handleShippingAddressChange("last_name", event.target.value)
                    }
                  />
                </div>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="company">
                  {t("subscriptions.detail.fields.company")}
                </Label>
                <Input
                  id="company"
                  value={shippingAddressForm.company}
                  onChange={(event) =>
                    handleShippingAddressChange("company", event.target.value)
                  }
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="address-1">
                  {t("subscriptions.detail.fields.addressLine1")}
                </Label>
                <Input
                  id="address-1"
                  value={shippingAddressForm.address_1}
                  onChange={(event) =>
                    handleShippingAddressChange("address_1", event.target.value)
                  }
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="address-2">
                  {t("subscriptions.detail.fields.addressLine2")}
                </Label>
                <Input
                  id="address-2"
                  value={shippingAddressForm.address_2}
                  onChange={(event) =>
                    handleShippingAddressChange("address_2", event.target.value)
                  }
                />
              </div>
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <div className="grid gap-2">
                  <Label htmlFor="city">{t("subscriptions.detail.fields.city")}</Label>
                  <Input
                    id="city"
                    value={shippingAddressForm.city}
                    onChange={(event) =>
                      handleShippingAddressChange("city", event.target.value)
                    }
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="postal-code">
                    {t("subscriptions.detail.fields.postalCode")}
                  </Label>
                  <Input
                    id="postal-code"
                    value={shippingAddressForm.postal_code}
                    onChange={(event) =>
                      handleShippingAddressChange("postal_code", event.target.value)
                    }
                  />
                </div>
              </div>
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <div className="grid gap-2">
                  <Label htmlFor="province">
                    {t("subscriptions.detail.fields.province")}
                  </Label>
                  <Input
                    id="province"
                    value={shippingAddressForm.province}
                    onChange={(event) =>
                      handleShippingAddressChange("province", event.target.value)
                    }
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="country-code">
                    {t("subscriptions.detail.fields.countryCode")}
                  </Label>
                  <Input
                    id="country-code"
                    maxLength={2}
                    value={shippingAddressForm.country_code}
                    onChange={(event) =>
                      handleShippingAddressChange("country_code", event.target.value)
                    }
                  />
                  <Text size="small" leading="compact" className="text-ui-fg-subtle">
                    {t("subscriptions.addressHints.countryCodeIso")}
                  </Text>
                </div>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="phone">{t("subscriptions.detail.fields.phone")}</Label>
                <Input
                  id="phone"
                  value={shippingAddressForm.phone}
                  onChange={(event) =>
                    handleShippingAddressChange("phone", event.target.value)
                  }
                />
              </div>
            </div>
          </Drawer.Body>
          <Drawer.Footer>
            <div className="flex items-center justify-end gap-x-2">
              <Drawer.Close asChild>
                <Button
                  size="small"
                  variant="secondary"
                  disabled={updateShippingAddressMutation.isPending}
                >
                  {t("common.actions.cancel")}
                </Button>
              </Drawer.Close>
              <Button
                size="small"
                onClick={handleShippingAddressSubmit}
                isLoading={updateShippingAddressMutation.isPending}
                disabled={updateShippingAddressMutation.isPending}
              >
                {t("common.actions.save")}
              </Button>
            </div>
          </Drawer.Footer>
        </Drawer.Content>
      </Drawer>

      <Drawer
        open={activityLogDrawerOpen}
        onOpenChange={(open) => {
          setActivityLogDrawerOpen(open);

          if (!open) {
            setSelectedLogId(null);
          }
        }}
      >
        <Drawer.Content>
          <Drawer.Header>
            <Drawer.Title>{t("subscriptions.timeline.eventTitle")}</Drawer.Title>
          </Drawer.Header>
          <Drawer.Body className="flex flex-1 flex-col gap-y-6 overflow-y-auto p-4">
            {isSelectedLogLoading ? (
              <div className="flex items-center gap-x-2 text-ui-fg-subtle">
                <Spinner className="animate-spin" />
                <Text size="small" leading="compact" className="text-ui-fg-subtle">
                  {t("subscriptions.timeline.eventLoading")}
                </Text>
              </div>
            ) : selectedLogData?.subscription_log ? (
              <ActivityLogDetailContent log={selectedLogData.subscription_log} />
            ) : (
              <Alert variant="error">
                {t("subscriptions.timeline.eventLoadError")}
              </Alert>
            )}
          </Drawer.Body>
          <Drawer.Footer>
            <div className="flex items-center justify-end gap-x-2">
              <Drawer.Close asChild>
                <Button size="small" variant="secondary">
                  {t("common.actions.close")}
                </Button>
              </Drawer.Close>
            </div>
          </Drawer.Footer>
        </Drawer.Content>
      </Drawer>
    </div>
  );
};

const DetailBlock = ({
  title,
  rows,
  columns = 1,
}: {
  title: string;
  rows: { label: string; value: ReactNode; className?: string }[];
  columns?: 1 | 2;
}) => {
  return (
    <div className="rounded-lg border p-4">
      <Text size="small" leading="compact" weight="plus">
        {title}
      </Text>
      <div
        className={`mt-4 grid gap-3 ${columns === 2 ? "md:grid-cols-2" : ""}`}
      >
        {rows.map((row) => (
          <DetailRow
            key={`${title}-${row.label}-${String(
              typeof row.value === "string" ? row.value : ""
            )}`}
            label={row.label}
            value={row.value}
            className={row.className}
          />
        ))}
      </div>
    </div>
  );
};

const DetailRow = ({
  label,
  value,
  className,
}: {
  label: string;
  value: ReactNode;
  className?: string;
}) => {
  const { t } = useTranslation("reorder");

  return (
    <div className={`grid gap-1 ${className ?? ""}`}>
      <Text size="small" leading="compact" className="text-ui-fg-subtle">
        {label}
      </Text>
      {typeof value === "string" ? (
        <Text size="small" leading="compact" weight="plus">
          {value || t("common.empty.noValue")}
        </Text>
      ) : (
        value
      )}
    </div>
  );
};

const LinkedOrderCard = ({
  label,
  orderId,
  title,
  subtitle,
}: {
  label: string;
  orderId: string;
  title: string;
  subtitle: string;
}) => {
  return (
    <div className="grid gap-1">
      <Text size="small" leading="compact" className="text-ui-fg-subtle">
        {label}
      </Text>
      <Link
        to={`/orders/${orderId}`}
        className="outline-none focus-within:shadow-borders-interactive-with-focus rounded-md [&:hover>div]:bg-ui-bg-component-hover"
      >
        <div className="shadow-elevation-card-rest bg-ui-bg-component rounded-md px-4 py-2 transition-colors">
          <div className="flex items-center gap-3">
            <div className="shadow-elevation-card-rest flex h-12 w-12 items-center justify-center rounded-md text-ui-fg-muted">
              <ShoppingBag />
            </div>
            <div className="flex flex-1 flex-col">
              <Text size="small" leading="compact" weight="plus">
                {title}
              </Text>
              <Text
                size="small"
                leading="compact"
                className="text-ui-fg-subtle"
              >
                {subtitle}
              </Text>
            </div>
            <div className="size-7 flex items-center justify-center">
              <TriangleRightMini className="text-ui-fg-muted rtl:rotate-180" />
            </div>
          </div>
        </div>
      </Link>
    </div>
  );
};

function formatOrderDisplayLabel(displayId: number | null, orderId: string) {
  if (displayId !== null) {
    return `#${displayId}`;
  }

  return orderId;
}

const ActivityLogDetailContent = ({ log }: { log: ActivityLogAdminDetail }) => {
  const { t } = useTranslation("reorder");

  return (
    <div className="flex flex-col gap-y-6">
      <DetailBlock
        title={t("subscriptions.detail.sections.overview")}
        rows={[
          {
            label: t("subscriptions.detail.fields.event"),
            value: (
              <StatusBadge color={getActivityEventColor(log.event_type)}>
                {formatActivityEventType(log.event_type)}
              </StatusBadge>
            ),
          },
          {
            label: t("subscriptions.detail.fields.actor"),
            value: getActivityActorDisplay(log, t),
          },
          {
            label: t("subscriptions.detail.fields.created"),
            value: formatDateTime(log.created_at, t("common.empty.noValue")),
          },
          {
            label: t("common.fields.reason"),
            value: log.reason || t("common.empty.noValue"),
          },
          {
            label: t("subscriptions.detail.fields.summary"),
            value: formatActivitySummary(log, t),
          },
        ]}
      />
      <DetailBlock
        title={t("subscriptions.detail.sections.subscriptionSnapshot")}
        rows={[
          {
            label: t("common.fields.reference"),
            value: log.subscription.reference,
          },
          {
            label: t("common.fields.customer"),
            value: log.subscription.customer_name,
          },
          {
            label: t("common.fields.product"),
            value: log.subscription.product_title,
          },
          {
            label: t("common.fields.variant"),
            value: log.subscription.variant_title,
          },
        ]}
      />
      <DetailBlock
        title={t("subscriptions.detail.sections.changedFields")}
        rows={
          log.changed_fields.length
            ? log.changed_fields.map((field) => ({
                label: formatActivitySummaryField(field.field, t),
                value: `${formatUnknown(field.before, t("common.empty.noValue"))} → ${formatUnknown(
                  field.after,
                  t("common.empty.noValue"),
                )}`,
              }))
            : [
                {
                  label: t("subscriptions.detail.sections.changedFields"),
                  value: t("subscriptions.timeline.noChangedFields"),
                },
              ]
        }
      />
      <JsonBlock
        title={t("subscriptions.detail.sections.previousState")}
        value={log.previous_state}
      />
      <JsonBlock
        title={t("subscriptions.detail.sections.newState")}
        value={log.new_state}
      />
      <JsonBlock
        title={t("subscriptions.detail.sections.metadata")}
        value={log.metadata}
      />
    </div>
  );
};

const JsonBlock = ({
  title,
  value,
}: {
  title: string;
  value: Record<string, unknown> | null;
}) => {
  const { t } = useTranslation("reorder");

  return (
    <div className="rounded-lg border p-4">
      <Text size="small" leading="compact" weight="plus">
        {title}
      </Text>
      <div className="mt-4">
        <pre className="overflow-x-auto whitespace-pre-wrap break-words text-[12px] leading-5 text-ui-fg-subtle">
          {value
            ? JSON.stringify(value, null, 2)
            : t("subscriptions.timeline.noData")}
        </pre>
      </div>
    </div>
  );
};

const FilterChip = ({
  label,
  value,
  onRemove,
}: {
  label: string;
  value: string;
  onRemove: () => void;
}) => {
  const { t } = useTranslation("reorder");

  return (
    <div className="flex items-center overflow-hidden rounded-md border border-ui-border-base bg-ui-bg-component">
      <div className="border-r border-ui-border-base px-4 py-2">
        <Text size="small" leading="compact" weight="plus">
          {label}
        </Text>
      </div>
      <div className="border-r border-ui-border-base px-4 py-2">
        <Text size="small" leading="compact" className="text-ui-fg-subtle">
          {t("common.filters.is")}
        </Text>
      </div>
      <div className="px-4 py-2">
        <Text size="small" leading="compact" weight="plus">
          {value}
        </Text>
      </div>
      <button
        type="button"
        className="border-l border-ui-border-base px-4 py-2 text-ui-fg-subtle transition-colors hover:text-ui-fg-base"
        onClick={onRemove}
        aria-label={t("common.filters.removeFilter", { label })}
      >
        <XMarkMini />
      </button>
    </div>
  );
};

function removeTimelineFilter(
  filtering: DataTableFilteringState,
  key: string,
): DataTableFilteringState {
  const next = { ...filtering };
  delete next[key];

  return next;
}

function getStatusColor(status: SubscriptionAdminStatus) {
  switch (status) {
    case SubscriptionAdminStatus.ACTIVE:
      return "green" as const;
    case SubscriptionAdminStatus.PAUSED:
      return "orange" as const;
    case SubscriptionAdminStatus.CANCELLED:
      return "red" as const;
    case SubscriptionAdminStatus.PAST_DUE:
      return "grey" as const;
  }
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

function formatDateTimeInputValue(value: string) {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function toDateTimeLocalValue(value: string | null) {
  if (!value) {
    return "";
  }

  const date = new Date(value);
  const pad = (input: number) => String(input).padStart(2, "0");

  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(
    date.getDate(),
  )}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function getSubscriptionActionPromptConfig(
  action: SubscriptionActionType,
  t: ReorderTranslate,
) {
  switch (action) {
    case "pause":
      return {
        title: t("subscriptions.prompt.pauseTitle"),
        description: t("subscriptions.prompt.pauseDescription"),
        confirmText: t("subscriptions.actions.pause"),
        cancelText: t("common.actions.cancel"),
        variant: "confirmation" as const,
      };
    case "resume":
      return {
        title: t("subscriptions.prompt.resumeTitle"),
        description: t("subscriptions.prompt.resumeDescription"),
        confirmText: t("subscriptions.actions.resume"),
        cancelText: t("common.actions.cancel"),
        variant: "confirmation" as const,
      };
    case "cancel":
      return {
        title: t("subscriptions.prompt.cancelTitle"),
        description: t("subscriptions.prompt.cancelDescription"),
        confirmText: t("subscriptions.actions.cancelSubscription"),
        cancelText: t("subscriptions.actions.keepSubscription"),
        variant: "danger" as const,
      };
  }
}

function getShippingAddressFormState(
  address: SubscriptionAdminShippingAddress,
): ShippingAddressFormState {
  return {
    first_name: address.first_name,
    last_name: address.last_name,
    company: address.company ?? "",
    address_1: address.address_1,
    address_2: address.address_2 ?? "",
    city: address.city,
    postal_code: address.postal_code,
    province: address.province ?? "",
    country_code: address.country_code.toUpperCase(),
    phone: address.phone ?? "",
  };
}

function getEmptyShippingAddressFormState(): ShippingAddressFormState {
  return {
    first_name: "",
    last_name: "",
    company: "",
    address_1: "",
    address_2: "",
    city: "",
    postal_code: "",
    province: "",
    country_code: "",
    phone: "",
  };
}

function normalizeOptionalString(value: string) {
  const normalized = value.trim();

  return normalized ? normalized : null;
}

function getActivityEventColor(eventType: string) {
  switch (eventType) {
    case "renewal.failed":
    case "dunning.unrecovered":
    case "subscription.canceled":
    case "cancellation.finalized":
      return "red" as const;
    case "renewal.succeeded":
    case "dunning.recovered":
    case "subscription.created":
      return "green" as const;
    case "renewal.force_requested":
    case "dunning.retry_executed":
    case "dunning.retry_schedule_updated":
    case "cancellation.offer_applied":
      return "orange" as const;
    case "subscription.paused":
    case "subscription.plan_change_scheduled":
      return "blue" as const;
    default:
      return "grey" as const;
  }
}

function formatActivityEventType(value: string) {
  return (
    value
      .split(".")
      .at(-1)
      ?.split("_")
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ") ?? value
  );
}

function formatActivityActorType(
  value: ActivityLogAdminActorType,
  t: ReorderTranslate,
) {
  return t(ACTIVITY_ACTOR_KEYS[value]);
}

function getActivityActorDisplay(
  log: Pick<ActivityLogAdminListItem, "actor" | "actor_id" | "actor_type">,
  t: ReorderTranslate,
) {
  return log.actor.display || log.actor_id || formatActivityActorType(log.actor_type, t);
}

function formatActivitySummary(
  log: Pick<ActivityLogAdminListItem, "change_summary" | "reason">,
  t: ReorderTranslate,
) {
  if (log.reason) {
    return log.reason;
  }

  if (!log.change_summary) {
    return t("subscriptions.timeline.noSummary");
  }

  return log.change_summary
    .split(",")
    .map((part) => formatActivitySummaryField(part.trim(), t))
    .filter(Boolean)
    .join(", ");
}

function formatActivitySummaryField(value: string, t: ReorderTranslate) {
  const key =
    ACTIVITY_SUMMARY_FIELD_KEYS[
      value as keyof typeof ACTIVITY_SUMMARY_FIELD_KEYS
    ];

  if (key) {
    return t(key);
  }

  return value
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function getActivityActorColor(value: ActivityLogAdminActorType) {
  switch (value) {
    case ActivityLogAdminActorType.USER:
      return "blue" as const;
    case ActivityLogAdminActorType.CUSTOMER:
      return "green" as const;
    case ActivityLogAdminActorType.SYSTEM:
      return "grey" as const;
    case ActivityLogAdminActorType.SCHEDULER:
      return "orange" as const;
  }
}

function formatUnknown(value: unknown, emptyValue: string) {
  if (value === null || value === undefined) {
    return emptyValue;
  }

  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  return JSON.stringify(value);
}

export const handle = {
  breadcrumb: ({ data }: UIMatch<SubscriptionAdminDetailResponse>) =>
    data?.subscription?.reference || translate("subscriptions.breadcrumb"),
};

export async function loader({ params }: LoaderFunctionArgs) {
  return sdk.client.fetch<SubscriptionAdminDetailResponse>(
    `/admin/subscriptions/${params.id}`,
  );
}

export default SubscriptionDetailPage;
