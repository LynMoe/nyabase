import * as React from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from './button.js';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from './select.js';
import { cn } from '../../lib/utils.js';

export function Pagination({
  page,
  pageSize,
  total,
  pageSizes = [25, 50, 100] as const,
  onPageChange,
  onPageSizeChange,
  className,
}: {
  page: number;
  pageSize: number;
  total: number;
  pageSizes?: readonly number[];
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: number) => void;
  className?: string;
}): React.ReactNode {
  const totalPages = Math.max(1, Math.ceil(total / Math.max(1, pageSize)));
  const canPrev = page > 0;
  const canNext = page + 1 < totalPages;

  return (
    <div
      className={cn(
        'flex flex-col gap-3 rounded-lg border border-border bg-background px-4 py-3 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between',
        className,
      )}
    >
      <span>
        第 {Math.min(page + 1, totalPages)} / {totalPages} 页
      </span>
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          每页
          <Select
            value={String(pageSize)}
            onValueChange={(value) => onPageSizeChange(Number(value))}
          >
            <SelectTrigger className="h-9 w-[72px]" aria-label="每页条数">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {pageSizes.map((size) => (
                <SelectItem key={size} value={String(size)}>
                  {size}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
        <Button
          variant="outline"
          size="sm"
          disabled={!canPrev}
          onClick={() => onPageChange(page - 1)}
        >
          <ChevronLeft className="h-4 w-4" />
          上一页
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={!canNext}
          onClick={() => onPageChange(page + 1)}
        >
          下一页
          <ChevronRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
