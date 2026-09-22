import { useState } from 'react';
import { Pencil, Search, Trash2 } from 'lucide-react';
import type { SharedVolumeDto } from '@nyabase/common';
import { StatusBadge } from '../layout/status-badge.js';
import { Button } from '../ui/button.js';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../ui/table.js';
import { ResourceRef } from '../refs/resource-ref.js';
import { SharedVolumeDetailDialog } from './shared-volume-detail-dialog.js';
import { formatObservedUsage } from '../../lib/storage-shrink.js';
import { approxGibHint } from '../../lib/utils.js';
import { volumeInProgress } from '../../lib/in-progress.js';
import { failureCodeLabel, volumeAttentionHint, volumeLifecycleLabel } from '../../lib/status-labels.js';

export function SharedVolumeTable({
  volumes,
  plane,
  showBackendColumn,
  onEdit,
  onDelete,
  onInspect,
  testId = 'shared-volume-table',
  emptyLabel,
}: {
  volumes: SharedVolumeDto[];
  plane: 'user' | 'admin';
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
    + (plane === 'admin' ? 1 : 0)
    + (showBackendColumn ? 1 : 0)
    + (showActions ? 1 : 0);

  return (
    <>
      <Table className="min-w-[720px]" data-testid={testId}>
        <TableHeader>
          <TableRow>
            <TableHead>名称</TableHead>
            {plane === 'admin' ? <TableHead>所有者</TableHead> : null}
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
                {emptyLabel ?? (plane === 'admin' ? '暂无租户共享卷' : '暂无共享卷')}
              </TableCell>
            </TableRow>
          ) : volumes.map((volume) => (
            <SharedVolumeRow
              key={volume.id}
              volume={volume}
              plane={plane}
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
        plane={plane}
        open={Boolean(detail)}
        onOpenChange={(open) => { if (!open) setDetail(null); }}
      />
    </>
  );
}

function SharedVolumeRow({
  volume,
  plane,
  showBackendColumn,
  showActions,
  onOpenDetail,
  onEdit,
  onDelete,
  onInspect,
}: {
  volume: SharedVolumeDto;
  plane: 'user' | 'admin';
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
      {plane === 'admin' ? (
        <TableCell onClick={(event) => event.stopPropagation()}>
          <ResourceRef kind="user" id={volume.ownerId} />
        </TableCell>
      ) : null}
      {showBackendColumn ? <TableCell>{volume.sharedBackendName}</TableCell> : null}
      <TableCell>{approxGibHint(volume.sizeBytes).replace(/^约 /, '')}</TableCell>
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
              <Button size="sm" variant="destructive" onClick={() => onDelete(volume)}>
                <Trash2 className="h-3.5 w-3.5" />删除
              </Button>
            ) : null}
          </div>
        </TableCell>
      ) : null}
    </TableRow>
  );
}
