import { IntentResourceType, type ListScope, type SharedVolumeDto } from '@nyabase/common';
import { StatusBadge } from '../layout/status-badge.js';
import { Button } from '../ui/button.js';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog.js';
import { ResourceIntentFailures, ResourceIntentHistory } from '../intents/resource-intent-failures.js';
import { ResourceRef } from '../refs/resource-ref.js';
import { formatObservedUsage } from '../../lib/storage-shrink.js';
import { relativeTime, formatGib } from '../../lib/utils.js';
import { resourceIntentsPath } from '../../lib/intent-visibility.js';
import { volumeInProgress } from '../../lib/in-progress.js';
import { failureCodeLabel, volumeAttentionHint, volumeLifecycleLabel } from '../../lib/status-labels.js';
import { Field } from '../layout/field.js';

function shrinkLabel(volume: SharedVolumeDto): string {
  if (volume.capability.shrinkNever) return '不可缩容';
  if (volume.capability.shrinkRequiresStop) return '缩容需卸载';
  if (volume.capability.shrinkOnline) return '可在线缩容';
  return '缩容受用量约束';
}

export function SharedVolumeDetailDialog({
  volume,
  scope,
  open,
  onOpenChange,
}: {
  volume: SharedVolumeDto | null;
  scope: ListScope;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  if (!volume) return null;
  const intentPath = resourceIntentsPath(scope, IntentResourceType.Volume, volume.id);
  const phaseLabel = volume.needsAttention
    ? '需要关注'
    : volumeLifecycleLabel(volume.lifecyclePhase);
  const codeLabel = failureCodeLabel(volume.failureCode);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl" data-testid="shared-volume-detail">
        <DialogHeader>
          <DialogTitle>{volume.name}</DialogTitle>
          <DialogDescription>
            {volume.sharedBackendName}
            {' · '}
            {volume.incusName}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 text-sm sm:grid-cols-2">
          {scope === 'all' ? (
            <Field label="所有者" value={<ResourceRef kind="user" id={volume.ownerId} />} />
          ) : null}
          <Field label="共享后端" value={volume.sharedBackendName} />
          <Field label="容量" value={formatGib(volume.sizeBytes)} />
          <Field label="已用" value={formatObservedUsage(volume.usedBytes)} />
          <Field label="缩容能力" value={shrinkLabel(volume)} />
          <Field label="目录" value={volume.dirEnsured ? '已在机器上落地' : '尚未挂载过'} />
          <Field label="最近更新" value={relativeTime(volume.updatedAt)} />
          <div className="sm:col-span-2">
            <p className="text-xs text-muted-foreground">状态</p>
            <div className="mt-1">
              <StatusBadge
                label={phaseLabel}
                pending={volumeInProgress(volume)}
                variant={volume.needsAttention ? 'destructive' : volume.lifecyclePhase === 'active' ? 'success' : 'secondary'}
              />
              {volume.needsAttention ? (
                <p className="mt-1 text-xs text-destructive">{volumeAttentionHint(volume.failureCode)}</p>
              ) : volume.failureCode ? (
                <p className="mt-1 text-xs text-destructive">
                  {codeLabel}
                  {codeLabel !== volume.failureCode ? `（${volume.failureCode}）` : null}
                </p>
              ) : null}
            </div>
          </div>
          <div className="sm:col-span-2">
            <p className="text-xs text-muted-foreground">挂载</p>
            <p className="mt-1">
              {volume.attachments.length === 0 ? (
                <span className="text-muted-foreground">未挂载</span>
              ) : (
                <span data-testid="shared-volume-attachments">
                  挂载于 {volume.attachments.map((item) => `${item.containerName}（${item.containerPath}）`).join('、')}
                </span>
              )}
            </p>
          </div>
        </div>
        {scope === 'mine' ? <ResourceIntentFailures listPath={intentPath} /> : null}
        <ResourceIntentHistory listPath={intentPath} scope={scope} defaultOpen />
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>关闭</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

