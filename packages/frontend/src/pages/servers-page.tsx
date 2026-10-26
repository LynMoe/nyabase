import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { Plus, RefreshCw, Server, Wifi, WifiOff } from 'lucide-react';
import {
  Role,
  type PerformanceAdminUsageResponse,
  type ServerDto,
} from '@nyabase/common';
import { useHasRole } from '../lib/use-role.js';
import { hostOccupancy } from '../components/performance/host-occupancy.js';
import { api } from '../lib/api.js';
import { Button } from '../components/ui/button.js';
import { Badge } from '../components/ui/badge.js';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table.js';
import { EmptyState } from '../components/layout/empty-state.js';
import { Page, PageHeader } from '../components/layout/page-header.js';
import { QueryView } from '../components/layout/query-view.js';
import { SectionCard } from '../components/layout/section-card.js';
import { TechnicalId } from '../components/refs/technical-id.js';
import { AgentStateBadge } from '../components/servers/agent-card.js';
import { nodeMetricsBadgeVariant } from '../components/servers/node-metrics-card.js';
import { RejectedAgentsNotice } from './servers-page/rejected-agents-notice.js';
import { ServerOnboardingDialog } from './servers-page/server-onboarding-dialog.js';
import { nodeMetricsStatusZh, serverStatusLabel } from '../lib/display-labels.js';
import { preflightPending } from '../lib/in-progress.js';
import { queryKeys } from '../lib/query-keys.js';
import { queryPollInterval, refetchWhileInProgress } from '../lib/query-lifecycle.js';
import { relativeTime } from '../lib/utils.js';

export default function ServersPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const canViewMetrics = useHasRole(Role.Admin);
  const usageQuery = useQuery({
    queryKey: queryKeys.performance.servers('all'),
    queryFn: () => api.get<PerformanceAdminUsageResponse>('/performance/usage?scope=all'),
    enabled: canViewMetrics,
    refetchInterval: (query) => queryPollInterval(query.state, { activeIntervalMs: 15_000 }),
  });
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  const serversQuery = useQuery({
    queryKey: queryKeys.servers.admin,
    queryFn: () => api.get<ServerDto[]>('/servers?scope=all'),
    refetchInterval: (query) => refetchWhileInProgress(query.state, {
      steadyIntervalMs: false,
      isSettled: (servers) => servers.every((server) => !preflightPending(server.preflightStatus)),
    }),
  });
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.servers.admin });
  };

  return (
    <Page testId="server-onboarding-page">
      <PageHeader
        title="服务器"
        actions={
          <>
            <Button variant="outline" size="icon" onClick={refresh} disabled={serversQuery.isFetching} aria-label="刷新服务器">
              <RefreshCw className={serversQuery.isFetching ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
            </Button>
            <Button onClick={() => setOnboardingOpen(true)}>
              <Plus className="h-4 w-4" />添加服务器
            </Button>
          </>
        }
      />
      <RejectedAgentsNotice servers={serversQuery.data} />
      <QueryView
        query={serversQuery}
        resourceName="服务器目录"
        loadingLabel="加载服务器..."
        showEmpty={serversQuery.data?.length === 0}
        empty={
          <EmptyState
            icon={Server}
            title="还没有注册服务器。"
            action={<Button onClick={() => setOnboardingOpen(true)}><Plus className="h-4 w-4" />开始接入</Button>}
          />
        }
      >
        {(items) => (
          <SectionCard flush>
          <Table className="min-w-[920px]">
            <TableHeader>
              <TableRow>
                <TableHead>名称</TableHead>
                {canViewMetrics ? (
                  <>
                    <TableHead>CPU</TableHead>
                    <TableHead>内存</TableHead>
                    <TableHead>磁盘</TableHead>
                    <TableHead>网络</TableHead>
                    {usageQuery.data?.servers.some((server) => server.host.gpus.length > 0) ? <TableHead>显存</TableHead> : null}
                  </>
                ) : null}
                <TableHead>状态</TableHead>
                <TableHead>Agent</TableHead>
                <TableHead>Incus</TableHead>
                <TableHead>指标</TableHead>
                <TableHead>最近观测</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((server) => (
                <ServerRow
                  key={server.id}
                  server={server}
                  metrics={usageQuery.data?.servers.find((item) => item.serverId === server.id)}
                  showMetrics={canViewMetrics}
                  showGpu={usageQuery.data?.servers.some((item) => item.host.gpus.length > 0) ?? false}
                />
              ))}
            </TableBody>
          </Table>
          </SectionCard>
        )}
      </QueryView>
      <ServerOnboardingDialog
        open={onboardingOpen}
        onOpenChange={setOnboardingOpen}
        onCreated={refresh}
        onDone={(serverId) => {
          setOnboardingOpen(false);
          void navigate({ to: '/servers/$id', params: { id: serverId }, search: { tab: 'connect' } });
        }}
      />
    </Page>
  );
}

function ServerRow({
  server,
  metrics,
  showMetrics,
  showGpu,
}: {
  server: ServerDto;
  metrics?: PerformanceAdminUsageResponse['servers'][number];
  showMetrics: boolean;
  showGpu: boolean;
}) {
  const online = server.status === 'online';
  const occupancy = metrics ? hostOccupancy(metrics.host) : null;
  return (
    <TableRow className="cursor-pointer">
      <TableCell className="whitespace-normal">
        <Link to="/servers/$id" params={{ id: server.id }} search={{ tab: 'overview' }} className="block min-w-0">
          <p className="font-medium">{server.name}</p>
        </Link>
        {server.slug && server.slug !== server.name ? (
          <div className="mt-0.5">
            <TechnicalId
              label="slug"
              value={server.slug}
              kind="text"
              className="block text-xs text-muted-foreground [overflow-wrap:anywhere]"
            />
          </div>
        ) : null}
      </TableCell>
      {showMetrics ? (
        <>
          <TableCell className="tabular-nums whitespace-nowrap" title={occupancy?.cpuTitle}>{occupancy?.cpu ?? '—'}</TableCell>
          <TableCell className="tabular-nums whitespace-nowrap" title={occupancy?.memoryTitle}>{occupancy?.memory ?? '—'}</TableCell>
          <TableCell className="tabular-nums whitespace-nowrap" title={occupancy?.diskTitle}>{occupancy?.disk ?? '—'}</TableCell>
          <TableCell className="tabular-nums whitespace-nowrap">{occupancy?.network ?? '—'}</TableCell>
          {showGpu ? <TableCell className="tabular-nums whitespace-nowrap" title={occupancy?.gpuTitle}>{occupancy?.gpu ?? ''}</TableCell> : null}
        </>
      ) : null}
      <TableCell>
        <Badge variant={online ? 'success' : 'secondary'}>
          {online ? <Wifi className="h-3 w-3" /> : <WifiOff className="h-3 w-3" />}
          {serverStatusLabel(server.status)}
        </Badge>
      </TableCell>
      <TableCell>
        <AgentStateBadge agent={server.agent} />
      </TableCell>
      <TableCell>{server.incusVersion ?? '未连接'}</TableCell>
      <TableCell className="whitespace-normal">
        <Badge variant={nodeMetricsBadgeVariant(server.metricsHealth.status)}>
          {nodeMetricsStatusZh(server.metricsHealth.status)}
        </Badge>
        {server.metricsHealth.outageSince ? (
          <p className="mt-1 text-xs text-destructive">
            中断自 {new Date(server.metricsHealth.outageSince).toLocaleString()}
          </p>
        ) : null}
      </TableCell>
      <TableCell>{relativeTime(server.lastSeenAt)}</TableCell>
    </TableRow>
  );
}
