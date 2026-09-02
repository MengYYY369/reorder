import { defineRouteConfig } from "@medusajs/admin-sdk"
import { translate, type ReorderTranslate } from "../../../i18n/translate"
import { useTranslation } from "react-i18next"
import { XMarkMini } from "@medusajs/icons"
import {
  Alert,
  Button,
  Container,
  DropdownMenu,
  Heading,
  Input,
  Select,
  Text,
  toast,
} from "@medusajs/ui"
import { useMutation } from "@tanstack/react-query"
import { useMemo, useState } from "react"
import {
  type AnalyticsExportFormat,
  AnalyticsGroupBy,
  AnalyticsMetricKey,
  type AdminAnalyticsFilters,
  type AnalyticsFrequencyFilter,
  type AnalyticsKpiSummary,
  type AnalyticsSubscriptionStatus,
  type AnalyticsTrendSeries,
} from "../../../types/analytics"
import {
  exportAdminAnalytics,
  useAdminAnalyticsKpisQuery,
  useAdminAnalyticsProductsQuery,
  useAdminAnalyticsTrendsQuery,
} from "./data-loading"

const DEFAULT_FILTERS: AdminAnalyticsFilters = {
  date_from: toLocalDateInputValue(addDays(new Date(), -29)),
  date_to: toLocalDateInputValue(new Date()),
  status: [],
  product_id: [],
  frequency: [],
  group_by: AnalyticsGroupBy.DAY,
}

const BUCKET_LABEL_KEYS: Record<AnalyticsGroupBy, string> = {
  [AnalyticsGroupBy.DAY]: "analytics.trend.bucketsDay",
  [AnalyticsGroupBy.WEEK]: "analytics.trend.bucketsWeek",
  [AnalyticsGroupBy.MONTH]: "analytics.trend.bucketsMonth",
}

const STATUS_FILTER_KEYS: Record<AnalyticsSubscriptionStatus, string> = {
  active: "analytics.status.active",
  paused: "analytics.status.paused",
  past_due: "analytics.status.pastDue",
  cancelled: "analytics.status.cancelled",
}

const AnalyticsPage = () => {
  const { t } = useTranslation("reorder")
  const [filters, setFilters] = useState<AdminAnalyticsFilters>(DEFAULT_FILTERS)
  const [selectedMetric, setSelectedMetric] = useState<AnalyticsMetricKey>(
    AnalyticsMetricKey.MRR
  )
  const exportMutation = useMutation({
    mutationFn: (format: AnalyticsExportFormat) =>
      exportAdminAnalytics(filters, format),
    onSuccess: (_response, format) => {
      toast.success(
        t("analytics.toast.exported", { format: format.toUpperCase() })
      )
    },
    onError: (error) => {
      toast.error(
        error instanceof Error
          ? error.message
          : t("analytics.list.exportError")
      )
    },
  })

  const statusFilterOptions = useMemo(
    () =>
      [
        { label: t("analytics.status.active"), value: "active" },
        { label: t("analytics.status.paused"), value: "paused" },
        { label: t("analytics.status.pastDue"), value: "past_due" },
        { label: t("analytics.status.cancelled"), value: "cancelled" },
      ] as Array<{
        label: string
        value: AnalyticsSubscriptionStatus
      }>,
    [t]
  )

  const frequencyFilterOptions = useMemo(
    () =>
      [
        {
          label: t("analytics.frequency.weekly"),
          value: { interval: "week", value: 1 },
        },
        {
          label: t("analytics.frequency.every2Weeks"),
          value: { interval: "week", value: 2 },
        },
        {
          label: t("analytics.frequency.monthly"),
          value: { interval: "month", value: 1 },
        },
        {
          label: t("analytics.frequency.quarterly"),
          value: { interval: "month", value: 3 },
        },
        {
          label: t("analytics.frequency.yearly"),
          value: { interval: "year", value: 1 },
        },
      ] as Array<{
        label: string
        value: AnalyticsFrequencyFilter
      }>,
    [t]
  )

  const metricTabs = useMemo(
    () =>
      [
        { key: AnalyticsMetricKey.MRR, label: t("analytics.metricTabs.mrr") },
        {
          key: AnalyticsMetricKey.CHURN_RATE,
          label: t("analytics.metricTabs.churn"),
        },
        { key: AnalyticsMetricKey.LTV, label: t("analytics.metricTabs.ltv") },
        {
          key: AnalyticsMetricKey.CREATED_SUBSCRIPTIONS_COUNT,
          label: t("analytics.metricTabs.created"),
        },
      ] as Array<{
        key: AnalyticsMetricKey
        label: string
      }>,
    [t]
  )

  const {
    data: kpisData,
    isLoading: isKpisLoading,
    isError: isKpisError,
    error: kpisError,
  } = useAdminAnalyticsKpisQuery(filters)
  const {
    data: trendsData,
    isLoading: isTrendsLoading,
    isError: isTrendsError,
    error: trendsError,
  } = useAdminAnalyticsTrendsQuery(filters)
  const { data: productsData } = useAdminAnalyticsProductsQuery()

  const selectedProductId = filters.product_id[0] ?? "__all"
  const isCreatedMetric =
    selectedMetric === AnalyticsMetricKey.CREATED_SUBSCRIPTIONS_COUNT
  const selectedSeries = useMemo(() => {
    const series = trendsData?.series ?? []

    return (
      series.find((item) => item.metric === selectedMetric) ??
      series[0] ??
      null
    )
  }, [selectedMetric, trendsData?.series])

  const hasActiveFilters =
    Boolean(filters.date_from) ||
    Boolean(filters.date_to) ||
    filters.status.length > 0 ||
    filters.product_id.length > 0 ||
    filters.frequency.length > 0 ||
    filters.group_by !== AnalyticsGroupBy.DAY

  const hasAnalyticsData = useMemo(() => {
    const countMetric = kpisData?.kpis.find(
      (item) => item.key === AnalyticsMetricKey.ACTIVE_SUBSCRIPTIONS_COUNT
    )
    const hasNonCountMetric = (kpisData?.kpis ?? []).some(
      (item) => item.key !== AnalyticsMetricKey.ACTIVE_SUBSCRIPTIONS_COUNT && item.value !== null
    )
    const hasTrendPoints = (trendsData?.series ?? []).some((series) =>
      series.metric !== AnalyticsMetricKey.CREATED_SUBSCRIPTIONS_COUNT &&
      series.points.some((point) => point.value !== null)
    )

    return Boolean(countMetric?.value && countMetric.value > 0) || hasNonCountMetric || hasTrendPoints
  }, [kpisData?.kpis, trendsData?.series])
  const hasSelectedSeriesData = useMemo(() => {
    if (!selectedSeries) {
      return false
    }

    if (selectedSeries.metric === AnalyticsMetricKey.CREATED_SUBSCRIPTIONS_COUNT) {
      return selectedSeries.points.length > 0
    }

    return selectedSeries.points.some((point) => point.value !== null)
  }, [selectedSeries])

  const pageError = isKpisError ? kpisError : isTrendsError ? trendsError : null

  return (
    <Container className="divide-y p-0">
      <div className="flex items-center justify-between px-6 py-4">
        <div className="flex flex-col">
          <Heading level="h1">{t("analytics.list.title")}</Heading>
          <Text size="small" leading="compact" className="text-ui-fg-subtle">
            {t("analytics.list.description")}
          </Text>
        </div>
        <div className="flex items-center gap-2">
          <DropdownMenu>
            <DropdownMenu.Trigger asChild>
              <Button
                size="small"
                variant="secondary"
                type="button"
                isLoading={exportMutation.isPending}
                disabled={exportMutation.isPending}
              >
                {t("analytics.export.button")}
              </Button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Content align="end">
              <DropdownMenu.Item
                disabled={exportMutation.isPending}
                onClick={() => {
                  exportMutation.mutate("csv")
                }}
              >
                {t("analytics.export.csv")}
              </DropdownMenu.Item>
              <DropdownMenu.Item
                disabled={exportMutation.isPending}
                onClick={() => {
                  exportMutation.mutate("json")
                }}
              >
                {t("analytics.export.json")}
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu>
        </div>
      </div>

      <div className="flex flex-col gap-4 px-6 py-4">
        <div className="flex flex-wrap items-center gap-2">
          {filters.status.map((status) => (
            <FilterChip
              key={status}
              label={t("analytics.filters.status")}
              value={formatStatus(status, t)}
              onRemove={() => {
                setFilters((current) => ({
                  ...current,
                  status: current.status.filter((value) => value !== status),
                }))
              }}
            />
          ))}
          {filters.frequency.map((frequency) => {
            const token = toFrequencyToken(frequency)

            return (
              <FilterChip
                key={token}
                label={t("analytics.filters.frequency")}
                value={formatFrequency(frequency, t)}
                onRemove={() => {
                  setFilters((current) => ({
                    ...current,
                    frequency: current.frequency.filter(
                      (value) => toFrequencyToken(value) !== token
                    ),
                  }))
                }}
              />
            )
          })}
          {filters.product_id.map((productId) => {
            const product = productsData?.products.find((item) => item.id === productId)

            return (
              <FilterChip
                key={productId}
                label={t("analytics.filters.product")}
                value={product?.title ?? productId}
                onRemove={() => {
                  setFilters((current) => ({
                    ...current,
                    product_id: current.product_id.filter((value) => value !== productId),
                  }))
                }}
              />
            )
          })}
          {filters.group_by !== AnalyticsGroupBy.DAY && !isCreatedMetric ? (
            <FilterChip
              label={t("analytics.filters.groupBy")}
              value={formatGroupBy(filters.group_by, t)}
              onRemove={() => {
                setFilters((current) => ({
                  ...current,
                  group_by: AnalyticsGroupBy.DAY,
                }))
              }}
            />
          ) : null}
          <DropdownMenu>
            <DropdownMenu.Trigger asChild>
              <Button size="small" variant="secondary" type="button">
                {t("analytics.filters.addFilter")}
              </Button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Content align="start">
              <DropdownMenu.SubMenu>
                <DropdownMenu.SubMenuTrigger>
                  {t("analytics.filters.status")}
                </DropdownMenu.SubMenuTrigger>
                <DropdownMenu.SubMenuContent>
                  {statusFilterOptions.map((option) => (
                    <DropdownMenu.CheckboxItem
                      key={option.value}
                      checked={filters.status.includes(option.value)}
                      onSelect={(event) => {
                        event.preventDefault()
                      }}
                      onCheckedChange={(checked) => {
                        setFilters((current) => ({
                          ...current,
                          status: checked
                            ? [...current.status, option.value]
                            : current.status.filter((value) => value !== option.value),
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
                  {t("analytics.filters.frequency")}
                </DropdownMenu.SubMenuTrigger>
                <DropdownMenu.SubMenuContent>
                  {frequencyFilterOptions.map((option) => {
                    const token = toFrequencyToken(option.value)
                    const checked = filters.frequency.some(
                      (value) => toFrequencyToken(value) === token
                    )

                    return (
                      <DropdownMenu.CheckboxItem
                        key={token}
                        checked={checked}
                        onSelect={(event) => {
                          event.preventDefault()
                        }}
                        onCheckedChange={(nextChecked) => {
                          setFilters((current) => ({
                            ...current,
                            frequency: nextChecked
                              ? [...current.frequency, option.value]
                              : current.frequency.filter(
                                  (value) => toFrequencyToken(value) !== token
                                ),
                          }))
                        }}
                      >
                        {option.label}
                      </DropdownMenu.CheckboxItem>
                    )
                  })}
                </DropdownMenu.SubMenuContent>
              </DropdownMenu.SubMenu>
            </DropdownMenu.Content>
          </DropdownMenu>
          {hasActiveFilters ? (
            <button
              type="button"
              className="text-ui-fg-muted hover:text-ui-fg-subtle txt-compact-small-plus rounded-md px-2 py-1 transition-fg"
              onClick={() => {
                setFilters(DEFAULT_FILTERS)
              }}
            >
              {t("common.filters.clearAll")}
            </button>
          ) : null}
        </div>

        <div className="grid gap-3 lg:grid-cols-[repeat(4,minmax(0,1fr))]">
          <DateField
            label={t("analytics.filters.dateFrom")}
            value={filters.date_from ?? ""}
            onChange={(value) => {
              setFilters((current) => ({ ...current, date_from: value || null }))
            }}
          />
          <DateField
            label={t("analytics.filters.dateTo")}
            value={filters.date_to ?? ""}
            onChange={(value) => {
              setFilters((current) => ({ ...current, date_to: value || null }))
            }}
          />
          <div className="flex flex-col gap-y-1">
            <Text size="small" leading="compact" weight="plus">
              {t("analytics.filters.product")}
            </Text>
            <Select
              value={selectedProductId}
              onValueChange={(value) => {
                setFilters((current) => ({
                  ...current,
                  product_id: value === "__all" ? [] : [value],
                }))
              }}
            >
              <Select.Trigger>
                <Select.Value placeholder={t("analytics.filters.allProducts")} />
              </Select.Trigger>
              <Select.Content>
                <Select.Item value="__all">
                  {t("analytics.filters.allProducts")}
                </Select.Item>
                {(productsData?.products ?? []).map((product) => (
                  <Select.Item key={product.id} value={product.id}>
                    {product.title}
                  </Select.Item>
                ))}
              </Select.Content>
            </Select>
          </div>
          <div className="flex flex-col gap-y-1">
            <Text size="small" leading="compact" weight="plus">
              {t("analytics.filters.groupBy")}
            </Text>
            <Select
              value={filters.group_by}
              disabled={isCreatedMetric}
              onValueChange={(value) => {
                setFilters((current) => ({
                  ...current,
                  group_by: value as AnalyticsGroupBy,
                }))
              }}
            >
              <Select.Trigger>
                <Select.Value />
              </Select.Trigger>
              <Select.Content>
                <Select.Item value={AnalyticsGroupBy.DAY}>
                  {t("analytics.groupBy.day")}
                </Select.Item>
                <Select.Item value={AnalyticsGroupBy.WEEK}>
                  {t("analytics.groupBy.week")}
                </Select.Item>
                <Select.Item value={AnalyticsGroupBy.MONTH}>
                  {t("analytics.groupBy.month")}
                </Select.Item>
              </Select.Content>
            </Select>
            {isCreatedMetric ? (
              <Text size="small" leading="compact" className="text-ui-fg-subtle">
                {t("analytics.trend.createdUtcNote")}
              </Text>
            ) : null}
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-4 px-6 py-6">
        {pageError ? (
          <Alert variant="error">
            {pageError instanceof Error
              ? pageError.message
              : t("analytics.list.loadError")}
          </Alert>
        ) : null}

        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {isKpisLoading && !kpisData
            ? metricTabs.map((metric) => <MetricCardSkeleton key={metric.key} />)
            : (kpisData?.kpis ?? []).map((metric) => (
                <MetricCard key={metric.key} metric={metric} />
              ))}
        </div>

        <Container className="p-0">
          <div className="flex flex-col gap-4 px-6 py-5">
            <div className="flex items-start justify-between gap-4">
              <div className="flex flex-col">
                <Heading level="h2">{t("analytics.list.trendOverview")}</Heading>
                <Text
                  size="small"
                  leading="compact"
                  className="text-ui-fg-subtle"
                >
                  {isCreatedMetric
                    ? t("analytics.trend.createdRangeNote")
                    : t("analytics.trend.trendUtcNote")}
                </Text>
              </div>
              <Text size="small" leading="compact" className="text-ui-fg-subtle">
                {isCreatedMetric
                  ? t("analytics.trend.dailyBars")
                  : t(BUCKET_LABEL_KEYS[filters.group_by])}
              </Text>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {metricTabs.map((metric) => (
                <Button
                  key={metric.key}
                  size="small"
                  type="button"
                  variant={selectedMetric === metric.key ? "primary" : "secondary"}
                  onClick={() => {
                    setSelectedMetric(metric.key)
                  }}
                >
                  {metric.label}
                </Button>
              ))}
            </div>

            {isTrendsLoading && !trendsData ? (
              <TrendChartSkeleton />
            ) : !selectedSeries || !hasSelectedSeriesData || (!hasAnalyticsData && !isCreatedMetric) ? (
              <EmptyAnalyticsState
                title={t("analytics.list.noDataRange")}
                description={t("analytics.list.noDataRangeHint")}
              />
            ) : (
              <>
                {isCreatedMetric ? (
                  <CreatedSubscriptionsBarChart series={selectedSeries} />
                ) : (
                  <TrendChart series={selectedSeries} />
                )}
              </>
            )}
          </div>
        </Container>
      </div>
    </Container>
  )
}

export const config = defineRouteConfig({
  label: "menuItems.analytics",
  translationNs: "reorder",
  rank: 5,
})

export const handle = {
  breadcrumb: () => translate("menuItems.analytics"),
}

export default AnalyticsPage

const DateField = ({
  label,
  value,
  onChange,
}: {
  label: string
  value: string
  onChange: (value: string) => void
}) => {
  return (
    <div className="flex flex-col gap-y-1">
      <Text size="small" leading="compact" weight="plus">
        {label}
      </Text>
      <Input
        type="date"
        size="small"
        value={value}
        onChange={(event) => {
          onChange(event.target.value)
        }}
      />
    </div>
  )
}

const MetricCard = ({ metric }: { metric: AnalyticsKpiSummary }) => {
  const { t } = useTranslation("reorder")

  return (
    <Container className="p-0">
      <div className="flex flex-col gap-3 px-5 py-4">
        <div className="flex items-center justify-between gap-3">
          <Text size="small" leading="compact" className="text-ui-fg-subtle">
            {metric.label}
          </Text>
          <Text size="small" leading="compact" className="text-ui-fg-muted">
            {formatUnitLabel(metric, t)}
          </Text>
        </div>
        <Heading level="h2">
          {formatMetricValue(metric.value, metric, t)}
        </Heading>
        <Text size="small" leading="compact" className="text-ui-fg-subtle">
          {formatMetricDelta(metric, t)}
        </Text>
      </div>
    </Container>
  )
}

const MetricCardSkeleton = () => {
  return (
    <Container className="p-0">
      <div className="flex animate-pulse flex-col gap-3 px-5 py-4">
        <div className="h-4 w-20 rounded bg-ui-bg-disabled" />
        <div className="h-8 w-32 rounded bg-ui-bg-disabled" />
        <div className="h-4 w-28 rounded bg-ui-bg-disabled" />
      </div>
    </Container>
  )
}

const EmptyAnalyticsState = ({
  title,
  description,
}: {
  title: string
  description: string
}) => {
  return (
    <div className="flex min-h-[260px] flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-ui-border-base px-6 py-12 text-center">
      <Heading level="h3">{title}</Heading>
      <Text size="small" leading="compact" className="max-w-xl text-ui-fg-subtle">
        {description}
      </Text>
    </div>
  )
}

const TrendChartSkeleton = () => {
  return (
    <div className="flex animate-pulse flex-col gap-4 rounded-lg border border-ui-border-base px-4 py-4">
      <div className="h-4 w-28 rounded bg-ui-bg-disabled" />
      <div className="h-[260px] rounded bg-ui-bg-disabled" />
      <div className="grid grid-cols-3 gap-4">
        <div className="h-4 rounded bg-ui-bg-disabled" />
        <div className="h-4 rounded bg-ui-bg-disabled" />
        <div className="h-4 rounded bg-ui-bg-disabled" />
      </div>
    </div>
  )
}

const TrendChart = ({ series }: { series: AnalyticsTrendSeries }) => {
  const { t } = useTranslation("reorder")
  const [hoveredPoint, setHoveredPoint] = useState<{
    bucket_start: string
    value: number
    cursor_x: number
    cursor_y: number
  } | null>(null)

  const numericPoints = series.points
    .map((point, index) => ({
      index,
      value: point.value,
      bucket_start: point.bucket_start,
      bucket_end: point.bucket_end,
    }))
    .filter((point): point is {
      index: number
      value: number
      bucket_start: string
      bucket_end: string
    } => typeof point.value === "number")

  if (!numericPoints.length) {
    return (
      <EmptyAnalyticsState
        title={t("analytics.list.noTrendPoints")}
        description={t("analytics.list.noTrendPointsHint")}
      />
    )
  }

  const width = 960
  const height = 280
  const padding = 24
  const min = Math.min(...numericPoints.map((point) => point.value))
  const max = Math.max(...numericPoints.map((point) => point.value))
  const range = max - min || 1
  const totalPoints = numericPoints.length - 1 || 1

  const coordinates = numericPoints.map((point, pointIndex) => {
    const x =
      padding + (pointIndex / totalPoints) * (width - padding * 2)
    const y =
      height -
      padding -
      ((point.value - min) / range) * (height - padding * 2)

    return {
      ...point,
      x,
      y,
    }
  })

  const linePath = coordinates
    .map((point, index) =>
      `${index === 0 ? "M" : "L"} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`
    )
    .join(" ")
  const areaPath = `${linePath} L ${
    coordinates[coordinates.length - 1].x
  } ${height - padding} L ${coordinates[0].x} ${height - padding} Z`
  const referencePoints = [
    coordinates[0],
    coordinates[Math.floor(coordinates.length / 2)],
    coordinates[coordinates.length - 1],
  ].filter(
    (point, index, collection) =>
      collection.findIndex(
        (candidate) =>
          candidate.bucket_start === point.bucket_start &&
          candidate.bucket_end === point.bucket_end
      ) === index
  )

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-2 md:grid-cols-[1fr_auto] md:items-start">
        <div className="flex flex-col">
          <Text size="small" leading="compact" weight="plus">
            {series.label}
          </Text>
          <Text size="small" leading="compact" className="text-ui-fg-subtle">
            {formatSeriesRangeSummary(series, t)}
          </Text>
        </div>
        <div className="flex flex-col items-start gap-1 md:items-end">
          <Text size="small" leading="compact" className="text-ui-fg-subtle">
            {`${t("analytics.trend.max")} ${formatTrendValue(max, series, t)}`}
          </Text>
          <Text size="small" leading="compact" className="text-ui-fg-subtle">
            {`${t("analytics.trend.min")} ${formatTrendValue(min, series, t)}`}
          </Text>
        </div>
      </div>
      <div className="rounded-lg border border-ui-border-base bg-ui-bg-subtle px-3 py-3">
        <div className="relative">
          {hoveredPoint ? (
            <div
              className="pointer-events-none absolute top-2 z-10 rounded-md border border-ui-border-base bg-ui-bg-base px-3 py-2 shadow-elevation-card-rest"
              style={{
                left: `${hoveredPoint.cursor_x}px`,
                top: `${Math.max(8, hoveredPoint.cursor_y - 12)}px`,
                transform: "translate(-50%, -100%)",
              }}
            >
              <Text size="small" leading="compact" weight="plus">
                {formatDateLabel(hoveredPoint.bucket_start)}
              </Text>
              <Text size="small" leading="compact" className="text-ui-fg-subtle">
                {formatTrendValue(hoveredPoint.value, series, t)}
              </Text>
            </div>
          ) : null}
          <svg
            viewBox={`0 0 ${width} ${height}`}
            role="img"
            aria-label={t("analytics.trend.ariaTrendChart", { label: series.label })}
            className="h-[280px] w-full"
          >
            <defs>
              <linearGradient id="analytics-area-gradient" x1="0" x2="0" y1="0" y2="1">
                <stop offset="0%" stopColor="#3b82f6" stopOpacity="0.18" />
                <stop offset="100%" stopColor="#3b82f6" stopOpacity="0.02" />
              </linearGradient>
            </defs>
            <line
              x1={padding}
              y1={height - padding}
              x2={width - padding}
              y2={height - padding}
              stroke="#d6d9df"
              strokeWidth="1"
            />
            <path d={areaPath} fill="url(#analytics-area-gradient)" />
            <path
              d={linePath}
              fill="none"
              stroke="#2563eb"
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="3"
            />
            {coordinates.map((point) => {
              const isHovered = hoveredPoint?.bucket_start === point.bucket_start
              return (
                <g key={`${point.bucket_start}-${point.index}`}>
                  {isHovered && (
                    <circle
                      cx={point.x}
                      cy={point.y}
                      r="8"
                      fill="#2563eb"
                      fillOpacity="0.3"
                    />
                  )}
                  <circle
                    cx={point.x}
                    cy={point.y}
                    r="4"
                    fill="#2563eb"
                    stroke="#ffffff"
                    strokeWidth="2"
                  />
                  <circle
                    cx={point.x}
                    cy={point.y}
                    r="16"
                    fill="transparent"
                    className="cursor-pointer"
                    onMouseEnter={(event) => {
                      const svgRect = event.currentTarget.ownerSVGElement?.getBoundingClientRect()
                      setHoveredPoint({
                        bucket_start: point.bucket_start,
                        value: point.value,
                        cursor_x: svgRect ? event.clientX - svgRect.left : point.x,
                        cursor_y: svgRect ? event.clientY - svgRect.top : point.y,
                      })
                    }}
                    onMouseMove={(event) => {
                      const svgRect = event.currentTarget.ownerSVGElement?.getBoundingClientRect()
                      setHoveredPoint({
                        bucket_start: point.bucket_start,
                        value: point.value,
                        cursor_x: svgRect ? event.clientX - svgRect.left : point.x,
                        cursor_y: svgRect ? event.clientY - svgRect.top : point.y,
                      })
                    }}
                    onMouseLeave={() => {
                      setHoveredPoint((current) =>
                        current?.bucket_start === point.bucket_start ? null : current
                      )
                    }}
                  />
                </g>
              )
            })}
          </svg>
        </div>
      </div>
      <div className="grid gap-2 md:grid-cols-3">
        {referencePoints.map((point) => (
          <div
            key={`${point.bucket_start}-${point.bucket_end}`}
            className="rounded-md border border-ui-border-base px-3 py-2"
          >
            <Text size="small" leading="compact" weight="plus">
              {formatDateLabel(point.bucket_start)}
            </Text>
            <Text size="small" leading="compact" className="text-ui-fg-subtle">
              {formatTrendValue(point.value, series, t)}
            </Text>
          </div>
        ))}
      </div>
    </div>
  )
}

const CreatedSubscriptionsBarChart = ({
  series,
}: {
  series: AnalyticsTrendSeries
}) => {
  const { t } = useTranslation("reorder")
  const [hoveredPoint, setHoveredPoint] = useState<{
    bucket_start: string
    value: number
    cursor_x: number
    cursor_y: number
  } | null>(null)
  const numericPoints = series.points.map((point, index) => ({
    index,
    value: typeof point.value === "number" ? point.value : 0,
    bucket_start: point.bucket_start,
    bucket_end: point.bucket_end,
  }))

  if (!numericPoints.length) {
    return (
      <EmptyAnalyticsState
        title={t("analytics.list.noDailyBuckets")}
        description={t("analytics.list.noDailyBucketsHint")}
      />
    )
  }

  const width = 960
  const height = 280
  const padding = 24
  const innerWidth = width - padding * 2
  const chartHeight = height - padding * 2
  const max = Math.max(...numericPoints.map((point) => point.value), 0)
  const min = Math.min(...numericPoints.map((point) => point.value), 0)
  const range = max || 1
  const barWidth = Math.max(
    6,
    Math.min(24, innerWidth / Math.max(numericPoints.length, 1) - 4)
  )
  const step = innerWidth / Math.max(numericPoints.length, 1)
  const referencePoints = [
    numericPoints[0],
    numericPoints[Math.floor(numericPoints.length / 2)],
    numericPoints[numericPoints.length - 1],
  ].filter(
    (point, index, collection) =>
      collection.findIndex(
        (candidate) => candidate.bucket_start === point.bucket_start
      ) === index
  )

  const bars = numericPoints.map((point, pointIndex) => {
    const barHeight = point.value === 0 ? 2 : (point.value / range) * chartHeight
    const x = padding + pointIndex * step + Math.max((step - barWidth) / 2, 0)
    const y = height - padding - barHeight

    return {
      ...point,
      x,
      y,
      barHeight,
    }
  })

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-2 md:grid-cols-[1fr_auto] md:items-start">
        <div className="flex flex-col">
          <Text size="small" leading="compact" weight="plus">
            {series.label}
          </Text>
          <Text size="small" leading="compact" className="text-ui-fg-subtle">
            {formatSeriesRangeSummary(series, t)}
          </Text>
        </div>
        <div className="flex flex-col items-start gap-1 md:items-end">
          <Text size="small" leading="compact" className="text-ui-fg-subtle">
            {`${t("analytics.trend.max")} ${formatTrendValue(max, series, t)}`}
          </Text>
          <Text size="small" leading="compact" className="text-ui-fg-subtle">
            {`${t("analytics.trend.min")} ${formatTrendValue(min, series, t)}`}
          </Text>
        </div>
      </div>
      <div className="rounded-lg border border-ui-border-base bg-ui-bg-subtle px-3 py-3">
        <div className="relative">
          {hoveredPoint ? (
            <div
              className="pointer-events-none absolute top-2 z-10 rounded-md border border-ui-border-base bg-ui-bg-base px-3 py-2 shadow-elevation-card-rest"
              style={{
                left: `${hoveredPoint.cursor_x}px`,
                top: `${Math.max(8, hoveredPoint.cursor_y - 12)}px`,
                transform: "translate(-50%, -100%)",
              }}
            >
              <Text size="small" leading="compact" weight="plus">
                {formatDateLabel(hoveredPoint.bucket_start)}
              </Text>
              <Text size="small" leading="compact" className="text-ui-fg-subtle">
                {formatTrendValue(hoveredPoint.value, series, t)}
              </Text>
            </div>
          ) : null}
          <svg
            viewBox={`0 0 ${width} ${height}`}
            role="img"
            aria-label={t("analytics.trend.ariaBarChart", { label: series.label })}
            className="h-[280px] w-full"
          >
            <defs>
              <linearGradient id="analytics-bar-gradient" x1="0" x2="0" y1="0" y2="1">
                <stop offset="0%" stopColor="#3b82f6" stopOpacity="0.95" />
                <stop offset="100%" stopColor="#2563eb" stopOpacity="0.8" />
              </linearGradient>
            </defs>
            <line
              x1={padding}
              y1={height - padding}
              x2={width - padding}
              y2={height - padding}
              stroke="#d6d9df"
              strokeWidth="1"
            />
            {bars.map((point) => (
              <rect
                key={`${point.bucket_start}-${point.index}`}
                x={point.x}
                y={point.y}
                width={barWidth}
                height={point.barHeight}
                rx="3"
                fill="url(#analytics-bar-gradient)"
                onMouseEnter={(event) => {
                  const svgRect = event.currentTarget.ownerSVGElement?.getBoundingClientRect()

                  setHoveredPoint({
                    bucket_start: point.bucket_start,
                    value: point.value,
                    cursor_x: svgRect ? event.clientX - svgRect.left : point.x,
                    cursor_y: svgRect ? event.clientY - svgRect.top : point.y,
                  })
                }}
                onMouseMove={(event) => {
                  const svgRect = event.currentTarget.ownerSVGElement?.getBoundingClientRect()

                  setHoveredPoint({
                    bucket_start: point.bucket_start,
                    value: point.value,
                    cursor_x: svgRect ? event.clientX - svgRect.left : point.x,
                    cursor_y: svgRect ? event.clientY - svgRect.top : point.y,
                  })
                }}
                onMouseLeave={() => {
                  setHoveredPoint((current) =>
                    current?.bucket_start === point.bucket_start ? null : current
                  )
                }}
              >
                <title>
                  {t("analytics.trend.createdBarTitle", {
                    bucket: formatDateLabel(point.bucket_start),
                    value: point.value,
                  })}
                </title>
              </rect>
            ))}
          </svg>
        </div>
      </div>
      <div className="grid gap-2 md:grid-cols-3">
        {referencePoints.map((point) => (
          <div
            key={`${point.bucket_start}-${point.bucket_end}`}
            className="rounded-md border border-ui-border-base px-3 py-2"
          >
            <Text size="small" leading="compact" weight="plus">
              {formatDateLabel(point.bucket_start)}
            </Text>
            <Text size="small" leading="compact" className="text-ui-fg-subtle">
              {formatTrendValue(point.value, series, t)}
            </Text>
          </div>
        ))}
      </div>
    </div>
  )
}

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

function formatMetricValue(
  value: number | null,
  metric: Pick<AnalyticsKpiSummary, "unit" | "currency_code" | "precision">,
  t: ReorderTranslate
) {
  if (value === null) {
    return t("analytics.units.unavailable")
  }

  switch (metric.unit) {
    case "currency":
      return new Intl.NumberFormat(
        metric.currency_code?.toUpperCase() === "USD" ? "en-US" : undefined,
        {
        style: "currency",
        currency: metric.currency_code || "USD",
        minimumFractionDigits: metric.precision,
        maximumFractionDigits: metric.precision,
        }
      ).format(value)
    case "percentage":
      return `${value.toFixed(metric.precision)}%`
    case "count":
      return new Intl.NumberFormat(undefined, {
        maximumFractionDigits: 0,
      }).format(value)
  }
}

function formatMetricDelta(metric: AnalyticsKpiSummary, t: ReorderTranslate) {
  if (metric.previous_value === null || metric.delta_value === null) {
    return t("analytics.list.noComparisonWindow")
  }

  const direction =
    metric.delta_value > 0 ? "up" : metric.delta_value < 0 ? "down" : "flat"
  const delta =
    metric.unit === "count"
      ? new Intl.NumberFormat(undefined, {
          maximumFractionDigits: 0,
        }).format(Math.abs(metric.delta_value))
      : Math.abs(metric.delta_value).toFixed(metric.precision)

  return t(
    direction === "flat"
      ? "analytics.trend.flat"
      : direction === "up"
        ? "analytics.trend.up"
        : "analytics.trend.down",
    { delta: `${delta}${metric.unit === "percentage" ? "%" : ""}` }
  )
}

function formatUnitLabel(
  metric: Pick<AnalyticsKpiSummary, "unit" | "currency_code">,
  t: ReorderTranslate
) {
  switch (metric.unit) {
    case "currency":
      return metric.currency_code?.toUpperCase() ?? t("analytics.units.currency")
    case "percentage":
      return t("analytics.units.percent")
    case "count":
      return t("analytics.units.count")
  }
}

function formatTrendValue(
  value: number | null,
  series: AnalyticsTrendSeries,
  t: ReorderTranslate
) {
  if (value === null) {
    return t("analytics.units.unavailable")
  }

  return formatMetricValue(
    value,
    {
      unit: series.unit,
      currency_code: series.currency_code,
      precision: series.precision,
    },
    t
  )
}

function formatSeriesRangeSummary(
  series: AnalyticsTrendSeries,
  t: ReorderTranslate
) {
  if (!series.points.length) {
    return t("analytics.trend.rangeEmpty")
  }

  return t("analytics.trend.rangeSummary", {
    from: formatDateLabel(series.points[0].bucket_start),
    to: formatDateLabel(series.points[series.points.length - 1].bucket_end),
  })
}

function formatDateLabel(value: string) {
  const date = new Date(value)

  if (Number.isNaN(date.getTime())) {
    return value
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
  }).format(date)
}

function formatStatus(
  value: AnalyticsSubscriptionStatus,
  t: ReorderTranslate
) {
  return t(STATUS_FILTER_KEYS[value])
}

function formatGroupBy(value: AnalyticsGroupBy, t: ReorderTranslate) {
  switch (value) {
    case AnalyticsGroupBy.DAY:
      return t("analytics.groupBy.day")
    case AnalyticsGroupBy.WEEK:
      return t("analytics.groupBy.week")
    case AnalyticsGroupBy.MONTH:
      return t("analytics.groupBy.month")
  }
}

function formatFrequency(
  value: AnalyticsFrequencyFilter,
  t: ReorderTranslate
) {
  switch (value.interval) {
    case "week":
      return value.value === 1
        ? t("analytics.frequency.weekly")
        : t("analytics.frequency.everyNWeeks", { value: value.value })
    case "month":
      return value.value === 1
        ? t("analytics.frequency.monthly")
        : t("analytics.frequency.everyNMonths", { value: value.value })
    case "year":
      return value.value === 1
        ? t("analytics.frequency.yearly")
        : t("analytics.frequency.everyNYears", { value: value.value })
  }
}

function toFrequencyToken(value: AnalyticsFrequencyFilter) {
  return `${value.interval}:${value.value}`
}

function toLocalDateInputValue(date: Date) {
  const next = new Date(date)
  next.setHours(0, 0, 0, 0)

  const year = next.getFullYear()
  const month = `${next.getMonth() + 1}`.padStart(2, "0")
  const day = `${next.getDate()}`.padStart(2, "0")

  return `${year}-${month}-${day}`
}

function addDays(date: Date, days: number) {
  const next = new Date(date)
  next.setDate(next.getDate() + days)

  return next
}
