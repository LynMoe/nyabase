import { type LucideIcon, MoreHorizontal } from 'lucide-react';
import { Button } from '../ui/button.js';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu.js';
import { cn } from '../../lib/utils.js';

export type MoreAction = {
  label: string;
  icon?: LucideIcon;
  onSelect: () => void;
  destructive?: boolean;
  disabled?: boolean;
  /** Shown under the label, e.g. why the action is unavailable. */
  description?: string;
};

/**
 * Overflow menu for a page's rarely used or destructive actions, so that
 * 删除 is never a bright button one stray click away from 编辑.
 */
export function MoreActions({ actions, label = '更多操作' }: { actions: MoreAction[]; label?: string }) {
  if (actions.length === 0) return null;
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="icon" className="h-9 w-9" aria-label={label}>
          <MoreHorizontal className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-48 max-w-72">
        {actions.map((action) => (
          <DropdownMenuItem
            key={action.label}
            disabled={action.disabled}
            onSelect={action.onSelect}
            className={cn(action.destructive && 'text-destructive focus:text-destructive')}
          >
            {action.icon ? <action.icon className="mr-2 h-4 w-4 shrink-0" /> : null}
            <span className="flex min-w-0 flex-col">
              <span>{action.label}</span>
              {action.description ? <span className="text-xs text-muted-foreground">{action.description}</span> : null}
            </span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
