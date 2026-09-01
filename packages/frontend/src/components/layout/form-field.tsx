import * as React from 'react';
import { Label } from '../ui/label.js';

export function FormField({
  id,
  label,
  hint,
  error,
  orientation = 'stack',
  children,
}: {
  id: string;
  label: string;
  hint?: React.ReactNode;
  error?: string | null;
  orientation?: 'stack' | 'inline';
  children: React.ReactNode;
}) {
  if (orientation === 'inline') {
    return (
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          {children}
          <Label htmlFor={id} className="text-sm font-normal">{label}</Label>
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
      </div>
    );
  }
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {hint && !error && <p className="text-xs text-muted-foreground">{hint}</p>}
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}
