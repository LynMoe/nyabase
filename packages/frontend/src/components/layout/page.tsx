import * as React from 'react';
import { cn } from '../../lib/utils.js';

export function Page({
  className,
  testId,
  children,
}: {
  className?: string;
  testId?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      data-testid={testId}
      className={cn('mx-auto w-full min-w-0 max-w-screen-2xl space-y-6 px-4 py-6 pb-[max(1.5rem,env(safe-area-inset-bottom))] md:px-6', className)}
    >
      {children}
    </div>
  );
}
