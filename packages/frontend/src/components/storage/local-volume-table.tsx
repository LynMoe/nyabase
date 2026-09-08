import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { Pencil, Trash2 } from 'lucide-react';
import type { VolumeDto } from '@nyabase/common';
import { Badge } from '../ui/badge.js';
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
import { LocalVolumeDetailDialog } from './local-volume-detail-dialog.js';
import { approxGibHint } from '../../lib/utils.js';
import { failureCodeLabel, volumeAttentionHint, volumeLifecycleLabel } from '../../lib/status-labels.js';

function adminContainerDetailTo(plane: 'user' | 'admin') {
  if (plane === 'admin') return '/manage/containers/$containerId' as const;
  return null;
}

export function LocalVolumeTable({
  volumes,
  plane,
  showPoolColumn,
  showServerColumn = false,
  serverNameById,
  canManageContainersAny = false,
  onEdit,
  onDelete,
  testId = 'server-volume-table',
  poolId,
}: {
  volumes: VolumeDto[];
  plane: 'user' | 'admin';
  showPoolColumn: boolean;
  showServerColumn?: boolean;
  serverNameById?: ReadonlyMap<string, string>;
  canManageContainersAny?: boolean;
  onEdit?: (volume: VolumeDto) => void;
  onDelete?: (volume: VolumeDto) => void;
  testId?: string;
  poolId?: string;
}) {
  const [detail, setDetail] = useState<VolumeDto | null>(null);
  const showActions = Boolean(onEdit || onDelete);
  const columnCount = 5
    + (plane === 'admin' ? 1 : 0)
    + (showServerColumn ? 1 : 0)
    + (showPoolColumn ? 1 : 0)
    + (showActions ? 1 : 0);

  return (
    <>
    <Table className="min-w-[720px]" data-testid={testId} data-pool-id={poolId}>
      <TableHeader>
        <TableRow>
          <TableHead>名称</TableHead>
          {plane === 'admin' ? <TableHead>所有者</TableHead> : null}
          {showServerColumn ? <TableHead>服务器</TableHead> : null}
          {showPoolColumn ? <TableHead>存储池</TableHead> : null}
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
              {plane === 'user' ? '暂无本地数据卷' : '暂无本地数据卷'}
            </TableCell>
          </TableRow>
        ) : volumes.map((volume) => (
          <VolumeRow
            key={volume.id}
            volume={volume}
            plane={plane}
            showPoolColumn={showPoolColumn}
            showServerColumn={showServerColumn}
            serverName={serverNameById?.get(volume.serverId) ?? '未知服务器'}
            canManageContainersAny={canManageContainersAny}
            showActions={showActions}
            onOpenDetail={() => setDetail(volume)}
            onEdit={onEdit}
            onDelete={onDelete}
          />
        ))}
      </TableBody>
    </Table>
    <LocalVolumeDetailDialog
      volume={detail}
      plane={plane}
      open={Boolean(detail)}
      onOpenChange={(open) => { if (!open) setDetail(null); }}
    />
    </>
  );
}

function VolumeRow({
  volume,
  plane,
  showPoolColumn,
  showServerColumn,
  serverName,
  canManageContainersAny,
  showActions,
  onOpenDetail,
  onEdit,
  onDelete,
}: {
  volume: VolumeDto;
  plane: 'user' | 'admin';
  showPoolColumn: boolean;
  showServerColumn: boolean;
  serverName: string;
  canManageContainersAny: boolean;
  showActions: boolean;
  onOpenDetail: () => void;
  onEdit?: (volume: VolumeDto) => void;
  onDelete?: (volume: VolumeDto) => void;
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
      {showServerColumn ? <TableCell>{serverName}</TableCell> : null}
      {showPoolColumn ? <TableCell>{volume.poolName}</TableCell> : null}
      <TableCell>{bytesLabel(volume.sizeBytes)}</TableCell>
      <TableCell>{volume.usedBytes === null ? '未知' : bytesLabel(volume.usedBytes)}</TableCell>
      <TableCell className="max-w-[16rem] whitespace-normal">
        <VolumeAttachmentsCell
          volume={volume}
          plane={plane}
          canManageContainersAny={canManageContainersAny}
        />
      </TableCell>
      <TableCell className="whitespace-normal">
        <Badge variant={volume.needsAttention ? 'destructive' : volume.lifecyclePhase === 'active' ? 'success' : 'secondary'}>
          {phaseLabel}
        </Badge>
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

function VolumeAttachmentsCell({
  volume,
  plane,
  canManageContainersAny,
}: {
  volume: VolumeDto;
  plane: 'user' | 'admin';
  canManageContainersAny: boolean;
}) {
  if (plane === 'admin') {
    if (volume.attachments.length === 0) {
      return <span className="text-muted-foreground">未挂载</span>;
    }
    const adminTo = adminContainerDetailTo(plane);
    return (
      <span data-testid="volume-attachments">
        挂载于{' '}
        {volume.attachments.map((item, index) => (
          <span key={item.attachmentId}>
            {index > 0 ? '、' : null}
            {canManageContainersAny && adminTo ? (
              <Link
                to={adminTo}
                params={{ containerId: item.containerId }}
                search={{ tab: 'storage' }}
                className="underline"
                onClick={(event) => event.stopPropagation()}
              >
                {item.containerName}（{item.containerPath}）
              </Link>
            ) : (
              `${item.containerName}（${item.containerPath}）`
            )}
          </span>
        ))}
      </span>
    );
  }

  if (plane === 'user') {
    if (volume.attachments.length === 0) {
      return (
        <span className="text-muted-foreground">
          请打开目标容器详情 → 存储 → 挂载
          {' '}
          <Link to="/containers" className="underline" onClick={(event) => event.stopPropagation()}>到容器</Link>
        </span>
      );
    }
    return (
      <span data-testid="volume-attachments">
        挂载于 {volume.attachments.map((item) => `${item.containerName}（${item.containerPath}）`).join('、')}
        {' '}
        <Link to="/containers" className="underline">到容器</Link>
      </span>
    );
  }

  return null;
}

function bytesLabel(bytes: number): string {
  return approxGibHint(bytes).replace(/^约 /, '');
}
