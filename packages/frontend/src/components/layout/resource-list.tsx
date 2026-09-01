import * as React from 'react';
import { cn } from '../../lib/utils.js';
import { Card, CardContent } from '../ui/card.js';

export function ResourceList({ children }: { children: React.ReactNode }) {
  return (
    <Card>
      <CardContent className="divide-y p-0">{children}</CardContent>
    </Card>
  );
}

export function ResourceListRow({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex min-w-0 flex-wrap items-start justify-between gap-3 px-4 py-3', className)}>
      {children}
    </div>
  );
}
