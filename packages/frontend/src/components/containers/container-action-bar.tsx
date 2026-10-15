import { useState } from 'react';
import { Play, RotateCw, Square, Trash2 } from 'lucide-react';
import type { ContainerAction, ContainerDto } from '@nyabase/common';
import { ConfirmDialog } from '../layout/confirm-dialog.js';
import { MoreActions } from '../layout/more-actions.js';
import { Button } from '../ui/button.js';
import { Hint } from '../ui/hint.js';

type PowerAction = Extract<ContainerAction, 'start' | 'stop' | 'restart'>;
export type ContainerBarAction = PowerAction | 'delete';

const POWER_LABEL: Record<PowerAction, string> = { start: '启动', stop: '停止', restart: '重启' };

export function ContainerActionBar({
  container,
  layout,
  pending,
  onAction,
  showDelete = false,
}: {
  container: ContainerDto;
  layout: 'icons' | 'labeled';
  pending: boolean;
  onAction: (action: ContainerBarAction) => void | Promise<void>;
  /** Puts 删除 behind a 更多 menu so it is never one stray click away. */
  showDelete?: boolean;
}) {
  const [confirmAction, setConfirmAction] = useState<'stop' | 'restart' | 'delete' | null>(null);

  const requestAction = (action: ContainerBarAction) => {
    if (action === 'stop' || action === 'restart' || action === 'delete') {
      setConfirmAction(action);
      return;
    }
    void Promise.resolve(onAction(action)).then(undefined, () => undefined);
  };
  const deleteAvailability = container.actions.delete;

  return (
    <>
      <div className={layout === 'icons' ? 'contents' : 'flex flex-wrap items-center gap-1'}>
        <ActionButton action="start" icon={Play} container={container} layout={layout} onClick={() => requestAction('start')} pending={pending} />
        <ActionButton action="stop" icon={Square} container={container} layout={layout} onClick={() => requestAction('stop')} pending={pending} />
        <ActionButton action="restart" icon={RotateCw} container={container} layout={layout} onClick={() => requestAction('restart')} pending={pending} />
        {showDelete && (
          <MoreActions
            actions={[{
              label: '删除容器',
              icon: Trash2,
              destructive: true,
              disabled: !deleteAvailability.enabled || pending,
              description: deleteAvailability.enabled ? undefined : deleteAvailability.message,
              onSelect: () => requestAction('delete'),
            }]}
          />
        )}
      </div>
      <ConfirmDialog
        open={Boolean(confirmAction)}
        title={
          confirmAction === 'delete'
            ? '删除容器？'
            : confirmAction === 'restart'
              ? '重启容器？'
              : '停止容器？'
        }
        description={
          confirmAction === 'delete'
            ? `将永久删除容器「${container.name}」。数据卷会保留，仅解除挂载。此操作不可恢复。`
            : confirmAction === 'restart'
              ? `将重启容器「${container.name}」。运行中的进程与 SSH 会话会短暂中断。`
              : `将停止容器「${container.name}」。运行中的进程与 SSH 会话会中断。`
        }
        confirmLabel={
          confirmAction === 'delete'
            ? '确认删除'
            : confirmAction === 'restart'
              ? '确认重启'
              : '确认停止'
        }
        pendingLabel="提交中..."
        confirmVariant={confirmAction === 'restart' ? 'default' : 'destructive'}
        pending={pending}
        onConfirm={() => {
          if (!confirmAction) return;
          void Promise.resolve(onAction(confirmAction)).then(
            () => setConfirmAction(null),
            () => undefined,
          );
        }}
        onOpenChange={(open) => { if (!open) setConfirmAction(null); }}
      />
    </>
  );
}

function ActionButton({
  action,
  icon: Icon,
  container,
  layout,
  onClick,
  pending,
}: {
  action: PowerAction;
  icon: typeof Play;
  container: ContainerDto;
  layout: 'icons' | 'labeled';
  onClick: () => void;
  pending: boolean;
}) {
  const availability = container.actions[action];
  const label = POWER_LABEL[action];
  const disabled = !availability.enabled || pending;
  const reason = availability.enabled ? undefined : availability.message ?? availability.reason;
  if (layout === 'icons') {
    return (
      <Hint content={reason ?? label} disabled={disabled}>
        <Button size="icon" variant="ghost" aria-label={label} disabled={disabled} onClick={onClick}>
          <Icon className="h-4 w-4" />
        </Button>
      </Hint>
    );
  }
  return (
    <Hint content={reason} disabled={disabled}>
      <Button size="sm" variant="outline" className="h-9" onClick={onClick} disabled={disabled}>
        <Icon className="h-4 w-4" />
        {label}
      </Button>
    </Hint>
  );
}
