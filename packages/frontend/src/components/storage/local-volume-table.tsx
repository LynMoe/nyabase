import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { Pencil, Trash2 } from 'lucide-react';
import { IntentResourceType, type ListScope, type VolumeDto } from '@nyabase/common';
import { Button } from '../ui/button.js';
import { shrinkLabel } from '../../lib/storage-shrink.js';
import { StatusBadge } from '../layout/status-badge.js';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../ui/table.js';
import { ResourceRef } from '../refs/resource-ref.js';
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
import { Field } from '../layout/form-field.js';

function adminContainerDetailTo(scope: ListScope) {
  if (scope === 'all') return '/manage/containers/$containerId' as const;
  return null;
}

export function LocalVolumeTable({
  volumes,
  scope,
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
  scope: ListScope;
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
    + (scope === 'all' ? 1 : 0)
    + (showServerColumn ? 1 : 0)
    + (showPoolColumn ? 1 : 0)
    + (showActions ? 1 : 0);

  return (
    <>
    <Table className="min-w-[720px]" data-testid={testId} data-pool-id={poolId}>
      <TableHeader>
        <TableRow>
          <TableHead>名称</TableHead>
          {scope === 'all' ? <TableHead>所有者</TableHead> : null}
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
              {scope === 'mine' ? '暂无本地数据卷' : '暂无本地数据卷'}
            </TableCell>
          </TableRow>
        ) : volumes.map((volume) => (
          <VolumeRow
            key={volume.id}
            volume={volume}
            scope={scope}
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
      scope={scope}
      open={Boolean(detail)}
      onOpenChange={(open) => { if (!open) setDetail(null); }}
    />
    </>
  );
}

function VolumeRow({
  volume,
  scope,
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
  scope: ListScope;
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
      {scope === 'all' ? (
        <TableCell onClick={(event) => event.stopPropagation()}>
          <ResourceRef kind="user" id={volume.ownerId} />
        </TableCell>
      ) : null}
      {showServerColumn ? <TableCell>{serverName}</TableCell> : null}
      {showPoolColumn ? <TableCell>{volume.poolName}</TableCell> : null}
      <TableCell>{formatGib(volume.sizeBytes)}</TableCell>
      <TableCell>{volume.usedBytes === null ? '未知' : formatGib(volume.usedBytes)}</TableCell>
      <TableCell className="max-w-[16rem] whitespace-normal">
        <VolumeAttachmentsCell
          volume={volume}
          scope={scope}
          canManageContainersAny={canManageContainersAny}
        />
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

function VolumeAttachmentsCell({
  volume,
  scope,
  canManageContainersAny,
}: {
  volume: VolumeDto;
  scope: ListScope;
  canManageContainersAny: boolean;
}) {
  if (scope === 'all') {
    if (volume.attachments.length === 0) {
      return <span className="text-muted-foreground">未挂载</span>;
    }
    const adminTo = adminContainerDetailTo(scope);
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
                search={{ tab: 'overview' }}
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

  if (scope === 'mine') {
    if (volume.attachments.length === 0) {
      return <span className="text-muted-foreground">未挂载</span>;
    }
    return (
      <span data-testid="volume-attachments">
        挂载于{' '}
        {volume.attachments.map((item, index) => (
          <span key={item.attachmentId}>
            {index > 0 ? '、' : null}
            <Link
              to="/containers/$containerId"
              params={{ containerId: item.containerId }}
              search={{ tab: 'overview' }}
              className="underline underline-offset-4"
              onClick={(event) => event.stopPropagation()}
            >
              {item.containerName}
            </Link>
            <span className="text-muted-foreground">（{item.containerPath}）</span>
          </span>
        ))}
      </span>
    );
  }

  return null;
}

export function LocalVolumeDetailDialog({
  volume,
  scope,
  open,
  onOpenChange,
}: {
  volume: VolumeDto | null;
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
          {scope === 'all' ? (
            <Field label="所有者" value={<ResourceRef kind="user" id={volume.ownerId} />} />
          ) : null}
          <Field label="存储池" value={volume.poolName} />
          <Field label="容量" value={formatGib(volume.sizeBytes)} />
          <Field label="已用" value={volume.usedBytes === null ? '未知' : formatGib(volume.usedBytes)} />
          <Field label="缩容能力" value={shrinkLabel(volume)} />
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
                <span data-testid="volume-attachments">
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
