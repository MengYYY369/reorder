import { defineRouteConfig } from "@medusajs/admin-sdk";
import { translate, type ReorderTranslate } from "../../../i18n/translate";
import { useTranslation } from "react-i18next";
import { XMarkMini } from "@medusajs/icons";
import {
  Alert,
  Button,
  Container,
  createDataTableColumnHelper,
  DataTable,
  DataTableFilteringState,
  DataTablePaginationState,
  DataTableSortingState,
  DropdownMenu,
  Heading,
  Input,
  StatusBadge,
  Table,
  Text,
  useDataTable,
} from "@medusajs/ui";
import { flexRender } from "@tanstack/react-table";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  RenewalAdminApprovalSummary,
  RenewalApprovalStatus,
  RenewalAttemptAdminStatus,
  RenewalCycleAdminListItem,
  RenewalCycleAdminStatus,
} from "../../../types/renewal";
import { useAdminRenewalsDisplayQuery } from "./data-loading";

const PAGE_SIZE = 20;

const columnHelper = createDataTableColumnHelper<RenewalCycleAdminListItem>();

const RENEWAL_CYCLE_STATUS_KEYS = {
  [RenewalCycleAdminStatus.SCHEDULED]: "renewals.status.scheduled",
  [RenewalCycleAdminStatus.PROCESSING]: "renewals.status.processing",
  [RenewalCycleAdminStatus.SUCCEEDED]: "renewals.status.succeeded",
  [RenewalCycleAdminStatus.FAILED]: "renewals.status.failed",
} as const;

const RENEWAL_ATTEMPT_STATUS_KEYS = {
  [RenewalAttemptAdminStatus.PROCESSING]: "renewals.attemptStatus.processing",
  [RenewalAttemptAdminStatus.SUCCEEDED]: "renewals.attemptStatus.succeeded",
  [RenewalAttemptAdminStatus.FAILED]: "renewals.attemptStatus.failed",
} as const;

const RENEWAL_APPROVAL_FILTER_KEYS = {
  [RenewalApprovalStatus.PENDING]: "renewals.approval.pending",
  [RenewalApprovalStatus.APPROVED]: "renewals.approval.approved",
  [RenewalApprovalStatus.REJECTED]: "renewals.approval.rejected",
} as const;

const RENEWAL_RELATIVE_STATUS_KEYS = {
  [RenewalCycleAdminStatus.SCHEDULED]: "renewals.relativeStatus.awaitingProcessing",
  [RenewalCycleAdminStatus.PROCESSING]:
    "renewals.relativeStatus.currentlyProcessing",
  [RenewalCycleAdminStatus.SUCCEEDED]: "renewals.relativeStatus.processed",
  [RenewalCycleAdminStatus.FAILED]: "renewals.relativeStatus.needsReview",
} as const;

const RenewalsPage = () => {
  const { t } = useTranslation("reorder");
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const [filtering, setFiltering] = useState<DataTableFilteringState>(() => ({
    scheduled_from: toLocalDateTimeInputValue(startOfDay(addDays(new Date(), -30))),
    scheduled_to: toLocalDateTimeInputValue(startOfDay(addDays(new Date(), 30))),
  }));
  const [sorting, setSorting] = useState<DataTableSortingState | null>({
    id: "scheduled_for",
    desc: true,
  });
  const [pagination, setPagination] = useState<DataTablePaginationState>({
    pageIndex: 0,
    pageSize: PAGE_SIZE,
  });

  const statusFilterOptions = useMemo(() => {
    return [
      {
        label: t(RENEWAL_CYCLE_STATUS_KEYS[RenewalCycleAdminStatus.SCHEDULED]),
        value: RenewalCycleAdminStatus.SCHEDULED,
      },
      {
        label: t(RENEWAL_CYCLE_STATUS_KEYS[RenewalCycleAdminStatus.PROCESSING]),
        value: RenewalCycleAdminStatus.PROCESSING,
      },
      {
        label: t(RENEWAL_CYCLE_STATUS_KEYS[RenewalCycleAdminStatus.SUCCEEDED]),
        value: RenewalCycleAdminStatus.SUCCEEDED,
      },
      {
        label: t(RENEWAL_CYCLE_STATUS_KEYS[RenewalCycleAdminStatus.FAILED]),
        value: RenewalCycleAdminStatus.FAILED,
      },
    ] as const;
  }, [t]);

  const approvalFilterOptions = useMemo(() => {
    return [
      {
        label: t(RENEWAL_APPROVAL_FILTER_KEYS[RenewalApprovalStatus.PENDING]),
        value: RenewalApprovalStatus.PENDING,
      },
      {
        label: t(RENEWAL_APPROVAL_FILTER_KEYS[RenewalApprovalStatus.APPROVED]),
        value: RenewalApprovalStatus.APPROVED,
      },
      {
        label: t(RENEWAL_APPROVAL_FILTER_KEYS[RenewalApprovalStatus.REJECTED]),
        value: RenewalApprovalStatus.REJECTED,
      },
    ] as const;
  }, [t]);

  const attemptFilterOptions = useMemo(() => {
    return [
      {
        label: t(RENEWAL_ATTEMPT_STATUS_KEYS[RenewalAttemptAdminStatus.PROCESSING]),
        value: RenewalAttemptAdminStatus.PROCESSING,
      },
      {
        label: t(RENEWAL_ATTEMPT_STATUS_KEYS[RenewalAttemptAdminStatus.SUCCEEDED]),
        value: RenewalAttemptAdminStatus.SUCCEEDED,
      },
      {
        label: t(RENEWAL_ATTEMPT_STATUS_KEYS[RenewalAttemptAdminStatus.FAILED]),
        value: RenewalAttemptAdminStatus.FAILED,
      },
    ] as const;
  }, [t]);

  const columns = useMemo(() => {
    return [
      columnHelper.accessor("scheduled_for", {
        header: t("renewals.columns.scheduled"),
        enableSorting: true,
        sortLabel: t("renewals.columns.scheduled"),
        cell: ({ getValue, row }) => (
          <div className="flex flex-col">
            <Text size="small" leading="compact" weight="plus">
              {formatDateTime(
                row.original.effective_scheduled_for,
                t("common.empty.noValue")
              )}
            </Text>
            <Text size="small" leading="compact" className="text-ui-fg-subtle">
              {row.original.effective_scheduled_for !== getValue()
                ? t("renewals.columns.operationalCycle", {
                    value: formatDateTime(
                      getValue(),
                      t("common.empty.noValue")
                    ),
                  })
                : t(RENEWAL_RELATIVE_STATUS_KEYS[row.original.status])}
            </Text>
          </div>
        ),
      }),
      columnHelper.accessor("subscription.reference", {
        id: "subscription_reference",
        header: t("renewals.columns.subscription"),
        enableSorting: true,
        sortLabel: t("renewals.columns.subscription"),
        cell: ({ row }) => (
          <div className="flex flex-col gap-y-0.5">
            <Text size="small" leading="compact" weight="plus">
              {row.original.subscription.reference}
            </Text>
            <Text size="small" leading="compact" className="text-ui-fg-subtle">
              {row.original.subscription.customer_name}
            </Text>
            <Text size="small" leading="compact" className="text-ui-fg-subtle">
              {formatSubscriptionContext(row.original)}
            </Text>
          </div>
        ),
      }),
      columnHelper.accessor("status", {
        header: t("renewals.columns.status"),
        enableSorting: true,
        sortLabel: t("renewals.columns.status"),
        cell: ({ getValue }) => (
          <StatusBadge color={getCycleStatusColor(getValue())} className="text-nowrap">
            {t(RENEWAL_CYCLE_STATUS_KEYS[getValue()])}
          </StatusBadge>
        ),
      }),
      columnHelper.accessor("approval.status", {
        id: "approval_status",
        header: t("renewals.columns.approval"),
        enableSorting: true,
        sortLabel: t("renewals.columns.approval"),
        cell: ({ row }) => (
          <StatusBadge
            color={getApprovalStatusColor(row.original.approval)}
            className="text-nowrap"
          >
            {formatApprovalStatus(row.original.approval, t)}
          </StatusBadge>
        ),
      }),
      columnHelper.accessor("last_attempt_status", {
        header: t("renewals.columns.lastAttempt"),
        enableSorting: true,
        sortLabel: t("renewals.columns.lastAttempt"),
        cell: ({ row }) => {
          if (!row.original.last_attempt_status) {
            return (
              <Text size="small" leading="compact" className="text-ui-fg-subtle">
                {t("renewals.columns.noAttemptsYet")}
              </Text>
            );
          }

          return (
            <div className="flex flex-col">
              <StatusBadge
                color={getAttemptStatusColor(row.original.last_attempt_status)}
                className="text-nowrap"
              >
                {t(RENEWAL_ATTEMPT_STATUS_KEYS[row.original.last_attempt_status])}
              </StatusBadge>
              <Text size="small" leading="compact" className="text-ui-fg-subtle">
                {formatDateTime(
                  row.original.last_attempt_at,
                  t("common.empty.noValue")
                )}
              </Text>
            </div>
          );
        },
      }),
    ];
  }, [t]);

  const statusFilterValue = useMemo(() => {
    return Array.isArray(filtering.status)
      ? (filtering.status as RenewalCycleAdminStatus[])
      : [];
  }, [filtering]);
  const approvalFilterValue = useMemo(() => {
    return Array.isArray(filtering.approval_status)
      ? (filtering.approval_status as RenewalApprovalStatus[])
      : [];
  }, [filtering]);
  const lastAttemptFilterValue = useMemo(() => {
    return Array.isArray(filtering.last_attempt_status)
      ? (filtering.last_attempt_status as RenewalAttemptAdminStatus[])
      : [];
  }, [filtering]);
  const scheduledFromValue = useMemo(() => {
    return typeof filtering.scheduled_from === "string"
      ? filtering.scheduled_from
      : "";
  }, [filtering]);
  const scheduledToValue = useMemo(() => {
    return typeof filtering.scheduled_to === "string"
      ? filtering.scheduled_to
      : "";
  }, [filtering]);

  const { data, isLoading, isError, error } = useAdminRenewalsDisplayQuery({
    pagination,
    search,
    filtering,
    sorting,
  });

  const table = useDataTable({
    columns,
    data: data?.renewals || [],
    getRowId: (row) => row.id,
    rowCount: data?.count || 0,
    isLoading,
    onRowClick: (_event, row) => {
      navigate(`/subscriptions/renewals/${row.id}`);
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
  });

  if (isError) {
    return (
      <Container className="divide-y p-0">
        <div className="px-6 py-4">
          <div className="flex items-center justify-between gap-x-4">
            <div className="flex flex-col">
              <Heading level="h1">{t("renewals.list.title")}</Heading>
              <Text
                size="small"
                leading="compact"
                className="text-ui-fg-subtle"
              >
                {t("renewals.list.description")}
              </Text>
            </div>
          </div>
        </div>
        <div className="px-6 py-6">
          <Alert variant="error">
            {error instanceof Error
              ? error.message
              : t("renewals.list.loadError")}
          </Alert>
        </div>
      </Container>
    );
  }

  const hasActiveFilters =
    statusFilterValue.length > 0 ||
    approvalFilterValue.length > 0 ||
    lastAttemptFilterValue.length > 0 ||
    Boolean(scheduledFromValue) ||
    Boolean(scheduledToValue);

  return (
    <Container className="divide-y p-0">
      <div className="flex items-center justify-between px-6 py-4">
        <div className="flex flex-col">
          <Heading level="h1">{t("renewals.list.title")}</Heading>
          <Text size="small" leading="compact" className="text-ui-fg-subtle">
            {t("renewals.list.description")}
          </Text>
        </div>
      </div>
      <DataTable instance={table}>
        <div className="flex flex-col gap-3 px-6 py-4">
          <div className="flex flex-wrap items-center gap-2">
            {statusFilterValue.map((status) => (
              <FilterChip
                key={status}
                label={t("renewals.columns.status")}
                value={t(RENEWAL_CYCLE_STATUS_KEYS[status])}
                onRemove={() => {
                  setFiltering((current) => ({
                    ...current,
                    status: statusFilterValue.filter((value) => value !== status),
                  }));
                }}
              />
            ))}
            {approvalFilterValue.map((status) => (
              <FilterChip
                key={status}
                label={t("renewals.columns.approval")}
                value={t(RENEWAL_APPROVAL_FILTER_KEYS[status])}
                onRemove={() => {
                  setFiltering((current) => ({
                    ...current,
                    approval_status: approvalFilterValue.filter(
                      (value) => value !== status
                    ),
                  }));
                }}
              />
            ))}
            {lastAttemptFilterValue.map((status) => (
              <FilterChip
                key={status}
                label={t("renewals.columns.lastAttempt")}
                value={t(RENEWAL_ATTEMPT_STATUS_KEYS[status])}
                onRemove={() => {
                  setFiltering((current) => ({
                    ...current,
                    last_attempt_status: lastAttemptFilterValue.filter(
                      (value) => value !== status
                    ),
                  }));
                }}
              />
            ))}
            <DropdownMenu>
              <DropdownMenu.Trigger asChild>
                <Button size="small" variant="secondary" type="button">
                  {t("common.filters.addFilter")}
                </Button>
              </DropdownMenu.Trigger>
              <DropdownMenu.Content align="start">
                <DropdownMenu.SubMenu>
                  <DropdownMenu.SubMenuTrigger>
                    {t("renewals.filters.status")}
                  </DropdownMenu.SubMenuTrigger>
                  <DropdownMenu.SubMenuContent>
                    {statusFilterOptions.map((option) => (
                      <DropdownMenu.CheckboxItem
                        key={option.value}
                        checked={statusFilterValue.includes(option.value)}
                        onSelect={(event) => {
                          event.preventDefault();
                        }}
                        onCheckedChange={(checked) => {
                          setFiltering((current) => ({
                            ...current,
                            status: checked
                              ? [...statusFilterValue, option.value]
                              : statusFilterValue.filter(
                                  (value) => value !== option.value
                                ),
                          }));
                        }}
                      >
                        {option.label}
                      </DropdownMenu.CheckboxItem>
                    ))}
                  </DropdownMenu.SubMenuContent>
                </DropdownMenu.SubMenu>
                <DropdownMenu.SubMenu>
                  <DropdownMenu.SubMenuTrigger>
                    {t("renewals.filters.approvalStatus")}
                  </DropdownMenu.SubMenuTrigger>
                  <DropdownMenu.SubMenuContent>
                    {approvalFilterOptions.map((option) => (
                      <DropdownMenu.CheckboxItem
                        key={option.value}
                        checked={approvalFilterValue.includes(option.value)}
                        onSelect={(event) => {
                          event.preventDefault();
                        }}
                        onCheckedChange={(checked) => {
                          setFiltering((current) => ({
                            ...current,
                            approval_status: checked
                              ? [...approvalFilterValue, option.value]
                              : approvalFilterValue.filter(
                                  (value) => value !== option.value
                                ),
                          }));
                        }}
                      >
                        {option.label}
                      </DropdownMenu.CheckboxItem>
                    ))}
                  </DropdownMenu.SubMenuContent>
                </DropdownMenu.SubMenu>
                <DropdownMenu.SubMenu>
                  <DropdownMenu.SubMenuTrigger>
                    {t("renewals.filters.lastAttemptResult")}
                  </DropdownMenu.SubMenuTrigger>
                  <DropdownMenu.SubMenuContent>
                    {attemptFilterOptions.map((option) => (
                      <DropdownMenu.CheckboxItem
                        key={option.value}
                        checked={lastAttemptFilterValue.includes(option.value)}
                        onSelect={(event) => {
                          event.preventDefault();
                        }}
                        onCheckedChange={(checked) => {
                          setFiltering((current) => ({
                            ...current,
                            last_attempt_status: checked
                              ? [...lastAttemptFilterValue, option.value]
                              : lastAttemptFilterValue.filter(
                                  (value) => value !== option.value
                                ),
                          }));
                        }}
                      >
                        {option.label}
                      </DropdownMenu.CheckboxItem>
                    ))}
                  </DropdownMenu.SubMenuContent>
                </DropdownMenu.SubMenu>
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
          <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
            <div className="grid gap-3 md:grid-cols-2">
              <div className="flex flex-col gap-y-1">
                <Text size="small" leading="compact" weight="plus">
                  {t("renewals.filters.scheduledFrom")}
                </Text>
                <Input
                  type="datetime-local"
                  size="small"
                  value={scheduledFromValue}
                  onChange={(event) => {
                    const value = event.target.value;

                    setFiltering((current) =>
                      value
                        ? { ...current, scheduled_from: value }
                        : removeFilter(current, "scheduled_from")
                    );
                  }}
                />
              </div>
              <div className="flex flex-col gap-y-1">
                <Text size="small" leading="compact" weight="plus">
                  {t("renewals.filters.scheduledTo")}
                </Text>
                <Input
                  type="datetime-local"
                  size="small"
                  value={scheduledToValue}
                  onChange={(event) => {
                    const value = event.target.value;

                    setFiltering((current) =>
                      value
                        ? { ...current, scheduled_to: value }
                        : removeFilter(current, "scheduled_to")
                    );
                  }}
                />
              </div>
            </div>
            <div className="flex items-center gap-x-2 self-end">
              <div className="w-full md:w-auto">
                <DataTable.Search placeholder={t("common.actions.search")} />
              </div>
              <DataTable.SortingMenu />
            </div>
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
                                header.getContext()
                              )}
                            </button>
                          ) : (
                            flexRender(
                              header.column.columnDef.header,
                              header.getContext()
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
                      navigate(`/subscriptions/renewals/${row.id}`);
                    }}
                  >
                    {row.getVisibleCells().map((cell) => (
                      <Table.Cell
                        key={cell.id}
                        className="items-stretch truncate whitespace-nowrap"
                      >
                        {flexRender(
                          cell.column.columnDef.cell,
                          cell.getContext()
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
                ? t("renewals.list.emptyFiltered")
                : t("renewals.list.empty")}
            </Text>
            <Text size="small" leading="compact" className="text-ui-fg-subtle">
              {hasActiveFilters || search
                ? t("renewals.list.emptyFilteredHint")
                : t("renewals.list.emptyHint")}
            </Text>
          </div>
        )}
        <DataTable.Pagination />
      </DataTable>
    </Container>
  );
};

export const config = defineRouteConfig({
  label: "menuItems.renewals",
  translationNs: "reorder",
  rank: 2,
});

export const handle = {
  breadcrumb: () => translate("menuItems.renewals"),
};

export default RenewalsPage;

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

function removeFilter(
  current: DataTableFilteringState,
  key: string
): DataTableFilteringState {
  const { [key]: _removed, ...rest } = current;
  return rest;
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

function formatSubscriptionContext(renewal: RenewalCycleAdminListItem) {
  const parts = [
    renewal.subscription.product_title,
    renewal.subscription.variant_title,
    renewal.subscription.sku,
  ].filter(Boolean);

  return parts.join(" · ");
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

function addDays(date: Date, amount: number) {
  const next = new Date(date);
  next.setDate(next.getDate() + amount);
  return next;
}

function startOfDay(date: Date) {
  const next = new Date(date);
  next.setHours(0, 0, 0, 0);
  return next;
}

function toLocalDateTimeInputValue(date: Date) {
  const next = new Date(date);
  next.setSeconds(0, 0);

  const year = next.getFullYear();
  const month = String(next.getMonth() + 1).padStart(2, "0");
  const day = String(next.getDate()).padStart(2, "0");
  const hours = String(next.getHours()).padStart(2, "0");
  const minutes = String(next.getMinutes()).padStart(2, "0");

  return `${year}-${month}-${day}T${hours}:${minutes}`;
}
