import { Area, AreaChart, CartesianGrid, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { PerformanceGpuUtilizationSeries } from '@nyabase/common';
import { formatPercent } from '../../lib/utils.js';
import { ChartHover, formatChartAxis } from './chart-hover.js';
import { chartColor, latestValue } from './chart-lines.js';

const SM_PREFIX = 'sm:';
const BANDWIDTH_PREFIX = 'bw:';
const TICKS = [-1, -0.5, 0, 0.5, 1];

/**
 * Mirrored stacked areas for one card: SM time share above the axis, memory
 * controller share below it, one colour per line in both halves. Without MPS
 * a card time-slices between processes, so each half stacks to at most 100%.
 */
export function GpuUtilizationChart({
  utilization,
  times,
  syncId,
  dense,
  plotClassName,
}: {
  utilization: PerformanceGpuUtilizationSeries;
  times: string[];
  syncId: string;
  dense: boolean;
  plotClassName: string;
}) {
  const lines = utilization.sm.map((line, index) => ({
    key: line.key,
    label: line.label,
    sm: line,
    bandwidth: utilization.memoryBandwidth[index],
  }));
  const data = times.map((time, index) => {
    const row: Record<string, string | number | null> = { t: time };
    for (const line of lines) {
      row[SM_PREFIX + line.key] = line.sm.points[index]?.v ?? null;
      const bandwidth = line.bandwidth?.points[index]?.v ?? null;
      row[BANDWIDTH_PREFIX + line.key] = bandwidth === null ? null : -bandwidth;
    }
    return row;
  });
  const nameFor = (dataKey: string) => {
    const bandwidth = dataKey.startsWith(BANDWIDTH_PREFIX);
    const key = dataKey.slice(bandwidth ? BANDWIDTH_PREFIX.length : SM_PREFIX.length);
    const label = lines.find((line) => line.key === key)?.label ?? key;
    return `${label} · ${bandwidth ? '显存带宽' : 'SM'}`;
  };
  const area = (prefix: string, key: string, stackId: string, opacity: number) => {
    const color = chartColor(key);
    return (
      <Area
        key={prefix + key}
        type="linear"
        dataKey={prefix + key}
        stackId={stackId}
        stroke={color}
        fill={color}
        fillOpacity={opacity}
        strokeWidth={1.5}
        dot={false}
        activeDot={{ r: 3, strokeWidth: 0, fill: color }}
        isAnimationActive={false}
        connectNulls={false}
      />
    );
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
              width={56}
              domain={[-1, 1]}
              ticks={TICKS}
              allowDataOverflow
              tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }}
              axisLine={false}
              tickLine={false}
              tickFormatter={(value: number) => `${Math.round(Math.abs(value) * 100)}%`}
            />
            <ReferenceLine y={0} stroke="hsl(var(--muted-foreground))" strokeOpacity={0.5} />
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
                  formatValue={(value) => formatPercent(Math.abs(value))}
                  nameFor={nameFor}
                />
              )}
            />
            {lines.map((line) => area(SM_PREFIX, line.key, 'sm', 0.32))}
            {lines.map((line) => area(BANDWIDTH_PREFIX, line.key, 'bandwidth', 0.16))}
          </AreaChart>
        </ResponsiveContainer>
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1 px-2 pt-1 text-[11px] text-muted-foreground">
        {lines.length === 0 ? <span>这段时间没有进程在这张卡上运行</span> : null}
        {lines.map((line) => {
          const sm = latestValue(line.sm);
          const bandwidth = line.bandwidth ? latestValue(line.bandwidth) : null;
          return (
            <span key={line.key} className="inline-flex items-center gap-1.5 tabular-nums">
              <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: chartColor(line.key) }} />
              {line.label}
              {sm === null ? null : ` · SM ${formatPercent(sm)}`}
              {bandwidth === null ? null : ` · 带宽 ${formatPercent(bandwidth)}`}
            </span>
          );
        })}
      </div>
    </div>
  );
}
