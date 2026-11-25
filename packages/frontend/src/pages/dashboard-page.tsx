import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Plus, Server, TriangleAlert } from 'lucide-react';
import {
  ContainerStatus,
  ServerStatus,
  type ContainerDto,
  type EffectiveAccessDto,
  type PerformanceUsageResponse,
  type UserServerDto,
} from '@nyabase/common';
import { api } from '../lib/api.js';
import { CreateContainerDialog } from '../components/containers/create-container-dialog.js';
import { GPU_LEGEND, GpuLegendSwatch } from '../components/dashboard/gpu-strip.js';
import { ServerCard } from '../components/dashboard/server-card.js';
import { EmptyState } from '../components/layout/empty-state.js';
import { Page, PageHeader } from '../components/layout/page-header.js';
import { QueryView } from '../components/layout/query-view.js';
import { QuotaSummary } from '../components/quota/quota-summary.js';
import { SshKeyNotice } from '../components/ssh/ssh-key-notice.js';
import { Alert, AlertDescription } from '../components/ui/alert.js';
import { Button } from '../components/ui/button.js';
import { useMySshKeys } from '../hooks/use-my-ssh-keys.js';
import { dashboardFreeGpus, dashboardServers } from '../lib/dashboard-servers.js';
import { containerInProgress } from '../lib/in-progress.js';
import { queryPollInterval, refetchWhileInProgress } from '../lib/query-lifecycle.js';
import { queryKeys } from '../lib/query-keys.js';
import { useAuthStore } from '../store/auth.js';

export default function DashboardPage() {
  const [createOpen, setCreateOpen] = useState(false);
  const serversQuery = useQuery({
    queryKey: queryKeys.servers.user,
    queryFn: () => api.get<UserServerDto[]>('/servers'),
    refetchInterval: (query) => queryPollInterval(query.state, { activeIntervalMs: 30_000 }),
  });
  const containersQuery = useQuery({
    queryKey: queryKeys.containers.userList,
    queryFn: () => api.get<ContainerDto[]>('/containers'),
    refetchInterval: (query) => refetchWhileInProgress(query.state, {
      steadyIntervalMs: 15_000,
      isSettled: (containers) => containers.every((container) => !containerInProgress(container)),
    }),
  });
  const accessQuery = useQuery({
    queryKey: queryKeys.meAccess,
    queryFn: () => api.get<EffectiveAccessDto>('/me/access'),
    refetchInterval: (query) => queryPollInterval(query.state, { activeIntervalMs: 30_000 }),
  });
  // The machines' load and who uses each card; the cards render without it while it loads or fails.
  const usageQuery = useQuery({
    queryKey: queryKeys.performance.servers('mine'),
    queryFn: () => api.get<PerformanceUsageResponse>('/performance/usage'),
    refetchInterval: (query) => queryPollInterval(query.state, { activeIntervalMs: 15_000 }),
  });

  return (
    <Page testId="incus-resource-dashboard">
      <PageHeader
        title="概览"
        actions={
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="h-4 w-4" />新建容器
          </Button>
        }
      />
      <QueryView
        queries={[accessQuery, serversQuery, containersQuery]}
        resourceNames={['授权', '服务器', '容器']}
        loadingLabel="加载概览..."
      >
        {() => (
          <DashboardBody
            servers={serversQuery.data ?? []}
            containers={containersQuery.data ?? []}
            access={accessQuery.data ?? { servers: [], sharedBackends: [] }}
            usage={usageQuery.data ?? null}
          />
        )}
      </QueryView>
      <CreateContainerDialog open={createOpen} onOpenChange={setCreateOpen} />
    </Page>
  );
}

function DashboardBody({
  servers,
  containers,
  access,
  usage,
}: {
  servers: UserServerDto[];
  containers: ContainerDto[];
  access: EffectiveAccessDto;
  usage: PerformanceUsageResponse | null;
}) {
  const selfId = useAuthStore((state) => state.user?.id ?? null);
  const sshKeys = useMySshKeys();
  const cards = useMemo(() => dashboardServers({
    servers,
    access: access.servers,
    usage: usage?.servers ?? [],
    containers,
    selfId,
  }), [servers, access, usage, containers, selfId]);
  const running = containers.filter((container) => container.actual.status === ContainerStatus.Running).length;
  const attention = containers.filter((container) => container.needsAttention).length;
  const granted = cards.filter((card) => card.access);
  const online = granted.filter((card) => servers.find((server) => server.id === card.serverId)?.status === ServerStatus.Online).length;
  const hasGpus = cards.some((card) => card.gpus.length > 0);

  return (
    <>
      {sshKeys.missing ? <SshKeyNotice /> : null}
      {attention > 0 ? (
        <Alert variant="warning" data-testid="dashboard-attention">
          <TriangleAlert className="h-4 w-4" />
          <AlertDescription>
            {attention} 个容器的操作失败，需要处理。
            {' '}
            <Link to="/containers" className="font-medium underline underline-offset-4">查看容器</Link>
          </AlertDescription>
        </Alert>
      ) : null}
      <div className="flex flex-wrap items-baseline gap-x-7 gap-y-2 text-sm text-muted-foreground" data-testid="dashboard-summary">
        {hasGpus ? (
          <span><b className="text-xl font-semibold text-success tabular-nums">{dashboardFreeGpus(cards)}</b> 张 GPU 空闲</span>
        ) : null}
        <span>
          <b className="text-xl font-semibold text-foreground tabular-nums">{running}</b> 个容器运行中 · 共 {containers.length} 个
          {' '}
          <Link to="/containers" className="text-primary hover:underline">查看</Link>
        </span>
        <span><b className="text-xl font-semibold text-foreground tabular-nums">{online}</b> / {granted.length} 台服务器在线</span>
        {hasGpus ? (
          <span className="flex w-full flex-wrap items-center gap-3.5 text-xs sm:ml-auto sm:w-auto">
            {GPU_LEGEND.map((item) => (
              <span key={item.state} className="inline-flex items-center gap-1"><GpuLegendSwatch state={item.state} />{item.label}</span>
            ))}
          </span>
        ) : null}
      </div>
      {cards.length === 0 ? (
        <EmptyState icon={Server} title="还没有可用的服务器" />
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {cards.map((card) => <ServerCard key={card.serverId} server={card} />)}
        </div>
      )}
      <section id="quota" className="scroll-mt-6">
        <QuotaSummary />
      </section>
    </>
  );
}
