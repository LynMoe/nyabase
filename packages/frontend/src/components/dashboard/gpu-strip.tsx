import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip.js';
import type { GpuCardState, GrantedGpuCard } from '../../lib/gpu-occupancy.js';
import { cn, formatBytesCompact } from '../../lib/utils.js';

const SQUARE: Record<GpuCardState, string> = {
  free: 'border-success bg-success/10 text-success',
  mine: 'border-primary bg-primary text-primary-foreground',
  others: 'border-orange-700 bg-orange-700 text-white dark:border-orange-500 dark:bg-orange-500 dark:text-orange-950',
  unknown: 'border-dashed border-muted-foreground/40 bg-muted text-muted-foreground',
};

export const GPU_LEGEND: Array<{ state: GpuCardState; label: string }> = [
  { state: 'free', label: '空闲' },
  { state: 'mine', label: '你在用' },
  { state: 'others', label: '别人在用' },
];

export function GpuLegendSwatch({ state }: { state: GpuCardState }) {
  return <span aria-hidden className={cn('inline-block h-3 w-3 rounded-[3px] border-2', SQUARE[state])} />;
}

/** The granted cards as numbered squares; hovering one lists who uses it. */
export function GpuStrip({ cards, model }: { cards: readonly GrantedGpuCard[]; model: string | null }) {
  return (
    <div className="flex flex-wrap gap-1.5" data-testid="dashboard-gpus">
      {cards.map((card, position) => (
        <GpuSquare key={card.pci} card={card} label={String(card.index ?? position)} model={model} />
      ))}
    </div>
  );
}

function GpuSquare({ card, label, model }: { card: GrantedGpuCard; label: string; model: string | null }) {
  return (
    <Tooltip delayDuration={0} disableHoverableContent>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={`GPU ${label}`}
          data-state-kind={card.state}
          className={cn(
            'flex h-10 w-10 cursor-default items-center justify-center rounded-md border-2 text-sm font-semibold tabular-nums',
            'focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
            SQUARE[card.state],
          )}
        >
          {label}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" align="start" className="w-72 max-w-none space-y-1.5 px-3 py-2">
        <div className="flex items-baseline gap-2">
          <span className="font-semibold">GPU {label}</span>
          {model ? <span className="ml-auto truncate text-muted-foreground">{model}</span> : null}
        </div>
        <GpuCardDetail card={card} />
      </TooltipContent>
    </Tooltip>
  );
}

const ROW = 'grid grid-cols-[3.5rem_minmax(0,1fr)_3.75rem_2.75rem] items-center gap-2';

function GpuCardDetail({ card }: { card: GrantedGpuCard }) {
  if (card.state === 'unknown') return <p className="text-muted-foreground">无数据</p>;
  if (card.rows.length === 0) return <p className="font-medium text-success">空闲</p>;
  return (
    <div className="space-y-1">
      <div className={cn(ROW, 'text-[11px] text-muted-foreground')}>
        <span />
        <span>显存</span>
        <span />
        <span className="text-right">利用率</span>
      </div>
      {card.rows.map((row) => (
        <div key={row.key} className={ROW}>
          <span className="truncate font-medium">{row.name}</span>
          <span className="h-1.5 overflow-hidden rounded-full bg-muted">
            <span
              className={cn('block h-full rounded-full', row.mine ? 'bg-primary' : 'bg-orange-700 dark:bg-orange-500')}
              style={{ width: `${Math.round((row.memoryRatio ?? 0) * 100)}%` }}
            />
          </span>
          <span className="text-right tabular-nums">{formatBytesCompact(row.memoryBytes)}</span>
          <span className="text-right tabular-nums">{row.smRatio === null ? '—' : `${Math.round(row.smRatio * 100)}%`}</span>
        </div>
      ))}
    </div>
  );
}
