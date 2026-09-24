import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import {
  Activity,
  CircleAlert,
  CircleCheck,
  Container,
  Gauge,
  Loader2,
  Server,
} from 'lucide-react';
import {
  type ContainerDto,
  type PerformanceOwnContainer,
  type PerformanceUsageResponse,
  type UserServerDto,
} from '@nyabase/common';
import { api } from '../lib/api.js';
import { SummaryCard } from '../components/dashboard/summary-card.js';
import { Page } from '../components/layout/page.js';
import { PageHeader } from '../components/layout/page-header.js';
import { QueryView } from '../components/layout/query-view.js';
import { SectionCard } from '../components/layout/section-card.js';
import { MetaStat } from '../components/layout/section-card.js';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card.js';
import { Badge } from '../components/ui/badge.js';
import { Button } from '../components/ui/button.js';
import { formatBytes, formatBytesCompact, formatCpu, relativeTime } from '../lib/utils.js';
import { containerInProgress } from '../lib/in-progress.js';
import { containerStatusLabel, serverStatusLabel } from '../lib/status-labels.js';
import { queryPollInterval, refetchWhileInProgress } from '../lib/query-lifecycle.js';
import { queryKeys } from '../lib/query-keys.js';
import { hostOccupancyLine, hostOccupancyTitle } from '../components/performance/host-occupancy.js';

export default function DashboardPage() {
  const serversQuery = useQuery({
    queryKey: queryKeys.servers.user,
    queryFn: () => api.get<UserServerDto[]>('/servers'),
    refetchInterval: (query) => queryPollInterval(query.state, { activeIntervalMs: 30_000 }),
  });
  const usageQuery = useQuery({
    queryKey: queryKeys.performance.servers('user'),
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
        title="资源概览"
        actions={
          <Button variant="outline" asChild>
            <Link to="/quota">
              <Gauge className="h-4 w-4" />配额
            </Link>
          </Button>
        }
      />
      <QueryView
        queries={[serversQuery, containersQuery]}
        resourceNames={['服务器资源', '容器资源']}
        loadingLabel="加载资源..."
      >
        {() => (
          <DashboardBody
            servers={serversQuery.data ?? []}
            containers={containersQuery.data ?? []}
            usage={usageQuery.data}
          />
        )}
      </QueryView>
    </Page>
  );
}

function DashboardBody({
  servers,
  containers,
  usage,
}: {
  servers: UserServerDto[];
  containers: ContainerDto[];
  usage?: PerformanceUsageResponse;
}) {
  const running = containers.filter((container) => container.actual.status === 'running').length;
  const stopped = containers.filter((container) => container.actual.status !== 'running').length;
  const attention = containers.filter((container) => container.needsAttention).length;
  const online = servers.filter((server) => server.status === 'online').length;

  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <SummaryCard icon={Server} label="服务器" value={`${online} / ${servers.length}`} detail="在线 / 可见" />
        <SummaryCard icon={Container} label="容器" value={`${running} / ${containers.length}`} detail="运行中 / 可见" />
        <SummaryCard icon={CircleAlert} label="需要关注" value={String(attention)} detail="收敛或授权状态" />
        <SummaryCard icon={Activity} label="非运行中" value={String(stopped)} detail="停止或其他状态" />
      </div>
      <SectionCard title="我的占用">
        <OwnOccupancy containers={usage?.ownContainers ?? []} />
      </SectionCard>

      <div className="grid items-start gap-4 xl:grid-cols-2">
        <Card data-testid="incus-server-resources">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Server className="h-4 w-4" />服务器健康
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {servers.length === 0 ? (
              <p className="text-sm text-muted-foreground">暂无可见服务器。</p>
            ) : (
              servers.map((server) => (
                <ServerHealthRow
                  key={server.id}
                  server={server}
                  metrics={usage?.servers.find((item) => item.serverId === server.id)}
                />
              ))
            )}
          </CardContent>
        </Card>

        <Card data-testid="incus-container-resources">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Container className="h-4 w-4" />容器资源
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {containers.length === 0 ? (
              <p className="text-sm text-muted-foreground">暂无可见容器。</p>
            ) : (
              containers.slice(0, 12).map((container) => (
                <ContainerResourceRow
                  key={container.id}
                  container={container}
                  occupancy={usage?.ownContainers?.find((item) => item.containerId === container.id)}
                />
              ))
            )}
            {containers.length > 12 ? (
              <Link to="/containers" className="text-sm text-muted-foreground">查看全部</Link>
            ) : null}
          </CardContent>
        </Card>
      </div>
    </>
  );
}

function OwnOccupancy({ containers }: { containers: PerformanceOwnContainer[] }) {
  if (containers.length === 0) return <p className="text-sm text-muted-foreground">暂无占用</p>;
  const cpuUsed = sum(containers.map((item) => item.cpu.usageCores));
  const memUsed = sum(containers.map((item) => item.memory.usedBytes));
  const diskUsed = sum(containers.map((item) => item.disk.usedBytes));
  const gpuRows = containers.filter((item) => item.gpu.pciAddresses.length > 0 || item.gpu.usedBytes !== null);
  const gpuUsed = sum(gpuRows.map((item) => item.gpu.usedBytes));
  return (
    <div className="flex flex-wrap gap-x-6 gap-y-2">
      <MetaStat label="CPU" value={cpuUsed === null ? '—' : `${Math.abs(cpuUsed) >= 10 ? cpuUsed.toFixed(0) : cpuUsed.toFixed(1)} 核`} />
      <MetaStat label="内存" value={memUsed === null ? '—' : formatBytesCompact(memUsed)} />
      {gpuRows.length > 0 && gpuUsed !== null ? <MetaStat label="显存" value={formatBytesCompact(gpuUsed)} /> : null}
      <MetaStat label="磁盘" value={diskUsed === null ? '—' : formatBytesCompact(diskUsed)} />
    </div>
  );
}

function ServerHealthRow({
  server,
  metrics,
}: {
  server: UserServerDto;
  metrics?: PerformanceUsageResponse['servers'][number];
}) {
  const healthy = server.status === 'online';
  return (
    <div className="rounded-md border p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{server.name}</p>
          {server.slug && server.slug !== server.name && (
            <p className="truncate font-mono text-xs text-muted-foreground">{server.slug}</p>
          )}
          <p className="mt-1 text-xs text-muted-foreground">
            最近观测 {relativeTime(metrics?.sampledAt ?? server.lastSeenAt)}
            {metrics?.stale ? ' · 样本偏旧' : ''}
          </p>
          {metrics ? <p className="mt-1 text-xs tabular-nums text-foreground" title={hostOccupancyTitle(metrics.host)}>{hostOccupancyLine(metrics.host)}</p> : null}
        </div>
        <Badge variant={healthy ? 'success' : 'destructive'} title={server.status}>
          {healthy ? '健康' : serverStatusLabel(server.status)}
        </Badge>
      </div>
    </div>
  );
}

function ContainerResourceRow({
  container,
  occupancy,
}: {
  container: ContainerDto;
  occupancy?: PerformanceOwnContainer;
}) {
  const status = container.actual.status;
  const gpuText = occupancy?.gpu.usedBytes == null
    ? null
    : occupancy.gpu.pciAddresses.length > 0 || occupancy.gpu.usedBytes > 0
      ? formatBytesCompact(occupancy.gpu.usedBytes)
      : null;
  return (
    <Link
      to="/containers/$containerId"
      params={{ containerId: container.id }}
      search={{ tab: 'overview' }}
      className="flex items-center justify-between gap-3 rounded-md border p-3 transition-colors hover:bg-muted/40"
    >
      <div className="min-w-0">
        <p className="truncate text-sm font-medium">{container.name}</p>
        <p className="truncate text-xs text-muted-foreground">
          {container.serverName} · {container.routedIp ?? '等待容器 IP'}
        </p>
      </div>
      <div className="shrink-0 text-right text-xs text-muted-foreground">
        <div className="flex items-center justify-end gap-1">
          {status === 'running' ? <CircleCheck className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-300" /> : <CircleAlert className="h-3.5 w-3.5" />}
          {containerInProgress(container) ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : null}
          <span title={status}>{containerStatusLabel(status)}</span>
        </div>
        <div className="flex flex-wrap justify-end gap-x-3 gap-y-0.5 tabular-nums">
          <span>{occupancy ? `${occupancy.cpu.usageCores?.toFixed(1) ?? '—'} 核` : formatCpu(container.cpuMillis)}</span>
          <span>{occupancy ? (occupancy.memory.usedBytes === null ? '—' : formatBytesCompact(occupancy.memory.usedBytes)) : formatBytes(container.memBytes)}</span>
          <span>磁盘 {occupancy?.disk.usedBytes == null ? '—' : formatBytesCompact(occupancy.disk.usedBytes)}</span>
          {gpuText ? <span>显存 {gpuText}</span> : null}
        </div>
      </div>
    </Link>
  );
}

function sum(values: Array<number | null>): number | null {
  const present = values.filter((value): value is number => value !== null && Number.isFinite(value));
  return present.length === 0 ? null : present.reduce((total, value) => total + value, 0);
}
