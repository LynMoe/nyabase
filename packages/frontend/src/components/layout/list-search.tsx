import { Search, X } from 'lucide-react';
import { Input } from '../ui/input.js';
import { cn } from '../../lib/utils.js';

/** Case-insensitive "every word appears in some field" match for list search. */
export function matchesSearch(query: string, fields: ReadonlyArray<string | null | undefined>): boolean {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const haystack = fields.filter(Boolean).join(' ').toLowerCase();
  return words.every((word) => haystack.includes(word));
}

export function ListSearch({
  value,
  onChange,
  placeholder,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  className?: string;
}) {
  return (
    <div className={cn('relative w-full sm:w-64', className)}>
      <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        type="search"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
        className="h-9 pl-8 pr-8 [&::-webkit-search-cancel-button]:hidden"
      />
      {value ? (
        <button
          type="button"
          className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground hover:text-foreground"
          aria-label="清除搜索"
          onClick={() => onChange('')}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      ) : null}
    </div>
  );
}

/** Small segmented control for one-of-few list filters. */
export function SegmentedFilter<T extends string>({
  value,
  onChange,
  options,
  label,
}: {
  value: T;
  onChange: (value: T) => void;
  options: ReadonlyArray<{ value: T; label: string; count?: number }>;
  label: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex flex-wrap rounded-md bg-muted p-0.5">
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(option.value)}
            className={cn(
              'rounded px-2.5 py-1 text-sm transition-colors',
              active ? 'bg-background font-medium text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {option.label}
            {option.count !== undefined ? <span className="ml-1 tabular-nums text-muted-foreground">{option.count}</span> : null}
          </button>
        );
      })}
    </div>
  );
}
