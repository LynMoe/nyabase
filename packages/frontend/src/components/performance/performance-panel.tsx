import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Area, AreaChart, ResponsiveContainer, Tooltip as ChartTooltip, XAxis, YAxis } from 'recharts';
import {
  Activity,
  Cpu,
  Gauge,
  HardDrive,
} from 'lucide-react';
import {
  type PerformanceAdminUsageResponse,
  type PerformanceContainerRow,
  type PerformanceMetric,
  type PerformancePersonRow,
  type PerformanceRange,
  type PerformanceSeriesResponse,
  type PerformanceUsageResponse,
} from '@nyabase/common';
import { api } from '../../lib/api.js';
import { queryKeys } from '../../lib/query-keys.js';
import { queryPollInterval } from '../../lib/query-lifecycle.js';
import { formatBytesCompact, formatPercent, formatRate, relativeTime, usedTotalLabel } from '../../lib/utils.js';
import { ChartHover } from './chart-hover.js';
import { containerStatusLabel, lifecyclePhaseLabel } from '../../lib/status-labels.js';
import { SummaryCard } from '../dashboard/summary-card.js';
import { QueryView } from '../layout/query-view.js';
import { SectionCard } from '../layout/section-card.js';
import { Button } from '../ui/button.js';
import { Progress } from '../ui/progress.js';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select.js';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../ui/table.js';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../ui/tooltip.js';

type Mode = 'user' | 'admin';
type SortKey = 'cpu' | 'memory' | 'gpu' | 'disk';

const METRICS: Array<{ id: PerformanceMetric; label: string }> = [
  { id: 'cpu', label: 'CPU' },
  { id: 'memory', label: '内存' },
  { id: 'disk', label: '磁盘' },
  { id: 'gpu', label: '显存' },
  { id: 'network', label: '网络' },
];
const RANGES: Array<{ id: PerformanceRange; label: string }> = [
  { id: '15m', label: '15分钟' },
  { id: '1h', label: '1小时' },
  { id: '6h', label: '6小时' },
  { id: '24h', label: '24小时' },
];
const COLORS = ['#0f766e', '#b45309', '#1d4ed8', '#be123c', '#4338ca', '#047857', '#0369a1', '#a16207', '#64748b'];

export function PerformancePanel({
  mode,
  serverId,
}: {
  mode: Mode;
  serverId?: string;
}) {
  const [serverFilter, setServerFilter] = useState(serverId ?? 'all');
  const [userFilter, setUserFilter] = useState('all');
  const [metric, setMetric] = useState<PerformanceMetric>('cpu');
  const [range, setRange] = useState<PerformanceRange>('1h');
  const [chartBy, setChartBy] = useState<'person' | 'container'>('person');
  const [selectedContainerId, setSelectedContainerId] = useState<string | null>(null);
  const lockedServer = serverId ?? (serverFilter === 'all' ? undefined : serverFilter);
  const serverKey = lockedServer ?? 'all';
  const usagePath = mode === 'admin' ? '/admin/performance/usage' : '/performance/usage';
  const seriesPath = mode === 'admin' ? '/admin/performance/series' : '/performance/series';
  const usageQuery = useQuery({
    queryKey: mode === 'admin' ? queryKeys.performance.admin(serverKey) : queryKeys.performance.user(serverKey),
    queryFn: () => api.get<PerformanceUsageResponse | PerformanceAdminUsageResponse>(
      withQuery(usagePath, { serverId: lockedServer }),
    ),
    refetchInterval: (query) => queryPollInterval(query.state, { activeIntervalMs: 15_000 }),
  });
  const seriesQuery = useQuery({
    queryKey: queryKeys.performance.series(
      mode,
      serverKey,
      userFilter,
      chartBy === 'container' && selectedContainerId ? selectedContainerId : 'all',
      metric,
      range,
    ),
    queryFn: () => api.get<PerformanceSeriesResponse>(withQuery(seriesPath, {
      serverId: lockedServer,
      userId: userFilter === 'all' ? undefined : userFilter,
      containerId: mode === 'admin' && chartBy === 'container' ? selectedContainerId ?? undefined : undefined,
      metric,
      range,
    })),
    refetchInterval: (query) => queryPollInterval(query.state, { activeIntervalMs: 15_000 }),
  });

  return (
    <QueryView query={usageQuery} resourceName="性能" loadingLabel="加载性能...">
      {(usage) => (
        <PerformanceView
          mode={mode}
          usage={usage}
          series={seriesQuery.data}
          serverId={serverId}
          serverFilter={serverId ?? serverFilter}
          userFilter={userFilter}
          metric={metric}
          range={range}
          chartBy={chartBy}
          selectedContainerId={selectedContainerId}
          onServerFilter={(value) => {
            setServerFilter(value);
            setUserFilter('all');
            setSelectedContainerId(null);
            setChartBy('person');
          }}
          onUserFilter={setUserFilter}
          onMetric={setMetric}
          onRange={setRange}
          onChartBy={setChartBy}
          onSelectContainer={(id) => {
            setSelectedContainerId(id);
            setChartBy('container');
          }}
        />
      )}
    </QueryView>
  );
}

export function PerformanceView({
  mode,
  usage,
  series,
  serverId,
  serverFilter,
  userFilter,
  metric,
  range,
  chartBy,
  selectedContainerId,
  onServerFilter,
  onUserFilter,
  onMetric,
  onRange,
  onChartBy,
  onSelectContainer,
}: {
  mode: Mode;
  usage: PerformanceUsageResponse | PerformanceAdminUsageResponse;
  series?: PerformanceSeriesResponse;
  serverId?: string;
  serverFilter: string;
  userFilter: string;
  metric: PerformanceMetric;
  range: PerformanceRange;
  chartBy: 'person' | 'container';
  selectedContainerId: string | null;
  onServerFilter: (value: string) => void;
  onUserFilter: (value: string) => void;
  onMetric: (value: PerformanceMetric) => void;
  onRange: (value: PerformanceRange) => void;
  onChartBy: (value: 'person' | 'container') => void;
  onSelectContainer: (id: string) => void;
}) {
  const people = usage.servers.flatMap((server) =>
    server.people
      .filter((person) => userFilter === 'all' || person.userId === userFilter)
      .map((person) => ({ ...person, serverId: server.serverId, serverName: server.serverName, stale: server.stale, sampledAt: server.sampledAt })));
  const containers = mode === 'admin'
    ? (usage as PerformanceAdminUsageResponse).servers.flatMap((server) =>
      server.containers
        .filter((container) => userFilter === 'all' || container.userId === userFilter)
        .map((container) => ({ ...container, serverName: server.serverName })))
    : [];
  const users = uniqueUsers(usage);
  const summary = summarize(people);
  const staleServer = usage.servers.find((server) => server.stale && server.sampledAt);
  const empty = emptyCopy(usage, people);

  return (
    <section className="space-y-4" data-testid={mode === 'admin' ? 'admin-performance' : 'user-performance'}>
      <div className="flex flex-wrap items-center gap-2">
        {serverId ? null : (
          <FilterSelect label="服务器" value={serverFilter} onChange={onServerFilter} options={[
            { value: 'all', label: '全部服务器' },
            ...usage.servers.map((server) => ({ value: server.serverId, label: server.serverName })),
          ]} />
        )}
        <FilterSelect label="用户" value={userFilter} onChange={onUserFilter} options={[
          { value: 'all', label: '全部用户' },
          ...users.map((user) => ({ value: user.userId, label: user.displayName })),
        ]} />
        <FilterSelect
          label="图表"
          value={metric}
          onChange={(value) => onMetric(value as PerformanceMetric)}
          options={METRICS.map((item) => ({ value: item.id, label: item.label }))}
        />
        <div className="flex flex-wrap gap-1">
          {RANGES.map((item) => (
            <Button
              key={item.id}
              type="button"
              size="sm"
              variant={range === item.id ? 'secondary' : 'ghost'}
              onClick={() => onRange(item.id)}
            >
              {item.label}
            </Button>
          ))}
        </div>
        {mode === 'admin' && selectedContainerId ? (
          <div className="flex gap-1">
            <Button type="button" size="sm" variant={chartBy === 'person' ? 'secondary' : 'ghost'} onClick={() => onChartBy('person')}>按人</Button>
            <Button type="button" size="sm" variant={chartBy === 'container' ? 'secondary' : 'ghost'} onClick={() => onChartBy('container')}>按容器</Button>
          </div>
        ) : null}
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <SummaryCard icon={Cpu} label="CPU" value={summary.cpu} detail={summary.cpuDetail} />
        <SummaryCard icon={Activity} label="内存" value={summary.memory} detail={summary.memoryDetail} />
        <SummaryCard icon={Gauge} label="显存" value={summary.gpu} detail={summary.gpuDetail} />
        <SummaryCard icon={HardDrive} label="磁盘" value={summary.disk} detail={summary.diskDetail} />
      </div>

      {empty ? <p className="text-sm text-muted-foreground">{empty}</p> : (
        <SectionCard title="性能" toolbar={staleServer?.sampledAt ? <span className="text-xs text-muted-foreground">最近样本 {relativeTime(staleServer.sampledAt)}</span> : undefined}>
          <div className="h-40 px-2">
            <PerformanceChart metric={metric} series={series} />
          </div>
        </SectionCard>
      )}

      <PersonTable rows={people} />
      {mode === 'admin' ? (
        <ContainerTable rows={containers} selectedId={selectedContainerId} onSelect={onSelectContainer} />
      ) : null}
      {usage.servers.some((server) => server.stale) && !empty ? null : null}
      {'truncated' in usage && usage.truncated ? (
        <p className="text-xs text-muted-foreground">只显示前 2000 个容器</p>
      ) : null}
    </section>
  );
}

function PerformanceChart({
  metric,
  series,
}: {
  metric: PerformanceMetric;
  series?: PerformanceSeriesResponse;
}) {
  const lines = series?.lines ?? [];
  const data = (lines[0]?.points ?? []).map((point, index) => {
    const row: Record<string, string | number | null> = { t: point.t };
    for (const line of lines) row[line.key] = line.points[index]?.v ?? null;
    return row;
  });
  if (data.length === 0) return <p className="px-4 text-sm text-muted-foreground">还没有性能样本</p>;
  const percent = metric !== 'network';
  return (
    <ResponsiveContainer width="100%" height="100%">
      <AreaChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <XAxis dataKey="t" hide />
        <YAxis
          width={48}
          tickFormatter={(value: number) => percent ? formatPercent(value) : formatRate(value)}
          tick={{ fontSize: 11 }}
        />
        <ChartTooltip
          isAnimationActive={false}
          cursor={{ stroke: 'hsl(var(--border))', strokeWidth: 1 }}
          wrapperStyle={{ outline: 'none', zIndex: 30 }}
          content={(props) => (
            <ChartHover
              active={props.active}
              payload={props.payload}
              label={props.label}
              formatValue={(value) => percent ? formatPercent(value) : formatRate(value)}
              nameFor={(key) => lines.find((item) => item.key === key)?.label ?? key}
            />
          )}
        />
        {lines.map((line, index) => (
          <Area
            key={line.key}
            type="monotone"
            dataKey={line.key}
            name={line.key}
            stroke={COLORS[index % COLORS.length]}
            fill={COLORS[index % COLORS.length]}
            fillOpacity={0.12}
            strokeWidth={1.25}
            dot={false}
            activeDot={{ r: 2.5, strokeWidth: 0 }}
            isAnimationActive={false}
            connectNulls
          />
        ))}
      </AreaChart>
    </ResponsiveContainer>
  );
}

function PersonTable({
  rows,
}: {
  rows: Array<PerformancePersonRow & { serverName: string; sampledAt: string | null }>;
}) {
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({ key: 'disk', dir: 'desc' });
  const ordered = useMemo(() => sortRows(rows, sort, (row) => ratioValue(row, sort.key), (row) => row.username), [rows, sort]);
  return (
    <SectionCard flush title="用户">
      <Table className="min-w-[880px]">
        <TableHeader>
          <TableRow>
            <TableHead>服务器</TableHead>
            <TableHead>用户</TableHead>
            <TableHead>容器</TableHead>
            <SortHead label="CPU" active={sort.key === 'cpu'} dir={sort.dir} onClick={() => setSort(toggleSort(sort, 'cpu'))} />
            <SortHead label="内存" active={sort.key === 'memory'} dir={sort.dir} onClick={() => setSort(toggleSort(sort, 'memory'))} />
            <SortHead label="显存" active={sort.key === 'gpu'} dir={sort.dir} onClick={() => setSort(toggleSort(sort, 'gpu'))} />
            <SortHead label="磁盘" active={sort.key === 'disk'} dir={sort.dir} onClick={() => setSort(toggleSort(sort, 'disk'))} />
            <TableHead>下行</TableHead>
            <TableHead>上行</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {ordered.map((row) => (
            <TableRow key={`${row.serverName}-${row.userId}`}>
              <TableCell>{row.serverName}</TableCell>
              <TableCell>
                <p>{row.displayName}</p>
                <p className="text-xs text-muted-foreground">{row.username}</p>
              </TableCell>
              <TableCell>
                {row.containerCount}
                {row.missingSamples > 0 ? (
                  <p className="text-xs text-muted-foreground">{row.missingSamples} 个容器暂无样本</p>
                ) : null}
              </TableCell>
              <TableCell className="tabular-nums">{cpuText(row.cpu)}</TableCell>
              <TableCell className="tabular-nums">{bytesText(row.memory.usedBytes, row.memory.ratio)}</TableCell>
              <TableCell className="tabular-nums">{gpuText(row.gpu.usedBytes, row.gpu.ratio)}</TableCell>
              <TableCell><DiskMeter used={row.disk.usedBytes} size={row.disk.sizeBytes} ratio={row.disk.ratio} /></TableCell>
              <TableCell className="tabular-nums">{rateText(row.network.rxBytesPerSec, '↓')}</TableCell>
              <TableCell className="tabular-nums">{rateText(row.network.txBytesPerSec, '↑')}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </SectionCard>
  );
}

function ContainerTable({
  rows,
  selectedId,
  onSelect,
}: {
  rows: Array<PerformanceContainerRow & { serverName: string }>;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const names = new Map<string, number>();
  for (const row of rows) names.set(row.name, (names.get(row.name) ?? 0) + 1);
  return (
    <SectionCard flush title="容器">
      <Table className="min-w-[1100px]">
        <TableHeader>
          <TableRow>
            <TableHead>容器</TableHead>
            <TableHead>用户</TableHead>
            <TableHead>状态</TableHead>
            <TableHead>CPU</TableHead>
            <TableHead>内存</TableHead>
            <TableHead>显存</TableHead>
            <TableHead>磁盘</TableHead>
            <TableHead>读</TableHead>
            <TableHead>写</TableHead>
            <TableHead>下行</TableHead>
            <TableHead>上行</TableHead>
            <TableHead>数据卷</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => {
            const volumeUsed = sum(row.volumes.map((volume) => volume.usedBytes));
            const volumeSize = sum(row.volumes.map((volume) => volume.sizeBytes));
            return (
              <TableRow
                key={row.containerId}
                className={selectedId === row.containerId ? 'bg-muted/50' : undefined}
                onClick={() => onSelect(row.containerId)}
              >
                <TableCell>
                  <p>{row.name}</p>
                  {(names.get(row.name) ?? 0) > 1 ? <p className="font-mono text-xs text-muted-foreground">{row.containerId.slice(0, 8)}</p> : null}
                </TableCell>
                <TableCell>
                  <p>{row.displayName}</p>
                  <p className="text-xs text-muted-foreground">{row.username}</p>
                </TableCell>
                <TableCell>{statusText(row.lifecyclePhase, row.powerIntent)}</TableCell>
                <TableCell className="tabular-nums">{cpuText(row.cpu)}</TableCell>
                <TableCell className="tabular-nums">{bytesText(row.memory.usedBytes, row.memory.ratio)}</TableCell>
                <TableCell className="tabular-nums">
                  <GpuCell used={row.gpu.usedBytes} ratio={row.gpu.ratio} pci={row.gpu.pciAddresses} />
                </TableCell>
                <TableCell><DiskMeter used={row.disk.usedBytes} size={row.disk.sizeBytes} ratio={row.disk.ratio} /></TableCell>
                <TableCell className="tabular-nums">{rateText(row.disk.readBytesPerSec, '↓')}</TableCell>
                <TableCell className="tabular-nums">{rateText(row.disk.writeBytesPerSec, '↑')}</TableCell>
                <TableCell className="tabular-nums">{rateText(row.network.rxBytesPerSec, '↓')}</TableCell>
                <TableCell className="tabular-nums">{rateText(row.network.txBytesPerSec, '↑')}</TableCell>
                <TableCell>
                  {row.volumes.length === 0 ? '—' : <DiskMeter used={volumeUsed} size={volumeSize} ratio={volumeSize && volumeUsed !== null ? volumeUsed / volumeSize : null} />}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </SectionCard>
  );
}

function GpuCell({ used, ratio, pci }: { used: number | null; ratio: number | null; pci: string[] }) {
  const text = gpuText(used, ratio);
  if (pci.length === 0) return text;
  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span>{text}</span>
        </TooltipTrigger>
        <TooltipContent>{pci.join(' ')}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function DiskMeter({ used, size, ratio }: { used: number | null; size: number | null; ratio: number | null }) {
  if (used === null && size === null) return <span>—</span>;
  return (
    <div className="w-full space-y-1 md:w-44">
      <div className="flex justify-between text-xs tabular-nums">
        <span>{usedTotalLabel(used, size)}</span>
        <span>{ratio === null ? '—' : formatPercent(ratio)}</span>
      </div>
      <Progress className="h-1.5" value={ratio === null ? 0 : Math.min(ratio, 1) * 100} />
    </div>
  );
}

function FilterSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="h-8 w-auto min-w-32 text-sm" aria-label={label}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function SortHead({
  label,
  active,
  dir,
  onClick,
}: {
  label: string;
  active: boolean;
  dir: 'asc' | 'desc';
  onClick: () => void;
}) {
  return (
    <TableHead>
      <button type="button" className="inline-flex items-center gap-1" onClick={onClick}>
        {label}
        <span className="text-xs text-muted-foreground">{active ? (dir === 'desc' ? '↓' : '↑') : ''}</span>
      </button>
    </TableHead>
  );
}

function toggleSort(current: { key: SortKey; dir: 'asc' | 'desc' }, key: SortKey) {
  if (current.key === key) return { key, dir: current.dir === 'desc' ? 'asc' as const : 'desc' as const };
  return { key, dir: 'desc' as const };
}

function sortRows<T>(
  rows: T[],
  sort: { key: SortKey; dir: 'asc' | 'desc' },
  ratio: (row: T) => number,
  name: (row: T) => string,
): T[] {
  return [...rows].sort((left, right) => {
    const delta = ratio(left) - ratio(right);
    if (delta !== 0) return sort.dir === 'desc' ? -delta : delta;
    return name(left).localeCompare(name(right));
  });
}

function ratioValue(row: PerformancePersonRow, key: SortKey): number {
  if (key === 'cpu') return row.cpu.ratio ?? -1;
  if (key === 'memory') return row.memory.ratio ?? -1;
  if (key === 'gpu') return row.gpu.ratio ?? -1;
  return row.disk.ratio ?? -1;
}

function summarize(rows: PerformancePersonRow[]) {
  const cpuUsed = sum(rows.map((row) => row.cpu.usageCores));
  const cpuLimit = rows.some((row) => row.cpu.limitCores === null) ? null : sum(rows.map((row) => row.cpu.limitCores));
  const memUsed = sum(rows.map((row) => row.memory.usedBytes));
  const memLimit = rows.some((row) => row.memory.limitBytes === null) ? null : sum(rows.map((row) => row.memory.limitBytes));
  const gpuUsed = sum(rows.map((row) => row.gpu.usedBytes));
  const gpuLimit = rows.some((row) => row.gpu.limitBytes === null) ? null : sum(rows.map((row) => row.gpu.limitBytes));
  const diskUsed = sum(rows.map((row) => row.disk.usedBytes));
  const diskSize = sum(rows.map((row) => row.disk.sizeBytes));
  return {
    cpu: ratioLabel(cpuUsed, cpuLimit, (value) => `${trimNumber(value)} 核`),
    cpuDetail: cpuLimit === null ? '不限' : `${trimNumber(cpuUsed ?? 0)} / ${trimNumber(cpuLimit)} 核`,
    memory: ratioLabel(memUsed, memLimit, formatBytesCompact),
    memoryDetail: memLimit === null ? '不限' : usedTotalLabel(memUsed, memLimit),
    gpu: ratioLabel(gpuUsed, gpuLimit, formatBytesCompact),
    gpuDetail: gpuLimit === null ? '不限' : usedTotalLabel(gpuUsed, gpuLimit),
    disk: diskUsed !== null && diskSize ? formatPercent(diskUsed / diskSize) : '—',
    diskDetail: usedTotalLabel(diskUsed, diskSize),
  };
}

function ratioLabel(
  used: number | null,
  limit: number | null,
  format: (value: number) => string,
): string {
  if (used === null && limit === null) return '—';
  if (limit === null || limit <= 0) return used === null ? '不限' : `${format(used)} · 不限`;
  if (used === null) return '—';
  return formatPercent(used / limit);
}

function cpuText(cpu: { usageCores: number | null; limitCores: number | null; ratio: number | null }): string {
  if (cpu.usageCores === null && cpu.ratio === null) return '—';
  const cores = cpu.usageCores === null ? '—' : `${trimNumber(cpu.usageCores)} 核`;
  const percent = cpu.limitCores === null || cpu.ratio === null ? '不限' : formatPercent(cpu.ratio);
  return `${cores} · ${percent}`;
}

function bytesText(used: number | null, ratio: number | null): string {
  if (used === null && ratio === null) return '—';
  if (ratio === null) return used === null ? '不限' : `${formatBytesCompact(used)} · 不限`;
  return `${used === null ? '—' : formatBytesCompact(used)} · ${formatPercent(ratio)}`;
}

function gpuText(used: number | null, ratio: number | null): string {
  if (used === null && ratio === null) return '—';
  return bytesText(used, ratio);
}

function rateText(value: number | null, arrow: '↓' | '↑'): string {
  if (value === null) return '—';
  return `${arrow} ${formatRate(value)}`;
}

function statusText(phase: string, power: string): string {
  if (phase !== 'active') return lifecyclePhaseLabel(phase);
  return containerStatusLabel(power === 'stopped' ? 'stopped' : 'running');
}

function emptyCopy(usage: PerformanceUsageResponse, people: readonly unknown[]): string | null {
  if (usage.servers.length === 0) return '暂无可见服务器';
  const containers = usage.servers.reduce((sum, server) => sum + server.people.reduce((inner, person) => inner + person.containerCount, 0), 0);
  if (containers === 0) return '这些服务器上还没有容器';
  const hasSample = people.some((person) => {
    const row = person as PerformancePersonRow;
    return row.cpu.usageCores !== null || row.memory.usedBytes !== null || row.disk.usedBytes !== null;
  });
  if (!hasSample) return '还没有性能样本';
  return null;
}

function uniqueUsers(usage: PerformanceUsageResponse) {
  const users = new Map<string, { userId: string; displayName: string }>();
  for (const server of usage.servers) {
    for (const person of server.people) {
      users.set(person.userId, { userId: person.userId, displayName: person.displayName });
    }
  }
  return [...users.values()];
}

function trimNumber(value: number): string {
  return value >= 10 ? value.toFixed(0) : value.toFixed(1);
}

function sum(values: Array<number | null>): number | null {
  const present = values.filter((value): value is number => value !== null && Number.isFinite(value));
  if (present.length === 0) return null;
  return present.reduce((total, value) => total + value, 0);
}

function withQuery(path: string, query: Record<string, string | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value) params.set(key, value);
  }
  const text = params.toString();
  return text ? `${path}?${text}` : path;
}
