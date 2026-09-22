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
  type UserServerDto,
} from '@nyabase/common';
import { api } from '../lib/api.js';
import { SummaryCard } from '../components/dashboard/summary-card.js';
import { Page } from '../components/layout/page.js';
import { PageHeader } from '../components/layout/page-header.js';
import { QueryView } from '../components/layout/query-view.js';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card.js';
import { Badge } from '../components/ui/badge.js';
import { Button } from '../components/ui/button.js';
import { formatBytes, formatCpu, relativeTime } from '../lib/utils.js';
import { containerInProgress } from '../lib/in-progress.js';
import { containerStatusLabel, serverStatusLabel } from '../lib/status-labels.js';
import { queryPollInterval, refetchWhileInProgress } from '../lib/query-lifecycle.js';
import { queryKeys } from '../lib/query-keys.js';

export default function DashboardPage() {
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
          />
        )}
      </QueryView>
    </Page>
  );
}

function DashboardBody({
  servers,
  containers,
}: {
  servers: UserServerDto[];
  containers: ContainerDto[];
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
                <ServerHealthRow key={server.id} server={server} />
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
                <ContainerResourceRow key={container.id} container={container} />
              ))
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}

function ServerHealthRow({ server }: { server: UserServerDto }) {
  const healthy = server.status === 'online';
  return (
    <div className="flex items-start justify-between gap-3 rounded-md border p-3">
      <div className="min-w-0">
        <p className="truncate text-sm font-medium">{server.name}</p>
        {server.slug && server.slug !== server.name && (
          <p className="truncate font-mono text-xs text-muted-foreground">{server.slug}</p>
        )}
        <p className="mt-1 text-xs text-muted-foreground">
          最近观测 {relativeTime(server.lastSeenAt)}
        </p>
      </div>
      <Badge variant={healthy ? 'success' : 'destructive'} title={server.status}>
        {healthy ? '健康' : serverStatusLabel(server.status)}
      </Badge>
    </div>
  );
}

function ContainerResourceRow({ container }: { container: ContainerDto }) {
  const status = container.actual.status;
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
        <div>{formatCpu(container.cpuMillis)} · {formatBytes(container.memBytes)}</div>
      </div>
    </Link>
  );
}
