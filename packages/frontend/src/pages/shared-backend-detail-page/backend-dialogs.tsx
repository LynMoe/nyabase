import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { Trash2 } from 'lucide-react';
import { type SharedBackendDto, zPatchSharedBackendRequest } from '@nyabase/common';
import { Button } from '../../components/ui/button.js';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '../../components/ui/dialog.js';
import { Input } from '../../components/ui/input.js';
import { ConfirmDialog } from '../../components/layout/confirm-dialog.js';
import { FormField } from '../../components/layout/form-field.js';
import { MoreActions } from '../../components/layout/more-actions.js';
import { toast } from '../../hooks/use-toast.js';
import { api } from '../../lib/api.js';
import { errorMessage } from '../../lib/api-error.js';
import { queryKeys } from '../../lib/query-keys.js';
import { parseSharedBackendFsidConflict, type SharedBackendFsidConflict } from '../../lib/storage-shrink.js';

/** Refresh one shared backend and the backend list after a change. */
export function useInvalidateBackend(id: string) {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.sharedBackends.detail(id) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.sharedBackends.admin });
  };
}

/** Hands an FSID identity conflict carried by a failed request to the page's alert. */
export function reportFsidConflict(error: unknown, onConflict: (conflict: SharedBackendFsidConflict) => void) {
  const conflict = parseSharedBackendFsidConflict(error);
  if (conflict) onConflict(conflict);
}

export function EditBackendDialog({
  backend,
  onConflict,
  onClose,
}: {
  backend: SharedBackendDto;
  onConflict: (conflict: SharedBackendFsidConflict) => void;
  onClose: () => void;
}) {
  const [displayName, setDisplayName] = useState(backend.displayName ?? '');
  const [overcommitRatio, setOvercommitRatio] = useState(String(backend.overcommitRatio));
  const invalidate = useInvalidateBackend(backend.id);
  const patchBackend = useMutation({
    mutationFn: (body: { expectedRevision: number; displayName?: string | null; overcommitRatio?: number }) =>
      api.patch<SharedBackendDto>(`/shared-backends/${backend.id}`, body),
    onSuccess: () => {
      toast({ title: '共享后端已更新' });
      onClose();
      invalidate();
    },
    onError: (error) => {
      reportFsidConflict(error, onConflict);
      toast({ title: '更新失败', description: errorMessage(error), variant: 'destructive' });
    },
  });
  const pending = patchBackend.isPending;
  const save = () => {
    const parsed = zPatchSharedBackendRequest.safeParse({
      expectedRevision: backend.revision,
      displayName: displayName.trim() || null,
      overcommitRatio: Number(overcommitRatio),
    });
    if (!parsed.success) {
      toast({
        title: '请检查参数',
        description: parsed.error.issues[0]?.message ?? '显示名称或超分比例无效',
        variant: 'destructive',
      });
      return;
    }
    patchBackend.mutate(parsed.data);
  };
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>编辑共享后端</DialogTitle>
        </DialogHeader>
        <FormField id="shared-backend-display-name" label="显示名称">
          <Input
            id="shared-backend-display-name"
            value={displayName}
            placeholder={backend.name}
            onChange={(event) => setDisplayName(event.target.value)}
          />
        </FormField>
        <FormField id="shared-backend-overcommit" label="超分比例">
          <Input
            id="shared-backend-overcommit"
            value={overcommitRatio}
            onChange={(event) => setOvercommitRatio(event.target.value)}
          />
        </FormField>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={pending}>取消</Button>
          <Button onClick={save} disabled={pending}>
            {pending ? '保存中...' : '保存'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Header menu entry that deletes the backend after a confirmation. */
export function DeleteBackendAction({
  backend,
  onConflict,
}: {
  backend: SharedBackendDto;
  onConflict: (conflict: SharedBackendFsidConflict) => void;
}) {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate({ from: '/shared-backends/$id' });
  const queryClient = useQueryClient();
  const deleteBackend = useMutation({
    mutationFn: () => api.delete<void>(`/shared-backends/${backend.id}`),
    onSuccess: () => {
      toast({ title: '共享后端已删除' });
      setOpen(false);
      void queryClient.invalidateQueries({ queryKey: queryKeys.sharedBackends.admin });
      void queryClient.invalidateQueries({ queryKey: queryKeys.sharedVolumes.admin });
      void navigate({ to: '/shared-backends' });
    },
    onError: (error) => {
      reportFsidConflict(error, onConflict);
      toast({ title: '删除失败', description: errorMessage(error), variant: 'destructive' });
    },
  });
  return (
    <>
      <MoreActions actions={[{ label: '删除后端', icon: Trash2, destructive: true, onSelect: () => setOpen(true) }]} />
      <ConfirmDialog
        open={open}
        title="删除共享后端？"
        description={
          <>
            将删除登记「{backend.displayName ?? backend.name}」。仍有关联存储池或数据卷时后端可能拒绝删除。
            <dl className="mt-3 space-y-2 rounded-md border px-3 py-3 text-sm text-foreground">
              <div>
                <dt className="text-xs text-muted-foreground">显示名称</dt>
                <dd>{backend.displayName ?? backend.name}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">identity key</dt>
                <dd className="break-all font-mono text-xs">{backend.identityKey}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Ceph FSID</dt>
                <dd className="break-all font-mono text-xs">{backend.cephFsid}</dd>
              </div>
            </dl>
          </>
        }
        confirmLabel="确认删除"
        pendingLabel="删除中..."
        pending={deleteBackend.isPending}
        testId="shared-backend-delete-confirm"
        onConfirm={() => deleteBackend.mutate()}
        onOpenChange={setOpen}
      />
    </>
  );
}
