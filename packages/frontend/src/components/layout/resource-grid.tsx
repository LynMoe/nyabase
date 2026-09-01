import * as React from 'react';
import { cn } from '../../lib/utils.js';

/** Card grid that stretches a lone card and only splits when two columns actually fit. */
export function ResourceGrid({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'grid items-start gap-4 [grid-template-columns:repeat(auto-fit,minmax(min(100%,22rem),1fr))]',
        className,
      )}
    >
      {children}
    </div>
  );
}
