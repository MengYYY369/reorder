import {
  Alert,
  Badge,
  Button,
  Container,
  Heading,
  StatusBadge,
  Table,
  Text,
  toast,
  usePrompt,
} from "@medusajs/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { sdk } from "../../../../lib/client";
import {
  AdminRedemptionCodeSummary,
  RedemptionBatchStatus,
  RedemptionCodeStatus,
} from "../../../../types/redemption";
import { adminRedemptionsQueryKeys, useAdminRedemptionBatchDetailQuery } from "../data-loading";

type AdminRedemptionRecord = {
  id: string;
  batch_id: string;
  code_id: string;
  customer_id: string;
  subscription_id: string;
  outcome: string;
  free_cycles_applied: number;
  frequency_interval: string;
  frequency_value: number;
  created_at: string;
};

function useBatchRecordsQuery(batchId: string) {
  return useQuery<{ redemption_records: AdminRedemptionRecord[]; count: number }>({
    queryKey: [...adminRedemptionsQueryKeys.all, "records", batchId],
    queryFn: () =>
      sdk.client.fetch(`/admin/redemptions/batches/${batchId}/records`),
    enabled: Boolean(batchId),
  });
}

function formatDateTime(value: string | null) {
  if (!value) {
    return null;
  }
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

export const RedemptionBatchDetailPageView = ({
  id,
}: {
  id: string;
}) => {
  const { t } = useTranslation("reorder");
  const queryClient = useQueryClient();
  const prompt = usePrompt();

  const {
    data,
    isLoading,
    isError,
    error,
  } = useAdminRedemptionBatchDetailQuery(id);

  const recordsQuery = useBatchRecordsQuery(id);

  const disableBatchMutation = useMutation({
    mutationFn: async () =>
      sdk.client.fetch(`/admin/redemptions/batches/${id}/disable`, {
        method: "POST",
        body: {},
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: adminRedemptionsQueryKeys.all,
      });
      toast.success(t("redemptions.toast.batchDisabled"));
    },
    onError: (mutationError) => {
      toast.error(
        mutationError instanceof Error
          ? mutationError.message
          : t("redemptions.errors.disableFailed")
      );
    },
  });

  const disableCodeMutation = useMutation({
    mutationFn: async (codeId: string) =>
      sdk.client.fetch(`/admin/redemptions/codes/${codeId}/disable`, {
        method: "POST",
        body: {},
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: adminRedemptionsQueryKeys.all,
      });
      toast.success(t("redemptions.toast.codeDisabled"));
    },
    onError: (mutationError) => {
      toast.error(
        mutationError instanceof Error
          ? mutationError.message
          : t("redemptions.errors.disableFailed")
      );
    },
  });

  if (isLoading) {
    return (
      <Container className="divide-y p-0">
        <div className="flex min-h-[200px] items-center justify-center">
          <Text size="small" className="text-ui-fg-subtle">
            {t("redemptions.detail.loading")}
          </Text>
        </div>
      </Container>
    );
  }

  if (isError || !data) {
    return (
      <Container className="divide-y p-0">
        <div className="px-6 py-4">
          <Alert variant="error" dismissible>
            {error instanceof Error ? error.message : t("redemptions.list.loadError")}
          </Alert>
        </div>
      </Container>
    );
  }

  const batch = data.redemption_batch;

  const handleDisableBatch = async () => {
    const confirmed = await prompt({
      title: t("redemptions.prompt.disableBatchTitle"),
      description: t("redemptions.prompt.disableBatchDescription"),
      confirmText: t("redemptions.actions.disable"),
      cancelText: t("common.actions.cancel"),
    });

    if (!confirmed) {
      return;
    }

    await disableBatchMutation.mutateAsync();
  };

  const handleDisableCode = async (code: AdminRedemptionCodeSummary) => {
    const confirmed = await prompt({
      title: t("redemptions.prompt.disableCodeTitle"),
      description: t("redemptions.prompt.disableCodeDescription", {
        code: code.code,
      }),
      confirmText: t("redemptions.actions.disable"),
      cancelText: t("common.actions.cancel"),
    });

    if (!confirmed) {
      return;
    }

    await disableCodeMutation.mutateAsync(code.id);
  };

  return (
    <div className="flex flex-col gap-y-4">
      <Container className="divide-y p-0">
        <div className="flex items-center justify-between px-6 py-4">
          <div className="flex flex-col gap-y-1">
            <div className="flex items-center gap-x-3">
              <Heading level="h1">{batch.name}</Heading>
              <StatusBadge
                color={batch.status === RedemptionBatchStatus.ACTIVE ? "green" : "grey"}
              >
                {t(
                  batch.status === RedemptionBatchStatus.ACTIVE
                    ? "redemptions.status.active"
                    : "redemptions.status.disabled"
                )}
              </StatusBadge>
            </div>
            <Text size="small" leading="compact" className="text-ui-fg-subtle">
              {t("redemptions.detail.variantId", { variantId: batch.variant_id })}
            </Text>
          </div>
          {batch.status === RedemptionBatchStatus.ACTIVE ? (
            <Button
              size="small"
              variant="danger"
              type="button"
              isLoading={disableBatchMutation.isPending}
              onClick={handleDisableBatch}
            >
              {t("redemptions.actions.disableBatch")}
            </Button>
          ) : null}
        </div>

        <div className="grid grid-cols-2 gap-4 px-6 py-4 md:grid-cols-4">
          <div className="flex flex-col gap-y-1">
            <Text size="small" className="text-ui-fg-subtle">
              {t("redemptions.fields.freeCycles")}
            </Text>
            <Text size="small" weight="plus">
              {batch.free_cycles}
            </Text>
          </div>
          <div className="flex flex-col gap-y-1">
            <Text size="small" className="text-ui-fg-subtle">
              {t("redemptions.columns.frequency")}
            </Text>
            <Text size="small" weight="plus">
              {t("common.intervals." + batch.frequency_interval)} / {batch.frequency_value}
            </Text>
          </div>
          <div className="flex flex-col gap-y-1">
            <Text size="small" className="text-ui-fg-subtle">
              {t("redemptions.fields.maxRedemptionsPerCode")}
            </Text>
            <Text size="small" weight="plus">
              {batch.max_redemptions_per_code}
            </Text>
          </div>
          <div className="flex flex-col gap-y-1">
            <Text size="small" className="text-ui-fg-subtle">
              {t("redemptions.fields.validityWindow")}
            </Text>
            <Text size="small" weight="plus">
              {batch.starts_at || batch.expires_at
                ? [
                    formatDateTime(batch.starts_at) ?? "—",
                    formatDateTime(batch.expires_at) ?? "—",
                  ].join(" → ")
                : t("redemptions.detail.noWindow")}
            </Text>
          </div>
        </div>
      </Container>

      <Container className="divide-y p-0">
        <div className="flex items-center justify-between px-6 py-4">
          <div className="flex flex-col">
            <Heading level="h2">{t("redemptions.codes.title")}</Heading>
            <Text size="small" leading="compact" className="text-ui-fg-subtle">
              {t("redemptions.codes.description", { count: data.codes.length })}
            </Text>
          </div>
        </div>
        <Table>
          <Table.Header>
            <Table.Row>
              <Table.HeaderCell>{t("redemptions.codes.code")}</Table.HeaderCell>
              <Table.HeaderCell>{t("redemptions.codes.status")}</Table.HeaderCell>
              <Table.HeaderCell>{t("redemptions.codes.usage")}</Table.HeaderCell>
              <Table.HeaderCell>{t("redemptions.codes.created")}</Table.HeaderCell>
              <Table.HeaderCell />
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {data.codes.map((code) => (
              <Table.Row key={code.id}>
                <Table.Cell>
                  <Badge size="2xsmall" color="grey">
                    {code.code}
                  </Badge>
                </Table.Cell>
                <Table.Cell>
                  <StatusBadge
                    color={code.status === RedemptionCodeStatus.ACTIVE ? "green" : "grey"}
                  >
                    {t(
                      code.status === RedemptionCodeStatus.ACTIVE
                        ? "redemptions.status.active"
                        : "redemptions.status.disabled"
                    )}
                  </StatusBadge>
                </Table.Cell>
                <Table.Cell>
                  {code.redemption_count} / {code.max_redemptions}
                </Table.Cell>
                <Table.Cell>{formatDateTime(code.created_at)}</Table.Cell>
                <Table.Cell>
                  {code.status === RedemptionCodeStatus.ACTIVE ? (
                    <Button
                      size="small"
                      variant="danger"
                      type="button"
                      isLoading={
                        disableCodeMutation.isPending &&
                        disableCodeMutation.variables === code.id
                      }
                      onClick={() => handleDisableCode(code)}
                    >
                      {t("redemptions.actions.disableCode")}
                    </Button>
                  ) : null}
                </Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table>
      </Container>

      <Container className="divide-y p-0">
        <div className="flex items-center justify-between px-6 py-4">
          <div className="flex flex-col">
            <Heading level="h2">{t("redemptions.records.title")}</Heading>
            <Text size="small" leading="compact" className="text-ui-fg-subtle">
              {t("redemptions.records.description", {
                count: recordsQuery.data?.count ?? 0,
              })}
            </Text>
          </div>
        </div>
        <Table>
          <Table.Header>
            <Table.Row>
              <Table.HeaderCell>{t("redemptions.records.customer")}</Table.HeaderCell>
              <Table.HeaderCell>{t("redemptions.records.outcome")}</Table.HeaderCell>
              <Table.HeaderCell>{t("redemptions.records.freeCycles")}</Table.HeaderCell>
              <Table.HeaderCell>{t("redemptions.records.subscription")}</Table.HeaderCell>
              <Table.HeaderCell>{t("redemptions.records.redeemedAt")}</Table.HeaderCell>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {(recordsQuery.data?.redemption_records ?? []).map((record) => (
              <Table.Row key={record.id}>
                <Table.Cell>
                  <Text size="small" leading="compact" className="font-mono">
                    {record.customer_id}
                  </Text>
                </Table.Cell>
                <Table.Cell>
                  <Badge size="2xsmall" color={record.outcome === "subscription_created" ? "blue" : "green"}>
                    {t(
                      record.outcome === "subscription_created"
                        ? "redemptions.records.outcomeCreated"
                        : "redemptions.records.outcomeExtended"
                    )}
                  </Badge>
                </Table.Cell>
                <Table.Cell>{record.free_cycles_applied}</Table.Cell>
                <Table.Cell>
                  <Text size="small" leading="compact" className="font-mono">
                    {record.subscription_id}
                  </Text>
                </Table.Cell>
                <Table.Cell>{formatDateTime(record.created_at)}</Table.Cell>
              </Table.Row>
            ))}
            {recordsQuery.data?.redemption_records?.length ? null : (
              <Table.Row>
                <Table.Cell colSpan={5}>
                  <Text size="small" className="text-ui-fg-subtle">
                    {t("redemptions.records.empty")}
                  </Text>
                </Table.Cell>
              </Table.Row>
            )}
          </Table.Body>
        </Table>
      </Container>
    </div>
  );
};
