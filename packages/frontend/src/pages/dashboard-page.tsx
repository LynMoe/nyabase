import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import {
  Activity,
  CircleAlert,
  CircleCheck,
  Container,
  Server,
} from 'lucide-react';
import {
  type ContainerDto,
  type UserServerDto,
} from '@nyabase/common';
import { api } from '../lib/api.js';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card.js';
import { Badge } from '../components/ui/badge.js';
import { QueryErrorState, QueryLoadingState } from '../components/query-state.js';
import { formatBytes, formatCpu, relativeTime } from '../lib/utils.js';
import { containerStatusLabel, serverStatusLabel } from '../lib/status-labels.js';
import { queryPollInterval } from '../lib/query-lifecycle.js';

export default function DashboardPage() {
  const serversQuery = useQuery({
    queryKey: ['dashboard', 'servers', 'user'],
    queryFn: () => api.get<UserServerDto[]>('/servers'),
    refetchInterval: (query) => queryPollInterval(query.state, { activeIntervalMs: 30_000 }),
  });
  const containersQuery = useQuery({
    queryKey: ['dashboard', 'containers', 'user'],
    queryFn: () => api.get<ContainerDto[]>('/containers'),
    refetchInterval: (query) => queryPollInterval(query.state, { activeIntervalMs: 15_000 }),
  });

  if (serversQuery.isLoading || containersQuery.isLoading) {
    return <QueryLoadingState label="加载资源..." />;
  }
  if (serversQuery.isError) {
    return <QueryErrorState error={serversQuery.error} resourceName="服务器资源" onRetry={() => { void serversQuery.refetch(); }} />;
  }
  if (containersQuery.isError) {
    return <QueryErrorState error={containersQuery.error} resourceName="容器资源" onRetry={() => { void containersQuery.refetch(); }} />;
  }

  const servers = serversQuery.data ?? [];
  const containers = containersQuery.data ?? [];
  const running = containers.filter((container) => container.actual.status === 'running').length;
  const stopped = containers.filter((container) => container.actual.status !== 'running').length;
  const attention = containers.filter((container) => container.needsAttention).length;
  const online = servers.filter((server) => server.status === 'online').length;

  return (
    <div className="space-y-5 px-4 py-4 md:px-6" data-testid="incus-resource-dashboard">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">资源概览</h1>
        <p className="text-sm text-muted-foreground">
          当前用户可见的服务器与容器状态。
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <SummaryCard icon={Server} label="服务器" value={`${online} / ${servers.length}`} detail="在线 / 可见" />
        <SummaryCard icon={Container} label="容器" value={`${running} / ${containers.length}`} detail="运行中 / 可见" />
        <SummaryCard icon={CircleAlert} label="需要关注" value={String(attention)} detail="收敛或授权状态" />
        <SummaryCard icon={Activity} label="非运行中" value={String(stopped)} detail="停止或其他状态" />
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
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
              servers.map((server) => <ServerHealthRow key={server.id} server={server} />)
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
    </div>
  );
}

function SummaryCard({
  icon: Icon,
  label,
  value,
  detail,
}: {
  icon: typeof Server;
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center justify-between text-muted-foreground">
          <span className="text-sm">{label}</span>
          <Icon className="h-4 w-4" />
        </div>
        <p className="mt-2 text-2xl font-semibold">{value}</p>
        <p className="mt-1 text-xs text-muted-foreground">{detail}</p>
      </CardContent>
    </Card>
  );
}

function ServerHealthRow({ server }: { server: UserServerDto }) {
  const healthy = server.status === 'online';

  return (
    <div className="flex items-start justify-between gap-3 rounded-md border p-3">
      <div className="min-w-0">
        <p className="truncate text-sm font-medium">{server.name}</p>
        <p className="truncate font-mono text-xs text-muted-foreground">{server.slug}</p>
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
          {status === 'running' ? <CircleCheck className="h-3.5 w-3.5 text-green-600" /> : <CircleAlert className="h-3.5 w-3.5" />}
          <span title={status}>{containerStatusLabel(status)}</span>
        </div>
        <div>{formatCpu(container.cpuMillis)} · {formatBytes(container.memBytes)}</div>
      </div>
    </Link>
  );
}
