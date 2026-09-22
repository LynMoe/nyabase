import * as React from 'react';
import { cn } from '../../lib/utils.js';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card.js';

/** Page section with a shared border. Use `flush` so tables sit edge-to-edge. */
export function SectionCard({
  title,
  description,
  actions,
  toolbar,
  footer,
  flush = false,
  children,
  testId,
  className,
}: {
  title?: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  toolbar?: React.ReactNode;
  footer?: React.ReactNode;
  flush?: boolean;
  children: React.ReactNode;
  testId?: string;
  className?: string;
}) {
  const hasHeader = title != null || description != null || actions != null;
  return (
    <Card data-testid={testId} className={cn('overflow-hidden', className)}>
      {hasHeader ? (
        <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
          <div className="min-w-0 flex-1 space-y-1.5">
            {title != null ? <CardTitle className="text-base">{title}</CardTitle> : null}
            {description ? <CardDescription>{description}</CardDescription> : null}
          </div>
          {actions ? <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">{actions}</div> : null}
        </CardHeader>
      ) : null}
      {toolbar ? (
        <div className={cn('px-6 py-3', hasHeader ? 'border-t' : undefined)}>
          {toolbar}
        </div>
      ) : null}
      <CardContent
        className={cn(
          flush ? 'p-0' : undefined,
          (hasHeader || toolbar) && flush ? 'border-t' : undefined,
        )}
      >
        {children}
      </CardContent>
      {footer ? <div className="border-t px-6 py-3">{footer}</div> : null}
    </Card>
  );
}

export function MetaChip({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-md border bg-muted/40 px-2.5 py-1 text-sm text-muted-foreground">
      {children}
    </span>
  );
}

export function MetaStat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="truncate text-sm">{value}</p>
    </div>
  );
}

/** Stat fields that wrap instead of leaving a reserved empty column. */
export function InfoGrid({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(min(100%,10rem),1fr))]',
        className,
      )}
    >
      {children}
    </div>
  );
}
