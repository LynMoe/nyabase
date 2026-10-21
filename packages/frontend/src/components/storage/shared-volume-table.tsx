import { useState } from 'react';
import { Pencil, Search, Trash2 } from 'lucide-react';
import { IntentResourceType, type ListScope, type SharedVolumeDto } from '@nyabase/common';
import { StatusBadge } from '../layout/status-badge.js';
import { Button } from '../ui/button.js';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../ui/table.js';
import { ResourceRef } from '../refs/resource-ref.js';
import { formatObservedUsage } from '../../lib/storage-shrink.js';
import { formatGib, relativeTime } from '../../lib/utils.js';
import { volumeInProgress } from '../../lib/in-progress.js';
import { failureCodeLabel, volumeAttentionHint, volumeLifecycleLabel } from '../../lib/status-labels.js';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog.js';
import { ResourceIntentFailures, ResourceIntentHistory } from '../intents/resource-intent-failures.js';
import { resourceIntentsPath } from '../../lib/intent-visibility.js';
import { Field } from '../layout/field.js';

export function SharedVolumeTable({
  volumes,
  scope,
  showBackendColumn,
  onEdit,
  onDelete,
  onInspect,
  testId = 'shared-volume-table',
  emptyLabel,
}: {
  volumes: SharedVolumeDto[];
  scope: ListScope;
  showBackendColumn?: boolean;
  onEdit?: (volume: SharedVolumeDto) => void;
  onDelete?: (volume: SharedVolumeDto) => void;
  onInspect?: (volume: SharedVolumeDto) => void;
  testId?: string;
  emptyLabel?: string;
}) {
  const [detail, setDetail] = useState<SharedVolumeDto | null>(null);
  const showActions = Boolean(onEdit || onDelete || onInspect);
  const columnCount = 5
    + (scope === 'all' ? 1 : 0)
    + (showBackendColumn ? 1 : 0)
    + (showActions ? 1 : 0);

  return (
    <>
      <Table className="min-w-[720px]" data-testid={testId}>
        <TableHeader>
          <TableRow>
            <TableHead>名称</TableHead>
            {scope === 'all' ? <TableHead>所有者</TableHead> : null}
            {showBackendColumn ? <TableHead>后端</TableHead> : null}
            <TableHead>容量</TableHead>
            <TableHead>已用</TableHead>
            <TableHead>挂载</TableHead>
            <TableHead>状态</TableHead>
            {showActions ? <TableHead className="text-right">操作</TableHead> : null}
          </TableRow>
        </TableHeader>
        <TableBody>
          {volumes.length === 0 ? (
            <TableRow>
              <TableCell colSpan={columnCount} className="py-6 text-center text-muted-foreground">
                {emptyLabel ?? (scope === 'all' ? '暂无租户共享卷' : '暂无共享卷')}
              </TableCell>
            </TableRow>
          ) : volumes.map((volume) => (
            <SharedVolumeRow
              key={volume.id}
              volume={volume}
              scope={scope}
              showBackendColumn={Boolean(showBackendColumn)}
              showActions={showActions}
              onOpenDetail={() => setDetail(volume)}
              onEdit={onEdit}
              onDelete={onDelete}
              onInspect={onInspect}
            />
          ))}
        </TableBody>
      </Table>
      <SharedVolumeDetailDialog
        volume={detail}
        scope={scope}
        open={Boolean(detail)}
        onOpenChange={(open) => { if (!open) setDetail(null); }}
      />
    </>
  );
}

function SharedVolumeRow({
  volume,
  scope,
  showBackendColumn,
  showActions,
  onOpenDetail,
  onEdit,
  onDelete,
  onInspect,
}: {
  volume: SharedVolumeDto;
  scope: ListScope;
  showBackendColumn: boolean;
  showActions: boolean;
  onOpenDetail: () => void;
  onEdit?: (volume: SharedVolumeDto) => void;
  onDelete?: (volume: SharedVolumeDto) => void;
  onInspect?: (volume: SharedVolumeDto) => void;
}) {
  const phaseLabel = volume.needsAttention
    ? '需要关注'
    : volumeLifecycleLabel(volume.lifecyclePhase);
  const codeLabel = failureCodeLabel(volume.failureCode);
  return (
    <TableRow className="cursor-pointer" onClick={onOpenDetail}>
      <TableCell>
        <button type="button" className="font-medium underline-offset-4 hover:underline">
          {volume.name}
        </button>
      </TableCell>
      {scope === 'all' ? (
        <TableCell onClick={(event) => event.stopPropagation()}>
          <ResourceRef kind="user" id={volume.ownerId} />
        </TableCell>
      ) : null}
      {showBackendColumn ? <TableCell>{volume.sharedBackendName}</TableCell> : null}
      <TableCell>{formatGib(volume.sizeBytes)}</TableCell>
      <TableCell>{formatObservedUsage(volume.usedBytes)}</TableCell>
      <TableCell className="max-w-[16rem] whitespace-normal">
        {volume.attachments.length === 0 ? (
          <span className="text-muted-foreground">未挂载</span>
        ) : (
          <span data-testid="shared-volume-attachments">
            挂载于 {volume.attachments.map((item) => `${item.containerName}（${item.containerPath}）`).join('、')}
          </span>
        )}
      </TableCell>
      <TableCell className="whitespace-normal">
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
      </TableCell>
      {showActions ? (
        <TableCell className="text-right" onClick={(event) => event.stopPropagation()}>
          <div className="flex justify-end gap-2">
            {onInspect ? (
              <Button size="sm" variant="outline" onClick={() => onInspect(volume)}>
                <Search className="h-3.5 w-3.5" />排障
              </Button>
            ) : null}
            {onEdit ? (
              <Button size="sm" variant="outline" onClick={() => onEdit(volume)}>
                <Pencil className="h-3.5 w-3.5" />编辑/扩缩
              </Button>
            ) : null}
            {onDelete ? (
              <Button size="sm" variant="ghost-destructive" onClick={() => onDelete(volume)}>
                <Trash2 className="h-3.5 w-3.5" />删除
              </Button>
            ) : null}
          </div>
        </TableCell>
      ) : null}
    </TableRow>
  );
}

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
