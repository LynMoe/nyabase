import * as React from 'react';
import { Label } from '../ui/label.js';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select.js';
import { cn } from '../../lib/utils.js';

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

/** Labelled single-choice select over `[value, label]` pairs. */
export function SelectField({
  id,
  label,
  value,
  onChange,
  options,
  placeholder = '请选择',
  disabled = false,
  error,
  hint,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: Array<[string, string]>;
  placeholder?: string;
  disabled?: boolean;
  error?: string | null;
  hint?: React.ReactNode;
}) {
  return (
    <FormField id={id} label={label} error={error} hint={hint}>
      {/* Keyed on value so clearing it back to '' shows the placeholder again. */}
      <Select key={value || 'empty'} value={value || undefined} onValueChange={onChange} disabled={disabled}>
        <SelectTrigger id={id} aria-invalid={error ? true : undefined}>
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          {options.map(([optionValue, optionLabel]) => (
            <SelectItem key={optionValue} value={optionValue}>{optionLabel}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </FormField>
  );
}

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
