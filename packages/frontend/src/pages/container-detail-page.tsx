import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getRouteApi, useNavigate } from '@tanstack/react-router';
import { Gauge, History, Info, KeyRound, Terminal, TriangleAlert } from 'lucide-react';
import {
  ContainerStatus,
  IntentResourceType,
  type ContainerAction,
  type ContainerDto,
  type CursorPaginatedResponse,
  type IntentAcceptedDto,
  type IntentDto,
  type ListScope,
} from '@nyabase/common';
import { Alert, AlertDescription } from '../components/ui/alert.js';
import { Button } from '../components/ui/button.js';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../components/ui/dialog.js';
import { Hint } from '../components/ui/hint.js';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs.js';
import { Page, PageHeader } from '../components/layout/page-header.js';
import { QueryView } from '../components/layout/query-view.js';
import { StatusBadge } from '../components/layout/status-badge.js';
import { ContainerActionBar } from '../components/containers/container-action-bar.js';
import { ContainerConsole } from '../components/containers/container-console.js';
import { IntentsPanel } from '../components/containers/intents-panel.js';
import { OverviewPanel } from '../components/containers/overview-panel.js';
import { StoragePanel } from '../components/containers/storage-panel.js';
import { SshSessionList } from '../components/ssh-sessions/ssh-session-list.js';
import { SshSessionStats } from '../components/ssh-sessions/ssh-session-stats.js';
import { useActionMutation } from '../hooks/use-action-mutation.js';
import { api } from '../lib/api.js';
import { useInvalidateContainer } from '../lib/container-queries.js';
import {
  containerLifecyclePending,
  containerStatusPending,
  intentListSettled,
} from '../lib/in-progress.js';
import { resourceIntentsPath } from '../lib/intent-visibility.js';
import { queryKeys } from '../lib/query-keys.js';
import { queryPollInterval, refetchWhileInProgress } from '../lib/query-lifecycle.js';
import { scopedPath } from '../lib/scoped-paths.js';
import { runGatedMutation, useResourceMutationPending } from '../lib/resource-mutation-gate.js';
import {
  containerActionSubmittedTitle,
  containerStatusLabel,
  lifecyclePhaseLabel,
} from '../lib/status-labels.js';

export type DetailTab = 'overview' | 'console' | 'ssh';
const DETAIL_TABS: DetailTab[] = ['overview', 'console', 'ssh'];

export function parseDetailTab(value: unknown): DetailTab {
  return DETAIL_TABS.includes(value as DetailTab) ? (value as DetailTab) : 'overview';
}

const userRouteApi = getRouteApi('/containers/$containerId');
const adminRouteApi = getRouteApi('/manage/containers/$containerId');

const DETAIL_TAB_ITEMS = [
  ['overview', '概况', Gauge],
  ['console', '控制台', Terminal],
  ['ssh', 'SSH 连接', KeyRound],
] as const;

export default function ContainerDetailPage() {
  const { containerId } = userRouteApi.useParams();
  const { tab } = userRouteApi.useSearch();
  return <ContainerDetailContent containerId={containerId} scope="mine" tab={tab} />;
}

export function AdminContainerDetailPage() {
  const { containerId } = adminRouteApi.useParams();
  const { tab } = adminRouteApi.useSearch();
  return <ContainerDetailContent containerId={containerId} scope="all" tab={tab} />;
}

function ContainerDetailContent({
  containerId,
  scope,
  tab,
}: {
  containerId: string;
  scope: ListScope;
  tab: DetailTab;
}) {
  const admin = scope === 'all';
  const navigate = useNavigate({ from: admin ? '/manage/containers/$containerId' : '/containers/$containerId' });
  const containerQuery = useQuery({
    queryKey: queryKeys.containers.detail(scope, containerId),
    queryFn: () => api.get<ContainerDto>(scopedPath(`/containers/${containerId}`, scope)),
    refetchInterval: (query) => queryPollInterval(query.state, { activeIntervalMs: 5_000 }),
  });

  return (
    <Page testId="container-canonical-detail">
      <ContainerDetailHeader container={containerQuery.data} scope={scope} />
      <QueryView
        query={containerQuery}
        resourceName="容器"
        loadingLabel="加载容器..."
        onBack={() => window.history.back()}
      >
        {(container) => (
          <>
            {container.needsAttention && (
              <Alert variant="destructive">
                <TriangleAlert className="h-4 w-4" />
                <AlertDescription>
                  {container.failureReason ?? container.failureCode ?? '容器需要人工关注。'}
                </AlertDescription>
              </Alert>
            )}

            <Tabs
              value={tab}
              onValueChange={(value) => {
                void navigate({ search: (prev) => ({ ...prev, tab: value as DetailTab }), replace: true });
              }}
            >
              <TabsList className="h-auto w-full flex-nowrap justify-start overflow-x-auto">
                {DETAIL_TAB_ITEMS.map(([key, label, Icon]) => (
                  <TabsTrigger key={key} value={key} className="gap-1.5">
                    <Icon className="h-4 w-4" />{label}
                  </TabsTrigger>
                ))}
              </TabsList>
              <TabsContent value="overview" className="space-y-3">
                <OverviewPanel container={container} scope={scope} />
                <StoragePanel container={container} scope={scope} />
              </TabsContent>
              <TabsContent value="console">
                <ContainerConsole container={container} scope={scope} />
              </TabsContent>
              <TabsContent value="ssh" className="space-y-3">
                {tab === 'ssh' ? (
                  <>
                    <SshSessionList
                      scope={scope}
                      containerId={container.id}
                      title="SSH 连接"
                      description="经 SSH 代理连到这个容器的连接（含登录名直接指定它的）。"
                    />
                    <SshSessionStats scope={scope} containerId={container.id} />
                  </>
                ) : null}
              </TabsContent>
            </Tabs>
          </>
        )}
      </QueryView>
    </Page>
  );
}

/** Container name with its status badges, breadcrumbs, the history button and the power actions. */
function ContainerDetailHeader({ container: c, scope }: { container: ContainerDto | undefined; scope: ListScope }) {
  const admin = scope === 'all';
  const containerId = c?.id ?? '';
  const [intentsOpen, setIntentsOpen] = useState(false);
  const actionPending = useResourceMutationPending(containerId);
  const invalidate = useInvalidateContainer(scope, containerId);
  const action = useActionMutation({
    mutationFn: (name: Extract<ContainerAction, 'start' | 'stop' | 'restart' | 'delete'>) =>
      api.post<IntentAcceptedDto>(scopedPath(`/containers/${containerId}/actions/${name}`, scope)),
    successTitle: (name) => containerActionSubmittedTitle(name),
    errorTitle: '容器操作失败',
    onSuccess: invalidate,
  });
  const runAction = async (name: Extract<ContainerAction, 'start' | 'stop' | 'restart' | 'delete'>) => {
    const ran = await runGatedMutation(containerId, () => action.mutateAsync(name).then(() => undefined));
    if (!ran) return Promise.reject();
  };
  const running = c?.actual.status === ContainerStatus.Running;
  return (
    <>
    <PageHeader
      title={
        c ? (
          <span className="inline-flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-1.5">
              <span>{c.name}</span>
              <InstanceNameHint instanceName={c.instanceName} />
            </span>
            <StatusBadge
              label={containerStatusLabel(c.actual.status)}
              raw={c.actual.status}
              pending={containerStatusPending(c)}
              variant={running ? 'success' : c.needsAttention ? 'destructive' : 'secondary'}
            />
            {c.lifecyclePhase !== 'active' && (
              <StatusBadge
                label={lifecyclePhaseLabel(c.lifecyclePhase)}
                raw={c.lifecyclePhase}
                pending={containerLifecyclePending(c)}
                variant="warning"
              />
            )}
          </span>
        ) : '容器'
      }
      description={c ? c.serverName : undefined}
      crumbs={[
        admin
          ? { label: '全平台容器', to: '/manage/containers' }
          : { label: '容器', to: '/containers' },
        { label: c?.name ?? '…' },
      ]}
      actions={c ? (
        <div className="flex flex-wrap items-center gap-1">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-9"
            data-testid="open-intent-history"
            onClick={() => setIntentsOpen(true)}
          >
            <History className="h-4 w-4" />操作记录
          </Button>
          <ContainerActionBar
            container={c}
            layout="labeled"
            pending={actionPending}
            showDelete
            onAction={runAction}
          />
        </div>
      ) : undefined}
    />
    <IntentHistoryDialog
      containerId={containerId}
      scope={scope}
      open={intentsOpen}
      onOpenChange={setIntentsOpen}
    />
    </>
  );
}

/** The Incus instance name is for debugging and support, so it stays behind an info icon. */
function InstanceNameHint({ instanceName }: { instanceName: string | null }) {
  const text = instanceName ? `实例名 ${instanceName}` : '实例创建中';
  return (
    <Hint
      content={instanceName ? <>实例名 <span className="font-mono">{instanceName}</span></> : text}
    >
      <button
        type="button"
        className="inline-flex rounded-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
        aria-label={text}
        data-testid="container-instance-name"
      >
        <Info className="h-4 w-4" />
      </button>
    </Hint>
  );
}

/** The container's operation history in a dialog. */
function IntentHistoryDialog({
  containerId,
  scope,
  open,
  onOpenChange,
}: {
  containerId: string;
  scope: ListScope;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const query = useQuery({
    queryKey: queryKeys.containers.intents(scope, containerId),
    queryFn: () => api.get<CursorPaginatedResponse<IntentDto>>(
      `${resourceIntentsPath(scope, IntentResourceType.Container, containerId)}&limit=50`,
    ),
    enabled: open,
    refetchInterval: (q) => refetchWhileInProgress(q.state, {
      steadyIntervalMs: false,
      isSettled: (data) => intentListSettled(data.items),
    }),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>操作记录</DialogTitle>
        </DialogHeader>
        <QueryView query={query} resourceName="操作记录" loadingLabel="加载操作记录...">
          {(page) => (
            <IntentsPanel
              intents={page.items}
              scope={scope}
              embedded
              onRetry={() => { void query.refetch(); }}
            />
          )}
        </QueryView>
      </DialogContent>
    </Dialog>
  );
}
