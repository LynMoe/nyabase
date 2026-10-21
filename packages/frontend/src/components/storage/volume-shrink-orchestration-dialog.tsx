import type { VolumeDto } from '@nyabase/common';
import { formatBytes } from '../../lib/utils.js';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog.js';
import { ShrinkDialogBody, ShrinkDialogFooter } from './volume-shrink-orchestration-dialog/dialog-parts.js';
import { useVolumeShrinkFlow } from './volume-shrink-orchestration-dialog/use-volume-shrink-flow.js';

/** Shrinking an attached volume: unmount it everywhere, shrink, offer to mount it back. */
export function VolumeShrinkOrchestrationDialog({
  volume,
  sizeBytes,
  open,
  onOpenChange,
  onComplete,
}: {
  volume: VolumeDto;
  sizeBytes: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onComplete: () => void;
}) {
  const flow = useVolumeShrinkFlow({ volume, sizeBytes, open, onComplete });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="volume-shrink-orchestration">
        <DialogHeader>
          <DialogTitle>缩容需要先卸载</DialogTitle>
          <DialogDescription>
            缩容前必须从相关容器卸载此数据卷（共 {flow.attachments.length} 处挂载），卸载完成后再提交缩容。目标容量 {formatBytes(sizeBytes)}。
          </DialogDescription>
        </DialogHeader>
        <ShrinkDialogBody flow={flow} />
        <ShrinkDialogFooter flow={flow} onClose={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}
