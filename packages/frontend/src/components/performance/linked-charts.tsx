import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { PerformanceChartSeries, PerformanceGpuChartSeries, PerformanceMultiSeriesResponse, PerformanceSeriesLine } from '@nyabase/common';
import { formatBytesCompact, formatPercent, formatRate } from '../../lib/utils.js';
import { SectionCard } from '../layout/section-card.js';
import { formatChartAxis } from './chart-format.js';
import { ChartHover } from './chart-hover.js';
import { gpuChartTitle } from './gpu-names.js';

const COLORS = [
  'hsl(221 83% 53%)',
  'hsl(173 58% 39%)',
  'hsl(32 90% 42%)',
  'hsl(346 72% 48%)',
  'hsl(262 47% 50%)',
  'hsl(199 80% 38%)',
  'hsl(142 45% 34%)',
  'hsl(24 75% 42%)',
];

export function LinkedCharts({
  series,
  syncId,
  height = 'h-60',
  gpuNames,
}: {
  series: PerformanceMultiSeriesResponse;
  syncId: string;
  height?: string;
  gpuNames?: ReadonlyMap<string, string>;
}) {
  const dense = series.range === '15m' || series.range === '1h';
  const main: Array<[string, string, PerformanceChartSeries]> = [
    ['cpu', 'CPU', series.charts.cpu],
    ['memory', '内存', series.charts.memory],
    ['disk', '磁盘', series.charts.disk],
    ['network', '网络', series.charts.network],
  ];
  return (
    <div className="space-y-3">
      {main.map(([key, title, chart]) => (
        <SectionCard key={key} title={title}>
          <div className="px-1">
            <MetricChart chart={chart} times={series.t} syncId={syncId} dense={dense} plotClassName={height} />
          </div>
        </SectionCard>
      ))}
      {series.gpus.map((gpu) => (
        <SectionCard
          key={gpu.pci}
          title={gpuChartTitle(gpu.index, gpu.pci, gpuNames ?? new Map())}
          description={gpu.pci}
        >
          <div className="px-1">
            <MetricChart chart={gpu} times={series.t} syncId={syncId} dense={dense} plotClassName={height} />
          </div>
        </SectionCard>
      ))}
    </div>
  );
}

function MetricChart({
  chart,
  times,
  syncId,
  dense,
  plotClassName,
}: {
  chart: PerformanceChartSeries | PerformanceGpuChartSeries;
  times: string[];
  syncId: string;
  dense: boolean;
  plotClassName: string;
}) {
  const lines = chart.lines;
  if (times.length === 0) {
    return <p className="px-2 text-sm text-muted-foreground">还没有性能样本</p>;
  }
  const yMax = chart.yMax != null && chart.yMax > 0 ? chart.yMax : null;
  const data = times.map((time, index) => {
    const row: Record<string, string | number | null> = { t: time };
    for (const line of lines) row[line.key] = line.points[index]?.v ?? null;
    return row;
  });
  const formatAbsolute = (value: number) => chart.unit === 'cores'
    ? formatCores(value)
    : chart.unit === 'bytes'
      ? formatBytesCompact(value)
      : formatRate(value);
  const formatValue = (value: number) => {
    const absolute = formatAbsolute(value);
    return yMax === null ? absolute : `${absolute} · ${formatPercent(value / yMax)}`;
  };
  return (
    <div className="flex h-full flex-col">
      <div className={plotClassName}>
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} syncId={syncId} margin={{ top: 12, right: 12, left: 0, bottom: 4 }}>
            <CartesianGrid stroke="hsl(var(--border))" vertical={false} />
            <XAxis
              dataKey="t"
              tickFormatter={(value: unknown) => formatChartAxis(value, dense)}
              tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }}
              minTickGap={36}
              axisLine={false}
              tickLine={false}
            />
            <YAxis
              width={chart.unit === 'bytes_per_sec' ? 72 : 56}
              domain={yMax === null ? [0, 'auto'] : [0, yMax]}
              allowDataOverflow={yMax !== null}
              padding={{ top: 8, bottom: 14 }}
              tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }}
              axisLine={false}
              tickLine={false}
              tickFormatter={(value: number) => formatAbsolute(value)}
            />
            <Tooltip
              isAnimationActive={false}
              cursor={{ stroke: 'hsl(var(--border))', strokeWidth: 1 }}
              wrapperStyle={{ outline: 'none', zIndex: 30 }}
              content={(props) => (
                <ChartHover
                  active={props.active}
                  payload={props.payload}
                  label={props.label}
                  withSeconds={dense}
                  formatValue={formatValue}
                  nameFor={(key) => lines.find((item) => item.key === key)?.label ?? key}
                />
              )}
            />
            {lines.map((line) => {
              const color = colorFor(line.key);
              return (
                <Area
                  key={line.key}
                  type="linear"
                  dataKey={line.key}
                  stroke={color}
                  fill={color}
                  fillOpacity={0.14}
                  strokeWidth={2}
                  dot={false}
                  activeDot={{ r: 3, strokeWidth: 0, fill: color }}
                  isAnimationActive={false}
                  connectNulls={false}
                />
              );
            })}
          </AreaChart>
        </ResponsiveContainer>
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1 px-2 pt-1 text-[11px] text-muted-foreground">
        {lines.map((line) => {
          const latest = latestValue(line);
          return (
            <span key={line.key} className="inline-flex items-center gap-1.5 tabular-nums">
              <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: colorFor(line.key) }} />
              {line.label}
              {latest === null ? null : ` · ${formatValue(latest)}`}
            </span>
          );
        })}
      </div>
    </div>
  );
}

function latestValue(line: PerformanceSeriesLine): number | null {
  for (let index = line.points.length - 1; index >= 0; index -= 1) {
    const value = line.points[index]?.v;
    if (value != null) return value;
  }
  return null;
}

function formatCores(value: number): string {
  const text = Math.abs(value) >= 10 ? String(Math.round(value)) : value.toFixed(1);
  return `${text} 核`;
}

function colorFor(key: string): string {
  if (key === 'host' || key === 'other') return 'hsl(221 83% 53%)';
  let result = 0;
  for (const char of key) result = (result * 33 + char.charCodeAt(0)) >>> 0;
  return COLORS[result % COLORS.length] ?? COLORS[0];
}
