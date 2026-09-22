import type { ReactNode } from 'react';
import type { VolumeDto } from '@nyabase/common';
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
import { approxGibHint, relativeTime } from '../../lib/utils.js';
import { volumeInProgress } from '../../lib/in-progress.js';
import { failureCodeLabel, volumeAttentionHint, volumeLifecycleLabel } from '../../lib/status-labels.js';

function bytesLabel(bytes: number): string {
  return approxGibHint(bytes).replace(/^约 /, '');
}

function shrinkLabel(volume: VolumeDto): string {
  if (volume.capability.shrinkNever) return '不可缩容';
  if (volume.capability.shrinkRequiresStop) return '缩容需卸载';
  if (volume.capability.shrinkOnline) return '可在线缩容';
  return '缩容受用量约束';
}

export function LocalVolumeDetailDialog({
  volume,
  plane,
  open,
  onOpenChange,
}: {
  volume: VolumeDto | null;
  plane: 'user' | 'admin';
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  if (!volume) return null;
  const intentPath = plane === 'admin'
    ? `/admin/volumes/${volume.id}/intents`
    : `/volumes/${volume.id}/intents`;
  const phaseLabel = volume.needsAttention
    ? '需要关注'
    : volumeLifecycleLabel(volume.lifecyclePhase);
  const codeLabel = failureCodeLabel(volume.failureCode);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl" data-testid="local-volume-detail">
        <DialogHeader>
          <DialogTitle>{volume.name}</DialogTitle>
          <DialogDescription>
            {volume.poolName}
            {' · '}
            {volume.incusName}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 text-sm sm:grid-cols-2">
          {plane === 'admin' ? (
            <Info label="所有者">
              <ResourceRef kind="user" id={volume.ownerId} />
            </Info>
          ) : null}
          <Info label="存储池" value={volume.poolName} />
          <Info label="容量" value={bytesLabel(volume.sizeBytes)} />
          <Info label="已用" value={volume.usedBytes === null ? '未知' : bytesLabel(volume.usedBytes)} />
          <Info label="缩容能力" value={shrinkLabel(volume)} />
          <Info label="最近更新" value={relativeTime(volume.updatedAt)} />
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
                <span data-testid="volume-attachments">
                  挂载于 {volume.attachments.map((item) => `${item.containerName}（${item.containerPath}）`).join('、')}
                </span>
              )}
            </p>
          </div>
        </div>
        {plane === 'user' ? <ResourceIntentFailures listPath={intentPath} admin={false} /> : null}
        <ResourceIntentHistory listPath={intentPath} admin={plane === 'admin'} defaultOpen />
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>关闭</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Info({
  label,
  value,
  children,
}: {
  label: string;
  value?: string;
  children?: ReactNode;
}) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <div className="mt-1 break-all">{children ?? value}</div>
    </div>
  );
}
