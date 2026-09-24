import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import {
  type PerformanceAdminUsageResponse,
  type PerformanceMultiSeriesResponse,
  type PerformanceHostSnapshot,
  type PerformancePersonRow,
  type PerformanceRange,
  type PerformanceUsageResponse,
} from '@nyabase/common';
import { api } from '../lib/api.js';
import { queryKeys } from '../lib/query-keys.js';
import { queryPollInterval } from '../lib/query-lifecycle.js';
import { formatBytesCompact, formatPercent, formatRate, relativeTime } from '../lib/utils.js';
import { containerStatusLabel, lifecyclePhaseLabel } from '../lib/status-labels.js';
import { Page } from '../components/layout/page.js';
import { PageHeader } from '../components/layout/page-header.js';
import { QueryView } from '../components/layout/query-view.js';
import { QueryErrorState } from '../components/query-state.js';
import { SectionCard } from '../components/layout/section-card.js';
import { Button } from '../components/ui/button.js';
import { Progress } from '../components/ui/progress.js';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select.js';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table.js';
import { LinkedCharts } from '../components/performance/linked-charts.js';
import { useGpuNames } from '../components/performance/gpu-names.js';

const RANGES: Array<{ id: PerformanceRange; label: string }> = [
  { id: '15m', label: '15分钟' },
  { id: '1h', label: '1小时' },
  { id: '6h', label: '6小时' },
  { id: '24h', label: '24小时' },
];
const METRICS = 'cpu,memory,disk,gpu,network';

export default function UsagePage({
  mode,
  initialServerId,
}: {
  mode: 'user' | 'admin';
  initialServerId?: string;
}) {
  const navigate = useNavigate();
  const storageKey = mode === 'admin' ? 'nyabase.adminUsage.serverId' : 'nyabase.usage.serverId';
  const [serverId, setServerId] = useState(initialServerId ?? '');
  const [range, setRange] = useState<PerformanceRange>('1h');
  const [view, setView] = useState<'chart' | 'table'>('chart');
  const listPath = mode === 'admin' ? '/admin/performance/usage' : '/performance/usage';
  const listQuery = useQuery({
    queryKey: queryKeys.performance.servers(mode),
    queryFn: () => api.get<PerformanceUsageResponse>(listPath),
    refetchInterval: (query) => queryPollInterval(query.state, { activeIntervalMs: 30_000 }),
  });
  const servers = listQuery.data?.servers ?? [];
  useEffect(() => {
    if (servers.length === 0) return;
    const stored = window.sessionStorage.getItem(storageKey) ?? '';
    const next = [initialServerId, serverId, stored].find((id) => id && servers.some((server) => server.serverId === id))
      ?? servers[0]?.serverId
      ?? '';
    if (next && next !== serverId) setServerId(next);
  }, [servers, initialServerId, serverId, storageKey]);
  useEffect(() => {
    if (serverId) window.sessionStorage.setItem(storageKey, serverId);
  }, [serverId, storageKey]);
  const chosen = servers.some((server) => server.serverId === serverId);
  const snapshotQuery = useQuery({
    queryKey: queryKeys.performance.scoped(mode, serverId),
    queryFn: () => api.get<PerformanceUsageResponse | PerformanceAdminUsageResponse>(`${listPath}?serverId=${serverId}`),
    enabled: chosen,
    refetchInterval: (query) => queryPollInterval(query.state, { activeIntervalMs: 15_000 }),
  });
  const seriesQuery = useQuery({
    queryKey: queryKeys.performance.multi(mode, serverId, 'all', range),
    queryFn: () => api.get<PerformanceMultiSeriesResponse>(
      `${mode === 'admin' ? '/admin/performance/series' : '/performance/series'}?serverId=${serverId}&metrics=${METRICS}&range=${range}`,
    ),
    enabled: chosen && view === 'chart',
    refetchInterval: (query) => queryPollInterval(query.state, { activeIntervalMs: 15_000 }),
  });
  const gpuNames = useGpuNames(serverId || undefined, mode === 'admin');
  const snapshot = snapshotQuery.data?.servers[0];
  const noServers = !listQuery.isLoading && servers.length === 0;
  const tableEmpty = snapshot
    ? ('containers' in snapshot ? snapshot.containers.length === 0 : snapshot.people.length === 0)
    : false;

  return (
    <Page testId={mode === 'admin' ? 'admin-usage' : 'user-usage'}>
      <PageHeader title="使用情况" />
      <div className="flex flex-wrap items-center gap-2">
        <Select value={serverId || undefined} onValueChange={(value) => { setServerId(value); void navigate({ search: { serverId: value } as never }); }}>
          <SelectTrigger className="h-8 w-auto min-w-32 text-sm" aria-label="服务器">
            <SelectValue placeholder="服务器" />
          </SelectTrigger>
          <SelectContent>
            {servers.map((server) => (
              <SelectItem key={server.serverId} value={server.serverId}>{server.serverName}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        {RANGES.map((item) => (
          <Button key={item.id} type="button" size="sm" variant={range === item.id ? 'secondary' : 'ghost'} onClick={() => setRange(item.id)}>{item.label}</Button>
        ))}
        <Button type="button" size="sm" variant={view === 'chart' ? 'secondary' : 'ghost'} onClick={() => setView('chart')}>图表</Button>
        <Button type="button" size="sm" variant={view === 'table' ? 'secondary' : 'ghost'} onClick={() => setView('table')}>表格</Button>
        {snapshot?.stale && snapshot.sampledAt ? <span className="text-xs text-muted-foreground">最近样本 {relativeTime(snapshot.sampledAt)}</span> : null}
      </div>
      <QueryView query={listQuery} resourceName="使用情况" loadingLabel="加载使用情况...">
        {() => noServers ? <p className="text-sm text-muted-foreground">暂无可见服务器</p> : view === 'chart'
          ? seriesQuery.isError
            ? <QueryErrorState error={seriesQuery.error} resourceName="使用情况" onRetry={() => { void seriesQuery.refetch(); }} />
            : seriesQuery.data
              ? <LinkedCharts series={seriesQuery.data} syncId="nyabase-usage" gpuNames={gpuNames} />
              : <p className="text-sm text-muted-foreground">加载图表...</p>
          : tableEmpty
            ? <p className="text-sm text-muted-foreground">这台服务器上还没有容器</p>
            : mode === 'admin'
              ? <AdminUsageTable usage={snapshotQuery.data as PerformanceAdminUsageResponse | undefined} />
              : <UserUsageTable people={snapshot?.people ?? []} host={snapshot?.host} />}
      </QueryView>
    </Page>
  );
}

function UserUsageTable({ people, host }: { people: PerformancePersonRow[]; host?: PerformanceHostSnapshot }) {
  const ordered = useMemo(() => [...people].sort((left, right) => (right.disk.usedBytes ?? -1) - (left.disk.usedBytes ?? -1)), [people]);
  return (
    <SectionCard flush title="用户">
      <Table className="min-w-[880px]">
        <TableHeader>
          <TableRow>
            <TableHead>用户</TableHead>
            <TableHead>CPU</TableHead>
            <TableHead>内存</TableHead>
            <TableHead>磁盘</TableHead>
            <TableHead>显存</TableHead>
            <TableHead>下行</TableHead>
            <TableHead>上行</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {ordered.map((row) => (
            <TableRow key={row.userId}>
              <TableCell><p>{row.displayName}</p><p className="text-xs text-muted-foreground">{row.username}</p></TableCell>
              <TableCell className="tabular-nums" title={shareTitle(row.cpu.usageCores, host?.cpuCount ?? null)}>{coresText(row.cpu.usageCores)}</TableCell>
              <TableCell className="tabular-nums" title={shareTitle(row.memory.usedBytes, host?.memory.limitBytes ?? null)}>{bytesLabel(row.memory.usedBytes)}</TableCell>
              <TableCell title={shareTitle(row.disk.usedBytes, diskCapacity(host))}><DiskMeter used={row.disk.usedBytes} capacity={diskCapacity(host)} /></TableCell>
              <TableCell className="tabular-nums" title={shareTitle(row.gpu.usedBytes, gpuCapacity(host))}>{bytesLabel(row.gpu.usedBytes)}</TableCell>
              <TableCell className="tabular-nums">{rateText(row.network.rxBytesPerSec, '↓')}</TableCell>
              <TableCell className="tabular-nums">{rateText(row.network.txBytesPerSec, '↑')}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </SectionCard>
  );
}

function AdminUsageTable({ usage }: { usage: PerformanceAdminUsageResponse | undefined }) {
  const server = usage?.servers[0];
  const rows = server?.containers ?? [];
  const groups = new Map<string, typeof rows>();
  for (const row of rows) {
    const list = groups.get(row.userId) ?? [];
    list.push(row);
    groups.set(row.userId, list);
  }
  return (
    <SectionCard flush title="容器">
      <Table className="min-w-[1100px]">
        <TableHeader>
          <TableRow>
            <TableHead>用户</TableHead>
            <TableHead>容器</TableHead>
            <TableHead>状态</TableHead>
            <TableHead>CPU</TableHead>
            <TableHead>内存</TableHead>
            <TableHead>磁盘</TableHead>
            <TableHead>显存</TableHead>
            <TableHead>下行</TableHead>
            <TableHead>上行</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {[...groups.values()].flatMap((group) => group.map((row, index) => (
            <TableRow key={row.containerId}>
              {index === 0 ? (
                <TableCell rowSpan={group.length}>
                  <p>{row.displayName}</p>
                  <p className="text-xs text-muted-foreground">{row.username}</p>
                </TableCell>
              ) : null}
              <TableCell>
                <Link to="/manage/containers/$containerId/usage" params={{ containerId: row.containerId }}>{row.name}</Link>
              </TableCell>
              <TableCell>{row.lifecyclePhase === 'active' ? containerStatusLabel(row.powerIntent === 'stopped' ? 'stopped' : 'running') : lifecyclePhaseLabel(row.lifecyclePhase)}</TableCell>
              <TableCell className="tabular-nums" title={shareTitle(row.cpu.usageCores, server?.host.cpuCount ?? null)}>{coresText(row.cpu.usageCores)}</TableCell>
              <TableCell className="tabular-nums" title={shareTitle(row.memory.usedBytes, server?.host.memory.limitBytes ?? null)}>{bytesLabel(row.memory.usedBytes)}</TableCell>
              <TableCell title={shareTitle(row.disk.usedBytes, diskCapacity(server?.host))}><DiskMeter used={row.disk.usedBytes} capacity={diskCapacity(server?.host)} /></TableCell>
              <TableCell className="tabular-nums" title={[shareTitle(row.gpu.usedBytes, gpuCapacity(server?.host)), row.gpu.pciAddresses.join(' ')].filter(Boolean).join(' · ')}>{bytesLabel(row.gpu.usedBytes)}</TableCell>
              <TableCell className="tabular-nums">{rateText(row.network.rxBytesPerSec, '↓')}</TableCell>
              <TableCell className="tabular-nums">{rateText(row.network.txBytesPerSec, '↑')}</TableCell>
            </TableRow>
          )))}
        </TableBody>
      </Table>
      {usage?.truncated ? <p className="px-6 py-2 text-xs text-muted-foreground">只显示前 2000 个容器</p> : null}
    </SectionCard>
  );
}

function DiskMeter({ used, capacity }: { used: number | null; capacity: number | null }) {
  if (used === null) return <span>—</span>;
  const share = capacity !== null && capacity > 0 ? Math.min(used / capacity, 1) : 0;
  return (
    <div className="w-full space-y-1 md:w-36">
      <span className="text-xs tabular-nums">{formatBytesCompact(used)}</span>
      <Progress className="h-1.5" value={share * 100} />
    </div>
  );
}

function coresText(value: number | null): string {
  if (value === null) return '—';
  return `${Math.abs(value) >= 10 ? value.toFixed(0) : value.toFixed(1)} 核`;
}

function bytesLabel(value: number | null): string {
  return value === null ? '—' : formatBytesCompact(value);
}

function shareTitle(used: number | null, total: number | null): string | undefined {
  if (used === null || total === null || total <= 0) return undefined;
  return `占整机 ${formatPercent(used / total)}`;
}

function diskCapacity(host: PerformanceHostSnapshot | undefined): number | null {
  if (!host) return null;
  const disks = host.disks.filter((disk) => disk.sizeBytes !== null && disk.sizeBytes > 0);
  if (disks.length === 0) return null;
  return disks.reduce((sum, disk) => sum + (disk.sizeBytes ?? 0), 0);
}

function gpuCapacity(host: PerformanceHostSnapshot | undefined): number | null {
  if (!host || host.gpus.length === 0 || host.gpus.some((card) => card.totalBytes === null)) return null;
  return host.gpus.reduce((sum, card) => sum + (card.totalBytes ?? 0), 0);
}

function rateText(value: number | null, arrow: '↓' | '↑'): string {
  return value === null ? '—' : `${arrow} ${formatRate(value)}`;
}
