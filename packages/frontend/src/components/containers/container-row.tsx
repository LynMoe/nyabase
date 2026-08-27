import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { ChevronRight, Play, RotateCw, Square, TriangleAlert } from 'lucide-react';
import type { ContainerAction, ContainerDto } from '@nyabase/common';
import { Badge } from '../ui/badge.js';
import { Button } from '../ui/button.js';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog.js';
import { formatBytes, formatCpu } from '../../lib/utils.js';
import { containerStatusLabel, lifecyclePhaseLabel } from '../../lib/status-labels.js';

export function ContainerRow({
  container,
  admin = false,
  onAction,
  actionPending = false,
}: {
  container: ContainerDto;
  admin?: boolean;
  onAction: (action: ContainerAction, container: ContainerDto) => void;
  actionPending?: boolean;
}) {
  const detailTo = admin ? '/manage/containers/$containerId' : '/containers/$containerId';
  const status = container.actual.status;
  const [confirmAction, setConfirmAction] = useState<'stop' | 'restart' | null>(null);

  const requestAction = (action: Extract<ContainerAction, 'start' | 'stop' | 'restart'>) => {
    if (action === 'stop' || action === 'restart') {
      setConfirmAction(action);
      return;
    }
    onAction(action, container);
  };

  const confirmPendingAction = () => {
    if (!confirmAction) return;
    onAction(confirmAction, container);
    setConfirmAction(null);
  };

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
      <Link to={detailTo} params={{ containerId: container.id }} search={{ tab: 'overview' }} className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-medium">{container.name}</span>
          <Badge
            variant={status === 'running' ? 'success' : container.needsAttention ? 'destructive' : 'secondary'}
            title={status}
          >
            {containerStatusLabel(status)}
          </Badge>
          {container.lifecyclePhase !== 'active' && (
            <Badge variant="warning" title={container.lifecyclePhase}>
              {lifecyclePhaseLabel(container.lifecyclePhase)}
            </Badge>
          )}
          {container.needsAttention && <TriangleAlert className="h-3.5 w-3.5 text-destructive" aria-label="需要关注" />}
        </div>
        <p className="mt-1 truncate text-xs text-muted-foreground">
          {admin && (container.ownerName ?? container.ownerId) ? `${container.ownerName ?? container.ownerId} · ` : ''}
          {container.serverName} · {container.routedIp ?? '等待容器 IP'} · {formatCpu(container.cpuMillis)} · {formatBytes(container.memBytes)}
        </p>
      </Link>
      <div className="flex shrink-0 gap-1">
        <ActionButton action="start" icon={Play} container={container} onClick={() => requestAction('start')} label="启动" pending={actionPending} />
        <ActionButton action="stop" icon={Square} container={container} onClick={() => requestAction('stop')} label="停止" pending={actionPending} />
        <ActionButton action="restart" icon={RotateCw} container={container} onClick={() => requestAction('restart')} label="重启" pending={actionPending} />
        <Button size="icon" variant="ghost" asChild aria-label="详情">
          <Link to={detailTo} params={{ containerId: container.id }} search={{ tab: 'overview' }}>
            <ChevronRight className="h-4 w-4" />
          </Link>
        </Button>
      </div>

      <Dialog open={Boolean(confirmAction)} onOpenChange={(open) => { if (!open) setConfirmAction(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{confirmAction === 'stop' ? '停止容器？' : '重启容器？'}</DialogTitle>
            <DialogDescription>
              {confirmAction === 'stop'
                ? `将停止容器「${container.name}」。运行中的进程与 SSH 会话会中断。`
                : `将重启容器「${container.name}」。运行中的进程与 SSH 会话会短暂中断。`}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmAction(null)}>取消</Button>
            <Button
              variant={confirmAction === 'stop' ? 'destructive' : 'default'}
              onClick={confirmPendingAction}
              disabled={actionPending}
            >
              {actionPending ? '提交中...' : confirmAction === 'stop' ? '确认停止' : '确认重启'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ActionButton({
  action,
  icon: Icon,
  container,
  onClick,
  label,
  pending,
}: {
  action: Extract<ContainerAction, 'start' | 'stop' | 'restart'>;
  icon: typeof Play;
  container: ContainerDto;
  onClick: () => void;
  label: string;
  pending: boolean;
}) {
  const availability = container.actions[action];
  return (
    <Button
      size="icon"
      variant="ghost"
      aria-label={label}
      title={availability.enabled ? label : availability.message ?? availability.reason}
      disabled={!availability.enabled || pending}
      onClick={onClick}
    >
      <Icon className="h-4 w-4" />
    </Button>
  );
}
