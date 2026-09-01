import { useState } from 'react';
import { Play, RotateCw, Square, Trash2 } from 'lucide-react';
import type { ContainerAction, ContainerDto } from '@nyabase/common';
import { ConfirmDialog } from '../layout/confirm-dialog.js';
import { Button } from '../ui/button.js';

type PowerAction = Extract<ContainerAction, 'start' | 'stop' | 'restart'>;
export type ContainerBarAction = PowerAction | 'delete';

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

  return (
    <>
      <div className={layout === 'icons' ? 'contents' : 'flex flex-wrap gap-1'}>
        <ActionButton
          action="start"
          icon={Play}
          container={container}
          layout={layout}
          onClick={() => requestAction('start')}
          pending={pending}
        />
        <ActionButton
          action="stop"
          icon={Square}
          container={container}
          layout={layout}
          onClick={() => requestAction('stop')}
          pending={pending}
        />
        <ActionButton
          action="restart"
          icon={RotateCw}
          container={container}
          layout={layout}
          onClick={() => requestAction('restart')}
          pending={pending}
        />
        {showDelete && (
          <Button
            size="sm"
            variant="destructive"
            disabled={!container.actions.delete.enabled || pending}
            title={container.actions.delete.message}
            onClick={() => requestAction('delete')}
          >
            <Trash2 className="h-4 w-4" />删除
          </Button>
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
  const label = action === 'start' ? '启动' : action === 'stop' ? '停止' : '重启';
  if (layout === 'icons') {
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
  return (
    <Button
      size="sm"
      variant="outline"
      onClick={onClick}
      disabled={!availability.enabled || pending}
      title={availability.message ?? availability.reason}
    >
      <Icon className="h-4 w-4" />
      {label}
    </Button>
  );
}
