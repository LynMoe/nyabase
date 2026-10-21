import { Button } from '../ui/button.js';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog.js';
import { shrinkNeverTooltip } from '../../lib/storage-shrink.js';
import { SharedVolumeFields } from './shared-volume-form-dialog/shared-volume-fields.js';
import {
  useSharedVolumeForm,
  type SharedVolumeFormProps,
} from './shared-volume-form-dialog/use-shared-volume-form.js';

export function SharedVolumeFormDialog(props: SharedVolumeFormProps) {
  const { open, onOpenChange } = props;
  const form = useSharedVolumeForm(props);
  const { quotaError, shrinkBlocked, path } = form;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="shared-volume-form">
        <DialogHeader>
          <DialogTitle>{form.editing ? '编辑共享卷' : '新建共享卷'}</DialogTitle>
          {form.description ? <DialogDescription>{form.description}</DialogDescription> : null}
        </DialogHeader>
        <SharedVolumeFields form={form} />
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
          <Button
            onClick={form.submit}
            disabled={form.pending || Boolean(form.floorError) || Boolean(quotaError) || (shrinkBlocked && path === 'never')}
            title={quotaError ?? (shrinkBlocked && path === 'never' ? shrinkNeverTooltip() : undefined)}
          >
            {form.pending ? '提交中...' : '保存'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
