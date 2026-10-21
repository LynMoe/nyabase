import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import {
  Box,
  CircleAlert,
  CircleCheck,
  Loader2,
  Plus,
  Server,
  TriangleAlert,
} from 'lucide-react';
import {
  type ContainerDto,
  type PerformanceOwnContainer,
  type PerformanceUsageResponse,
  type UserServerDto,
} from '@nyabase/common';
import { api } from '../lib/api.js';
import { SummaryCard } from '../components/dashboard/summary-card.js';
import { CreateContainerDialog } from '../components/containers/create-container-dialog.js';
import { Page } from '../components/layout/page-header.js';
import { PageHeader } from '../components/layout/page-header.js';
import { QueryView } from '../components/layout/query-view.js';
import { SectionCard } from '../components/layout/section-card.js';
import { QuotaSummary } from '../components/quota/quota-summary.js';
import { SshKeyNotice } from '../components/ssh/ssh-key-notice.js';
import { Alert, AlertDescription } from '../components/ui/alert.js';
import { useMySshKeys } from '../hooks/use-my-ssh-keys.js';
import { StatusBadge } from '../components/layout/status-badge.js';
import { Button } from '../components/ui/button.js';
import { formatBytesCompact, formatCpu, relativeTime } from '../lib/utils.js';
import { containerInProgress } from '../lib/in-progress.js';
import { containerStatusLabel, serverStatusLabel } from '../lib/status-labels.js';
import { queryPollInterval, refetchWhileInProgress } from '../lib/query-lifecycle.js';
import { queryKeys } from '../lib/query-keys.js';
import { hostOccupancyLine, hostOccupancyTitle } from '../components/performance/host-occupancy.js';

const CONTAINER_PREVIEW = 8;

export default function DashboardPage() {
  const [createOpen, setCreateOpen] = useState(false);
  const serversQuery = useQuery({
    queryKey: queryKeys.servers.user,
    queryFn: () => api.get<UserServerDto[]>('/servers'),
    refetchInterval: (query) => queryPollInterval(query.state, { activeIntervalMs: 30_000 }),
  });
  const usageQuery = useQuery({
    queryKey: queryKeys.performance.servers('mine'),
    queryFn: () => api.get<PerformanceUsageResponse>('/performance/usage'),
    refetchInterval: (query) => queryPollInterval(query.state, { activeIntervalMs: 15_000 }),
  });
  const containersQuery = useQuery({
    queryKey: queryKeys.containers.userList,
    queryFn: () => api.get<ContainerDto[]>('/containers'),
    refetchInterval: (query) => refetchWhileInProgress(query.state, {
      steadyIntervalMs: 15_000,
      isSettled: (containers) => containers.every((container) => !containerInProgress(container)),
    }),
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
        queries={[serversQuery, containersQuery]}
        resourceNames={['服务器', '容器']}
        loadingLabel="加载概览..."
      >
        {() => (
          <DashboardBody
            servers={serversQuery.data ?? []}
            containers={containersQuery.data ?? []}
            usage={usageQuery.data}
            onCreate={() => setCreateOpen(true)}
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
  usage,
  onCreate,
}: {
  servers: UserServerDto[];
  containers: ContainerDto[];
  usage?: PerformanceUsageResponse;
  onCreate: () => void;
}) {
  const running = containers.filter((container) => container.actual.status === 'running').length;
  const attention = containers.filter((container) => container.needsAttention).length;
  const online = servers.filter((server) => server.status === 'online').length;
  const occupancyById = new Map((usage?.ownContainers ?? []).map((item) => [item.containerId, item]));
  const serverUsageById = new Map((usage?.servers ?? []).map((item) => [item.serverId, item]));
  const sshKeys = useMySshKeys();

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
      <div className="grid grid-cols-2 gap-3">
        <SummaryCard
          icon={Box}
          label="容器"
          value={String(running)}
          detail={`运行中 · 共 ${containers.length} 个`}
          to="/containers"
        />
        <SummaryCard
          icon={Server}
          label="服务器"
          value={`${online} / ${servers.length}`}
          detail="在线 / 可用"
        />
      </div>

      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <SectionCard
          title="我的容器"
          testId="incus-container-resources"
          actions={containers.length > 0 ? (
            <Button variant="ghost" size="sm" asChild>
              <Link to="/containers">查看全部</Link>
            </Button>
          ) : undefined}
        >
          {containers.length === 0 ? (
            <div className="flex flex-col items-start gap-3">
              <p className="text-sm text-muted-foreground">还没有容器。</p>
              <Button size="sm" onClick={onCreate}><Plus className="h-4 w-4" />新建容器</Button>
            </div>
          ) : (
            <div className="space-y-2">
              {containers.slice(0, CONTAINER_PREVIEW).map((container) => (
                <ContainerResourceRow
                  key={container.id}
                  container={container}
                  occupancy={occupancyById.get(container.id)}
                />
              ))}
              {containers.length > CONTAINER_PREVIEW ? (
                <Link to="/containers" className="block pt-1 text-sm text-muted-foreground hover:text-foreground">
                  还有 {containers.length - CONTAINER_PREVIEW} 个容器，查看全部
                </Link>
              ) : null}
            </div>
          )}
        </SectionCard>

        <SectionCard title="服务器" testId="incus-server-resources">
          {servers.length === 0 ? (
            <p className="text-sm text-muted-foreground">暂无可用服务器。</p>
          ) : (
            <div className="space-y-2">
              {servers.map((server) => (
                <ServerHealthRow
                  key={server.id}
                  server={server}
                  metrics={serverUsageById.get(server.id)}
                />
              ))}
            </div>
          )}
        </SectionCard>
      </div>

      <section id="quota" className="scroll-mt-6">
        <QuotaSummary />
      </section>
    </>
  );
}

function ServerHealthRow({
  server,
  metrics,
}: {
  server: UserServerDto;
  metrics?: PerformanceUsageResponse['servers'][number];
}) {
  const online = server.status === 'online';
  return (
    <div className="rounded-md border p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{server.name}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            最近观测 {relativeTime(metrics?.sampledAt ?? server.lastSeenAt)}
            {metrics?.stale ? ' · 数据可能已过时' : ''}
          </p>
        </div>
        <StatusBadge
          label={serverStatusLabel(server.status)}
          raw={server.status}
          pending={false}
          variant={online ? 'success' : 'destructive'}
        />
      </div>
      {metrics ? (
        <p className="mt-2 text-xs tabular-nums text-muted-foreground" title={hostOccupancyTitle(metrics.host)}>
          整机 {hostOccupancyLine(metrics.host)}
        </p>
      ) : null}
    </div>
  );
}

/** "used / allocated" so a number is never ambiguous between the two. */
function usedOf(used: string | null, allocated: string): string {
  return `${used ?? '—'} / ${allocated}`;
}

function ContainerResourceRow({
  container,
  occupancy,
}: {
  container: ContainerDto;
  occupancy?: PerformanceOwnContainer;
}) {
  const status = container.actual.status;
  const running = status === 'running';
  const cpuUsed = occupancy?.cpu.usageCores == null ? null : `${occupancy.cpu.usageCores.toFixed(1)}`;
  const memUsed = occupancy?.memory.usedBytes == null ? null : formatBytesCompact(occupancy.memory.usedBytes);
  const diskUsed = occupancy?.disk.usedBytes == null ? null : formatBytesCompact(occupancy.disk.usedBytes);
  const gpuUsed = occupancy && occupancy.gpu.usedBytes != null
    && (occupancy.gpu.pciAddresses.length > 0 || occupancy.gpu.usedBytes > 0)
    ? formatBytesCompact(occupancy.gpu.usedBytes)
    : null;
  return (
    <Link
      to="/containers/$containerId"
      params={{ containerId: container.id }}
      search={{ tab: 'overview' }}
      className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-md border p-3 transition-colors hover:bg-accent/40"
    >
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          {running
            ? <CircleCheck className="h-4 w-4 shrink-0 text-success" aria-hidden />
            : <CircleAlert className={container.needsAttention ? 'h-4 w-4 shrink-0 text-destructive' : 'h-4 w-4 shrink-0 text-muted-foreground'} aria-hidden />}
          <p className="truncate text-sm font-medium">{container.name}</p>
          <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground" title={status}>
            {containerInProgress(container) ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : null}
            {containerStatusLabel(status)}
          </span>
        </div>
        <p className="mt-0.5 truncate pl-6 text-xs text-muted-foreground">
          {container.serverName} · <span className="font-mono">{container.routedIp ?? '等待分配 IP'}</span>
        </p>
      </div>
      <dl className="flex flex-wrap gap-x-4 gap-y-1 pl-6 text-xs tabular-nums text-muted-foreground sm:pl-0" title="已用 / 规格">
        <div className="flex gap-1"><dt>CPU</dt><dd className="text-foreground">{usedOf(cpuUsed, formatCpu(container.cpuMillis))}</dd></div>
        <div className="flex gap-1"><dt>内存</dt><dd className="text-foreground">{usedOf(memUsed, formatBytesCompact(container.memBytes))}</dd></div>
        <div className="flex gap-1"><dt>磁盘</dt><dd className="text-foreground">{usedOf(diskUsed, formatBytesCompact(container.rootSizeBytes))}</dd></div>
        {gpuUsed ? <div className="flex gap-1"><dt>显存</dt><dd className="text-foreground">{gpuUsed}</dd></div> : null}
      </dl>
    </Link>
  );
}
