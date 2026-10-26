import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Loader2, Pencil, Plus } from 'lucide-react';
import {
  Role,
  ContainerStatus,
  type AttachVolumeRequest,
  type ContainerDto,
  type IntentAcceptedDto,
  type ListScope,
  type SharedVolumeDto,
  type VolumeAttachmentDto,
  type VolumeDto,
} from '@nyabase/common';
import { Button } from '../ui/button.js';
import { LocalVolumeFormDialog } from '../storage/local-volume-form-dialog.js';
import { Checkbox } from '../ui/checkbox.js';
import { Input } from '../ui/input.js';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../ui/table.js';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog.js';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../ui/tooltip.js';
import { FormField } from '../layout/form-field.js';
import { SectionCard } from '../layout/section-card.js';
import { Progress } from '../ui/progress.js';
import { api } from '../../lib/api.js';
import { filterAttachableSharedVolumes, filterAttachableVolumes } from '../../lib/attachable-volumes.js';
import { useInvalidateContainer } from '../../lib/container-queries.js';
import { bindInProgress } from '../../lib/in-progress.js';
import { queryKeys } from '../../lib/query-keys.js';
import { refetchWhileInProgress } from '../../lib/query-lifecycle.js';
import { scopedPath } from '../../lib/scoped-paths.js';
import { useHasRole } from '../../lib/use-role.js';
import { useActionMutation } from '../../hooks/use-action-mutation.js';
import { ConfirmDialog } from '../layout/confirm-dialog.js';
import { QueryView } from '../layout/query-view.js';
import { RootShrinkOrchestrationDialog } from '../storage/root-shrink-orchestration-dialog.js';
import { formatGib } from '../../lib/utils.js';
import { observedRootUsedBytes } from '../../lib/storage-shrink.js';
import { RootSizeDialog } from './spec-panel.js';

const BIND_STATE_LABEL = {
  attaching: '挂载中',
  attached: '已挂载',
  detaching: '卸载中',
} as const;

type MountDisk = {
  id: string;
  name: string;
  kind: 'local' | 'shared';
  sizeBytes: number;
};

type VolumeUsage = {
  id: string;
  sizeBytes: number;
  usedBytes: number | null;
};

/**
 * The container's storage table with the mount, root-resize and detach flows.
 * Reads its own attachments and attachable volumes; `scope` decides whether the
 * owner or the administrator endpoints and permissions apply.
 */
export function StoragePanel({ container, scope }: { container: ContainerDto; scope: ListScope }) {
  const containerId = container.id;
  const { admin, canMutateLocal, canMutateShared } = useVolumeCaps(scope);
  const showSharedVolumes = canMutateShared && Boolean(container.serverId);
  const [rootOpen, setRootOpen] = useState(false);
  const [mountOpen, setMountOpen] = useState(false);
  const [createVolumeOpen, setCreateVolumeOpen] = useState(false);
  const [rootOrchestrateSize, setRootOrchestrateSize] = useState<number | null>(null);
  const [detachTarget, setDetachTarget] = useState<VolumeAttachmentDto | null>(null);
  const invalidate = useInvalidateContainer(scope, containerId);

  const attachmentsQuery = useQuery({
    queryKey: queryKeys.containers.attachments(scope, containerId),
    queryFn: async () => {
      const [local, shared] = await Promise.all([
        api.get<VolumeAttachmentDto[]>(scopedPath(`/containers/${containerId}/volumes`, scope)),
        api.get<VolumeAttachmentDto[]>(scopedPath(`/containers/${containerId}/shared-volumes`, scope)),
      ]);
      return [...local, ...shared];
    },
    refetchInterval: (query) => refetchWhileInProgress(query.state, {
      steadyIntervalMs: false,
      isSettled: (rows) => rows.every((row) => !bindInProgress(row.bindState)),
    }),
  });
  const volumesQuery = useQuery({
    queryKey: admin ? queryKeys.volumes.admin : queryKeys.volumes.user,
    queryFn: () => api.get<VolumeDto[]>(scopedPath('/volumes', scope)),
    enabled: canMutateLocal,
  });
  const sharedVolumesQuery = useQuery({
    queryKey: [...queryKeys.sharedVolumes.attachable(container.serverId), scope],
    queryFn: () => api.get<SharedVolumeDto[]>(
      scopedPath('/shared-volumes', scope, { attachableOnServerId: container.serverId }),
    ),
    enabled: showSharedVolumes,
  });

  const attachments = attachmentsQuery.data ?? [];
  const attachedVolumeIds = new Set(
    (attachmentsQuery.data ?? [...container.volumes, ...container.sharedVolumes]).map((row) => row.volumeId),
  );
  const localVolumes = filterAttachableVolumes(volumesQuery.data ?? [], container, attachedVolumeIds);
  const sharedVolumes = filterAttachableSharedVolumes(sharedVolumesQuery.data ?? [], container, attachedVolumeIds);
  const disks: MountDisk[] = [
    ...(canMutateLocal ? localVolumes.map((volume) => ({ ...volume, kind: 'local' as const })) : []),
    ...(canMutateShared ? sharedVolumes.map((volume) => ({ ...volume, kind: 'shared' as const })) : []),
  ];
  const usageById = new Map<string, VolumeUsage>(
    [...(volumesQuery.data ?? []), ...(sharedVolumesQuery.data ?? [])].map((volume) => [volume.id, volume]),
  );
  const rows = [
    ...attachments.filter((attachment) => attachment.kind === 'local'),
    ...attachments.filter((attachment) => attachment.kind === 'shared'),
  ];
  return (
    <QueryView
      queries={[
        attachmentsQuery,
        ...(canMutateLocal ? [volumesQuery] : []),
        ...(showSharedVolumes ? [sharedVolumesQuery] : []),
      ]}
      resourceNames={[
        '挂载',
        ...(canMutateLocal ? ['数据卷'] : []),
        ...(showSharedVolumes ? ['共享卷'] : []),
      ]}
      loadingLabel="加载存储..."
    >
      {() => (
        <div data-testid="container-storage">
          <StorageCard
            container={container}
            scope={scope}
            rows={rows}
            usageById={usageById}
            onMount={() => setMountOpen(true)}
            onResizeRoot={() => setRootOpen(true)}
            onDetachRequest={setDetachTarget}
          />
          {rootOpen ? (
            <RootSizeDialog
              container={container}
              scope={scope}
              onRequiresStop={setRootOrchestrateSize}
              onOpenChange={(open) => { if (!open) setRootOpen(false); }}
            />
          ) : null}
          {mountOpen ? (
            <MountDialog
              container={container}
              scope={scope}
              disks={disks}
              onCreateVolume={!admin && canMutateLocal ? () => setCreateVolumeOpen(true) : undefined}
              onOpenChange={(open) => { if (!open) setMountOpen(false); }}
            />
          ) : null}
          {!admin ? (
            <LocalVolumeFormDialog
              open={createVolumeOpen}
              onOpenChange={setCreateVolumeOpen}
              lockedServerId={container.serverId}
            />
          ) : null}
          {rootOrchestrateSize !== null && (
            <RootShrinkOrchestrationDialog
              scope={scope}
              container={container}
              sizeBytes={rootOrchestrateSize}
              open
              onOpenChange={(open) => { if (!open) setRootOrchestrateSize(null); }}
              onComplete={invalidate}
            />
          )}
          <DetachVolumeDialog
            container={container}
            scope={scope}
            target={detachTarget}
            onClose={() => setDetachTarget(null)}
          />
        </div>
      )}
    </QueryView>
  );
}

function useVolumeCaps(scope: ListScope) {
  const admin = scope === 'all';
  const isAdmin = useHasRole(Role.UserAdmin);
  const canManageVolumes = isAdmin;
  const canManageSharedVolumes = isAdmin;
  return {
    admin,
    canManageVolumes,
    canManageSharedVolumes,
    canMutateLocal: !admin || canManageVolumes,
    canMutateShared: !admin || canManageSharedVolumes,
  };
}

function StorageCard({
  container,
  scope,
  rows,
  usageById,
  onMount,
  onResizeRoot,
  onDetachRequest,
}: {
  container: ContainerDto;
  scope: ListScope;
  rows: VolumeAttachmentDto[];
  usageById: ReadonlyMap<string, VolumeUsage>;
  onMount: () => void;
  onResizeRoot: () => void;
  onDetachRequest: (attachment: VolumeAttachmentDto) => void;
}) {
  const { admin, canManageVolumes, canManageSharedVolumes, canMutateLocal, canMutateShared } = useVolumeCaps(scope);
  const localBlocked = admin && !canManageVolumes
    ? '挂载与卸载本地数据卷需要「管理本地数据卷」权限；当前账号可以管理容器，但无法列出或挂载本地数据卷。'
    : null;
  const sharedBlocked = admin && !canManageSharedVolumes
    ? '挂载与卸载共享卷需要「管理共享卷」权限；当前账号可以管理容器，但无法列出或挂载共享卷。'
    : null;
  return (
    <SectionCard
      title="存储"
      flush
      actions={canMutateLocal || canMutateShared ? (
        <Button size="sm" onClick={onMount} data-testid="attach-volume-open">
          <Plus className="h-4 w-4" />挂载
        </Button>
      ) : undefined}
    >
      <Table className="min-w-[720px]">
        <TableHeader>
          <TableRow>
            <TableHead>名称</TableHead>
            <TableHead>类型</TableHead>
            <TableHead>挂载点</TableHead>
            <TableHead>容量</TableHead>
            <TableHead>状态</TableHead>
            <TableHead className="text-right">操作</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow>
            <TableCell>系统盘</TableCell>
            <TableCell>系统盘</TableCell>
            <TableCell>/</TableCell>
            <TableCell>
              <UsageMeter used={observedRootUsedBytes(container)} total={container.rootSizeBytes} />
            </TableCell>
            <TableCell>已挂载</TableCell>
            <TableCell className="text-right">
              <Button size="sm" variant="outline" onClick={onResizeRoot} data-testid="edit-root-size">
                <Pencil className="h-3.5 w-3.5" />调整容量
              </Button>
            </TableCell>
          </TableRow>
          {rows.map((attachment) => (
            <AttachmentRow
              key={attachment.id}
              attachment={attachment}
              running={container.actual.status === ContainerStatus.Running}
              canMutate={attachment.kind === 'shared' ? canMutateShared : canMutateLocal}
              usage={usageById.get(attachment.volumeId)}
              onDetachRequest={onDetachRequest}
            />
          ))}
        </TableBody>
      </Table>
      {(localBlocked || sharedBlocked) && (
        <div className="space-y-1 border-t px-6 py-3 text-sm text-muted-foreground">
          {localBlocked ? <p data-testid="attach-capability-hint">{localBlocked}</p> : null}
          {sharedBlocked ? <p>{sharedBlocked}</p> : null}
        </div>
      )}
    </SectionCard>
  );
}

function MountDialog({
  container,
  scope,
  disks,
  onCreateVolume,
  onOpenChange,
}: {
  container: ContainerDto;
  scope: ListScope;
  disks: MountDisk[];
  onCreateVolume?: () => void;
  onOpenChange: (open: boolean) => void;
}) {
  const invalidate = useInvalidateContainer(scope, container.id);
  const attach = useActionMutation({
    mutationFn: ({ kind, body }: { kind: MountDisk['kind']; body: AttachVolumeRequest }) =>
      api.post<IntentAcceptedDto>(
        scopedPath(`/containers/${container.id}/${kind === 'shared' ? 'shared-volumes' : 'volumes'}`, scope),
        body,
      ),
    successTitle: '已提交挂载，正在生效',
    errorTitle: '挂载失败',
    onSuccess: invalidate,
  });
  const pending = attach.isPending;
  const serverName = container.serverName;
  const [selectedKey, setSelectedKey] = useState('');
  const [containerPath, setContainerPath] = useState('/data');
  const [readOnly, setReadOnly] = useState(false);
  const selected = disks.find((disk) => diskKey(disk) === selectedKey);
  const canSubmit = Boolean(selected) && containerPath.startsWith('/') && containerPath.length > 1;

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>挂载</DialogTitle>
        </DialogHeader>
        {disks.length === 0 ? (
          <div className="space-y-3 text-sm" data-testid="attach-volume-empty">
            <p>{serverName} 上没有空闲的数据卷或共享卷。</p>
            <p className="text-muted-foreground">
              数据卷只能挂到同一台服务器上的容器，且一次只挂一个容器。
              {onCreateVolume ? '新建一个后，它会出现在这里。' : null}
            </p>
            {onCreateVolume ? (
              <Button size="sm" variant="outline" onClick={onCreateVolume}>
                <Plus className="h-4 w-4" />新建数据卷
              </Button>
            ) : null}
          </div>
        ) : (
          <div className="space-y-4">
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">磁盘</legend>
              <div className="max-h-64 space-y-1 overflow-y-auto" role="radiogroup" aria-label="可挂载的盘">
                {disks.map((disk) => {
                  const key = diskKey(disk);
                  return (
                    <label
                      key={key}
                      className={`flex cursor-pointer items-center gap-3 rounded-md border px-3 py-2 text-sm ${selectedKey === key ? 'border-primary bg-accent' : ''}`}
                    >
                      <input
                        type="radio"
                        name="mount-disk"
                        className="h-4 w-4"
                        checked={selectedKey === key}
                        disabled={pending}
                        onChange={() => setSelectedKey(key)}
                      />
                      <span className="min-w-0 flex-1 truncate">{disk.name}</span>
                      <span className="text-muted-foreground">{disk.kind === 'shared' ? '共享卷' : '数据卷'}</span>
                      <span className="text-muted-foreground">{gibLabel(disk.sizeBytes)}</span>
                    </label>
                  );
                })}
              </div>
            </fieldset>
            <FormField id="attach-volume-path" label="挂载点">
              <Input
                id="attach-volume-path"
                value={containerPath}
                onChange={(event) => setContainerPath(event.target.value)}
                disabled={pending}
              />
            </FormField>
            <FormField id="attach-volume-readonly" label="只读" orientation="inline">
              <Checkbox
                id="attach-volume-readonly"
                checked={readOnly}
                onCheckedChange={(checked) => setReadOnly(checked === true)}
                disabled={pending}
              />
            </FormField>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>{disks.length > 0 ? '取消' : '关闭'}</Button>
          {disks.length > 0 ? (
            <Button
              disabled={pending || !canSubmit}
              onClick={() => {
                if (!selected) return;
                attach.mutate(
                  { kind: selected.kind, body: { volumeId: selected.id, containerPath, readOnly } },
                  { onSuccess: () => onOpenChange(false) },
                );
              }}
            >
              {pending ? '提交中...' : '挂载'}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AttachmentRow({
  attachment,
  running,
  canMutate,
  usage,
  onDetachRequest,
}: {
  attachment: VolumeAttachmentDto;
  running: boolean;
  canMutate: boolean;
  usage?: VolumeUsage;
  onDetachRequest: (attachment: VolumeAttachmentDto) => void;
}) {
  const cancel = attachment.onlineCancelAllowed;
  const stopRequired = running && !cancel;
  const label = cancel ? '取消挂载' : '卸载';
  return (
    <TableRow>
      <TableCell>{attachment.volumeName}</TableCell>
      <TableCell>{attachment.kind === 'shared' ? '共享卷' : '数据卷'}</TableCell>
      <TableCell className="min-w-32 whitespace-normal">{mountIdentifier(attachment.containerPath)}</TableCell>
      <TableCell>
        {usage ? <UsageMeter used={usage.usedBytes} total={usage.sizeBytes} /> : '—'}
      </TableCell>
      <TableCell>
        <span className="inline-flex items-center gap-1">
          {bindInProgress(attachment.bindState) ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : null}
          {BIND_STATE_LABEL[attachment.bindState]}
          {attachment.readOnly ? ' · 只读' : ''}
        </span>
      </TableCell>
      <TableCell className="text-right">
        {canMutate ? (
          stopRequired ? (
            <TooltipProvider delayDuration={200}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="inline-flex">
                    <Button
                      size="sm"
                      variant="outline"
                      className="pointer-events-none"
                      disabled
                      tabIndex={-1}
                    >
                      {label}
                    </Button>
                  </span>
                </TooltipTrigger>
                <TooltipContent>先停止容器</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          ) : (
            <Button
              size="sm"
              variant="outline"
              onClick={() => onDetachRequest(attachment)}
            >
              {label}
            </Button>
          )
        ) : null}
      </TableCell>
    </TableRow>
  );
}

function diskKey(disk: MountDisk): string {
  return `${disk.kind}:${disk.id}`;
}

function mountIdentifier(value: string) {
  return <span className="font-mono text-xs [overflow-wrap:anywhere]">{value}</span>;
}

function gibLabel(bytes: number): string {
  return formatGib(bytes);
}

function UsageMeter({ used, total }: { used: number | null; total: number }) {
  if (!Number.isFinite(total) || total <= 0) return <span>—</span>;
  if (used === null || !Number.isFinite(used)) return <span>{gibLabel(total)}</span>;
  const pct = Math.min(100, Math.max(0, Math.round((used / total) * 100)));
  return (
    <div className="w-44 space-y-1">
      <div className="flex items-center justify-between gap-2 text-xs">
        <span>{gibLabel(used)} / {gibLabel(total)}</span>
        <span className="tabular-nums">{pct}%</span>
      </div>
      <Progress value={pct} className="h-1.5" aria-label={`已用 ${gibLabel(used)}，共 ${gibLabel(total)}，${pct}%`} />
    </div>
  );
}

/** Confirm unmounting (or cancelling a not-yet-finished mount of) a data volume. */
function DetachVolumeDialog({
  container,
  scope,
  target,
  onClose,
}: {
  container: ContainerDto;
  scope: ListScope;
  target: VolumeAttachmentDto | null;
  onClose: () => void;
}) {
  const invalidate = useInvalidateContainer(scope, container.id);
  const detach = useActionMutation({
    mutationFn: (attachment: VolumeAttachmentDto) => api.delete<IntentAcceptedDto>(
      scopedPath(
        `/containers/${container.id}/${attachment.kind === 'shared' ? 'shared-volumes' : 'volumes'}/${attachment.id}`,
        scope,
      ),
    ),
    successTitle: '已提交卸载，正在生效',
    errorTitle: '卸载失败',
    onSuccess: () => {
      onClose();
      invalidate();
    },
  });
  return (
    <ConfirmDialog
      open={Boolean(target)}
      title={target?.onlineCancelAllowed ? '取消挂载？' : '卸载数据卷？'}
      description={
        target
          ? (target.onlineCancelAllowed
            ? `将取消容器「${container.name}」路径 ${target.containerPath} 尚未完成的挂载。`
            : `将从容器「${container.name}」卸载路径 ${target.containerPath}（设备 ${target.deviceName}）。`)
          : null
      }
      confirmLabel={target?.onlineCancelAllowed ? '确认取消' : '确认卸载'}
      pendingLabel="提交中..."
      pending={detach.isPending}
      onConfirm={() => { if (target) detach.mutate(target); }}
      onOpenChange={(open) => { if (!open) onClose(); }}
    />
  );
}
