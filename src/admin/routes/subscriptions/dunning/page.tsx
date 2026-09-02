import { defineRouteConfig } from "@medusajs/admin-sdk"
import { translate, type ReorderTranslate } from "../../../i18n/translate"
import { useTranslation } from "react-i18next"
import { XMarkMini } from "@medusajs/icons"
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
} from "@medusajs/ui"
import { flexRender } from "@tanstack/react-table"
import { useMemo, useState } from "react"
import { Link, useNavigate } from "react-router-dom"
import {
  DunningCaseAdminListItem,
  DunningCaseAdminStatus,
} from "../../../types/dunning"
import { useAdminDunningDisplayQuery } from "./data-loading"

const PAGE_SIZE = 20
const DEFAULT_NEXT_RETRY_FROM = toLocalDateTimeInputValue(
  startOfDay(addDays(new Date(), -30))
)
const DEFAULT_NEXT_RETRY_TO = toLocalDateTimeInputValue(
  startOfDay(addDays(new Date(), 30))
)

const columnHelper = createDataTableColumnHelper<DunningCaseAdminListItem>()

const DUNNING_CASE_STATUS_KEYS = {
  [DunningCaseAdminStatus.OPEN]: "dunning.status.open",
  [DunningCaseAdminStatus.RETRY_SCHEDULED]: "dunning.status.retryScheduled",
  [DunningCaseAdminStatus.RETRYING]: "dunning.status.retrying",
  [DunningCaseAdminStatus.AWAITING_MANUAL_RESOLUTION]:
    "dunning.status.awaitingManualResolution",
  [DunningCaseAdminStatus.RECOVERED]: "dunning.status.recovered",
  [DunningCaseAdminStatus.UNRECOVERED]: "dunning.status.unrecovered",
} as const

const DunningPage = () => {
  const { t } = useTranslation("reorder")
  const navigate = useNavigate()
  const [search, setSearch] = useState("")
  const [filtering, setFiltering] = useState<DataTableFilteringState>(() => ({
    next_retry_from: DEFAULT_NEXT_RETRY_FROM,
    next_retry_to: DEFAULT_NEXT_RETRY_TO,
  }))
  const [sorting, setSorting] = useState<DataTableSortingState | null>({
    id: "updated_at",
    desc: true,
  })
  const [pagination, setPagination] = useState<DataTablePaginationState>({
    pageIndex: 0,
    pageSize: PAGE_SIZE,
  })

  const statusFilterOptions = useMemo(() => {
    return [
      {
        label: t(DUNNING_CASE_STATUS_KEYS[DunningCaseAdminStatus.OPEN]),
        value: DunningCaseAdminStatus.OPEN,
      },
      {
        label: t(
          DUNNING_CASE_STATUS_KEYS[DunningCaseAdminStatus.RETRY_SCHEDULED]
        ),
        value: DunningCaseAdminStatus.RETRY_SCHEDULED,
      },
      {
        label: t(DUNNING_CASE_STATUS_KEYS[DunningCaseAdminStatus.RETRYING]),
        value: DunningCaseAdminStatus.RETRYING,
      },
      {
        label: t(
          DUNNING_CASE_STATUS_KEYS[
            DunningCaseAdminStatus.AWAITING_MANUAL_RESOLUTION
          ]
        ),
        value: DunningCaseAdminStatus.AWAITING_MANUAL_RESOLUTION,
      },
      {
        label: t(DUNNING_CASE_STATUS_KEYS[DunningCaseAdminStatus.RECOVERED]),
        value: DunningCaseAdminStatus.RECOVERED,
      },
      {
        label: t(DUNNING_CASE_STATUS_KEYS[DunningCaseAdminStatus.UNRECOVERED]),
        value: DunningCaseAdminStatus.UNRECOVERED,
      },
    ] as const
  }, [t])

  const columns = useMemo(() => {
    return [
      columnHelper.accessor("subscription.reference", {
        id: "subscription_reference",
        header: t("dunning.columns.subscription"),
        enableSorting: true,
        sortLabel: t("dunning.columns.subscription"),
        cell: ({ row }) => (
          <div className="flex flex-col gap-y-0.5">
            <Text size="small" leading="compact" weight="plus">
              {row.original.subscription.reference}
            </Text>
            <Text size="small" leading="compact" className="text-ui-fg-subtle">
              {row.original.subscription.customer_name}
            </Text>
            <Text size="small" leading="compact" className="text-ui-fg-subtle">
              {[
                row.original.subscription.product_title,
                row.original.subscription.variant_title,
              ]
                .filter(Boolean)
                .join(" · ")}
            </Text>
          </div>
        ),
      }),
      columnHelper.accessor("status", {
        header: t("dunning.columns.status"),
        enableSorting: true,
        sortLabel: t("dunning.columns.status"),
        cell: ({ getValue }) => (
          <StatusBadge color={getStatusColor(getValue())} className="text-nowrap">
            {t(DUNNING_CASE_STATUS_KEYS[getValue()])}
          </StatusBadge>
        ),
      }),
      columnHelper.accessor("next_retry_at", {
        header: t("dunning.columns.nextRetry"),
        enableSorting: true,
        sortLabel: t("dunning.columns.nextRetry"),
        cell: ({ getValue, row }) => (
          <div className="flex flex-col">
            <Text size="small" leading="compact" weight="plus">
              {formatDateTime(getValue(), t("common.empty.noValue"))}
            </Text>
            <Text size="small" leading="compact" className="text-ui-fg-subtle">
              {formatRetryWindow(row.original, t)}
            </Text>
          </div>
        ),
      }),
      columnHelper.accessor("attempt_count", {
        header: t("dunning.columns.attempts"),
        enableSorting: true,
        sortLabel: t("dunning.columns.attempts"),
        cell: ({ row }) => (
          <div className="flex flex-col">
            <Text size="small" leading="compact" weight="plus">
              {row.original.attempt_count} / {row.original.max_attempts}
            </Text>
            <Text size="small" leading="compact" className="text-ui-fg-subtle">
              {row.original.last_attempt_at
                ? t("dunning.columns.lastAttemptAt", {
                    value: formatDateTime(
                      row.original.last_attempt_at,
                      t("common.empty.noValue")
                    ),
                  })
                : t("dunning.columns.noRetryAttemptsYet")}
            </Text>
          </div>
        ),
      }),
      columnHelper.accessor("last_payment_error_code", {
        header: t("dunning.columns.lastError"),
        cell: ({ row }) => (
          <div className="flex flex-col">
            <Text size="small" leading="compact" weight="plus">
              {row.original.last_payment_error_code ||
                t("dunning.columns.noPaymentErrorCode")}
            </Text>
            <Text size="small" leading="compact" className="text-ui-fg-subtle">
              {row.original.subscription.payment_provider_id ||
                t("dunning.columns.unknownProvider")}
            </Text>
          </div>
        ),
      }),
    ]
  }, [t])

  const statusFilterValue = useMemo(() => {
    return Array.isArray(filtering.status)
      ? (filtering.status as DunningCaseAdminStatus[])
      : []
  }, [filtering])
  const paymentProviderValue = useMemo(() => {
    return typeof filtering.payment_provider_id === "string"
      ? filtering.payment_provider_id
      : ""
  }, [filtering])
  const errorCodeValue = useMemo(() => {
    return typeof filtering.last_payment_error_code === "string"
      ? filtering.last_payment_error_code
      : ""
  }, [filtering])
  const attemptCountMinValue = useMemo(() => {
    return typeof filtering.attempt_count_min === "string"
      ? filtering.attempt_count_min
      : typeof filtering.attempt_count_min === "number"
        ? filtering.attempt_count_min.toString()
        : ""
  }, [filtering])
  const attemptCountMaxValue = useMemo(() => {
    return typeof filtering.attempt_count_max === "string"
      ? filtering.attempt_count_max
      : typeof filtering.attempt_count_max === "number"
        ? filtering.attempt_count_max.toString()
        : ""
  }, [filtering])
  const nextRetryFromValue = useMemo(() => {
    return typeof filtering.next_retry_from === "string"
      ? filtering.next_retry_from
      : ""
  }, [filtering])
  const nextRetryToValue = useMemo(() => {
    return typeof filtering.next_retry_to === "string"
      ? filtering.next_retry_to
      : ""
  }, [filtering])

  const { data, isLoading, isError, error } = useAdminDunningDisplayQuery({
    pagination,
    search,
    filtering,
    sorting,
  })

  const table = useDataTable({
    columns,
    data: data?.dunning_cases || [],
    getRowId: (row) => row.id,
    rowCount: data?.count || 0,
    isLoading,
    onRowClick: (_event, row) => {
      navigate(`/subscriptions/dunning/${row.id}`)
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
  })

  if (isError) {
    return (
      <Container className="divide-y p-0">
        <div className="px-6 py-4">
          <div className="flex items-center justify-between gap-x-4">
            <div className="flex flex-col">
              <Heading level="h1">{t("dunning.list.title")}</Heading>
              <Text
                size="small"
                leading="compact"
                className="text-ui-fg-subtle"
              >
                {t("dunning.list.description")}
              </Text>
            </div>
          </div>
        </div>
        <div className="px-6 py-6">
          <Alert variant="error">
            {error instanceof Error
              ? error.message
              : t("dunning.list.loadError")}
          </Alert>
        </div>
      </Container>
    )
  }

  const hasActiveFilters =
    statusFilterValue.length > 0 ||
    Boolean(paymentProviderValue) ||
    Boolean(errorCodeValue) ||
    Boolean(attemptCountMinValue) ||
    Boolean(attemptCountMaxValue) ||
    Boolean(nextRetryFromValue) ||
    Boolean(nextRetryToValue)

  return (
    <Container className="divide-y p-0">
      <div className="flex items-center justify-between px-6 py-4">
        <div className="flex flex-col">
          <Heading level="h1">{t("dunning.list.title")}</Heading>
          <Text size="small" leading="compact" className="text-ui-fg-subtle">
            {t("dunning.list.description")}
          </Text>
        </div>
      </div>
      <DataTable instance={table}>
        <div className="flex flex-col gap-3 px-6 py-4">
          <div className="flex flex-wrap items-center gap-2">
            {statusFilterValue.map((status) => (
              <FilterChip
                key={status}
                label={t("dunning.columns.status")}
                value={t(DUNNING_CASE_STATUS_KEYS[status])}
                onRemove={() => {
                  setFiltering((current) => ({
                    ...current,
                    status: statusFilterValue.filter((value) => value !== status),
                  }))
                }}
              />
            ))}
            {paymentProviderValue ? (
              <FilterChip
                label={t("dunning.filters.provider")}
                value={paymentProviderValue}
                onRemove={() => {
                  setFiltering((current) =>
                    removeFilter(current, "payment_provider_id")
                  )
                }}
              />
            ) : null}
            {errorCodeValue ? (
              <FilterChip
                label={t("dunning.filters.errorCode")}
                value={errorCodeValue}
                onRemove={() => {
                  setFiltering((current) =>
                    removeFilter(current, "last_payment_error_code")
                  )
                }}
              />
            ) : null}
            {attemptCountMinValue || attemptCountMaxValue ? (
              <FilterChip
                label={t("dunning.filters.attemptCount")}
                value={formatAttemptRange(
                  t,
                  attemptCountMinValue,
                  attemptCountMaxValue
                )}
                onRemove={() => {
                  setFiltering((current) => ({
                    ...removeFilter(current, "attempt_count_min"),
                    attempt_count_max: undefined,
                  }))
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
                    {t("dunning.filters.status")}
                  </DropdownMenu.SubMenuTrigger>
                  <DropdownMenu.SubMenuContent>
                    {statusFilterOptions.map((option) => (
                      <DropdownMenu.CheckboxItem
                        key={option.value}
                        checked={statusFilterValue.includes(option.value)}
                        onSelect={(event) => {
                          event.preventDefault()
                        }}
                        onCheckedChange={(checked) => {
                          setFiltering((current) => ({
                            ...current,
                            status: checked
                              ? [...statusFilterValue, option.value]
                              : statusFilterValue.filter(
                                  (value) => value !== option.value
                                ),
                          }))
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
                onClick={() =>
                  setFiltering({
                    next_retry_from: DEFAULT_NEXT_RETRY_FROM,
                    next_retry_to: DEFAULT_NEXT_RETRY_TO,
                  })
                }
              >
                {t("common.filters.clearAll")}
              </button>
            ) : null}
          </div>
          <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              <div className="flex flex-col gap-y-1">
                <Text size="small" leading="compact" weight="plus">
                  {t("dunning.filters.providerId")}
                </Text>
                <Input
                  type="text"
                  size="small"
                  placeholder={t("dunning.filters.providerId")}
                  value={paymentProviderValue}
                  onChange={(event) => {
                    const value = event.target.value

                    setFiltering((current) =>
                      value
                        ? { ...current, payment_provider_id: value }
                        : removeFilter(current, "payment_provider_id")
                    )
                  }}
                />
              </div>
              <div className="flex flex-col gap-y-1">
                <Text size="small" leading="compact" weight="plus">
                  {t("dunning.filters.errorCode")}
                </Text>
                <Input
                  type="text"
                  size="small"
                  placeholder={t("dunning.filters.errorCode")}
                  value={errorCodeValue}
                  onChange={(event) => {
                    const value = event.target.value

                    setFiltering((current) =>
                      value
                        ? { ...current, last_payment_error_code: value }
                        : removeFilter(current, "last_payment_error_code")
                    )
                  }}
                />
              </div>
              <div className="flex flex-col gap-y-1">
                <Text size="small" leading="compact" weight="plus">
                  {t("dunning.filters.attemptRange")}
                </Text>
                <div className="grid grid-cols-2 gap-3">
                  <Input
                    type="number"
                    min={0}
                    size="small"
                    placeholder={t("dunning.filters.min")}
                    value={attemptCountMinValue}
                    onChange={(event) => {
                      const value = event.target.value

                      setFiltering((current) =>
                        value
                          ? { ...current, attempt_count_min: value }
                          : removeFilter(current, "attempt_count_min")
                      )
                    }}
                  />
                  <Input
                    type="number"
                    min={0}
                    size="small"
                    placeholder={t("dunning.filters.max")}
                    value={attemptCountMaxValue}
                    onChange={(event) => {
                      const value = event.target.value

                      setFiltering((current) =>
                        value
                          ? { ...current, attempt_count_max: value }
                          : removeFilter(current, "attempt_count_max")
                      )
                    }}
                  />
                </div>
              </div>
              <div className="flex flex-col gap-y-1">
                <Text size="small" leading="compact" weight="plus">
                  {t("dunning.filters.nextRetryFrom")}
                </Text>
                <Input
                  type="datetime-local"
                  size="small"
                  value={nextRetryFromValue}
                  onChange={(event) => {
                    const value = event.target.value

                    setFiltering((current) =>
                      value
                        ? { ...current, next_retry_from: value }
                        : removeFilter(current, "next_retry_from")
                    )
                  }}
                />
              </div>
              <div className="flex flex-col gap-y-1">
                <Text size="small" leading="compact" weight="plus">
                  {t("dunning.filters.nextRetryTo")}
                </Text>
                <Input
                  type="datetime-local"
                  size="small"
                  value={nextRetryToValue}
                  onChange={(event) => {
                    const value = event.target.value

                    setFiltering((current) =>
                      value
                        ? { ...current, next_retry_to: value }
                        : removeFilter(current, "next_retry_to")
                    )
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
                      const canSort = header.column.getCanSort()
                      const sortHandler = header.column.getToggleSortingHandler()

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
                      )
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
                      event.preventDefault()
                      navigate(`/subscriptions/dunning/${row.id}`)
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
                ? t("dunning.list.emptyFiltered")
                : t("dunning.list.empty")}
            </Text>
            <Text size="small" leading="compact" className="text-ui-fg-subtle">
              {hasActiveFilters || search
                ? t("dunning.list.emptyFilteredHint")
                : t("dunning.list.emptyHint")}
            </Text>
          </div>
        )}
        <DataTable.Pagination />
      </DataTable>
    </Container>
  )
}

export const config = defineRouteConfig({
  label: "menuItems.dunning",
  translationNs: "reorder",
  rank: 3,
})

export const handle = {
  breadcrumb: () => translate("menuItems.dunning"),
}

export default DunningPage

const FilterChip = ({
  label,
  value,
  onRemove,
}: {
  label: string
  value: string
  onRemove: () => void
}) => {
  const { t } = useTranslation("reorder")

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
  )
}

function removeFilter(
  current: DataTableFilteringState,
  key: string
): DataTableFilteringState {
  const next = { ...current }
  delete next[key]
  return next
}

function getStatusColor(status: DunningCaseAdminStatus) {
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

function formatRetryWindow(item: DunningCaseAdminListItem, t: ReorderTranslate) {
  if (item.status === DunningCaseAdminStatus.RECOVERED) {
    return t("dunning.retryWindow.recovered")
  }

  if (item.status === DunningCaseAdminStatus.UNRECOVERED) {
    return t("dunning.retryWindow.closedUnrecovered")
  }

  if (item.status === DunningCaseAdminStatus.AWAITING_MANUAL_RESOLUTION) {
    return t("dunning.retryWindow.waitingManualResolution")
  }

  if (!item.next_retry_at) {
    return t("dunning.retryWindow.noRetryScheduled")
  }

  return t("dunning.retryWindow.queuedForRetry")
}

function formatDateTime(value?: string | null, emptyValue: string) {
  const date = value ? new Date(value) : null

  if (!date || Number.isNaN(date.getTime())) {
    return emptyValue
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date)
}

function formatAttemptRange(t: ReorderTranslate, min?: string, max?: string) {
  if (min && max) {
    return `${min}-${max}`
  }

  if (min) {
    return `${min}+`
  }

  if (max) {
    return t("dunning.filters.upTo", { max })
  }

  return t("common.empty.noValue")
}

function formatDateRange(
  from: string | undefined,
  to: string | undefined,
  t: ReorderTranslate
) {
  const formattedFrom = formatDateTime(from, t("common.empty.noValue"))
  const formattedTo = formatDateTime(to, t("common.empty.noValue"))

  if (from && to) {
    return t("dunning.dateRange.fromTo", {
      from: formattedFrom,
      to: formattedTo,
    })
  }

  if (from) {
    return t("dunning.dateRange.from", { value: formattedFrom })
  }

  if (to) {
    return t("dunning.dateRange.until", { value: formattedTo })
  }

  return t("common.empty.noValue")
}

function addDays(date: Date, amount: number) {
  const next = new Date(date)
  next.setDate(next.getDate() + amount)
  return next
}

function startOfDay(date: Date) {
  const next = new Date(date)
  next.setHours(0, 0, 0, 0)
  return next
}

function toLocalDateTimeInputValue(date: Date) {
  const next = new Date(date)
  next.setSeconds(0, 0)

  const year = next.getFullYear()
  const month = String(next.getMonth() + 1).padStart(2, "0")
  const day = String(next.getDate()).padStart(2, "0")
  const hours = String(next.getHours()).padStart(2, "0")
  const minutes = String(next.getMinutes()).padStart(2, "0")

  return `${year}-${month}-${day}T${hours}:${minutes}`
}
