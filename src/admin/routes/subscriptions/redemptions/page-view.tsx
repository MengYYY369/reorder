import {
  Alert,
  Button,
  Container,
  createDataTableColumnHelper,
  DataTable,
  DataTablePaginationState,
  DataTableSortingState,
  Heading,
  StatusBadge,
  Text,
  useDataTable,
} from "@medusajs/ui";
import { useQueryClient } from "@tanstack/react-query";
import { flexRender } from "@tanstack/react-table";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import {
  RedemptionBatchStatus,
  RedemptionFrequencyInterval,
} from "../../../types/redemption";
import {
  adminRedemptionsQueryKeys,
  useAdminRedemptionBatchesDisplayQuery,
} from "./data-loading";
import { CreateBatchModal } from "./components/create-batch-modal";

const PAGE_SIZE = 20;

const columnHelper = createDataTableColumnHelper<{
  id: string;
  name: string;
  status: RedemptionBatchStatus;
  free_cycles: number;
  frequency_interval: RedemptionFrequencyInterval;
  frequency_value: number;
  code_count: number;
  total_redemptions: number;
}>();

export const TicketsRedemptionPage = () => {
  const { t } = useTranslation("reorder");
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [sorting, setSorting] = useState<DataTableSortingState | null>({
    id: "created_at",
    desc: true,
  });
  const [pagination, setPagination] = useState<DataTablePaginationState>({
    pageIndex: 0,
    pageSize: PAGE_SIZE,
  });
  const [createModalOpen, setCreateModalOpen] = useState(false);

  const { data, isLoading, isError, error } =
    useAdminRedemptionBatchesDisplayQuery({
      pagination,
      search,
      sorting,
    });

  const columns = useMemo(
    () => [
      columnHelper.accessor("name", {
        header: t("redemptions.columns.name"),
        enableSorting: true,
        cell: ({ row }) => (
          <Link
            to={`/subscriptions/redemptions/${row.original.id}`}
            className="text-ui-fg-base hover:text-ui-fg-subtle"
          >
            <Text size="small" leading="compact" weight="plus">
              {row.original.name}
            </Text>
          </Link>
        ),
      }),
      columnHelper.accessor("status", {
        header: t("redemptions.columns.status"),
        cell: ({ getValue }) => (
          <StatusBadge color={getValue() === RedemptionBatchStatus.ACTIVE ? "green" : "grey"}>
            {t(
              getValue() === RedemptionBatchStatus.ACTIVE
                ? "redemptions.status.active"
                : "redemptions.status.disabled"
            )}
          </StatusBadge>
        ),
      }),
      columnHelper.accessor("free_cycles", {
        header: t("redemptions.columns.grant"),
        cell: ({ row }) => (
          <Text size="small" leading="compact">
            {t("redemptions.columns.grantValue", {
              cycles: row.original.free_cycles,
              interval: t(
                `common.intervals.${row.original.frequency_interval}`
              ),
              value: row.original.frequency_value,
            })}
          </Text>
        ),
      }),
      columnHelper.accessor("code_count", {
        header: t("redemptions.columns.codes"),
        cell: ({ getValue }) => (
          <Text size="small" leading="compact">
            {getValue()}
          </Text>
        ),
      }),
      columnHelper.accessor("total_redemptions", {
        header: t("redemptions.columns.redemptions"),
        cell: ({ getValue }) => (
          <Text size="small" leading="compact">
            {getValue()}
          </Text>
        ),
      }),
    ],
    [t]
  );

  const table = useDataTable({
    columns,
    data: data?.redemption_batches ?? [],
    getRowId: (row) => row.id,
    rowCount: data?.count ?? 0,
    isLoading,
    sorting,
    onSortingChange: setSorting,
    pagination: {
      state: pagination,
      onPaginationChange: setPagination,
    },
    search: "onSearchChange" as never,
  });

  void queryClient;

  return (
    <div className="flex flex-col gap-y-4">
      <CreateBatchModal open={createModalOpen} onOpenChange={setCreateModalOpen} />

      <Container className="divide-y p-0">
        <div className="flex items-center justify-between px-6 py-4">
          <div className="flex flex-col">
            <Heading level="h1">{t("redemptions.list.title")}</Heading>
            <Text size="small" leading="compact" className="text-ui-fg-subtle">
              {t("redemptions.list.description")}
            </Text>
          </div>
          <div className="flex items-center gap-x-2">
            <Button size="small" type="button" onClick={() => setCreateModalOpen(true)}>
              {t("redemptions.actions.create")}
            </Button>
          </div>
        </div>
        <DataTable instance={table}>
          <DataTable.Search
            placeholder={t("common.actions.search")}
            onChange={(event) => setSearch(event.target.value)}
          />
          {table.getRowModel().rows.length ? (
            <div className="overflow-x-auto border-y">
              <table className="w-full">
                <thead>
                  {table.getHeaderGroups().map((headerGroup) => (
                    <tr key={headerGroup.id} className="border-b">
                      {headerGroup.headers.map((header) => (
                        <th key={header.id} className="px-6 py-3 text-left">
                          {header.isPlaceholder
                            ? null
                            : flexRender(
                                header.column.columnDef.header,
                                header.getContext()
                              )}
                        </th>
                      ))}
                    </tr>
                  ))}
                </thead>
                <tbody>
                  {table.getRowModel().rows.map((row) => (
                    <tr key={row.id} className="border-b last:border-b-0">
                      {row.getVisibleCells().map((cell) => (
                        <td key={cell.id} className="px-6 py-3">
                          {flexRender(cell.column.columnDef.cell, cell.getContext())}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="flex min-h-[250px] w-full flex-col items-center justify-center border-y px-6 py-4 text-center">
              <Text size="base" weight="plus">
                {t("redemptions.list.empty")}
              </Text>
              <Text size="small" leading="compact" className="text-ui-fg-subtle">
                {t("redemptions.list.emptyHint")}
              </Text>
            </div>
          )}
          <DataTable.Pagination />
        </DataTable>
      </Container>
    </div>
  );
};

export const RedemptionsErrorAlert = ({
  message,
}: {
  message?: string | null;
}) => {
  return (
    <Container className="divide-y p-0">
      <div className="px-6 py-4">
        <Alert variant="error" dismissible>
          {message ?? "error"}
        </Alert>
      </div>
    </Container>
  );
};
