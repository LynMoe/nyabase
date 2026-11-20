import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { IntentAcceptedDto, SharedVolumeDto, VolumeDto } from '@nyabase/common';
import { toast } from '../../hooks/use-toast.js';
import { api } from '../../lib/api.js';
import { storageErrorMessage } from '../../lib/data-disks.js';
import { queryKeys } from '../../lib/query-keys.js';
import { ConfirmDialog } from '../layout/confirm-dialog.js';
import { ResourceRef } from '../refs/resource-ref.js';

/** A volume an administrator picked for deletion. */
export type DeleteVolumeTarget =
  | { kind: 'local'; volume: VolumeDto }
  | { kind: 'shared'; volume: SharedVolumeDto };

/**
 * Deleting a volume no grant covers any more (user admins). The platform owns
 * every other volume: while a grant covers its disk it would only be created
 * again, so the server refuses; it also refuses while the volume is mounted.
 */
export function DeleteVolumeDialog({
  target,
  onClose,
}: {
  target: DeleteVolumeTarget | null;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const remove = useMutation({
    mutationFn: ({ kind, volume }: DeleteVolumeTarget) => api.delete<IntentAcceptedDto>(
      kind === 'local' ? `/volumes/${volume.id}` : `/shared-volumes/${volume.id}`,
    ),
    onSuccess: (_result, { kind }) => {
      toast({ title: '删除已提交' });
      onClose();
      void queryClient.invalidateQueries({ queryKey: kind === 'local' ? queryKeys.volumes.admin : queryKeys.sharedVolumes.all });
    },
    onError: (error) => toast({ title: '删除失败', description: storageErrorMessage(error), variant: 'destructive' }),
  });
  const volume = target?.volume;
  const place = target?.kind === 'local' ? target.volume.poolName : target?.volume.sharedBackendName;
  return (
    <ConfirmDialog
      open={Boolean(target)}
      title={target?.kind === 'shared' ? '删除共享卷？' : '删除数据卷？'}
      testId="volume-delete-confirm"
      description={volume ? (
        <div className="space-y-2">
          <p>
            将永久删除 <ResourceRef kind="user" id={volume.ownerId} /> 在「{place}」上的卷「{volume.name}」及其中的全部数据，无法恢复。
          </p>
          <p className="text-muted-foreground">
            只有不再被任何授权覆盖的卷才能删除：仍有授权时请先撤销授权（撤销后卷会很快从容器卸载，宽限期满也会自动删除）。
            {volume.attachments.length > 0 ? ` 它现在仍挂载在 ${volume.attachments.length} 个容器里，卸载完成前无法删除。` : ''}
          </p>
        </div>
      ) : null}
      confirmLabel="永久删除"
      pendingLabel="提交中..."
      pending={remove.isPending}
      onConfirm={() => { if (target) remove.mutate(target); }}
      onOpenChange={(open) => { if (!open) onClose(); }}
    />
  );
}
