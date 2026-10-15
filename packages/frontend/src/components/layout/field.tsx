import * as React from 'react';
import { cn } from '../../lib/utils.js';

/** One labelled value. The single key/value primitive for detail surfaces. */
export function Field({
  label,
  value,
  mono = false,
  title,
  className,
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  mono?: boolean;
  title?: string;
  className?: string;
}) {
  const empty = value === null || value === undefined || value === '';
  return (
    <div className={cn('min-w-0', className)}>
      <p className="text-xs text-muted-foreground">{label}</p>
      <div
        className={cn('mt-0.5 min-w-0 break-words text-sm', mono && 'font-mono', empty && 'text-muted-foreground')}
        title={title}
      >
        {empty ? '—' : value}
      </div>
    </div>
  );
}

/** Fields that wrap into as many columns as fit, never leaving a hollow column. */
export function FieldGrid({
  children,
  className,
  min = '9rem',
}: {
  children: React.ReactNode;
  className?: string;
  /** Narrowest a column may get before the grid wraps. */
  min?: string;
}) {
  return (
    <div
      className={cn('grid gap-x-6 gap-y-3', className)}
      style={{ gridTemplateColumns: `repeat(auto-fill, minmax(min(100%, ${min}), 1fr))` }}
    >
      {children}
    </div>
  );
}
