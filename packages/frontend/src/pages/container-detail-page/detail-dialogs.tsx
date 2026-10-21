import type { UseQueryResult } from '@tanstack/react-query';
import type {
  ContainerDto,
  CursorPaginatedResponse,
  IntentDto,
  ListScope,
  VolumeAttachmentDto,
} from '@nyabase/common';
import { ConfirmDialog } from '../../components/layout/confirm-dialog.js';
import { QueryView } from '../../components/layout/query-view.js';
import { IntentsPanel } from '../../components/containers/intents-panel.js';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../../components/ui/dialog.js';

/** The container's operation history in a dialog. */
export function IntentHistoryDialog({
  open,
  onOpenChange,
  query,
  scope,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  query: UseQueryResult<CursorPaginatedResponse<IntentDto>>;
  scope: ListScope;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>操作记录</DialogTitle>
        </DialogHeader>
        <QueryView
          query={query}
          resourceName="操作记录"
          loadingLabel="加载操作记录..."
        >
          {(page) => (
            <IntentsPanel
              intents={page.items}
              scope={scope}
              embedded
              onRetry={() => { void query.refetch(); }}
            />
          )}
        </QueryView>
      </DialogContent>
    </Dialog>
  );
}

/** Confirm unmounting (or cancelling a not-yet-finished mount of) a data volume. */
export function DetachVolumeDialog({
  container,
  target,
  pending,
  onConfirm,
  onClose,
}: {
  container: ContainerDto;
  target: VolumeAttachmentDto | null;
  pending: boolean;
  onConfirm: (attachmentId: string) => void;
  onClose: () => void;
}) {
  return (
    <ConfirmDialog
      open={Boolean(target)}
      title={target?.onlineCancelAllowed ? '取消挂载？' : '卸载数据卷？'}
      description={
        target
          ? (target.onlineCancelAllowed
            ? `将取消容器「${container.name}」路径 ${target.containerPath} 尚未完成的挂载。`
            : `将从容器「${container.name}」卸载路径 ${target.containerPath}（设备 ${target.deviceName}）。`)
          : null
      }
      confirmLabel={target?.onlineCancelAllowed ? '确认取消' : '确认卸载'}
      pendingLabel="提交中..."
      pending={pending}
      onConfirm={() => {
        if (target) onConfirm(target.id);
      }}
      onOpenChange={(open) => { if (!open) onClose(); }}
    />
  );
}
