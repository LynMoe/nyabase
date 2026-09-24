import { formatChartStamp } from './chart-format.js';

export function ChartHover({
  active,
  payload,
  label,
  formatValue,
  nameFor,
  withSeconds = false,
}: {
  active?: boolean;
  payload?: ReadonlyArray<{ dataKey?: unknown; value?: unknown; color?: string }>;
  label?: unknown;
  formatValue: (value: number) => string;
  nameFor: (key: string) => string;
  withSeconds?: boolean;
}) {
  if (!active || !payload?.length) return null;
  const rows = payload.flatMap((item) => {
    if (typeof item.value !== 'number' || !Number.isFinite(item.value)) return [];
    const key = String(item.dataKey ?? '');
    return [{ key, color: item.color ?? 'hsl(var(--foreground))', value: item.value }];
  });
  return (
    <div className="rounded-md border bg-popover px-2 py-1.5 text-xs text-popover-foreground shadow-md">
      <p className="tabular-nums text-muted-foreground">{formatChartStamp(label, withSeconds)}</p>
      {rows.map((row) => (
        <p key={row.key} className="mt-1 flex items-center gap-2">
          <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: row.color }} />
          <span className="max-w-40 truncate text-muted-foreground">{nameFor(row.key)}</span>
          <span className="ml-auto tabular-nums">{formatValue(row.value)}</span>
        </p>
      ))}
    </div>
  );
}
