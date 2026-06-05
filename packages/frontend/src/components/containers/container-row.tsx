import { Link } from '@tanstack/react-router';
import { AlertTriangle, Loader2, Play, Square, RotateCw, Trash2, Terminal } from 'lucide-react';
import { ContainerPhase, ContainerStatus } from '@nyabase/common';
import type { ContainerAction, ContainerView } from '@nyabase/common';
import { Badge } from '../ui/badge.js';
import { Button } from '../ui/button.js';
import { formatBytesLimit, formatCpu } from '../../lib/utils.js';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../ui/tooltip.js';

export const STATUS_VARIANT: Record<string, 'success' | 'destructive' | 'warning' | 'secondary' | 'outline'> = {
  [ContainerStatus.Running]: 'success',
  [ContainerStatus.Exited]: 'secondary',
  [ContainerStatus.Creating]: 'warning',
  [ContainerStatus.Paused]: 'warning',
  [ContainerStatus.Restarting]: 'warning',
  [ContainerStatus.Dead]: 'destructive',
  [ContainerStatus.Unknown]: 'outline',
};

const PHASE_LABEL: Record<ContainerPhase, string> = {
  [ContainerPhase.Provisioning]: '初始化',
  [ContainerPhase.Active]: '就绪',
  [ContainerPhase.Updating]: '更新中',
  [ContainerPhase.Deleting]: '删除中',
  [ContainerPhase.Deleted]: '已删除',
  [ContainerPhase.Failed]: '失败',
  [ContainerPhase.Orphaned]: '孤儿运行态',
};

function actionTitle(c: ContainerView, action: ContainerAction): string | undefined {
  const availability = c.actions[action];
  return availability.enabled ? undefined : availability.message ?? availability.reason;
}

export function ContainerRow({
  container: c,
  onAction,
  linkToDetail = true,
}: {
  container: ContainerView;
  onAction: (action: ContainerAction, containerId: string, name: string) => void;
  linkToDetail?: boolean;
}) {
  const running = c.runtime.status === ContainerStatus.Running;
  const showRuntimeStatus = c.runtime.bound && c.runtime.status !== ContainerStatus.Unknown;
  const confirmation = c.runtimeConfirmation;
  const statusLabel = confirmation?.status === 'pending'
    ? '确认中'
    : confirmation?.status === 'expired'
    ? '确认超时'
    : showRuntimeStatus
    ? (c.runtime.status ?? ContainerStatus.Unknown)
    : PHASE_LABEL[c.phase];
  const statusVariant = confirmation
    ? 'warning'
    : showRuntimeStatus
    ? STATUS_VARIANT[String(c.runtime.status)] ?? 'outline'
    : c.phase === ContainerPhase.Active
    ? 'success'
    : c.phase === ContainerPhase.Failed
    ? 'destructive'
    : 'warning';
  const detailItems = [
    c.runtime.ip ? { key: 'ip', value: c.runtime.ip, className: 'font-mono' } : null,
    { key: 'cpu', value: formatCpu(c.resources.cpuMillis) },
    { key: 'mem', value: formatBytesLimit(c.resources.memBytes) },
    c.resources.gpuIndices.length > 0 ? { key: 'gpu', value: `GPU ${c.resources.gpuIndices.join(',')}` } : null,
  ].filter((item): item is { key: string; value: string; className?: string } => item !== null);
  const failureInfo = c.failureReason?.trim()
    ? c.failureReason
    : c.failureCode ?? null;

  return (
    <div className="flex items-center gap-4 px-4 py-3">
      <div className="flex-1 min-w-0 space-y-1">
        <div className="flex items-center gap-2 flex-wrap">
          {linkToDetail ? (
            <Link
              to="/containers/$containerId"
              params={{ containerId: c.id }}
              search={{ tab: 'overview' }}
              className="font-medium text-sm hover:underline"
            >
              {c.name}
            </Link>
          ) : (
            <span className="font-medium text-sm">{c.name}</span>
          )}
          <Badge variant={statusVariant} title={confirmation?.message}>
            {confirmation?.status === 'pending' && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
            {statusLabel}
          </Badge>
          {failureInfo && (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    className="inline-flex h-4 w-4 items-center justify-center rounded-full text-destructive transition-colors hover:text-destructive/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    aria-label="失败信息"
                  >
                    <AlertTriangle className="h-3.5 w-3.5" />
                  </button>
                </TooltipTrigger>
                <TooltipContent>
                  <p className="max-w-xs break-words">{failureInfo}</p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
        </div>
        {detailItems.length > 0 && (
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            {detailItems.map((item) => (
              <span key={item.key} className={item.className}>{item.value}</span>
            ))}
          </div>
        )}
      </div>

      <div className="flex items-center gap-1 shrink-0">
        {running ? (
          <Button
            size="icon"
            variant="ghost"
            className="h-8 w-8"
            title={actionTitle(c, 'stop')}
            disabled={!c.actions.stop.enabled}
            onClick={() => onAction('stop', c.id, c.name)}
          >
            <Square className="h-3.5 w-3.5" />
          </Button>
        ) : (
          <Button
            size="icon"
            variant="ghost"
            className="h-8 w-8"
            title={actionTitle(c, 'start')}
            disabled={!c.actions.start.enabled}
            onClick={() => onAction('start', c.id, c.name)}
          >
            <Play className="h-3.5 w-3.5" />
          </Button>
        )}
        <Button
          size="icon"
          variant="ghost"
          className="h-8 w-8"
          title={actionTitle(c, 'restart')}
          disabled={!c.actions.restart.enabled}
          onClick={() => onAction('restart', c.id, c.name)}
        >
          <RotateCw className="h-3.5 w-3.5" />
        </Button>
        {c.actions.console.enabled && linkToDetail ? (
          <Button size="icon" variant="ghost" className="h-8 w-8" asChild>
            <Link to="/containers/$containerId" params={{ containerId: c.id }} search={{ tab: 'console' }}>
              <Terminal className="h-3.5 w-3.5" />
            </Link>
          </Button>
        ) : (
          <Button size="icon" variant="ghost" className="h-8 w-8" disabled title={actionTitle(c, 'console')}>
            <Terminal className="h-3.5 w-3.5" />
          </Button>
        )}
        <Button
          size="icon"
          variant="ghost"
          className="h-8 w-8 text-destructive hover:text-destructive"
          title={actionTitle(c, 'delete')}
          disabled={!c.actions.delete.enabled}
          onClick={() => onAction('delete', c.id, c.name)}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}
