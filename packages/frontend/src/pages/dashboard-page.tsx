import { useState, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api.js';
import { formatBytesCompact } from '../lib/utils.js';
import { Server, HardDrive, Wifi, Users, Container } from 'lucide-react';
import { Capability, type UserServerDto, type UserMetricsDto, type ContainerMetricsDto, type MetricSeries } from '@nyabase/common';
import {
  MultiLineChart, EmptyChart, SkeletonSection, TimeRangeSelector,
  fmtBps, zeroFillSeriesFromReferences,
} from '../components/dashboard/server-metrics.js';
import { useAuthStore } from '../store/auth.js';
import { queryKeys } from '../lib/query-keys.js';
import { adminCatalogPaths, type MetricServerCatalogItem } from '../lib/admin-catalog.js';
import { QueryErrorState, QueryLoadingState } from '../components/query-state.js';
import { safePreferences } from '../lib/safe-preferences.js';
import { dashboardServerHasGpu, preferredDashboardServerId } from '../lib/dashboard-server-selection.js';
import { queryPollInterval } from '../lib/query-lifecycle.js';

const STORED_SERVER_KEY = 'nyabase-dashboard-server-v2';

type DashboardServer = UserServerDto | MetricServerCatalogItem;

// ---------------------------------------------------------------------------
// Users dimension tab
// ---------------------------------------------------------------------------

function UsersTab({
  serverId,
  range,
  hasGpu,
  admin = false,
}: {
  serverId: string;
  range: string;
  hasGpu: boolean;
  admin?: boolean;
}) {
  const metricsBase = admin ? '/admin/metrics' : '/metrics';
  const { data, isLoading, error } = useQuery({
    queryKey: ['metrics-users', admin ? 'admin' : 'user', serverId, range],
    queryFn: () => api.get<UserMetricsDto>(`${metricsBase}/servers/${serverId}/users?range=${range}`),
    staleTime: 30_000,
    refetchInterval: (query) => queryPollInterval(query.state, { activeIntervalMs: 60_000 }),
    retry: false,
  });

  if (isLoading) return <SkeletonSection rows={3} />;
  if (error) return <QueryErrorState error={error} resourceName="用户指标" />;
  if (!data || data.users.length === 0) return <EmptyChart title="用户资源" />;

  const showGpu = hasGpu || data.users.some((user) => user.gpuMemUsed.points.some((point) => point.v !== null));

  const entries = (key: keyof UserMetricsDto['users'][0]) =>
    data.users.map((u) => ({
      key: u.userId,
      label: u.username || u.displayName || u.userId,
      series: u[key] as MetricSeries,
    }));

  const gpuEntries = data.users.map((u) => ({
    key: u.userId,
    label: u.username || u.displayName || u.userId,
    series: zeroFillSeriesFromReferences(u.gpuMemUsed, [u.cpu, u.memUsed]),
  }));

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
      <MultiLineChart title="CPU 用量（核心数）" entries={entries('cpu')} yFormatter={(v) => v.toFixed(2)} />
      <MultiLineChart title="内存用量" entries={entries('memUsed')} yFormatter={formatBytesCompact} />
      {showGpu && (
        <MultiLineChart title="GPU 显存" entries={gpuEntries} yFormatter={formatBytesCompact} />
      )}
      <MultiLineChart title="磁盘 IO（读 + 写）" entries={entries('diskBps')} yFormatter={fmtBps} />
      <MultiLineChart title="网络 IO（收 + 发）" entries={entries('netBps')} yFormatter={fmtBps} />
      <MultiLineChart title="磁盘占用空间" entries={entries('diskUsed')} yFormatter={formatBytesCompact} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Containers dimension tab — always only the current user's containers
// ---------------------------------------------------------------------------

function ContainersTab({
  serverId,
  range,
  hasGpu,
  admin = false,
}: {
  serverId: string;
  range: string;
  hasGpu: boolean;
  admin?: boolean;
}) {
  const metricsBase = admin ? '/admin/metrics' : '/metrics';
  const { data, isLoading, error } = useQuery({
    queryKey: ['metrics-containers', admin ? 'admin' : 'user', serverId, range],
    queryFn: () => api.get<ContainerMetricsDto>(`${metricsBase}/servers/${serverId}/containers?range=${range}`),
    staleTime: 30_000,
    refetchInterval: (query) => queryPollInterval(query.state, { activeIntervalMs: 60_000 }),
    retry: false,
  });

  if (isLoading) return <SkeletonSection rows={3} />;
  if (error) return <QueryErrorState error={error} resourceName="容器指标" />;
  if (!data || data.containers.length === 0) return <EmptyChart title="容器资源" />;

  const showGpu = hasGpu || data.containers.some((container) => container.gpuMemUsed.points.some((point) => point.v !== null));

  const entries = (key: keyof ContainerMetricsDto['containers'][0]) =>
    data.containers.map((c) => ({
      key: c.containerId,
      label: c.name || c.containerId,
      series: c[key] as MetricSeries,
    }));

  const gpuEntries = data.containers.map((c) => ({
    key: c.containerId,
    label: c.name || c.containerId,
    series: zeroFillSeriesFromReferences(c.gpuMemUsed, [c.cpu, c.memUsed]),
  }));

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
      <MultiLineChart title="CPU 用量（核心数）" entries={entries('cpu')} yFormatter={(v) => v.toFixed(2)} />
      <MultiLineChart title="内存用量" entries={entries('memUsed')} yFormatter={formatBytesCompact} />
      {showGpu && (
        <MultiLineChart title="GPU 显存" entries={gpuEntries} yFormatter={formatBytesCompact} />
      )}
      <MultiLineChart title="磁盘 IO（读 + 写）" entries={entries('diskBps')} yFormatter={fmtBps} />
      <MultiLineChart title="网络 IO（收 + 发）" entries={entries('netBps')} yFormatter={fmtBps} />
    </div>
  );
}

export default function DashboardPage() {
  const { user } = useAuthStore();
  const adminMetrics = user?.capabilities.includes(Capability.ViewMetricsAll) ?? false;
  const serversPath = adminMetrics ? adminCatalogPaths.metricServers : '/servers';
  const serversQuery = useQuery<DashboardServer[]>({
    queryKey: adminMetrics ? ['admin-catalog', 'metric-servers'] : queryKeys.servers.user,
    queryFn: () => adminMetrics
      ? api.get<MetricServerCatalogItem[]>(serversPath)
      : api.get<UserServerDto[]>(serversPath),
    refetchInterval: (query) => queryPollInterval(query.state, { activeIntervalMs: 30_000 }),
  });
  const servers = serversQuery.data ?? [];
  const srvLoading = serversQuery.isLoading;

  const [serverId, setServerId] = useState<string>(() => safePreferences.get(STORED_SERVER_KEY) ?? '');
  const [range, setRange] = useState('1h');
  const [activeTab, setActiveTab] = useState<'users' | 'containers'>('users');

  useEffect(() => {
    const fallbackId = preferredDashboardServerId(servers);
    if (serverId && servers.some((server) => server.id === serverId)) return;
    setServerId(fallbackId);
    if (fallbackId) {
      safePreferences.set(STORED_SERVER_KEY, fallbackId);
    } else {
      safePreferences.remove(STORED_SERVER_KEY);
    }
  }, [servers, serverId]);

  const selectedServer = servers.find((s) => s.id === serverId);
  const hasGpu = Boolean(selectedServer && dashboardServerHasGpu(selectedServer));

  function handleServerChange(id: string) {
    setServerId(id);
    safePreferences.set(STORED_SERVER_KEY, id);
  }

  return (
    <div className="px-4 py-4 md:px-6 space-y-5 w-full">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <Server className="h-4 w-4 text-muted-foreground shrink-0" />
          <select
            value={serverId}
            onChange={(e) => handleServerChange(e.target.value)}
            disabled={srvLoading || servers.length === 0}
            className="text-sm rounded-md border border-input bg-background px-2 py-1.5 pr-7 focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-50"
          >
            {servers.length === 0 && (
              <option value="">
                {serversQuery.isError ? '服务器目录加载失败' : srvLoading ? '正在加载服务器...' : '无可用服务器'}
              </option>
            )}
            {servers.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}{s.status !== 'online' ? ' (离线)' : ''}
              </option>
            ))}
          </select>
        </div>

        {selectedServer && (
          <span
            className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full border font-medium ${
              selectedServer.status === 'online'
                ? 'bg-green-50 text-green-700 border-green-200'
                : 'bg-muted text-muted-foreground border-border'
            }`}
          >
            <Wifi className="h-3 w-3" />
            {selectedServer.status}
          </span>
        )}

        <div className="flex-1" />
        <TimeRangeSelector value={range} onChange={setRange} />
      </div>

      {/* Content */}
      {serversQuery.isLoading ? (
        <QueryLoadingState label="加载指标服务器目录..." />
      ) : serversQuery.isError ? (
        <QueryErrorState
          error={serversQuery.error}
          resourceName="指标服务器目录"
          onRetry={() => { void serversQuery.refetch(); }}
        />
      ) : !selectedServer ? (
        <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
          <HardDrive className="h-10 w-10 mb-3 opacity-20" />
          <p className="text-sm">请选择服务器</p>
        </div>
      ) : (
        <div className="space-y-3">
          {/* Dimension tabs */}
          <div className="flex items-center gap-1 border-b">
            {([
              { key: 'users' as const, label: '用户维度', icon: Users },
              { key: 'containers' as const, label: '容器维度', icon: Container },
            ]).map((tab) => {
              const Icon = tab.icon;
              const active = activeTab === tab.key;
              return (
              <button
                key={tab.key}
                onClick={() => setActiveTab(tab.key)}
                className={`inline-flex items-center gap-1.5 text-sm px-4 py-2 border-b-2 transition-colors ${
                  active
                    ? 'border-primary text-foreground font-medium'
                    : 'border-transparent text-muted-foreground hover:text-foreground'
                }`}
              >
                <Icon className={`h-4 w-4 ${active ? 'text-primary' : 'text-muted-foreground'}`} />
                {tab.label}
              </button>
              );
            })}
          </div>

          <div className="pt-1">
            {activeTab === 'users'
              ? <UsersTab serverId={selectedServer.id} range={range} hasGpu={hasGpu} admin={adminMetrics} />
              : <ContainersTab serverId={selectedServer.id} range={range} hasGpu={hasGpu} admin={adminMetrics} />}
          </div>
        </div>
      )}
    </div>
  );
}
