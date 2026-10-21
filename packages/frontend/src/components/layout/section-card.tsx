import * as React from 'react';
import type { ComponentType } from 'react';
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
        <div className={cn('px-4 py-3 sm:px-6', hasHeader ? 'border-t' : undefined)}>
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

/** Small bordered stat: label and icon on top, a big value, a muted sub line. */
export function MetricTile({
  icon: Icon,
  label,
  value,
  sub,
}: {
  icon: ComponentType<{ className?: string }>;
  label: string;
  value: string;
  sub: string;
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">{label}</p>
        <Icon className="h-4 w-4 text-muted-foreground" />
      </div>
      <p className="mt-2 text-xl font-semibold text-foreground break-words">{value}</p>
      <p className="mt-1 text-xs text-muted-foreground">{sub}</p>
    </div>
  );
}
