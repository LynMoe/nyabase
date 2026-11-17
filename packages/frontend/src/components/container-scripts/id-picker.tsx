import { useMemo, useState } from 'react';
import { X } from 'lucide-react';
import { Badge } from '../ui/badge.js';
import { Checkbox } from '../ui/checkbox.js';
import { Input } from '../ui/input.js';
import { Label } from '../ui/label.js';
import { matchesSearch } from '../layout/list-search.js';
import { opaquePreview } from '../refs/technical-id.js';

export interface PickerOption {
  id: string;
  label: string;
  /** Muted text after the label (owner, server, username…), also searched. */
  hint?: string;
}

/** Matches shown at once; typing narrows the rest. */
const SHOWN_MATCHES = 100;

/**
 * Pick any number of ids from a searchable list. The picked ones stay above
 * the list as removable badges, also when they are no longer among the
 * options (a deleted container keeps its folded id).
 */
export function IdPicker({
  id,
  label,
  options,
  value,
  onChange,
  loading = false,
  placeholder = '搜索',
  emptyText = '没有可选项',
}: {
  id: string;
  label: string;
  options: PickerOption[];
  value: string[];
  onChange: (next: string[]) => void;
  loading?: boolean;
  placeholder?: string;
  emptyText?: string;
}) {
  const [query, setQuery] = useState('');
  const byId = useMemo(() => new Map(options.map((option) => [option.id, option])), [options]);
  const selected = new Set(value);
  const matches = options.filter((option) => matchesSearch(query, [option.label, option.hint, option.id]));
  const shown = matches.slice(0, SHOWN_MATCHES);
  const toggle = (optionId: string, checked: boolean) => {
    onChange(checked ? [...new Set([...value, optionId])] : value.filter((item) => item !== optionId));
  };

  return (
    <div className="flex flex-col gap-1.5" data-testid={id}>
      <Label htmlFor={id}>{label}</Label>
      {value.length > 0 ? (
        <div className="flex flex-wrap gap-1">
          {value.map((item) => (
            <Badge key={item} variant="secondary" className="gap-1 pr-1">
              <span className="max-w-[12rem] truncate">{byId.get(item)?.label ?? opaquePreview(item)}</span>
              <button
                type="button"
                className="rounded-full p-0.5 hover:bg-background"
                aria-label={`移除 ${byId.get(item)?.label ?? item}`}
                onClick={() => toggle(item, false)}
              >
                <X className="h-3 w-3" />
              </button>
            </Badge>
          ))}
        </div>
      ) : null}
      <Input
        id={id}
        className="h-8"
        value={query}
        placeholder={loading ? '加载中…' : placeholder}
        onChange={(event) => setQuery(event.target.value)}
      />
      <div className="max-h-40 overflow-y-auto rounded-md border" role="group" aria-label={label}>
        {!loading && shown.length === 0 ? (
          <p className="px-3 py-2 text-xs text-muted-foreground">{options.length === 0 ? emptyText : '没有匹配项'}</p>
        ) : null}
        {shown.map((option) => (
          <label
            key={option.id}
            className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm hover:bg-accent/50"
          >
            <Checkbox
              checked={selected.has(option.id)}
              onCheckedChange={(checked) => toggle(option.id, checked === true)}
            />
            <span className="truncate">{option.label}</span>
            {option.hint ? <span className="truncate text-xs text-muted-foreground">{option.hint}</span> : null}
          </label>
        ))}
        {matches.length > shown.length ? (
          <p className="px-3 py-1.5 text-xs text-muted-foreground">
            另有 {matches.length - shown.length} 项，请输入关键字缩小范围
          </p>
        ) : null}
      </div>
    </div>
  );
}
