import type { SharedBackendDto } from '@nyabase/common';
import { Button } from '../../components/ui/button.js';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '../../components/ui/dialog.js';
import { Input } from '../../components/ui/input.js';
import { ConfirmDialog } from '../../components/layout/confirm-dialog.js';
import { FormField } from '../../components/layout/form-field.js';

export function EditBackendDialog({
  backend,
  displayName,
  overcommitRatio,
  pending,
  onDisplayNameChange,
  onOvercommitChange,
  onSave,
  onClose,
}: {
  backend: SharedBackendDto | undefined;
  displayName: string;
  overcommitRatio: string;
  pending: boolean;
  onDisplayNameChange: (value: string) => void;
  onOvercommitChange: (value: string) => void;
  onSave: () => void;
  onClose: () => void;
}) {
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
            placeholder={backend?.name}
            onChange={(event) => onDisplayNameChange(event.target.value)}
          />
        </FormField>
        <FormField id="shared-backend-overcommit" label="超分比例">
          <Input
            id="shared-backend-overcommit"
            value={overcommitRatio}
            onChange={(event) => onOvercommitChange(event.target.value)}
          />
        </FormField>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={pending}>取消</Button>
          <Button onClick={onSave} disabled={pending}>
            {pending ? '保存中...' : '保存'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function DeleteBackendDialog({
  backend,
  open,
  pending,
  onConfirm,
  onClose,
}: {
  backend: SharedBackendDto | undefined;
  open: boolean;
  pending: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <ConfirmDialog
      open={open}
      title="删除共享后端？"
      description={
        <>
          将删除登记「{backend?.displayName ?? backend?.name}」。仍有关联存储池或数据卷时后端可能拒绝删除。
          {backend && (
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
          )}
        </>
      }
      confirmLabel="确认删除"
      pendingLabel="删除中..."
      pending={pending}
      testId="shared-backend-delete-confirm"
      onConfirm={onConfirm}
      onOpenChange={(next) => { if (!next) onClose(); }}
    />
  );
}
