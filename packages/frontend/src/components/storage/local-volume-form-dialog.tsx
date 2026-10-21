import { Button } from '../ui/button.js';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog.js';
import { shrinkNeverTooltip } from '../../lib/storage-shrink.js';
import { LocalVolumeFields } from './local-volume-form-dialog/local-volume-fields.js';
import {
  useLocalVolumeForm,
  type LocalVolumeFormProps,
} from './local-volume-form-dialog/use-local-volume-form.js';
import { VolumeShrinkOrchestrationDialog } from './volume-shrink-orchestration-dialog.js';

export function LocalVolumeFormDialog(props: LocalVolumeFormProps) {
  const { volume, open, onOpenChange } = props;
  const form = useLocalVolumeForm(props);
  const { editing, orchestrate, nextSize, quotaError, shrinkBlocked, path } = form;

  return (
    <>
      <Dialog open={open && !orchestrate} onOpenChange={onOpenChange}>
        <DialogContent data-testid="volume-form">
          <DialogHeader>
            <DialogTitle>{editing ? '编辑数据卷' : '新建数据卷'}</DialogTitle>
            {form.description ? <DialogDescription>{form.description}</DialogDescription> : null}
          </DialogHeader>
          <LocalVolumeFields form={form} />
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
            <Button
              onClick={form.submit}
              disabled={form.pending || Boolean(form.floorError) || Boolean(quotaError) || (shrinkBlocked && path === 'never')}
              title={quotaError ?? (shrinkBlocked && path === 'never' ? shrinkNeverTooltip() : undefined)}
            >
              {form.pending ? '提交中...' : path === 'requires_stop' ? '继续缩容编排' : '保存'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {volume && orchestrate && Number.isFinite(nextSize) && (
        <VolumeShrinkOrchestrationDialog
          volume={{ ...volume, name: form.name.trim() || volume.name }}
          sizeBytes={nextSize}
          open={orchestrate}
          onOpenChange={(next) => {
            form.setOrchestrate(next);
            if (!next) onOpenChange(false);
          }}
          onComplete={() => {
            form.data.invalidateVolumeLists();
          }}
        />
      )}
    </>
  );
}
