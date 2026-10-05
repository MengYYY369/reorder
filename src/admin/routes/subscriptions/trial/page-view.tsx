import { Beaker } from "@medusajs/icons"
import {
  Alert,
  Button,
  Container,
  Heading,
  StatusBadge,
  Table,
  Text,
  toast,
  usePrompt,
} from "@medusajs/ui"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useTranslation } from "react-i18next"
import { Link } from "react-router-dom"
import { sdk } from "../../../lib/client"
import {
  SubscriptionAdminListResponse,
  SubscriptionAdminStatus,
} from "../../../types/subscription"

type AdminTrialClaimListItem = {
  id: string
  customer_id: string
  product_id: string
  variant_id: string
  claimed_at: string
  trial_ends_at: string | null
  source: string
  subscription_id: string
  binding_method: string
}

type AdminTrialClaimListResponse = {
  trial_claims: AdminTrialClaimListItem[]
  count: number
  limit: number
  offset: number
}

const TRIAL_CLAIM_SOURCES = ["self_service", "redemption", "admin"] as const

const SUBSCRIPTION_STATUS_KEYS: Record<string, string> = {
  [SubscriptionAdminStatus.ACTIVE]: "subscriptions.status.active",
  [SubscriptionAdminStatus.PAUSED]: "subscriptions.status.paused",
  [SubscriptionAdminStatus.CANCELLED]: "subscriptions.status.cancelled",
  [SubscriptionAdminStatus.PAST_DUE]: "subscriptions.status.pastDue",
}

function formatDateTime(value: string | null) {
  if (!value) {
    return null
  }
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value))
}

function getStatusColor(status: string): "green" | "orange" | "grey" | "red" {
  switch (status) {
    case "active":
      return "green"
    case "paused":
      return "orange"
    case "cancelled":
      return "grey"
    default:
      return "red"
  }
}

const PAGE_SIZE = 20

export const TrialPageView = () => {
  const { t } = useTranslation("reorder")
  const queryClient = useQueryClient()
  const prompt = usePrompt()

  const claimsQuery = useQuery({
    queryKey: ["admin-trial-claims", "list"],
    queryFn: () =>
      sdk.client.fetch<AdminTrialClaimListResponse>(
        `/admin/trial-claims?limit=${PAGE_SIZE}&offset=0&direction=desc`
      ),
  })

  const trialSubscriptionsQuery = useQuery({
    queryKey: ["admin-subscriptions", "trial-list"],
    queryFn: () =>
      sdk.client.fetch<SubscriptionAdminListResponse>(
        `/admin/subscriptions?is_trial=true&limit=${PAGE_SIZE}&offset=0`
      ),
  })

  const deleteClaimMutation = useMutation({
    mutationFn: async (claimId: string) =>
      sdk.client.fetch(`/admin/trial-claims/${claimId}/delete`, {
        method: "POST",
        body: {},
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: ["admin-trial-claims"],
      })
      toast.success(t("trial.toast.claimDeleted"))
    },
    onError: (mutationError) => {
      toast.error(
        mutationError instanceof Error
          ? mutationError.message
          : t("trial.errors.deleteFailed")
      )
    },
  })

  const cancelSubscriptionMutation = useMutation({
    mutationFn: async (subscriptionId: string) =>
      sdk.client.fetch(`/admin/subscriptions/${subscriptionId}/cancel`, {
        method: "POST",
        body: {},
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: ["admin-subscriptions"],
      })
      toast.success(t("trial.toast.subscriptionCancelled"))
    },
    onError: (mutationError) => {
      toast.error(
        mutationError instanceof Error
          ? mutationError.message
          : t("trial.errors.cancelFailed")
      )
    },
  })

  const handleDeleteClaim = async (claim: AdminTrialClaimListItem) => {
    const confirmed = await prompt({
      title: t("trial.claims.confirmDeleteTitle"),
      description: t("trial.claims.confirmDeleteDescription"),
      confirmText: t("trial.claims.delete"),
      cancelText: t("common.actions.cancel"),
    })

    if (!confirmed) {
      return
    }

    await deleteClaimMutation.mutateAsync(claim.id)
  }

  const handleCancelSubscription = async (subscriptionId: string) => {
    const confirmed = await prompt({
      title: t("trial.subscriptions.confirmCancelTitle"),
      description: t("trial.subscriptions.confirmCancelDescription"),
      confirmText: t("trial.subscriptions.cancel"),
      cancelText: t("common.actions.cancel"),
    })

    if (!confirmed) {
      return
    }

    await cancelSubscriptionMutation.mutateAsync(subscriptionId)
  }

  const claims = claimsQuery.data?.trial_claims ?? []
  const trialSubscriptions =
    trialSubscriptionsQuery.data?.subscriptions.filter(
      (subscription) => subscription.trial.is_trial
    ) ?? []

  const renderSource = (source: string) => {
    return (TRIAL_CLAIM_SOURCES as readonly string[]).includes(source)
      ? t(`trial.source.${source}`)
      : source
  }

  return (
    <div className="flex flex-col gap-y-4">
      <Container className="divide-y p-0">
        <div className="flex items-center gap-x-3 px-6 py-4">
          <Beaker className="text-ui-fg-subtle" />
          <div className="flex flex-col gap-y-1">
            <Heading level="h1">{t("trial.list.title")}</Heading>
            <Text size="small" leading="compact" className="text-ui-fg-subtle">
              {t("trial.list.description")}
            </Text>
          </div>
        </div>
      </Container>

      <Container className="divide-y p-0">
        <div className="flex items-center justify-between px-6 py-4">
          <div className="flex flex-col">
            <Heading level="h2">{t("trial.claims.title")}</Heading>
            <Text size="small" leading="compact" className="text-ui-fg-subtle">
              {t("trial.claims.description", {
                count: claimsQuery.data?.count ?? 0,
              })}
            </Text>
          </div>
        </div>
        {claimsQuery.isError ? (
          <div className="px-6 py-4">
            <Alert variant="error" dismissible>
              {claimsQuery.error instanceof Error
                ? claimsQuery.error.message
                : t("trial.list.loadError")}
            </Alert>
          </div>
        ) : claimsQuery.isLoading ? (
          <div className="flex min-h-[120px] items-center justify-center">
            <Text size="small" className="text-ui-fg-subtle">
              {t("trial.claims.loading")}
            </Text>
          </div>
        ) : claims.length === 0 ? (
          <div className="flex min-h-[120px] flex-col items-center justify-center px-6 py-4 text-center">
            <Text size="small" weight="plus">
              {t("trial.claims.empty")}
            </Text>
            <Text size="small" leading="compact" className="text-ui-fg-subtle">
              {t("trial.claims.emptyHint")}
            </Text>
          </div>
        ) : (
          <Table>
            <Table.Header>
              <Table.Row>
                <Table.HeaderCell>{t("trial.columns.customer")}</Table.HeaderCell>
                <Table.HeaderCell>{t("trial.columns.product")}</Table.HeaderCell>
                <Table.HeaderCell>{t("trial.columns.claimedAt")}</Table.HeaderCell>
                <Table.HeaderCell>{t("trial.columns.trialEndsAt")}</Table.HeaderCell>
                <Table.HeaderCell>{t("trial.columns.source")}</Table.HeaderCell>
                <Table.HeaderCell>{t("trial.columns.bindingMethod")}</Table.HeaderCell>
                <Table.HeaderCell>{t("trial.columns.subscription")}</Table.HeaderCell>
                <Table.HeaderCell />
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {claims.map((claim) => (
                <Table.Row key={claim.id}>
                  <Table.Cell>
                    <Text size="small" leading="compact" family="mono">
                      {claim.customer_id}
                    </Text>
                  </Table.Cell>
                  <Table.Cell>
                    <Text size="small" leading="compact" family="mono">
                      {claim.product_id}
                    </Text>
                  </Table.Cell>
                  <Table.Cell>{formatDateTime(claim.claimed_at)}</Table.Cell>
                  <Table.Cell>
                    {formatDateTime(claim.trial_ends_at) ??
                      t("common.empty.noValue")}
                  </Table.Cell>
                  <Table.Cell>{renderSource(claim.source)}</Table.Cell>
                  <Table.Cell>
                    {t(`trial.bindingMethod.${claim.binding_method}`)}
                  </Table.Cell>
                  <Table.Cell>
                    <Link to={`/subscriptions/${claim.subscription_id}`}>
                      {t("trial.claims.viewSubscription")}
                    </Link>
                  </Table.Cell>
                  <Table.Cell>
                    <Button
                      size="small"
                      variant="danger"
                      type="button"
                      isLoading={
                        deleteClaimMutation.isPending &&
                        deleteClaimMutation.variables === claim.id
                      }
                      onClick={() => {
                        void handleDeleteClaim(claim)
                      }}
                    >
                      {t("trial.claims.delete")}
                    </Button>
                  </Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table>
        )}
      </Container>

      <Container className="divide-y p-0">
        <div className="flex items-center justify-between px-6 py-4">
          <div className="flex flex-col">
            <Heading level="h2">{t("trial.subscriptions.title")}</Heading>
            <Text size="small" leading="compact" className="text-ui-fg-subtle">
              {t("trial.subscriptions.description", {
                count: trialSubscriptionsQuery.data?.count ?? 0,
              })}
            </Text>
          </div>
        </div>
        {trialSubscriptionsQuery.isError ? (
          <div className="px-6 py-4">
            <Alert variant="error" dismissible>
              {trialSubscriptionsQuery.error instanceof Error
                ? trialSubscriptionsQuery.error.message
                : t("trial.list.loadError")}
            </Alert>
          </div>
        ) : trialSubscriptionsQuery.isLoading ? (
          <div className="flex min-h-[120px] items-center justify-center">
            <Text size="small" className="text-ui-fg-subtle">
              {t("trial.subscriptions.loading")}
            </Text>
          </div>
        ) : trialSubscriptions.length === 0 ? (
          <div className="flex min-h-[120px] flex-col items-center justify-center px-6 py-4 text-center">
            <Text size="small" weight="plus">
              {t("trial.subscriptions.empty")}
            </Text>
            <Text size="small" leading="compact" className="text-ui-fg-subtle">
              {t("trial.subscriptions.emptyHint")}
            </Text>
          </div>
        ) : (
          <Table>
            <Table.Header>
              <Table.Row>
                <Table.HeaderCell>{t("trial.columns.reference")}</Table.HeaderCell>
                <Table.HeaderCell>{t("trial.columns.customer")}</Table.HeaderCell>
                <Table.HeaderCell>{t("trial.columns.product")}</Table.HeaderCell>
                <Table.HeaderCell>{t("common.fields.status")}</Table.HeaderCell>
                <Table.HeaderCell>{t("trial.columns.trialEndsAt")}</Table.HeaderCell>
                <Table.HeaderCell />
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {trialSubscriptions.map((subscription) => (
                <Table.Row key={subscription.id}>
                  <Table.Cell>
                    <Link to={`/subscriptions/${subscription.id}`}>
                      {subscription.reference}
                    </Link>
                  </Table.Cell>
                  <Table.Cell>
                    <Text size="small" leading="compact">
                      {subscription.customer.email}
                    </Text>
                  </Table.Cell>
                  <Table.Cell>
                    <Text size="small" leading="compact">
                      {subscription.product.product_title}
                    </Text>
                    <Text size="small" leading="compact" className="text-ui-fg-subtle">
                      {subscription.product.variant_title}
                    </Text>
                  </Table.Cell>
                  <Table.Cell>
                    <StatusBadge color={getStatusColor(subscription.status)}>
                      {t(SUBSCRIPTION_STATUS_KEYS[subscription.status])}
                    </StatusBadge>
                  </Table.Cell>
                  <Table.Cell>
                    {formatDateTime(subscription.trial.trial_ends_at) ??
                      t("common.empty.noValue")}
                  </Table.Cell>
                  <Table.Cell>
                    {subscription.status === SubscriptionAdminStatus.CANCELLED ? null : (
                      <Button
                        size="small"
                        variant="danger"
                        type="button"
                        isLoading={
                          cancelSubscriptionMutation.isPending &&
                          cancelSubscriptionMutation.variables === subscription.id
                        }
                        onClick={() => {
                          void handleCancelSubscription(subscription.id)
                        }}
                      >
                        {t("trial.subscriptions.cancel")}
                      </Button>
                    )}
                  </Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table>
        )}
      </Container>
    </div>
  )
}
