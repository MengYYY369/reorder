import {
  DataTablePaginationState,
  DataTableSortingState,
} from "@medusajs/ui";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { sdk } from "../../../lib/client";
import {
  AdminRedemptionBatchDetailResponse,
  AdminRedemptionBatchListResponse,
  RedemptionBatchStatus,
} from "../../../types/redemption";

type UseAdminRedemptionBatchesDisplayQueryInput = {
  pagination: DataTablePaginationState;
  search: string;
  status?: RedemptionBatchStatus;
  sorting: DataTableSortingState | null;
};

export const adminRedemptionsQueryKeys = {
  all: ["admin-redemption-batches"] as const,
  detail: (id: string) =>
    [...adminRedemptionsQueryKeys.all, "detail", id] as const,
  display: (params: {
    pageSize: number;
    offset: number;
    search: string;
    status?: RedemptionBatchStatus;
    sortingId?: string;
    sortingDesc?: boolean;
  }) =>
    [
      ...adminRedemptionsQueryKeys.all,
      "display",
      params.pageSize,
      params.offset,
      params.search,
      params.status,
      params.sortingId,
      params.sortingDesc,
    ] as const,
};

export function useAdminRedemptionBatchesDisplayQuery(
  input: UseAdminRedemptionBatchesDisplayQueryInput
) {
  const offset = input.pagination.pageIndex * input.pagination.pageSize;

  return useQuery<AdminRedemptionBatchListResponse>({
    queryKey: adminRedemptionsQueryKeys.display({
      pageSize: input.pagination.pageSize,
      offset,
      search: input.search,
      status: input.status,
      sortingId: input.sorting?.id,
      sortingDesc: input.sorting?.desc,
    }),
    queryFn: () =>
      sdk.client.fetch("/admin/redemptions/batches", {
        query: {
          limit: input.pagination.pageSize,
          offset,
          q: input.search || undefined,
          status: input.status,
          order: input.sorting?.id,
          direction:
            input.sorting && typeof input.sorting.desc === "boolean"
              ? input.sorting.desc
                ? "desc"
                : "asc"
              : undefined,
        },
      }),
    placeholderData: keepPreviousData,
  });
}

export function useAdminRedemptionBatchDetailQuery(id?: string) {
  return useQuery<AdminRedemptionBatchDetailResponse>({
    queryKey: adminRedemptionsQueryKeys.detail(id ?? ""),
    queryFn: () => sdk.client.fetch(`/admin/redemptions/batches/${id}`),
    enabled: Boolean(id),
  });
}
