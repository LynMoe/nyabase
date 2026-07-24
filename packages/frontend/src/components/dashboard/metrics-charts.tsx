/**
 * Recharts-using chart primitives. Imported lazily so recharts stays out of
 * the first-paint bundle.
 */
import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { Activity, Cpu } from 'lucide-react';
import type { GpuMetricsDto, HostMetricsDto, MetricSeries } from '@nyabase/common';

import { api } from '../../lib/api.js';
import {
  hostDiskCapacityTitle,
  hostDiskIoChartEntries,
  hostNetIoChartEntries,
} from '../../lib/host-metrics-presentation.js';
import { formatBytesCompact } from '../../lib/utils.js';
import { QueryErrorState } from '../query-state.js';
import { queryPollInterval } from '../../lib/query-lifecycle.js';
import {
  AXIS_TICK, GRID_STROKE, SectionHeader, SkeletonSection, TIP_STYLE,
  colorFor, fmtBps, fmtPercent, multiSeriesData, singleSeriesData,
} from './metrics-shared.js';

export function ChartCard({
  title, height = 160, children,
}: {
  title: string; height?: number; children: ReactNode;
}) {
  return (
    <div className="bg-card rounded-lg border p-4">
      <p className="text-xs font-medium text-muted-foreground mb-3">{title}</p>
      <ResponsiveContainer width="100%" height={height}>
        {children as React.ReactElement}
      </ResponsiveContainer>
    </div>
  );
}

export function SingleLineChartImpl({
  title, series, yFormatter, unit,
}: {
  title: string;
  series: MetricSeries;
  yFormatter?: (v: number) => string;
  unit?: string;
}) {
  const data = singleSeriesData(series);
  return (
    <ChartCard title={title}>
      <LineChart data={data}>
        <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} />
        <XAxis dataKey="time" tick={AXIS_TICK} tickLine={false} interval="preserveStartEnd" />
        <YAxis tick={AXIS_TICK} tickLine={false} axisLine={false} tickFormatter={yFormatter} width={48} />
        <Tooltip
          contentStyle={TIP_STYLE}
          separator=""
          formatter={(v: number) => [yFormatter ? yFormatter(v) : `${v}${unit ?? ''}`, '']}
        />
        <Line type="monotone" dataKey="value" dot={false} strokeWidth={2} stroke="#3b82f6" connectNulls />
      </LineChart>
    </ChartCard>
  );
}

export function InlineSingleLineChartImpl({
  title, series, yFormatter, height = 150, unit,
}: {
  title: string;
  series: MetricSeries;
  yFormatter?: (v: number) => string;
  height?: number;
  unit?: string;
}) {
  const data = singleSeriesData(series);
  return (
    <div className="min-w-0">
      <p className="text-xs font-medium text-muted-foreground mb-2">{title}</p>
      <ResponsiveContainer width="100%" height={height}>
        <LineChart data={data}>
          <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} />
          <XAxis dataKey="time" tick={AXIS_TICK} tickLine={false} interval="preserveStartEnd" />
          <YAxis tick={AXIS_TICK} tickLine={false} axisLine={false} tickFormatter={yFormatter} width={48} />
          <Tooltip
            contentStyle={TIP_STYLE}
            separator=""
            formatter={(v: number) => [yFormatter ? yFormatter(v) : `${v}${unit ?? ''}`, '']}
          />
          <Line type="monotone" dataKey="value" dot={false} strokeWidth={2} stroke="#3b82f6" connectNulls />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

export function MultiLineChartImpl({
  title, entries, yFormatter,
}: {
  title: string;
  entries: Array<{ key: string; label: string; series: MetricSeries }>;
  yFormatter?: (v: number) => string;
}) {
  const data = multiSeriesData(entries);
  if (data.length === 0) {
    return (
      <ChartCard title={title}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
          <span style={{ fontSize: 12, color: '#9ca3af' }}>暂无数据</span>
        </div>
      </ChartCard>
    );
  }
  return (
    <ChartCard title={title} height={180}>
      <LineChart data={data}>
        <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} />
        <XAxis dataKey="time" tick={AXIS_TICK} tickLine={false} interval="preserveStartEnd" />
        <YAxis tick={AXIS_TICK} tickLine={false} axisLine={false} tickFormatter={yFormatter} width={52} />
        <Tooltip
          contentStyle={TIP_STYLE}
          formatter={(v: number, key: string) => {
            const label = entries.find((e) => e.key === key)?.label ?? key;
            return [yFormatter ? yFormatter(v) : v, label];
          }}
        />
        <Legend
          iconSize={8}
          wrapperStyle={{ fontSize: 11 }}
          formatter={(key: string) => entries.find((e) => e.key === key)?.label ?? key}
        />
        {entries.map(({ key }) => (
          <Line
            key={key}
            type="monotone"
            dataKey={key}
            dot={false}
            strokeWidth={2}
            stroke={colorFor(key)}
            connectNulls
          />
        ))}
      </LineChart>
    </ChartCard>
  );
}

export function HostSectionImpl({ serverId, range, admin = false }: { serverId: string; range: string; admin?: boolean }) {
  const basePath = admin ? '/admin/metrics' : '/metrics';
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['metrics-host', admin ? 'admin' : 'user', serverId, range],
    queryFn: () => api.get<HostMetricsDto>(`${basePath}/servers/${serverId}/host?range=${range}`),
    staleTime: 30_000,
    refetchInterval: (query) => queryPollInterval(query.state, { activeIntervalMs: 60_000 }),
    retry: false,
  });

  if (isLoading) return <SkeletonSection rows={2} />;
  if (error || !data) {
    return <QueryErrorState error={error ?? new Error('未收到主机指标数据')} resourceName="主机指标" onRetry={() => void refetch()} />;
  }

  return (
    <div className="space-y-3">
      <SectionHeader icon={<Activity className="h-4 w-4 text-blue-500" />} title="主机资源" />

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        <SingleLineChartImpl title="CPU 利用率" series={data.cpu} yFormatter={(v) => `${(v * 100).toFixed(0)}%`} />
        <SingleLineChartImpl title="内存用量" series={data.memUsed} yFormatter={formatBytesCompact} />
        <SingleLineChartImpl title="1min 负载" series={data.load1} yFormatter={(v) => v.toFixed(2)} />
      </div>

      {data.disks.length > 0 && (
        <div className={`grid gap-3 ${data.disks.length === 1 ? 'grid-cols-1' : 'grid-cols-1 sm:grid-cols-2'}`}>
          {data.disks.map((d) => (
            <SingleLineChartImpl
              key={d.diskId}
              title={hostDiskCapacityTitle(d)}
              series={d.used}
              yFormatter={formatBytesCompact}
            />
          ))}
        </div>
      )}

      {(data.diskIo.length > 0 || data.netIo.length > 0) && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {data.diskIo.length > 0 && (
            <MultiLineChartImpl
              title="磁盘 IO（读 + 写）"
              entries={hostDiskIoChartEntries(data.diskIo)}
              yFormatter={fmtBps}
            />
          )}
          {data.netIo.length > 0 && (
            <MultiLineChartImpl
              title="网络 IO（收 + 发）"
              entries={hostNetIoChartEntries(data.netIo)}
              yFormatter={fmtBps}
            />
          )}
        </div>
      )}
    </div>
  );
}

export function GpuSectionImpl({ serverId, range, admin = false }: { serverId: string; range: string; admin?: boolean }) {
  const basePath = admin ? '/admin/metrics' : '/metrics';
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['metrics-gpus', admin ? 'admin' : 'user', serverId, range],
    queryFn: () => api.get<GpuMetricsDto>(`${basePath}/servers/${serverId}/gpus?range=${range}`),
    staleTime: 30_000,
    refetchInterval: (query) => queryPollInterval(query.state, { activeIntervalMs: 60_000 }),
    retry: false,
  });

  if (isLoading) return <SkeletonSection rows={1} />;
  if (error) {
    return <QueryErrorState error={error} resourceName="GPU 指标" onRetry={() => void refetch()} />;
  }
  if (!data || data.gpus.length === 0) return null;

  return (
    <div className="space-y-3">
      <SectionHeader icon={<Cpu className="h-4 w-4 text-purple-500" />} title="GPU" />
      {data.gpus.map((gpu) => (
        <div key={gpu.index} className="space-y-1">
          <p className="text-xs text-muted-foreground font-medium">
            GPU {gpu.index} — {gpu.model}
            {gpu.memTotalMiB > 0 && ` (${gpu.memTotalMiB} MiB)`}
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-5 gap-3">
            <SingleLineChartImpl title="利用率" series={gpu.util} yFormatter={fmtPercent} />
            <SingleLineChartImpl title="显存用量" series={gpu.memUsed} yFormatter={formatBytesCompact} />
            <SingleLineChartImpl title="温度 (°C)" series={gpu.temp} yFormatter={(v) => `${v.toFixed(0)}°C`} />
            <SingleLineChartImpl title="功耗 (W)" series={gpu.power} yFormatter={(v) => `${v.toFixed(0)}W`} />
            <SingleLineChartImpl
              title="图形时钟 (MHz)"
              series={gpu.graphicsClockMHz}
              yFormatter={(v) => `${v.toFixed(0)} MHz`}
            />
          </div>
        </div>
      ))}
    </div>
  );
}
