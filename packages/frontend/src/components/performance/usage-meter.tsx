import type { ReactNode } from 'react';
import { cn } from '../../lib/utils.js';
import type { MeterReading } from '../../lib/container-usage.js';

export type MeterTone = 'normal' | 'warning' | 'critical';

/** Warning from 80 %, critical from 95 %: one threshold for every meter on the site. */
export function meterTone(ratio: number): MeterTone {
  if (ratio >= 0.95) return 'critical';
  if (ratio >= 0.8) return 'warning';
  return 'normal';
}

const BAR_TONE: Record<MeterTone, string> = {
  normal: 'bg-primary',
  warning: 'bg-warning',
  critical: 'bg-destructive',
};

/**
 * "used / allocated" with a thin bar underneath (`stacked`) or beside it
 * (`inline`, for phone cards). Without a live sample the used side is a muted
 * "—" and no bar is drawn, so an idle container never looks empty-but-healthy.
 */
export function UsageMeter({
  reading,
  label,
  detail,
  layout = 'stacked',
  stale = false,
  className,
  testId,
}: {
  reading: MeterReading | null;
  label?: ReactNode;
  /** Muted line under the bar (stacked layout only). */
  detail?: ReactNode;
  layout?: 'stacked' | 'inline';
  /** The sample is older than the freshness window: dim the bar and say so. */
  stale?: boolean;
  className?: string;
  testId?: string;
}) {
  const value = <MeterValue reading={reading} />;
  const bar = reading && reading.used !== null && reading.ratio !== null
    ? <MeterBar ratio={reading.ratio} stale={stale} label={typeof label === 'string' ? label : undefined} />
    : null;
  const title = [reading?.title, stale ? '数据可能已过时' : null].filter(Boolean).join(' · ') || undefined;

  if (layout === 'inline') {
    return (
      <div className={cn('flex min-w-0 items-center gap-2 text-xs', className)} title={title} data-testid={testId}>
        {label != null ? <span className="w-8 shrink-0 text-muted-foreground">{label}</span> : null}
        <span className="shrink-0">{value}</span>
        {bar ? <span className="min-w-6 max-w-24 flex-1">{bar}</span> : null}
      </div>
    );
  }
  return (
    <div className={cn('min-w-0', className)} title={title} data-testid={testId}>
      {label != null ? (
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-xs text-muted-foreground">{label}</span>
          <span className="text-sm">{value}</span>
        </div>
      ) : (
        <p className="text-sm">{value}</p>
      )}
      {bar ? <div className="mt-1.5">{bar}</div> : null}
      {detail != null ? <div className="mt-1 text-xs text-muted-foreground">{detail}</div> : null}
    </div>
  );
}

function MeterValue({ reading }: { reading: MeterReading | null }) {
  if (!reading) return <span className="text-muted-foreground">—</span>;
  return (
    <span className="whitespace-nowrap tabular-nums">
      {reading.lead ? <span>{reading.lead}{reading.used !== null || reading.total ? ' · ' : ''}</span> : null}
      {reading.used === null && reading.lead && !reading.total ? null : (
        <span className={reading.used === null ? 'text-muted-foreground' : undefined}>{reading.used ?? '—'}</span>
      )}
      {reading.total ? <span className="text-muted-foreground"> / {reading.total}</span> : null}
    </span>
  );
}

function MeterBar({ ratio, stale, label }: { ratio: number; stale: boolean; label?: string }) {
  const clamped = Math.min(1, Math.max(0, ratio));
  const percent = Math.round(clamped * 100);
  // A sliver stays visible for tiny non-zero usage so "almost idle" differs from "no data".
  const width = clamped > 0 ? Math.max(percent, 2) : 0;
  return (
    <div
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(ratio * 100)}
      className={cn('h-1 w-full overflow-hidden rounded-full bg-muted', stale && 'opacity-50')}
    >
      <div
        className={cn('h-full rounded-full transition-[width] duration-500', BAR_TONE[meterTone(ratio)])}
        style={{ width: `${width}%` }}
      />
    </div>
  );
}
