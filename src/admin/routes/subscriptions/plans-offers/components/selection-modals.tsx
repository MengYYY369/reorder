import { HttpTypes } from "@medusajs/framework/types"
import {
  Button,
  DataTable,
  DataTablePaginationState,
  DataTableRowSelectionState,
  FocusModal,
  Heading,
  Text,
  createDataTableColumnHelper,
  useDataTable,
} from "@medusajs/ui"
import { useEffect, useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import {
  useAdminProductsSelectionQuery,
  useAdminProductVariantsSelectionQuery,
} from "../data-loading"

type ProductPickerModalProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  selectedProductId?: string | null
  onSelect: (product: HttpTypes.AdminProduct) => void
}

type VariantPickerModalProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  productId?: string | null
  productTitle?: string | null
  selectedVariantId?: string | null
  onSelect: (variant: HttpTypes.AdminProductVariant) => void
}

export const PlanOfferProductPickerModal = ({
  open,
  onOpenChange,
  selectedProductId,
  onSelect,
}: ProductPickerModalProps) => {
  const { t } = useTranslation("reorder")
  const [search, setSearch] = useState("")
  const [pagination, setPagination] = useState<DataTablePaginationState>({
    pageIndex: 0,
    pageSize: 10,
  })
  const [rowSelection, setRowSelection] = useState<DataTableRowSelectionState>(
    selectedProductId ? { [selectedProductId]: true } : {}
  )

  useEffect(() => {
    setRowSelection(selectedProductId ? { [selectedProductId]: true } : {})
  }, [selectedProductId, open])

  const { data, isLoading } = useAdminProductsSelectionQuery({
    open,
    pagination,
    search,
  })

  const selectedRowId = Object.keys(rowSelection).find((key) => rowSelection[key])
  const selectedProduct = useMemo(
    () => data?.products?.find((product) => product.id === selectedRowId) || null,
    [data?.products, selectedRowId]
  )

  const columnHelper = createDataTableColumnHelper<HttpTypes.AdminProduct>()

  const table = useDataTable({
    columns: [
      columnHelper.select(),
      columnHelper.accessor("title", {
        header: t("common.fields.product"),
      }),
      columnHelper.accessor("id", {
        header: t("common.fields.id"),
        cell: ({ getValue }) => (
          <Text size="small" leading="compact" className="text-ui-fg-subtle">
            {getValue()}
          </Text>
        ),
      }),
    ],
    data: data?.products || [],
    getRowId: (row) => row.id,
    rowCount: data?.count || 0,
    isLoading,
    rowSelection: {
      state: rowSelection,
      onRowSelectionChange: (nextState) => {
        const firstSelectedId = Object.keys(nextState).find(
          (key) => nextState[key]
        )

        setRowSelection(firstSelectedId ? { [firstSelectedId]: true } : {})
      },
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

  return (
    <FocusModal open={open} onOpenChange={onOpenChange}>
      <FocusModal.Content>
        <div className="flex h-full flex-col overflow-hidden">
          <FocusModal.Header />
          <FocusModal.Body className="flex items-start justify-center">
            <div className="w-full max-w-4xl">
              <div className="flex flex-col gap-y-4">
                <div className="flex flex-col gap-y-1">
                  <Heading level="h2">{t("planOffers.pickers.selectProduct")}</Heading>
                  <Text
                    size="small"
                    leading="compact"
                    className="text-ui-fg-subtle"
                  >
                    {t("planOffers.pickers.selectProductHint")}
                  </Text>
                </div>
                <DataTable instance={table}>
                  <div className="flex items-center justify-end px-6 py-4">
                    <div className="w-full md:w-auto">
                      <DataTable.Search placeholder={t("common.placeholders.searchProducts")} />
                    </div>
                  </div>
                  <DataTable.Table />
                  <DataTable.Pagination />
                </DataTable>
              </div>
            </div>
          </FocusModal.Body>
          <FocusModal.Footer>
            <div className="flex items-center justify-end gap-x-2">
              <FocusModal.Close asChild>
                <Button size="small" variant="secondary">
                  {t("common.actions.cancel")}
                </Button>
              </FocusModal.Close>
              <Button
                size="small"
                disabled={!selectedProduct}
                onClick={() => {
                  if (!selectedProduct) {
                    return
                  }

                  onSelect(selectedProduct)
                  onOpenChange(false)
                }}
              >
                {t("common.actions.apply")}
              </Button>
            </div>
          </FocusModal.Footer>
        </div>
      </FocusModal.Content>
    </FocusModal>
  )
}

export const PlanOfferVariantPickerModal = ({
  open,
  onOpenChange,
  productId,
  productTitle,
  selectedVariantId,
  onSelect,
}: VariantPickerModalProps) => {
  const { t } = useTranslation("reorder")
  const [rowSelection, setRowSelection] = useState<DataTableRowSelectionState>(
    selectedVariantId ? { [selectedVariantId]: true } : {}
  )

  useEffect(() => {
    setRowSelection(selectedVariantId ? { [selectedVariantId]: true } : {})
  }, [selectedVariantId, open])

  const { data, isLoading } = useAdminProductVariantsSelectionQuery(
    productId ?? undefined,
    open
  )

  const selectedRowId = Object.keys(rowSelection).find((key) => rowSelection[key])
  const selectedVariant = useMemo(
    () => data?.variants?.find((variant) => variant.id === selectedRowId) || null,
    [data?.variants, selectedRowId]
  )

  const columnHelper =
    createDataTableColumnHelper<HttpTypes.AdminProductVariant>()

  const table = useDataTable({
    columns: [
      columnHelper.select(),
      columnHelper.accessor("title", {
        header: t("common.fields.variant"),
        cell: ({ row }) => (
          <div className="flex flex-col">
            <Text size="small" leading="compact" weight="plus">
              {row.original.title}
            </Text>
            <Text size="small" leading="compact" className="text-ui-fg-subtle">
              {row.original.sku || t("common.empty.noValue")}
            </Text>
          </div>
        ),
      }),
    ],
    data: data?.variants || [],
    getRowId: (row) => row.id,
    rowCount: data?.variants?.length || 0,
    isLoading,
    rowSelection: {
      state: rowSelection,
      onRowSelectionChange: (nextState) => {
        const firstSelectedId = Object.keys(nextState).find(
          (key) => nextState[key]
        )

        setRowSelection(firstSelectedId ? { [firstSelectedId]: true } : {})
      },
    },
  })

  return (
    <FocusModal open={open} onOpenChange={onOpenChange}>
      <FocusModal.Content>
        <div className="flex h-full flex-col overflow-hidden">
          <FocusModal.Header />
          <FocusModal.Body className="flex items-start justify-center">
            <div className="w-full max-w-3xl">
              <div className="flex flex-col gap-y-4">
                <div className="flex flex-col gap-y-1">
                  <Heading level="h2">{t("planOffers.pickers.selectVariant")}</Heading>
                  <Text
                    size="small"
                    leading="compact"
                    className="text-ui-fg-subtle"
                  >
                    {productTitle
                      ? t("planOffers.pickers.selectVariantHint", { productTitle })
                      : t("planOffers.pickers.selectProductFirst")}
                  </Text>
                </div>
                <DataTable instance={table}>
                  <DataTable.Table />
                </DataTable>
              </div>
            </div>
          </FocusModal.Body>
          <FocusModal.Footer>
            <div className="flex items-center justify-end gap-x-2">
              <FocusModal.Close asChild>
                <Button size="small" variant="secondary">
                  {t("common.actions.cancel")}
                </Button>
              </FocusModal.Close>
              <Button
                size="small"
                disabled={!selectedVariant}
                onClick={() => {
                  if (!selectedVariant) {
                    return
                  }

                  onSelect(selectedVariant)
                  onOpenChange(false)
                }}
              >
                {t("common.actions.apply")}
              </Button>
            </div>
          </FocusModal.Footer>
        </div>
      </FocusModal.Content>
    </FocusModal>
  )
}
