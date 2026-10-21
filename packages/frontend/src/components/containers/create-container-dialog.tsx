import { Button } from '../ui/button.js';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog.js';
import { Input } from '../ui/input.js';
import { FormField } from '../layout/form-field.js';
import { useMySshKeys } from '../../hooks/use-my-ssh-keys.js';
import { SshKeyNotice } from '../ssh/ssh-key-notice.js';
import {
  GpuAndStartFields,
  PlacementFields,
  SpecFields,
} from './create-container-dialog/create-container-fields.js';
import { useCreateContainerForm } from './create-container-dialog/use-create-container-form.js';

export function CreateContainerDialog({
  open,
  onOpenChange,
  defaultServerId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultServerId?: string;
}) {
  const form = useCreateContainerForm({ open, onOpenChange, defaultServerId });
  const sshKeys = useMySshKeys(open);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="container-create-canonical">
        <DialogHeader>
          <DialogTitle>新建容器</DialogTitle>
          <DialogDescription>创建后可通过 SSH 跳板机登录，规格之后也能调整。</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            form.submit();
          }}
        >
          <FormField id="container-name" label="名称" error={form.errors.name} hint="字母、数字和连字符，例如 dev-ubuntu">
            <Input
              id="container-name"
              value={form.form.name}
              autoFocus
              autoComplete="off"
              onChange={(event) => form.update('name', event.target.value)}
              placeholder="dev-ubuntu"
            />
          </FormField>
          <PlacementFields form={form} />
          <SpecFields form={form} />
          <GpuAndStartFields form={form} />
          {sshKeys.missing ? <SshKeyNotice variant="inline" onNavigate={() => onOpenChange(false)} /> : null}
          {form.submitError ? <p className="text-sm text-destructive" role="alert">{form.submitError}</p> : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
            <Button type="submit" disabled={form.pending || form.data.serversLoading || form.overQuota}>
              {form.pending ? '提交中...' : '创建'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
