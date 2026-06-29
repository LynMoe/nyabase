/**
 * Recharts-free building blocks shared by the dashboard:
 *   - palette / colour helper
 *   - axis tick / grid / tooltip style constants
 *   - data shapers (singleSeriesData / multiSeriesData)
 *   - layout-only components (TimeRangeSelector, EmptyChart, SkeletonSection, SectionHeader)
 *
 * Importing this module does NOT pull in recharts, so it is safe to bundle
 * with the first paint chunk.
 */
import type { ReactNode } from 'react';
import { Activity } from 'lucide-react';
import type { MetricSeries } from '@nyabase/common';

const PALETTE = [
  '#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6',
  '#06b6d4', '#f97316', '#ec4899', '#14b8a6', '#a855f7',
];

export function colorFor(str: string): string {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

export function fmtTime(t: number): string {
  return new Date(t * 1000).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

export function fmtBps(val: number): string {
  if (val >= 1024 ** 3) return `${(val / 1024 ** 3).toFixed(1)} GB/s`;
  if (val >= 1024 ** 2) return `${(val / 1024 ** 2).toFixed(1)} MB/s`;
  if (val >= 1024) return `${(val / 1024).toFixed(1)} KB/s`;
  return `${val.toFixed(0)} B/s`;
}

export function fmtPercent(v: number): string {
  return `${(v * 100).toFixed(1)}%`;
}

export type ChartPoint = Record<string, number | string | null | undefined>;

// Convert a single series to chart rows. `null` is preserved so recharts can
// render a gap with `connectNulls` controlling line continuity.
export function singleSeriesData(series: MetricSeries): ChartPoint[] {
  return series.points.map((p) => ({
    t: p.t,
    time: fmtTime(p.t),
    value: p.v ?? null,
  }));
}

// Join multiple series by their `t` (epoch seconds) so each row corresponds
// to a single timestamp and missing values surface as `null`. Series may
// have unaligned/sparse timestamps; we union them all.
export function multiSeriesData(
  entries: Array<{ key: string; label: string; series: MetricSeries }>,
): ChartPoint[] {
  if (entries.length === 0) return [];

  const buckets = new Map<number, ChartPoint>();
  for (const { key, series } of entries) {
    for (const p of series.points) {
      let row = buckets.get(p.t);
      if (!row) {
        row = { t: p.t, time: fmtTime(p.t) };
        buckets.set(p.t, row);
      }
      row[key] = p.v ?? null;
    }
  }

  const rows = [...buckets.values()].sort((a, b) => (a.t as number) - (b.t as number));
  // Backfill keys missing on a row as null so legend/tooltip behave consistently.
  for (const row of rows) {
    for (const { key } of entries) {
      if (!(key in row)) row[key] = null;
    }
  }
  return rows;
}

export function zeroFillSeriesFromReferences(
  series: MetricSeries,
  references: MetricSeries[],
): MetricSeries {
  const timestamps = new Set<number>();
  for (const point of series.points) timestamps.add(point.t);
  for (const ref of references) {
    for (const point of ref.points) timestamps.add(point.t);
  }

  if (timestamps.size === series.points.length) return series;

  const values = new Map(series.points.map((point) => [point.t, point.v]));
  return {
    ...series,
    points: [...timestamps]
      .sort((a, b) => a - b)
      .map((t) => ({ t, v: values.get(t) ?? 0 })),
  };
}

export const AXIS_TICK = { fontSize: 10, fill: '#9ca3af' };
export const GRID_STROKE = '#f3f4f6';
export const TIP_STYLE = { fontSize: 11, borderRadius: 6, border: '1px solid #e5e7eb' };

export function EmptyChart({ title }: { title: string }) {
  return (
    <div
      className="bg-card rounded-lg border p-4 flex flex-col items-center justify-center"
      style={{ minHeight: 160 }}
    >
      <Activity className="h-6 w-6 text-muted-foreground/30 mb-2" />
      <p className="text-xs text-muted-foreground">{title} — 暂无数据</p>
    </div>
  );
}

export function SkeletonSection({ rows }: { rows: number }) {
  return (
    <div className="space-y-3">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {[1, 2, 3].map((j) => (
            <div key={j} className="bg-card rounded-lg border p-4 h-[196px] animate-pulse">
              <div className="h-3 w-24 bg-muted rounded mb-3" />
              <div className="h-full bg-muted/50 rounded" />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

export function SectionHeader({ icon, title }: { icon: ReactNode; title: string }) {
  return (
    <div className="flex items-center gap-2 mb-3">
      {icon}
      <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
    </div>
  );
}

const RANGE_OPTIONS = [
  { value: '1h', label: '1 小时' },
  { value: '6h', label: '6 小时' },
  { value: '24h', label: '24 小时' },
];

export function TimeRangeSelector({
  value, onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex items-center gap-1">
      {RANGE_OPTIONS.map((opt) => (
        <button
          key={opt.value}
          onClick={() => onChange(opt.value)}
          className={`text-xs px-3 py-1.5 rounded-md border transition-colors ${
            value === opt.value
              ? 'bg-primary text-primary-foreground border-primary'
              : 'bg-background text-muted-foreground border-border hover:border-primary/50'
          }`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

// Lightweight placeholder used while the chart chunk is loading.
export function ChartLoading({ title, height = 160 }: { title?: string; height?: number }) {
  return (
    <div className="bg-card rounded-lg border p-4 animate-pulse" style={{ minHeight: height + 32 }}>
      {title && <div className="h-3 w-24 bg-muted rounded mb-3" />}
      <div className="h-full bg-muted/40 rounded" style={{ height }} />
    </div>
  );
}
