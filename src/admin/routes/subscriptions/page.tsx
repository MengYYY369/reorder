import { defineRouteConfig } from "@medusajs/admin-sdk";
import { translate, type ReorderTranslate } from "../../i18n/translate";
import { useTranslation } from "react-i18next";
import {
  Calendar,
  Pause,
  TriangleRightMini,
  Trash,
  XMarkMini,
} from "@medusajs/icons";
import {
  Alert,
  Button,
  Container,
  createDataTableColumnHelper,
  createDataTableFilterHelper,
  DataTable,
  DataTableFilteringState,
  DataTablePaginationState,
  DataTableSortingState,
  DropdownMenu,
  Heading,
  StatusBadge,
  Table,
  Text,
  toast,
  useDataTable,
  usePrompt,
} from "@medusajs/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { flexRender } from "@tanstack/react-table";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  invalidateAdminSubscriptionsQueries,
  useAdminSubscriptionsDisplayQuery,
} from "./data-loading";
import { sdk } from "../../lib/client";
import {
  SubscriptionAdminDetailResponse,
  SubscriptionAdminListItem,
  SubscriptionAdminStatus,
} from "../../types/subscription";

const PAGE_SIZE = 20;

const columnHelper = createDataTableColumnHelper<SubscriptionAdminListItem>();
const filterHelper = createDataTableFilterHelper<SubscriptionAdminListItem>();

type SubscriptionActionType = "pause" | "resume" | "cancel";

const SubscriptionsPage = () => {
  const { t } = useTranslation("reorder");
  const [search, setSearch] = useState("");
  const [filtering, setFiltering] = useState<DataTableFilteringState>({});
  const [sorting, setSorting] = useState<DataTableSortingState | null>({
    id: "updated_at",
    desc: true,
  });
  const [pagination, setPagination] = useState<DataTablePaginationState>({
    pageIndex: 0,
    pageSize: PAGE_SIZE,
  });
  const prompt = usePrompt();
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const statusFilters = useMemo(() => {
    return (filtering.status || []) as SubscriptionAdminStatus[];
  }, [filtering]);
  const trialFilterValue = useMemo(() => {
    return typeof filtering.is_trial === "boolean"
      ? filtering.is_trial
      : undefined;
  }, [filtering]);
  const skipNextCycleFilterValue = useMemo(() => {
    return typeof filtering.skip_next_cycle === "boolean"
      ? filtering.skip_next_cycle
      : undefined;
  }, [filtering]);
  const nextRenewalFilterValue = useMemo(() => {
    return typeof filtering.next_renewal === "string"
      ? filtering.next_renewal
      : undefined;
  }, [filtering]);

  const statusFilterOptions = useMemo(() => {
    return [
      {
        label: t("subscriptions.status.active"),
        value: SubscriptionAdminStatus.ACTIVE,
      },
      {
        label: t("subscriptions.status.paused"),
        value: SubscriptionAdminStatus.PAUSED,
      },
      {
        label: t("subscriptions.status.cancelled"),
        value: SubscriptionAdminStatus.CANCELLED,
      },
      {
        label: t("subscriptions.status.pastDue"),
        value: SubscriptionAdminStatus.PAST_DUE,
      },
    ] as const;
  }, [t]);

  const booleanFilterOptions = useMemo(() => {
    return [
      { label: t("common.filters.yes"), value: true },
      { label: t("common.filters.no"), value: false },
    ] as const;
  }, [t]);

  const nextRenewalFilterOptions = useMemo(() => {
    return [
      { label: t("subscriptions.filters.overdue"), value: "overdue" },
      { label: t("subscriptions.filters.next7Days"), value: "next_7_days" },
      { label: t("subscriptions.filters.next30Days"), value: "next_30_days" },
      { label: t("subscriptions.filters.next90Days"), value: "next_90_days" },
    ] as const;
  }, [t]);

  const filters = useMemo(() => {
    const statusFilter = filterHelper.accessor("status", {
      type: "multiselect",
      label: t("common.fields.status"),
      options: [...statusFilterOptions],
    });

    const trialFilter = filterHelper.accessor("trial.is_trial", {
      id: "is_trial",
      type: "radio",
      label: t("subscriptions.filters.trial"),
      options: [...booleanFilterOptions],
    });

    const skipNextCycleFilter = filterHelper.accessor("skip_next_cycle", {
      type: "radio",
      label: t("subscriptions.filters.skipNextCycle"),
      options: [...booleanFilterOptions],
    });

    const nextRenewalFilter = filterHelper.accessor("next_renewal_at", {
      id: "next_renewal",
      type: "radio",
      label: t("common.fields.nextRenewal"),
      options: [...nextRenewalFilterOptions],
    });

    return [statusFilter, trialFilter, skipNextCycleFilter, nextRenewalFilter];
  }, [booleanFilterOptions, nextRenewalFilterOptions, statusFilterOptions, t]);

  const activeStatusLabels = useMemo(() => {
    return (
      statusFilterOptions
        .filter((option) => statusFilters.includes(option.value))
        .map((option) => option.label) ?? []
    );
  }, [statusFilterOptions, statusFilters]);
  const activeTrialLabel = useMemo(() => {
    return booleanFilterOptions.find((option) => option.value === trialFilterValue)
      ?.label;
  }, [booleanFilterOptions, trialFilterValue]);
  const activeSkipNextCycleLabel = useMemo(() => {
    return booleanFilterOptions.find(
      (option) => option.value === skipNextCycleFilterValue,
    )?.label;
  }, [booleanFilterOptions, skipNextCycleFilterValue]);
  const activeNextRenewalLabel = useMemo(() => {
    return nextRenewalFilterOptions.find(
      (option) => option.value === nextRenewalFilterValue,
    )?.label;
  }, [nextRenewalFilterOptions, nextRenewalFilterValue]);
  const hasActiveFilters =
    statusFilters.length ||
    typeof trialFilterValue === "boolean" ||
    typeof skipNextCycleFilterValue === "boolean" ||
    Boolean(nextRenewalFilterValue);

  const { data, isLoading, isError, error } =
    useAdminSubscriptionsDisplayQuery({
      pagination,
      search,
      filtering,
      sorting,
    });

  const pauseMutation = useMutation({
    mutationFn: async (subscriptionId: string) =>
      sdk.client.fetch<SubscriptionAdminDetailResponse>(
        `/admin/subscriptions/${subscriptionId}/pause`,
        {
          method: "POST",
          body: {},
        },
      ),
    onSuccess: async (_data, subscriptionId) => {
      await invalidateAdminSubscriptionsQueries(queryClient, subscriptionId);
      toast.success(t("subscriptions.toast.paused"));
    },
    onError: (error) => {
      toast.error(
        error instanceof Error
          ? error.message
          : t("subscriptions.errors.pauseFailed"),
      );
    },
  });

  const resumeMutation = useMutation({
    mutationFn: async (subscriptionId: string) =>
      sdk.client.fetch<SubscriptionAdminDetailResponse>(
        `/admin/subscriptions/${subscriptionId}/resume`,
        {
          method: "POST",
          body: {},
        },
      ),
    onSuccess: async (_data, subscriptionId) => {
      await invalidateAdminSubscriptionsQueries(queryClient, subscriptionId);
      toast.success(t("subscriptions.toast.resumed"));
    },
    onError: (error) => {
      toast.error(
        error instanceof Error
          ? error.message
          : t("subscriptions.errors.resumeFailed"),
      );
    },
  });

  const cancelMutation = useMutation({
    mutationFn: async (subscriptionId: string) =>
      sdk.client.fetch<SubscriptionAdminDetailResponse>(
        `/admin/subscriptions/${subscriptionId}/cancel`,
        {
          method: "POST",
          body: {},
        },
      ),
    onSuccess: async (_data, subscriptionId) => {
      await invalidateAdminSubscriptionsQueries(queryClient, subscriptionId);
      toast.success(t("subscriptions.toast.cancelled"));
    },
    onError: (error) => {
      toast.error(
        error instanceof Error
          ? error.message
          : t("subscriptions.errors.cancelFailed"),
      );
    },
  });

  const pendingActionBySubscriptionId = useMemo(() => {
    const pending = new Map<string, SubscriptionActionType>();

    if (pauseMutation.isPending && pauseMutation.variables) {
      pending.set(pauseMutation.variables, "pause");
    }

    if (resumeMutation.isPending && resumeMutation.variables) {
      pending.set(resumeMutation.variables, "resume");
    }

    if (cancelMutation.isPending && cancelMutation.variables) {
      pending.set(cancelMutation.variables, "cancel");
    }

    return pending;
  }, [
    cancelMutation.isPending,
    cancelMutation.variables,
    pauseMutation.isPending,
    pauseMutation.variables,
    resumeMutation.isPending,
    resumeMutation.variables,
  ]);

  const columns = useMemo(() => {
    const baseColumns = [
      columnHelper.accessor("reference", {
        header: t("subscriptions.columns.reference"),
        cell: ({ getValue, row }) => (
          <div className="flex flex-col">
            <Text size="small" leading="compact" weight="plus">
              {getValue()}
            </Text>
            <Text size="small" leading="compact" className="text-ui-fg-subtle">
              {row.original.id}
            </Text>
          </div>
        ),
      }),
      columnHelper.accessor((row) => row.product.product_title, {
        id: "product_title",
        header: t("common.fields.product"),
        enableSorting: true,
        sortLabel: t("common.fields.product"),
        cell: ({ row }) => (
          <div className="flex flex-col">
            <Text size="small" leading="compact" weight="plus">
              {row.original.product.product_title}
            </Text>
            <Text size="small" leading="compact" className="text-ui-fg-subtle">
              {row.original.product.variant_title}
            </Text>
          </div>
        ),
      }),
      columnHelper.accessor("status", {
        header: t("common.fields.status"),
        enableSorting: true,
        sortLabel: t("common.fields.status"),
        cell: ({ getValue }) => (
          <StatusBadge color={getStatusColor(getValue())} className="text-nowrap">
            {t(SUBSCRIPTION_STATUS_KEYS[getValue()])}
          </StatusBadge>
        ),
      }),
      columnHelper.accessor("frequency.label", {
        id: "frequency",
        header: t("common.fields.frequency"),
        cell: ({ getValue, row }) => (
          <div className="flex flex-col">
            <Text size="small" leading="compact" weight="plus">
              {getValue()}
            </Text>
            {row.original.discount ? (
              <Text size="small" leading="compact" className="text-ui-fg-subtle">
                {row.original.discount.label}
              </Text>
            ) : null}
          </div>
        ),
      }),
      columnHelper.accessor("next_renewal_at", {
        header: t("common.fields.nextRenewal"),
        enableSorting: true,
        sortLabel: t("common.fields.nextRenewal"),
        cell: ({ getValue, row }) => (
          <div className="flex flex-col">
            <Text size="small" leading="compact" weight="plus">
              {formatDateTime(
                row.original.effective_next_renewal_at ?? getValue(),
                t("common.empty.noValue"),
              )}
            </Text>
            <Text size="small" leading="compact" className="text-ui-fg-subtle">
              {row.original.skip_next_cycle
                ? t("subscriptions.columns.projectedAfterSkip")
                : t("subscriptions.columns.scheduled")}
            </Text>
          </div>
        ),
      }),
    ];

    return [
      ...baseColumns,
      columnHelper.action({
        actions: ({ row }) => {
          const subscription = row.original;
          const pendingAction = pendingActionBySubscriptionId.get(subscription.id);
          const isPending = Boolean(pendingAction);
          const canPause =
            subscription.status === SubscriptionAdminStatus.ACTIVE;
          const canResume =
            subscription.status === SubscriptionAdminStatus.PAUSED;
          const canCancel =
            subscription.status !== SubscriptionAdminStatus.CANCELLED;

          const actionGroups = [
            canPause
              ? [
                  {
                    label: pendingAction === "pause"
                      ? t("subscriptions.actions.pausing")
                      : t("subscriptions.actions.pause"),
                    icon: <Pause />,
                    onClick: () => {
                      void handleSubscriptionAction(subscription, "pause");
                    },
                  },
                ]
              : [],
            canResume
              ? [
                  {
                    label: pendingAction === "resume"
                      ? t("subscriptions.actions.resuming")
                      : t("subscriptions.actions.resume"),
                    icon: <TriangleRightMini />,
                    onClick: () => {
                      void handleSubscriptionAction(subscription, "resume");
                    },
                  },
                ]
              : [],
            canCancel
              ? [
                  {
                    label: pendingAction === "cancel"
                      ? t("subscriptions.actions.cancelling")
                      : t("common.actions.cancel"),
                    icon: <Trash />,
                    onClick: () => {
                      void handleSubscriptionAction(subscription, "cancel");
                    },
                  },
                ]
              : [],
          ].filter((group) => group.length);

          return actionGroups.map((group) =>
            group.map((action) => ({
              ...action,
              icon: (
                <span className="text-ui-fg-subtle [&_svg]:text-ui-fg-subtle">
                  {action.icon}
                </span>
              ),
              onClick: () => {
                if (isPending) {
                  return;
                }

                action.onClick();
              },
            })),
          );
        },
      }),
    ];
  }, [pendingActionBySubscriptionId, t]);

  const handleSubscriptionAction = async (
    subscription: SubscriptionAdminListItem,
    action: SubscriptionActionType,
  ) => {
    const confirmed = await prompt(getSubscriptionActionPromptConfig(action, t));

    if (!confirmed) {
      return;
    }

    switch (action) {
      case "pause":
        await pauseMutation.mutateAsync(subscription.id);
        break;
      case "resume":
        await resumeMutation.mutateAsync(subscription.id);
        break;
      case "cancel":
        await cancelMutation.mutateAsync(subscription.id);
        break;
    }
  };

  const table = useDataTable({
    columns,
    data: data?.subscriptions || [],
    getRowId: (row) => row.id,
    rowCount: data?.count || 0,
    isLoading,
    filters,
    filtering: {
      state: filtering,
      onFilteringChange: setFiltering,
    },
    sorting: {
      state: sorting,
      onSortingChange: setSorting,
    },
    search: {
      state: search,
      onSearchChange: setSearch,
    },
    pagination: {
      state: pagination,
      onPaginationChange: setPagination,
    },
    onRowClick: (_event, row) => {
      navigate(`/subscriptions/${row.id}`);
    },
  });

  if (isError) {
    return (
      <Container className="divide-y p-0">
        <div className="px-6 py-4">
          <Heading level="h1">{t("subscriptions.list.title")}</Heading>
          <Text size="small" leading="compact" className="text-ui-fg-subtle">
            {t("subscriptions.list.description")}
          </Text>
        </div>
        <div className="px-6 py-6">
          <Alert variant="error">
            {error instanceof Error
              ? error.message
              : t("subscriptions.list.loadError")}
          </Alert>
        </div>
      </Container>
    );
  }

  return (
    <div className="flex flex-col gap-y-4">
      <Container className="divide-y p-0">
        <div className="px-6 py-4">
          <Heading level="h1">{t("subscriptions.list.title")}</Heading>
          <Text size="small" leading="compact" className="text-ui-fg-subtle">
            {t("subscriptions.list.description")}
          </Text>
        </div>
        <DataTable instance={table} className="min-h-0">
          <div className="flex flex-col gap-2 px-6 py-4 md:flex-row md:items-center md:justify-between">
            <div className="flex flex-wrap items-center gap-2">
              {statusFilters.length ? (
                <FilterChip
                  label={statusFilter.label}
                  value={activeStatusLabels.join(", ")}
                  onRemove={() => {
                    setFiltering((current) => removeFilter(current, "status"));
                  }}
                />
              ) : null}
              {activeTrialLabel ? (
                <FilterChip
                  label={trialFilter.label}
                  value={activeTrialLabel}
                  onRemove={() => {
                    setFiltering((current) => removeFilter(current, "is_trial"));
                  }}
                />
              ) : null}
              {activeSkipNextCycleLabel ? (
                <FilterChip
                  label={skipNextCycleFilter.label}
                  value={activeSkipNextCycleLabel}
                  onRemove={() => {
                    setFiltering((current) =>
                      removeFilter(current, "skip_next_cycle"),
                    );
                  }}
                />
              ) : null}
              {activeNextRenewalLabel ? (
                <FilterChip
                  label={nextRenewalFilter.label}
                  value={activeNextRenewalLabel}
                  onRemove={() => {
                    setFiltering((current) => removeFilter(current, "next_renewal"));
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
                      {statusFilter.label}
                    </DropdownMenu.SubMenuTrigger>
                    <DropdownMenu.SubMenuContent>
                      {statusFilterOptions.map((option) => {
                        const checked = statusFilters.includes(option.value);

                        return (
                          <DropdownMenu.CheckboxItem
                            key={option.value}
                            checked={checked}
                            onSelect={(event) => {
                              event.preventDefault();
                            }}
                            onCheckedChange={(nextChecked) => {
                              const value = option.value;

                              setFiltering((current) => {
                                const currentValues = Array.isArray(
                                  current.status,
                                )
                                  ? (current.status as SubscriptionAdminStatus[])
                                  : [];

                                const nextValues = nextChecked
                                  ? currentValues.includes(value)
                                    ? currentValues
                                    : [...currentValues, value]
                                  : currentValues.filter(
                                      (currentValue) => currentValue !== value,
                                    );

                                if (!nextValues.length) {
                                  const { status, ...rest } = current;

                                  return rest;
                                }

                                return {
                                  ...current,
                                  status: nextValues,
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
                  <DropdownMenu.SubMenu>
                    <DropdownMenu.SubMenuTrigger>
                      {trialFilter.label}
                    </DropdownMenu.SubMenuTrigger>
                    <DropdownMenu.SubMenuContent>
                      {booleanFilterOptions.map((option) => (
                        <DropdownMenu.CheckboxItem
                          key={`trial-${String(option.value)}`}
                          checked={trialFilterValue === option.value}
                          onSelect={(event) => {
                            event.preventDefault();
                          }}
                          onCheckedChange={(nextChecked) => {
                            setFiltering((current) => {
                              if (!nextChecked) {
                                return removeFilter(current, "is_trial");
                              }

                              return {
                                ...current,
                                is_trial: option.value,
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
                      {skipNextCycleFilter.label}
                    </DropdownMenu.SubMenuTrigger>
                    <DropdownMenu.SubMenuContent>
                      {booleanFilterOptions.map((option) => (
                        <DropdownMenu.CheckboxItem
                          key={`skip-next-cycle-${String(option.value)}`}
                          checked={skipNextCycleFilterValue === option.value}
                          onSelect={(event) => {
                            event.preventDefault();
                          }}
                          onCheckedChange={(nextChecked) => {
                            setFiltering((current) => {
                              if (!nextChecked) {
                                return removeFilter(current, "skip_next_cycle");
                              }

                              return {
                                ...current,
                                skip_next_cycle: option.value,
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
                      {nextRenewalFilter.label}
                    </DropdownMenu.SubMenuTrigger>
                    <DropdownMenu.SubMenuContent>
                      {nextRenewalFilterOptions.map((option) => (
                        <DropdownMenu.CheckboxItem
                          key={option.value}
                          checked={nextRenewalFilterValue === option.value}
                          onSelect={(event) => {
                            event.preventDefault();
                          }}
                          onCheckedChange={(nextChecked) => {
                            setFiltering((current) => {
                              if (!nextChecked) {
                                return removeFilter(current, "next_renewal");
                              }

                              return {
                                ...current,
                                next_renewal: option.value,
                              };
                            });
                          }}
                        >
                          {option.label}
                        </DropdownMenu.CheckboxItem>
                      ))}
                    </DropdownMenu.SubMenuContent>
                  </DropdownMenu.SubMenu>
                  {hasActiveFilters ? (
                    <>
                      <DropdownMenu.Separator />
                      <DropdownMenu.Item
                        onSelect={(event) => {
                          event.preventDefault();
                          setFiltering({});
                        }}
                      >
                        Clear all filters
                      </DropdownMenu.Item>
                    </>
                  ) : null}
                </DropdownMenu.Content>
              </DropdownMenu>
              {hasActiveFilters ? (
                <button
                  type="button"
                  className="text-ui-fg-muted hover:text-ui-fg-subtle txt-compact-small-plus rounded-md px-2 py-1 transition-fg"
                  onClick={() => {
                    setFiltering({});
                  }}
                >
                  {t("common.filters.clearAll")}
                </button>
              ) : null}
            </div>
            <div className="flex items-center gap-x-2 self-end md:self-auto">
              <div className="w-full md:w-auto">
                <DataTable.Search placeholder={t("common.actions.search")} />
              </div>
              <DataTable.SortingMenu />
            </div>
          </div>
          {table.getRowModel().rows.length ? (
            <div className="overflow-x-auto border-y">
              <Table className="relative isolate w-full">
                <Table.Header className="border-t-0">
                  {table.getHeaderGroups().map((headerGroup) => (
                    <Table.Row
                      key={headerGroup.id}
                      className="border-b-0 [&_th:last-of-type]:w-[1%] [&_th:last-of-type]:whitespace-nowrap"
                    >
                      {headerGroup.headers.map((header) => {
                        const canSort = header.column.getCanSort();
                        const sortHandler = header.column.getToggleSortingHandler();

                        return (
                          <Table.HeaderCell
                            key={header.id}
                            className="whitespace-nowrap"
                          >
                            {header.isPlaceholder ? null : canSort ? (
                              <button
                                type="button"
                                onClick={sortHandler}
                                className="group flex items-center gap-2 text-left"
                              >
                                {flexRender(
                                  header.column.columnDef.header,
                                  header.getContext(),
                                )}
                              </button>
                            ) : (
                              flexRender(
                                header.column.columnDef.header,
                                header.getContext(),
                              )
                            )}
                          </Table.HeaderCell>
                        );
                      })}
                    </Table.Row>
                  ))}
                </Table.Header>
                <Table.Body className="border-b-0">
                  {table.getRowModel().rows.map((row) => (
                    <Table.Row
                      key={row.id}
                      className="group/row cursor-pointer"
                      onClick={(event) => {
                        event.preventDefault();
                        navigate(`/subscriptions/${row.id}`);
                      }}
                    >
                      {row.getVisibleCells().map((cell) => (
                        <Table.Cell
                          key={cell.id}
                          className="items-stretch truncate whitespace-nowrap"
                        >
                          {flexRender(
                            cell.column.columnDef.cell,
                            cell.getContext(),
                          )}
                        </Table.Cell>
                      ))}
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table>
            </div>
          ) : (
            <div className="flex min-h-[250px] w-full flex-col items-center justify-center border-y px-6 py-4 text-center">
              <Text size="base" weight="plus">
                {hasActiveFilters || search
                  ? t("subscriptions.list.emptyFiltered")
                  : t("subscriptions.list.empty")}
              </Text>
              <Text size="small" leading="compact" className="text-ui-fg-subtle">
                {hasActiveFilters || search
                  ? t("subscriptions.list.emptyFilteredHint")
                  : t("subscriptions.list.emptyHint")}
              </Text>
            </div>
          )}
          <DataTable.Pagination />
        </DataTable>
      </Container>
    </div>
  );
};

function getStatusColor(status: SubscriptionAdminStatus) {
  switch (status) {
    case SubscriptionAdminStatus.ACTIVE:
      return "green";
    case SubscriptionAdminStatus.PAUSED:
      return "orange";
    case SubscriptionAdminStatus.CANCELLED:
      return "red";
    case SubscriptionAdminStatus.PAST_DUE:
      return "grey";
  }
}

const SUBSCRIPTION_STATUS_KEYS = {
  [SubscriptionAdminStatus.ACTIVE]: "subscriptions.status.active",
  [SubscriptionAdminStatus.PAUSED]: "subscriptions.status.paused",
  [SubscriptionAdminStatus.CANCELLED]: "subscriptions.status.cancelled",
  [SubscriptionAdminStatus.PAST_DUE]: "subscriptions.status.pastDue",
} as const;

function formatDateTime(value: string | null, emptyValue: string) {
  if (!value) {
    return emptyValue;
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

export const config = defineRouteConfig({
  label: "menuItems.subscriptions",
  translationNs: "reorder",
  icon: Calendar,
});

export const handle = {
  breadcrumb: () => translate("menuItems.subscriptions"),
};

export default SubscriptionsPage;

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
    <div className="shadow-buttons-neutral txt-compact-small-plus bg-ui-button-neutral text-ui-fg-base inline-flex items-center overflow-hidden rounded-md">
      <span className="border-ui-border-base border-r px-3 py-1.5">{label}</span>
      <span className="border-ui-border-base border-r px-3 py-1.5 text-ui-fg-subtle">
        {t("common.filters.is")}
      </span>
      <span className="border-ui-border-base border-r px-3 py-1.5">{value}</span>
      <button
        type="button"
        className="hover:bg-ui-button-neutral-hover px-2 py-1.5 transition-fg"
        onClick={onRemove}
      >
        <XMarkMini />
      </button>
    </div>
  );
};

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

function removeFilter(
  current: DataTableFilteringState,
  key: string,
) {
  const { [key]: _removed, ...rest } = current;

  return rest;
}
