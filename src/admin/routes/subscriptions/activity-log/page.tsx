import { defineRouteConfig } from "@medusajs/admin-sdk"
import { translate, type ReorderTranslate } from "../../../i18n/translate"
import { useTranslation } from "react-i18next"
import { XMarkMini } from "@medusajs/icons"
import {
  Alert,
  Button,
  Container,
  Drawer,
  DropdownMenu,
  Heading,
  createDataTableColumnHelper,
  DataTable,
  DataTableFilteringState,
  DataTablePaginationState,
  DataTableSortingState,
  Input,
  StatusBadge,
  Table,
  Text,
  useDataTable,
} from "@medusajs/ui"
import { flexRender } from "@tanstack/react-table"
import { useMemo, useState, type ReactNode } from "react"
import {
  ActivityLogAdminActorType,
  ActivityLogAdminDetail,
  ActivityLogAdminListItem,
} from "../../../types/activity-log"
import {
  useAdminActivityLogDetailQuery,
  useAdminActivityLogDisplayQuery,
} from "./data-loading"

const PAGE_SIZE = 20
const DEFAULT_DATE_FROM = toLocalDateTimeInputValue(addDays(new Date(), -30))
const DEFAULT_DATE_TO = toLocalDateTimeInputValue(new Date())

const columnHelper = createDataTableColumnHelper<ActivityLogAdminListItem>()

const ACTIVITY_ACTOR_KEYS: Record<ActivityLogAdminActorType, string> = {
  [ActivityLogAdminActorType.USER]: "activityLog.actor.admin",
  [ActivityLogAdminActorType.CUSTOMER]: "activityLog.actor.customer",
  [ActivityLogAdminActorType.SYSTEM]: "activityLog.actor.system",
  [ActivityLogAdminActorType.SCHEDULER]: "activityLog.actor.scheduler",
}

const ACTIVITY_DOMAIN_KEYS: Array<{
  prefix: string
  key: string
}> = [
  { prefix: "subscription.", key: "activityLog.domains.subscriptions" },
  { prefix: "renewal.", key: "activityLog.domains.renewals" },
  { prefix: "dunning.", key: "activityLog.domains.dunning" },
  { prefix: "cancellation.", key: "activityLog.domains.cancellation" },
]

const ACTIVITY_SUMMARY_FIELD_KEYS: Record<string, string> = {
  subscription_created: "activityLog.summaryFields.subscriptionCreated",
  pending_update_data: "activityLog.summaryFields.pendingUpdateData",
  status: "activityLog.summaryFields.status",
  recipient: "activityLog.summaryFields.recipient",
  address: "activityLog.summaryFields.address",
  address_lines_changed: "activityLog.summaryFields.addressLinesChanged",
  postal_code_changed: "activityLog.summaryFields.postalCodeChanged",
  phone_changed: "activityLog.summaryFields.phoneChanged",
  country_code: "activityLog.summaryFields.countryCode",
  province: "activityLog.summaryFields.province",
  city: "activityLog.summaryFields.city",
}

const ActivityLogPage = () => {
  const { t } = useTranslation("reorder")
  const [search, setSearch] = useState("")
  const [filtering, setFiltering] = useState<DataTableFilteringState>(() => ({
    date_from: DEFAULT_DATE_FROM,
    date_to: DEFAULT_DATE_TO,
  }))
  const [sorting, setSorting] = useState<DataTableSortingState | null>({
    id: "created_at",
    desc: true,
  })
  const [pagination, setPagination] = useState<DataTablePaginationState>({
    pageIndex: 0,
    pageSize: PAGE_SIZE,
  })
  const [selectedLogId, setSelectedLogId] = useState<string | null>(null)
  const [detailDrawerOpen, setDetailDrawerOpen] = useState(false)

  const actorFilterOptions = useMemo(
    () =>
      [
        {
          label: t("activityLog.actor.admin"),
          value: ActivityLogAdminActorType.USER,
        },
        {
          label: t("activityLog.actor.customer"),
          value: ActivityLogAdminActorType.CUSTOMER,
        },
        {
          label: t("activityLog.actor.system"),
          value: ActivityLogAdminActorType.SYSTEM,
        },
        {
          label: t("activityLog.actor.scheduler"),
          value: ActivityLogAdminActorType.SCHEDULER,
        },
      ] as const,
    [t]
  )

  const domainPresetOptions = useMemo(
    () =>
      [
        {
          label: t("activityLog.domains.subscriptions"),
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
          label: t("activityLog.domains.renewals"),
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
          label: t("activityLog.domains.dunning"),
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
          label: t("activityLog.domains.cancellation"),
          value: "cancellation",
          eventTypes: [
            "cancellation.case_started",
            "cancellation.offer_applied",
            "cancellation.reason_updated",
            "cancellation.finalized",
          ],
        },
      ] as const,
    [t]
  )

  const allEventTypes = useMemo(
    () => domainPresetOptions.flatMap((option) => option.eventTypes),
    [domainPresetOptions]
  )

  const baseColumns = useMemo(
    () => [
      columnHelper.accessor("subscription.reference", {
        id: "subscription_reference",
        header: t("common.fields.subscription"),
        enableSorting: true,
        sortLabel: t("common.fields.subscription"),
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
      columnHelper.accessor("created_at", {
        header: t("activityLog.columns.created"),
        enableSorting: true,
        sortLabel: t("activityLog.columns.created"),
        cell: ({ getValue }) => (
          <Text size="small" leading="compact">
            {formatDateTime(getValue(), t("common.empty.noValue"))}
          </Text>
        ),
      }),
      columnHelper.accessor("actor_type", {
        header: t("activityLog.columns.actor"),
        enableSorting: true,
        sortLabel: t("activityLog.columns.actor"),
        cell: ({ row }) => (
          <Text size="small" leading="compact">
            {getActorDisplay(row.original, t)}
          </Text>
        ),
      }),
      columnHelper.accessor("event_type", {
        header: t("activityLog.columns.event"),
        enableSorting: true,
        sortLabel: t("activityLog.columns.event"),
        cell: ({ row }) => (
          <StatusBadge
            color={getEventColor(row.original.event_type)}
            className="w-fit text-nowrap"
          >
            {formatEventType(row.original.event_type)}
          </StatusBadge>
        ),
      }),
      columnHelper.accessor("reason", {
        header: t("activityLog.columns.reason"),
        enableSorting: true,
        sortLabel: t("activityLog.columns.reason"),
        cell: ({ row }) => (
          <div className="flex flex-col gap-y-0.5">
            <Text size="small" leading="compact" weight="plus">
              {formatSummary(row.original, t)}
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
    [t]
  )

  const eventTypeFilters = useMemo(
    () =>
      Array.isArray(filtering.event_type) ? (filtering.event_type as string[]) : [],
    [filtering]
  )
  const actorTypeFilters = useMemo(
    () =>
      Array.isArray(filtering.actor_type)
        ? (filtering.actor_type as ActivityLogAdminActorType[])
        : [],
    [filtering]
  )
  const dateFromValue = useMemo(
    () => (typeof filtering.date_from === "string" ? filtering.date_from : ""),
    [filtering]
  )
  const dateToValue = useMemo(
    () => (typeof filtering.date_to === "string" ? filtering.date_to : ""),
    [filtering]
  )

  const activePreset = useMemo(() => {
    if (!eventTypeFilters.length) {
      return null
    }

    return (
      domainPresetOptions.find(
        (preset) =>
          preset.eventTypes.length === eventTypeFilters.length &&
          preset.eventTypes.every((eventType) => eventTypeFilters.includes(eventType))
      ) ?? null
    )
  }, [eventTypeFilters])

  const { data, isLoading, isError, error } = useAdminActivityLogDisplayQuery({
    pagination,
    search,
    filtering,
    sorting,
  })
  const { data: detailData, isLoading: isDetailLoading } =
    useAdminActivityLogDetailQuery(
      selectedLogId ?? undefined,
      detailDrawerOpen && Boolean(selectedLogId)
    )

  const table = useDataTable({
    columns: baseColumns,
    data: data?.subscription_logs || [],
    getRowId: (row) => row.id,
    rowCount: data?.count || 0,
    isLoading,
    onRowClick: (_event, row) => {
      setSelectedLogId(row.id)
      setDetailDrawerOpen(true)
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
              <Heading level="h1">{t("activityLog.list.title")}</Heading>
              <Text size="small" leading="compact" className="text-ui-fg-subtle">
                {t("activityLog.list.description")}
              </Text>
            </div>
          </div>
        </div>
        <div className="px-6 py-6">
          <Alert variant="error">
            {error instanceof Error
              ? error.message
              : t("activityLog.list.loadError")}
          </Alert>
        </div>
      </Container>
    )
  }

  const hasActiveFilters =
    eventTypeFilters.length > 0 ||
    actorTypeFilters.length > 0 ||
    Boolean(dateFromValue) ||
    Boolean(dateToValue)

  return (
    <>
      <Container className="divide-y p-0">
        <div className="flex items-center justify-between px-6 py-4">
          <div className="flex flex-col">
            <Heading level="h1">{t("activityLog.list.title")}</Heading>
            <Text size="small" leading="compact" className="text-ui-fg-subtle">
              {t("activityLog.list.description")}
            </Text>
          </div>
        </div>
        <DataTable instance={table}>
          <div className="flex flex-col gap-3 px-6 py-4">
            <div className="flex flex-wrap items-center gap-2">
              {activePreset ? (
                <FilterChip
                  label={t("activityLog.filters.preset")}
                  value={activePreset.label}
                  onRemove={() => {
                    setFiltering((current) => ({
                      ...current,
                      event_type: undefined,
                    }))
                  }}
                />
              ) : null}
              {!activePreset
                ? eventTypeFilters.map((eventType) => (
                    <FilterChip
                      key={eventType}
                      label={t("activityLog.columns.event")}
                      value={formatEventType(eventType)}
                      onRemove={() => {
                        setFiltering((current) => ({
                          ...current,
                          event_type: eventTypeFilters.filter(
                            (value) => value !== eventType
                          ),
                        }))
                      }}
                    />
                  ))
                : null}
              {actorTypeFilters.map((actorType) => (
                <FilterChip
                  key={actorType}
                  label={t("activityLog.columns.actor")}
                  value={formatActorType(actorType, t)}
                  onRemove={() => {
                    setFiltering((current) => ({
                      ...current,
                      actor_type: actorTypeFilters.filter(
                        (value) => value !== actorType
                      ),
                    }))
                  }}
                />
              ))}
              <DropdownMenu>
                <DropdownMenu.Trigger asChild>
                <Button size="small" variant="secondary" type="button">
                  {t("activityLog.filters.addFilter")}
                </Button>
                </DropdownMenu.Trigger>
                <DropdownMenu.Content align="start">
                  <DropdownMenu.SubMenu>
                    <DropdownMenu.SubMenuTrigger>
                      {t("activityLog.filters.quickPresets")}
                    </DropdownMenu.SubMenuTrigger>
                    <DropdownMenu.SubMenuContent>
                      {domainPresetOptions.map((option) => (
                        <DropdownMenu.CheckboxItem
                          key={option.value}
                          checked={activePreset?.value === option.value}
                          onSelect={(event) => {
                            event.preventDefault()
                          }}
                          onCheckedChange={(checked) => {
                            setFiltering((current) => ({
                              ...current,
                              event_type: checked ? [...option.eventTypes] : undefined,
                            }))
                          }}
                        >
                          {option.label}
                        </DropdownMenu.CheckboxItem>
                      ))}
                    </DropdownMenu.SubMenuContent>
                  </DropdownMenu.SubMenu>
                  <DropdownMenu.SubMenu>
                    <DropdownMenu.SubMenuTrigger>
                      {t("activityLog.filters.eventType")}
                    </DropdownMenu.SubMenuTrigger>
                    <DropdownMenu.SubMenuContent className="max-h-80 overflow-y-auto">
                      {allEventTypes.map((eventType) => (
                        <DropdownMenu.CheckboxItem
                          key={eventType}
                          checked={eventTypeFilters.includes(eventType)}
                          onSelect={(event) => {
                            event.preventDefault()
                          }}
                          onCheckedChange={(checked) => {
                            setFiltering((current) => ({
                              ...current,
                              event_type: checked
                                ? [...eventTypeFilters, eventType]
                                : eventTypeFilters.filter((value) => value !== eventType),
                            }))
                          }}
                        >
                          {formatEventType(eventType)}
                        </DropdownMenu.CheckboxItem>
                      ))}
                    </DropdownMenu.SubMenuContent>
                  </DropdownMenu.SubMenu>
                  <DropdownMenu.SubMenu>
                    <DropdownMenu.SubMenuTrigger>
                      {t("activityLog.columns.actor")}
                    </DropdownMenu.SubMenuTrigger>
                    <DropdownMenu.SubMenuContent>
                      {actorFilterOptions.map((option) => (
                        <DropdownMenu.CheckboxItem
                          key={option.value}
                          checked={actorTypeFilters.includes(option.value)}
                          onSelect={(event) => {
                            event.preventDefault()
                          }}
                          onCheckedChange={(checked) => {
                            setFiltering((current) => ({
                              ...current,
                              actor_type: checked
                                ? [...actorTypeFilters, option.value]
                                : actorTypeFilters.filter(
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
                  onClick={() => {
                    setFiltering({
                      date_from: DEFAULT_DATE_FROM,
                      date_to: DEFAULT_DATE_TO,
                    })
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
                    {t("activityLog.filters.createdFrom")}
                  </Text>
                  <Input
                    type="datetime-local"
                    size="small"
                    value={dateFromValue}
                    onChange={(event) => {
                      const value = event.target.value

                      setFiltering((current) =>
                        value
                          ? { ...current, date_from: value }
                          : removeFilter(current, "date_from")
                      )
                    }}
                  />
                </div>
                <div className="flex flex-col gap-y-1">
                  <Text size="small" leading="compact" weight="plus">
                    {t("activityLog.filters.createdTo")}
                  </Text>
                  <Input
                    type="datetime-local"
                    size="small"
                    value={dateToValue}
                    onChange={(event) => {
                      const value = event.target.value

                      setFiltering((current) =>
                        value
                          ? { ...current, date_to: value }
                          : removeFilter(current, "date_to")
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
                        setSelectedLogId(row.id)
                        setDetailDrawerOpen(true)
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
                  ? t("activityLog.list.emptyFiltered")
                  : t("activityLog.list.empty")}
              </Text>
              <Text size="small" leading="compact" className="text-ui-fg-subtle">
                {hasActiveFilters || search
                  ? t("activityLog.list.emptyFilteredHint")
                  : t("activityLog.list.emptyHint")}
              </Text>
            </div>
          )}
          <DataTable.Pagination />
        </DataTable>
      </Container>

      <Drawer
        open={detailDrawerOpen}
        onOpenChange={(open) => {
          setDetailDrawerOpen(open)

          if (!open) {
            setSelectedLogId(null)
          }
        }}
      >
        <Drawer.Content>
          <Drawer.Header>
            <Drawer.Title>{t("activityLog.eventDetail.title")}</Drawer.Title>
          </Drawer.Header>
          <Drawer.Body className="flex flex-1 flex-col gap-y-6 overflow-y-auto p-4">
            {isDetailLoading ? (
              <Text size="small" leading="compact" className="text-ui-fg-subtle">
                {t("activityLog.eventDetail.loading")}
              </Text>
            ) : detailData?.subscription_log ? (
              <ActivityLogDetailContent
                log={detailData.subscription_log}
              />
            ) : (
              <Alert variant="error">
                <Text size="small" leading="compact">
                  {t("activityLog.eventDetail.loadError")}
                </Text>
              </Alert>
            )}
          </Drawer.Body>
          <Drawer.Footer>
            <div className="flex w-full items-center justify-end">
              <Drawer.Close asChild>
                <Button size="small" variant="secondary" type="button">
                  {t("activityLog.eventDetail.close")}
                </Button>
              </Drawer.Close>
            </div>
          </Drawer.Footer>
        </Drawer.Content>
      </Drawer>
    </>
  )
}

const ActivityLogDetailContent = ({ log }: { log: ActivityLogAdminDetail }) => {
  const { t } = useTranslation("reorder")

  return (
    <div className="flex flex-col gap-y-6">
      <DetailBlock
        title={t("activityLog.eventDetail.overview")}
        rows={[
          {
            label: t("activityLog.eventDetail.event"),
            value: (
              <StatusBadge color={getEventColor(log.event_type)}>
                {formatEventType(log.event_type)}
              </StatusBadge>
            ),
          },
          {
            label: t("activityLog.eventDetail.domain"),
            value: formatDomainLabel(log.event_type, t),
          },
          {
            label: t("activityLog.eventDetail.actor"),
            value: getActorDisplay(log, t),
          },
          {
            label: t("activityLog.eventDetail.created"),
            value: formatDateTime(log.created_at, t("common.empty.noValue")),
          },
          {
            label: t("activityLog.eventDetail.reason"),
            value: log.reason || t("common.empty.noValue"),
          },
          {
            label: t("activityLog.eventDetail.summary"),
            value: formatSummary(log, t),
          },
        ]}
      />

      <DetailBlock
        title={t("activityLog.eventDetail.subscriptionSnapshot")}
        rows={[
          {
            label: t("activityLog.eventDetail.reference"),
            value: log.subscription.reference,
          },
          {
            label: t("activityLog.eventDetail.customer"),
            value: log.subscription.customer_name,
          },
          {
            label: t("activityLog.eventDetail.product"),
            value: log.subscription.product_title,
          },
          {
            label: t("activityLog.eventDetail.variant"),
            value: log.subscription.variant_title,
          },
        ]}
      />

      <DetailBlock
        title={t("activityLog.eventDetail.changedFields")}
        rows={
          log.changed_fields.length
            ? log.changed_fields.map((field) => ({
                label: formatSummaryField(field.field, t),
                value: `${formatUnknown(field.before, t("common.empty.noValue"))} → ${formatUnknown(
                  field.after,
                  t("common.empty.noValue")
                )}`,
              }))
            : [
                {
                  label: t("activityLog.eventDetail.changedFieldsLabel"),
                  value: t("activityLog.eventDetail.noChangedFields"),
                },
              ]
        }
      />

      <JsonBlock
        title={t("activityLog.eventDetail.previousState")}
        value={log.previous_state}
        noDataLabel={t("activityLog.eventDetail.noData")}
      />
      <JsonBlock
        title={t("activityLog.eventDetail.newState")}
        value={log.new_state}
        noDataLabel={t("activityLog.eventDetail.noData")}
      />
      <JsonBlock
        title={t("activityLog.eventDetail.metadata")}
        value={log.metadata}
        noDataLabel={t("activityLog.eventDetail.noData")}
      />
    </div>
  )
}

const DetailBlock = ({
  title,
  rows,
}: {
  title: string
  rows: Array<{ label: string; value: ReactNode }>
}) => {
  return (
    <div className="rounded-lg border border-ui-border-base">
      <div className="border-b border-ui-border-base px-4 py-3">
        <Text size="small" leading="compact" weight="plus">
          {title}
        </Text>
      </div>
      <div className="flex flex-col divide-y divide-ui-border-base">
        {rows.map((row) => (
          <div
            key={`${title}-${row.label}`}
            className="flex items-start justify-between gap-4 px-4 py-3"
          >
            <Text size="small" leading="compact" className="text-ui-fg-subtle">
              {row.label}
            </Text>
            <div className="max-w-[70%] text-right">
              {typeof row.value === "string" ? (
                <Text size="small" leading="compact" weight="plus">
                  {row.value}
                </Text>
              ) : (
                row.value
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

const JsonBlock = ({
  title,
  value,
  noDataLabel,
}: {
  title: string
  value: Record<string, unknown> | null
  noDataLabel: string
}) => {
  return (
    <div className="rounded-lg border border-ui-border-base">
      <div className="border-b border-ui-border-base px-4 py-3">
        <Text size="small" leading="compact" weight="plus">
          {title}
        </Text>
      </div>
      <div className="px-4 py-3">
        <pre className="overflow-x-auto whitespace-pre-wrap break-words text-[12px] leading-5 text-ui-fg-subtle">
          {value ? JSON.stringify(value, null, 2) : noDataLabel}
        </pre>
      </div>
    </div>
  )
}

export const config = defineRouteConfig({
  label: "menuItems.activityLog",
  translationNs: "reorder",
})

export const handle = {
  breadcrumb: () => translate("menuItems.activityLog"),
}

export default ActivityLogPage

type FilterChipProps = {
  label: string
  value: string
  onRemove: () => void
}

const FilterChip = ({ label, value, onRemove }: FilterChipProps) => {
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

function formatEventType(value: string) {
  return value
    .split(".")
    .at(-1)
    ?.split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ") ?? value
}

function formatDomainLabel(value: string, t: ReorderTranslate) {
  const match = ACTIVITY_DOMAIN_KEYS.find((domain) =>
    value.startsWith(domain.prefix)
  )

  if (!match) {
    return t("activityLog.domains.unknown")
  }

  if (match.key === "activityLog.domains.cancellation") {
    return t("activityLog.domains.cancellationFull")
  }

  return t(match.key)
}

function getActorDisplay(
  log: Pick<ActivityLogAdminListItem, "actor" | "actor_id" | "actor_type">,
  t: ReorderTranslate
) {
  return log.actor.display || log.actor_id || formatActorType(log.actor_type, t)
}

function formatSummary(
  log: Pick<ActivityLogAdminListItem, "change_summary" | "reason">,
  t: ReorderTranslate
) {
  if (log.reason) {
    return log.reason
  }

  if (!log.change_summary) {
    return t("activityLog.eventDetail.noSummary")
  }

  return log.change_summary
    .split(",")
    .map((part) => formatSummaryField(part.trim(), t))
    .filter(Boolean)
    .join(", ")
}

function formatSummaryField(value: string, t: ReorderTranslate) {
  const key = ACTIVITY_SUMMARY_FIELD_KEYS[value]

  if (key) {
    return t(key)
  }

  return value
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ")
}

function getEventColor(value: string) {
  switch (value) {
    case "renewal.failed":
    case "dunning.unrecovered":
    case "subscription.canceled":
    case "cancellation.finalized":
      return "red"
    case "renewal.succeeded":
    case "dunning.recovered":
    case "subscription.created":
      return "green"
    case "renewal.force_requested":
    case "dunning.retry_executed":
    case "dunning.retry_schedule_updated":
    case "cancellation.offer_applied":
      return "orange"
    case "subscription.paused":
    case "subscription.plan_change_scheduled":
      return "blue"
    default:
      return "grey"
  }
}

function formatActorType(value: ActivityLogAdminActorType, t: ReorderTranslate) {
  return t(ACTIVITY_ACTOR_KEYS[value])
}

function getActorColor(value: ActivityLogAdminActorType) {
  switch (value) {
    case ActivityLogAdminActorType.USER:
      return "blue"
    case ActivityLogAdminActorType.CUSTOMER:
      return "green"
    case ActivityLogAdminActorType.SYSTEM:
      return "grey"
    case ActivityLogAdminActorType.SCHEDULER:
      return "orange"
  }
}

function formatDateTime(value: string | null | undefined, emptyValue: string) {
  if (!value) {
    return emptyValue
  }

  const date = new Date(value)

  if (Number.isNaN(date.getTime())) {
    return emptyValue
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date)
}

function formatUnknown(value: unknown, emptyValue: string) {
  if (value === null || value === undefined) {
    return emptyValue
  }

  if (typeof value === "string") {
    return value
  }

  if (
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return String(value)
  }

  return JSON.stringify(value)
}

function addDays(date: Date, amount: number) {
  const next = new Date(date)
  next.setDate(next.getDate() + amount)
  return next
}

function removeFilter(current: DataTableFilteringState, key: string) {
  const next = { ...current }
  delete next[key]
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
