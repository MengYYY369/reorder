import { defineRouteConfig } from "@medusajs/admin-sdk";
import { translate, type ReorderTranslate } from "../../../i18n/translate";
import { useTranslation } from "react-i18next";
import {
  CheckCircle,
  Pause,
  PencilSquare,
  Plus,
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
import { sdk } from "../../../lib/client";
import {
  adminPlanOffersQueryKeys,
  useAdminPlanOffersDisplayQuery,
} from "./data-loading";
import { Link } from "react-router-dom";
import {
  PlanOfferAdminDetailResponse,
  PlanOfferAdminListItem,
  PlanOfferAdminStatus,
  PlanOfferFrequencyInterval,
  PlanOfferScope,
} from "../../../types/plan-offer";
import { CreatePlanOfferModal } from "./components/create-plan-offer-modal";
import { EditPlanOfferDrawer } from "./components/edit-plan-offer-drawer";
import {
  PlanOfferProductPickerModal,
  PlanOfferVariantPickerModal,
} from "./components/selection-modals";

const PAGE_SIZE = 20;

const columnHelper = createDataTableColumnHelper<PlanOfferAdminListItem>();
const filterHelper = createDataTableFilterHelper<PlanOfferAdminListItem>();

const PLAN_OFFER_STATUS_KEYS = {
  [PlanOfferAdminStatus.ENABLED]: "planOffers.status.enabled",
  [PlanOfferAdminStatus.DISABLED]: "planOffers.status.disabled",
} as const;

const PLAN_OFFER_SCOPE_KEYS = {
  [PlanOfferScope.PRODUCT]: "planOffers.scope.product",
  [PlanOfferScope.VARIANT]: "planOffers.scope.variant",
} as const;

const PLAN_OFFER_INTERVAL_KEYS = {
  [PlanOfferFrequencyInterval.WEEK]: "common.intervals.week",
  [PlanOfferFrequencyInterval.MONTH]: "common.intervals.month",
  [PlanOfferFrequencyInterval.YEAR]: "common.intervals.year",
} as const;

const discountRangeFilterOptions = [
  { label: "1-9", min: 1, max: 9 },
  { label: "10-24", min: 10, max: 24 },
  { label: "25+", min: 25 },
] as const;

const PlansOffersPage = () => {
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
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [editDrawerOpen, setEditDrawerOpen] = useState(false);
  const [editPlanOfferId, setEditPlanOfferId] = useState<string>();
  const [productPickerOpen, setProductPickerOpen] = useState(false);
  const [variantPickerOpen, setVariantPickerOpen] = useState(false);
  const prompt = usePrompt();
  const queryClient = useQueryClient();

  const statusFilterValue = useMemo(() => {
    return typeof filtering.status === "string"
      ? (filtering.status as PlanOfferAdminStatus)
      : undefined;
  }, [filtering]);

  const scopeFilterValue = useMemo(() => {
    return typeof filtering.scope === "string"
      ? (filtering.scope as PlanOfferScope)
      : undefined;
  }, [filtering]);

  const frequencyFilterValue = useMemo(() => {
    return typeof filtering.frequency === "string"
      ? (filtering.frequency as PlanOfferFrequencyInterval)
      : undefined;
  }, [filtering]);
  const productIdFilterValue = useMemo(() => {
    return typeof filtering.product_id === "string"
      ? filtering.product_id
      : undefined;
  }, [filtering]);
  const productTitleFilterValue = useMemo(() => {
    return typeof filtering.product_title === "string"
      ? filtering.product_title
      : undefined;
  }, [filtering]);
  const variantIdFilterValue = useMemo(() => {
    return typeof filtering.variant_id === "string"
      ? filtering.variant_id
      : undefined;
  }, [filtering]);
  const variantTitleFilterValue = useMemo(() => {
    return typeof filtering.variant_title === "string"
      ? filtering.variant_title
      : undefined;
  }, [filtering]);
  const discountMinFilterValue = useMemo(() => {
    return typeof filtering.discount_min === "number"
      ? filtering.discount_min
      : undefined;
  }, [filtering]);
  const discountMaxFilterValue = useMemo(() => {
    return typeof filtering.discount_max === "number"
      ? filtering.discount_max
      : undefined;
  }, [filtering]);

  const statusFilterOptions = useMemo(() => {
    return [
      {
        label: t(PLAN_OFFER_STATUS_KEYS[PlanOfferAdminStatus.ENABLED]),
        value: PlanOfferAdminStatus.ENABLED,
      },
      {
        label: t(PLAN_OFFER_STATUS_KEYS[PlanOfferAdminStatus.DISABLED]),
        value: PlanOfferAdminStatus.DISABLED,
      },
    ] as const;
  }, [t]);

  const scopeFilterOptions = useMemo(() => {
    return [
      {
        label: t(PLAN_OFFER_SCOPE_KEYS[PlanOfferScope.PRODUCT]),
        value: PlanOfferScope.PRODUCT,
      },
      {
        label: t(PLAN_OFFER_SCOPE_KEYS[PlanOfferScope.VARIANT]),
        value: PlanOfferScope.VARIANT,
      },
    ] as const;
  }, [t]);

  const frequencyFilterOptions = useMemo(() => {
    return [
      {
        label: t(PLAN_OFFER_INTERVAL_KEYS[PlanOfferFrequencyInterval.WEEK]),
        value: PlanOfferFrequencyInterval.WEEK,
      },
      {
        label: t(PLAN_OFFER_INTERVAL_KEYS[PlanOfferFrequencyInterval.MONTH]),
        value: PlanOfferFrequencyInterval.MONTH,
      },
      {
        label: t(PLAN_OFFER_INTERVAL_KEYS[PlanOfferFrequencyInterval.YEAR]),
        value: PlanOfferFrequencyInterval.YEAR,
      },
    ] as const;
  }, [t]);

  const filters = useMemo(() => {
    const statusFilter = filterHelper.accessor("status", {
      type: "radio",
      label: t("planOffers.filters.status"),
      options: [...statusFilterOptions],
    });

    const scopeFilter = filterHelper.accessor("target.scope", {
      id: "scope",
      type: "radio",
      label: t("planOffers.filters.scope"),
      options: [...scopeFilterOptions],
    });

    const frequencyFilter = filterHelper.accessor("allowed_frequencies", {
      id: "frequency",
      type: "radio",
      label: t("planOffers.filters.frequency"),
      options: [...frequencyFilterOptions],
    });

    return [statusFilter, scopeFilter, frequencyFilter];
  }, [frequencyFilterOptions, scopeFilterOptions, statusFilterOptions, t]);

  const { data, isLoading, isError, error } = useAdminPlanOffersDisplayQuery({
    pagination,
    search,
    filtering,
    sorting,
  });

  const toggleMutation = useMutation({
    mutationFn: async (input: { id: string; is_enabled: boolean }) =>
      sdk.client.fetch<PlanOfferAdminDetailResponse>(
        `/admin/subscription-offers/${input.id}/toggle`,
        {
          method: "POST",
          body: {
            is_enabled: input.is_enabled,
          },
        }
      ),
    onSuccess: async (_response, variables) => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: adminPlanOffersQueryKeys.all,
        }),
        queryClient.invalidateQueries({
          queryKey: adminPlanOffersQueryKeys.detail(variables.id),
        }),
      ]);
      toast.success(
        variables.is_enabled
          ? t("planOffers.toast.enabled")
          : t("planOffers.toast.disabled")
      );
    },
    onError: (mutationError) => {
      toast.error(
        mutationError instanceof Error
          ? mutationError.message
          : t("planOffers.errors.updateFailed")
      );
    },
  });

  const pendingToggleId = toggleMutation.isPending
    ? toggleMutation.variables?.id
    : undefined;

  const selectedProduct = useMemo(() => {
    if (!productIdFilterValue || !productTitleFilterValue) {
      return null;
    }

    return {
      id: productIdFilterValue,
      title: productTitleFilterValue,
    };
  }, [productIdFilterValue, productTitleFilterValue]);

  const selectedVariant = useMemo(() => {
    if (!variantIdFilterValue || !variantTitleFilterValue) {
      return null;
    }

    return {
      id: variantIdFilterValue,
      title: variantTitleFilterValue,
    };
  }, [variantIdFilterValue, variantTitleFilterValue]);

  const handleToggle = async (planOffer: PlanOfferAdminListItem) => {
    const nextEnabled = !planOffer.is_enabled;
    const confirmed = await prompt({
      title: nextEnabled
        ? t("planOffers.prompt.enableTitle")
        : t("planOffers.prompt.disableTitle"),
      description: nextEnabled
        ? t("planOffers.prompt.enableDescription")
        : t("planOffers.prompt.disableDescription"),
      confirmText: nextEnabled
        ? t("planOffers.actions.enable")
        : t("planOffers.actions.disable"),
      cancelText: t("common.actions.cancel"),
    });

    if (!confirmed) {
      return;
    }

    await toggleMutation.mutateAsync({
      id: planOffer.id,
      is_enabled: nextEnabled,
    });
  };

  const columns = useMemo(() => {
    const baseColumns = [
      columnHelper.accessor("name", {
        header: t("planOffers.columns.name"),
        enableSorting: true,
        sortLabel: t("planOffers.columns.name"),
        cell: ({ row }) => (
          <div className="flex flex-col">
            <Text size="small" leading="compact" weight="plus">
              {row.original.name}
            </Text>
            <Text size="small" leading="compact" className="text-ui-fg-subtle">
              {row.original.id}
            </Text>
          </div>
        ),
      }),
      columnHelper.accessor("target.product_title", {
        id: "product_title",
        header: t("planOffers.columns.target"),
        enableSorting: true,
        sortLabel: t("common.fields.product"),
        cell: ({ row }) => (
          <div className="flex flex-col">
            <Text size="small" leading="compact" weight="plus">
              {row.original.target.product_title}
            </Text>
            <Text size="small" leading="compact" className="text-ui-fg-subtle">
              {row.original.target.scope === PlanOfferScope.PRODUCT
                ? t("planOffers.columns.allVariants")
                : [row.original.target.variant_title, row.original.target.sku]
                    .filter(Boolean)
                    .join(" · ")}
            </Text>
          </div>
        ),
      }),
      columnHelper.accessor("status", {
        header: t("planOffers.columns.status"),
        enableSorting: true,
        sortLabel: t("planOffers.columns.status"),
        cell: ({ getValue }) => (
          <StatusBadge
            color={
              getValue() === PlanOfferAdminStatus.ENABLED ? "green" : "grey"
            }
            className="text-nowrap"
          >
            {t(PLAN_OFFER_STATUS_KEYS[getValue()])}
          </StatusBadge>
        ),
      }),
      columnHelper.accessor("allowed_frequencies", {
        id: "frequencies",
        header: t("planOffers.columns.frequencies"),
        cell: ({ row }) => (
          <div className="flex flex-col gap-y-1">
            {row.original.allowed_frequencies.length ? (
              row.original.allowed_frequencies.slice(0, 2).map((frequency) => (
                <Text key={frequency.label} size="small" leading="compact">
                  {frequency.label}
                </Text>
              ))
            ) : (
              <Text size="small" leading="compact" className="text-ui-fg-subtle">
                {t("common.empty.noValue")}
              </Text>
            )}
            {row.original.allowed_frequencies.length > 2 ? (
              <Text size="small" leading="compact" className="text-ui-fg-subtle">
                {t("planOffers.columns.moreCount", {
                  count: row.original.allowed_frequencies.length - 2,
                })}
              </Text>
            ) : null}
          </div>
        ),
      }),
      columnHelper.accessor("effective_config_summary.source_scope", {
        id: "effective_source",
        header: t("planOffers.columns.effectiveSource"),
        cell: ({ row }) => (
          <Text size="small" leading="compact">
            {formatEffectiveSource(row.original, t)}
          </Text>
        ),
      }),
      columnHelper.accessor("updated_at", {
        header: t("planOffers.columns.updated"),
        enableSorting: true,
        sortLabel: t("planOffers.columns.updated"),
        cell: ({ getValue }) => (
          <Text size="small" leading="compact">
            {formatDateTime(getValue())}
          </Text>
        ),
      }),
    ];

    return [
      ...baseColumns,
      columnHelper.action({
        actions: ({ row }) => {
          const planOffer = row.original;
          const isPending = pendingToggleId === planOffer.id;

          return [
            [
              {
                label: t("planOffers.actions.edit"),
                icon: <PencilSquare />,
                onClick: () => {
                  setEditPlanOfferId(planOffer.id);
                  setEditDrawerOpen(true);
                },
              },
              {
                label:
                  isPending
                    ? planOffer.is_enabled
                      ? t("planOffers.actions.disabling")
                      : t("planOffers.actions.enabling")
                    : planOffer.is_enabled
                      ? t("planOffers.actions.disable")
                      : t("planOffers.actions.enable"),
                icon: planOffer.is_enabled ? <Pause /> : <CheckCircle />,
                onClick: () => {
                  if (isPending) {
                    return;
                  }

                  void handleToggle(planOffer);
                },
              },
            ],
          ];
        },
      }),
    ];
  }, [pendingToggleId, t]);

  const table = useDataTable({
    columns,
    data: data?.plan_offers || [],
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
  });

  if (isError) {
    return (
      <Container className="divide-y p-0">
        <div className="px-6 py-4">
          <div className="flex flex-col gap-y-3">
            <div className="flex items-center justify-between gap-x-4">
              <div className="flex flex-col">
                <Heading level="h1">{t("planOffers.list.title")}</Heading>
                <Text
                  size="small"
                  leading="compact"
                  className="text-ui-fg-subtle"
                >
                  {t("planOffers.list.description")}
                </Text>
              </div>
              <Button asChild size="small" variant="secondary" type="button">
                <Link to="/subscriptions">
                  {t("planOffers.list.backToSubscriptions")}
                </Link>
              </Button>
            </div>
          </div>
        </div>
        <div className="px-6 py-6">
          <Alert variant="error">
            {error instanceof Error
              ? error.message
              : t("planOffers.list.loadError")}
          </Alert>
        </div>
      </Container>
    );
  }

  const hasActiveFilters =
    Boolean(statusFilterValue) ||
    Boolean(scopeFilterValue) ||
    Boolean(frequencyFilterValue) ||
    Boolean(selectedProduct) ||
    Boolean(selectedVariant) ||
    typeof discountMinFilterValue === "number" ||
    typeof discountMaxFilterValue === "number";

  return (
    <div className="flex flex-col gap-y-4">
      <PlanOfferProductPickerModal
        open={productPickerOpen}
        onOpenChange={setProductPickerOpen}
        selectedProductId={selectedProduct?.id}
        onSelect={(product) => {
          setFiltering((current) => ({
            ...removeFilter(removeFilter(current, "variant_id"), "variant_title"),
            product_id: product.id,
            product_title: product.title,
          }));
        }}
      />
      <PlanOfferVariantPickerModal
        open={variantPickerOpen}
        onOpenChange={setVariantPickerOpen}
        productId={selectedProduct?.id}
        productTitle={selectedProduct?.title}
        selectedVariantId={selectedVariant?.id}
        onSelect={(variant) => {
          setFiltering((current) => ({
            ...current,
            variant_id: variant.id,
            variant_title: variant.title,
          }));
        }}
      />
      <CreatePlanOfferModal
        open={createModalOpen}
        onOpenChange={setCreateModalOpen}
      />
      <EditPlanOfferDrawer
        open={editDrawerOpen}
        onOpenChange={setEditDrawerOpen}
        planOfferId={editPlanOfferId}
      />

      <Container className="divide-y p-0">
        <div className="flex items-center justify-between px-6 py-4">
          <div className="flex flex-col">
            <Heading level="h1">{t("planOffers.list.title")}</Heading>
            <Text
              size="small"
              leading="compact"
              className="text-ui-fg-subtle"
            >
              {t("planOffers.list.description")}
            </Text>
          </div>
          <div className="flex items-center gap-x-2">
            <Button
              size="small"
              type="button"
              onClick={() => setCreateModalOpen(true)}
            >
              <Plus />
              {t("planOffers.actions.create")}
            </Button>
          </div>
        </div>
        <DataTable instance={table}>
          <div className="flex flex-col gap-2 px-6 py-4 md:flex-row md:items-center md:justify-between">
            <div className="flex flex-wrap items-center gap-2">
              {statusFilterValue ? (
                <FilterChip
                  label={t("planOffers.filters.status")}
                  value={t(PLAN_OFFER_STATUS_KEYS[statusFilterValue])}
                  onRemove={() => {
                    setFiltering((current) => removeFilter(current, "status"));
                  }}
                />
              ) : null}
              {scopeFilterValue ? (
                <FilterChip
                  label={t("planOffers.filters.scope")}
                  value={t(PLAN_OFFER_SCOPE_KEYS[scopeFilterValue])}
                  onRemove={() => {
                    setFiltering((current) => removeFilter(current, "scope"));
                  }}
                />
              ) : null}
              {frequencyFilterValue ? (
                <FilterChip
                  label={t("planOffers.filters.frequency")}
                  value={t(PLAN_OFFER_INTERVAL_KEYS[frequencyFilterValue])}
                  onRemove={() => {
                    setFiltering((current) => removeFilter(current, "frequency"));
                  }}
                />
              ) : null}
              {selectedProduct ? (
                <FilterChip
                  label={t("common.fields.product")}
                  value={selectedProduct.title}
                  onRemove={() => {
                    setFiltering((current) => {
                      const next = removeFilter(
                        removeFilter(
                          removeFilter(removeFilter(current, "product_id"), "product_title"),
                          "variant_id"
                        ),
                        "variant_title"
                      );

                      return next;
                    });
                  }}
                />
              ) : null}
              {selectedVariant ? (
                <FilterChip
                  label={t("common.fields.variant")}
                  value={selectedVariant.title}
                  onRemove={() => {
                    setFiltering((current) =>
                      removeFilter(removeFilter(current, "variant_id"), "variant_title")
                    );
                  }}
                />
              ) : null}
              {typeof discountMinFilterValue === "number" ||
              typeof discountMaxFilterValue === "number" ? (
                <FilterChip
                  label={t("common.fields.discount")}
                  value={formatDiscountRange(
                    t,
                    discountMinFilterValue,
                    discountMaxFilterValue
                  )}
                  onRemove={() => {
                    setFiltering((current) =>
                      removeFilter(removeFilter(current, "discount_min"), "discount_max")
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
                      {t("planOffers.filters.status")}
                    </DropdownMenu.SubMenuTrigger>
                    <DropdownMenu.SubMenuContent>
                      {statusFilterOptions.map((option) => (
                        <DropdownMenu.CheckboxItem
                          key={option.value}
                          checked={statusFilterValue === option.value}
                          onSelect={(event) => {
                            event.preventDefault();
                          }}
                          onCheckedChange={(checked) => {
                            setFiltering((current) =>
                              checked
                                ? {
                                    ...current,
                                    status: option.value,
                                  }
                                : removeFilter(current, "status")
                            );
                          }}
                        >
                          {option.label}
                        </DropdownMenu.CheckboxItem>
                      ))}
                    </DropdownMenu.SubMenuContent>
                  </DropdownMenu.SubMenu>
                  <DropdownMenu.SubMenu>
                    <DropdownMenu.SubMenuTrigger>
                      {t("planOffers.filters.scope")}
                    </DropdownMenu.SubMenuTrigger>
                    <DropdownMenu.SubMenuContent>
                      {scopeFilterOptions.map((option) => (
                        <DropdownMenu.CheckboxItem
                          key={option.value}
                          checked={scopeFilterValue === option.value}
                          onSelect={(event) => {
                            event.preventDefault();
                          }}
                          onCheckedChange={(checked) => {
                            setFiltering((current) =>
                              checked
                                ? {
                                    ...current,
                                    scope: option.value,
                                  }
                                : removeFilter(current, "scope")
                            );
                          }}
                        >
                          {option.label}
                        </DropdownMenu.CheckboxItem>
                      ))}
                    </DropdownMenu.SubMenuContent>
                  </DropdownMenu.SubMenu>
                  <DropdownMenu.SubMenu>
                    <DropdownMenu.SubMenuTrigger>
                      {t("planOffers.filters.frequency")}
                    </DropdownMenu.SubMenuTrigger>
                    <DropdownMenu.SubMenuContent>
                      {frequencyFilterOptions.map((option) => (
                        <DropdownMenu.CheckboxItem
                          key={option.value}
                          checked={frequencyFilterValue === option.value}
                          onSelect={(event) => {
                            event.preventDefault();
                          }}
                          onCheckedChange={(checked) => {
                            setFiltering((current) =>
                              checked
                                ? {
                                    ...current,
                                    frequency: option.value,
                                  }
                                : removeFilter(current, "frequency")
                            );
                          }}
                        >
                          {option.label}
                        </DropdownMenu.CheckboxItem>
                      ))}
                    </DropdownMenu.SubMenuContent>
                  </DropdownMenu.SubMenu>
                  <DropdownMenu.SubMenu>
                    <DropdownMenu.SubMenuTrigger>
                      {t("planOffers.filters.discountRange")}
                    </DropdownMenu.SubMenuTrigger>
                    <DropdownMenu.SubMenuContent>
                      {discountRangeFilterOptions.map((option) => {
                        const checked =
                          discountMinFilterValue === option.min &&
                          discountMaxFilterValue === option.max;

                        return (
                          <DropdownMenu.CheckboxItem
                            key={option.label}
                            checked={checked}
                            onSelect={(event) => {
                              event.preventDefault();
                            }}
                            onCheckedChange={(isChecked) => {
                              setFiltering((current) =>
                                isChecked
                                  ? {
                                      ...current,
                                      discount_min: option.min,
                                      discount_max: option.max,
                                    }
                                  : removeFilter(
                                      removeFilter(current, "discount_min"),
                                      "discount_max"
                                    )
                              );
                            }}
                          >
                            {option.label}
                          </DropdownMenu.CheckboxItem>
                        );
                      })}
                    </DropdownMenu.SubMenuContent>
                  </DropdownMenu.SubMenu>
                  <DropdownMenu.Separator />
                  <DropdownMenu.Item
                    onClick={() => {
                      setProductPickerOpen(true);
                    }}
                  >
                    {t("common.fields.product")}
                  </DropdownMenu.Item>
                  <DropdownMenu.Item
                    disabled={!selectedProduct}
                    onClick={() => {
                      if (!selectedProduct) {
                        return;
                      }

                      setVariantPickerOpen(true);
                    }}
                  >
                    {t("common.fields.variant")}
                  </DropdownMenu.Item>
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
                      className="group/row"
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
                  ? t("planOffers.list.emptyFiltered")
                  : t("planOffers.list.empty")}
              </Text>
              <Text size="small" leading="compact" className="text-ui-fg-subtle">
                {hasActiveFilters || search
                  ? t("planOffers.list.emptyFilteredHint")
                  : t("planOffers.list.emptyHint")}
              </Text>
            </div>
          )}
          <DataTable.Pagination />
        </DataTable>
      </Container>
    </div>
  );
};

export const config = defineRouteConfig({
  label: "menuItems.planOffers",
  translationNs: "reorder",
  rank: 1,
});

export const handle = {
  breadcrumb: () => translate("menuItems.planOffers"),
};

export default PlansOffersPage;

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

function formatDateTime(value: string | null) {
  if (!value) {
    return "-";
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function formatEffectiveSource(
  planOffer: PlanOfferAdminListItem,
  t: ReorderTranslate
) {
  const scope = planOffer.effective_config_summary.source_scope;

  if (!scope) {
    return t("planOffers.status.inactive");
  }

  return t(PLAN_OFFER_SCOPE_KEYS[scope]);
}

function formatDiscountRange(t: ReorderTranslate, min?: number, max?: number) {
  if (typeof min === "number" && typeof max === "number") {
    return `${min}-${max}`;
  }

  if (typeof min === "number") {
    return `${min}+`;
  }

  if (typeof max === "number") {
    return t("planOffers.filters.discountRangeUpTo", { max });
  }

  return t("common.empty.noValue");
}
