import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Loader2, Pencil } from 'lucide-react';
import type {
  ContainerDto,
  ListScope,
  SharedVolumeDto,
  VolumeAttachmentDto,
  VolumeDto,
} from '@nyabase/common';
import { Button } from '../ui/button.js';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../ui/table.js';
import { SectionCard } from '../layout/section-card.js';
import { Progress } from '../ui/progress.js';
import { api } from '../../lib/api.js';
import { useInvalidateContainer } from '../../lib/container-queries.js';
import { mountStatus } from '../../lib/data-disks.js';
import { bindInProgress } from '../../lib/in-progress.js';
import { queryKeys } from '../../lib/query-keys.js';
import { refetchWhileInProgress } from '../../lib/query-lifecycle.js';
import { scopedPath } from '../../lib/scoped-paths.js';
import { QueryView } from '../layout/query-view.js';
import { RootShrinkOrchestrationDialog } from '../storage/root-shrink-orchestration-dialog.js';
import { cn, formatCapacity } from '../../lib/utils.js';
import { observedRootUsedBytes } from '../../lib/storage-shrink.js';
import { RootSizeDialog } from './spec-panel.js';
import { ResourceRef } from '../refs/resource-ref.js';

type VolumeUsage = {
  id: string;
  sizeBytes: number;
  usedBytes: number | null;
};

/**
 * The volumes behind the mounts, for their size and data: the owner's own, or
 * (`scope=all`) every volume on the container's server and every shared one.
 */
function useVolumeUsage(container: ContainerDto, scope: ListScope): ReadonlyMap<string, VolumeUsage> {
  const admin = scope === 'all';
  const local = useQuery({
    queryKey: admin ? queryKeys.volumes.adminByServer(container.serverId) : queryKeys.volumes.user,
    queryFn: () => api.get<VolumeDto[]>(admin ? `/volumes?scope=all&serverId=${container.serverId}` : '/volumes'),
  });
  const shared = useQuery({
    queryKey: admin ? queryKeys.sharedVolumes.admin : queryKeys.sharedVolumes.user,
    queryFn: () => api.get<SharedVolumeDto[]>(admin ? '/shared-volumes?scope=all' : '/shared-volumes'),
  });
  return new Map<string, VolumeUsage>(
    [...(local.data ?? []), ...(shared.data ?? [])].map((volume) => [volume.id, volume]),
  );
}

/**
 * The container's storage: the system disk (resizable) and the mounts of the
 * owner's data disks and shared storage, which the platform makes in every
 * container of the owner; nothing here mounts or unmounts them.
 */
export function StoragePanel({ container, scope }: { container: ContainerDto; scope: ListScope }) {
  const containerId = container.id;
  const [rootOpen, setRootOpen] = useState(false);
  const [rootOrchestrateSize, setRootOrchestrateSize] = useState<number | null>(null);
  const invalidate = useInvalidateContainer(scope, containerId);
  const usageById = useVolumeUsage(container, scope);

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

  return (
    <QueryView query={attachmentsQuery} resourceName="挂载" loadingLabel="加载存储...">
      {(attachments) => (
        <div data-testid="container-storage">
          <SectionCard title="存储" flush>
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
                  <TableCell>
                    系统盘
                    {scope === 'all' ? (
                      <div className="text-xs text-muted-foreground" data-testid="container-root-pool">{container.rootPoolName}</div>
                    ) : null}
                  </TableCell>
                  <TableCell>/</TableCell>
                  <TableCell>
                    <UsageMeter used={observedRootUsedBytes(container)} total={container.rootSizeBytes} />
                  </TableCell>
                  <TableCell>已挂载</TableCell>
                  <TableCell className="text-right">
                    <Button size="sm" variant="outline" onClick={() => setRootOpen(true)} data-testid="edit-root-size">
                      <Pencil className="h-3.5 w-3.5" />调整容量
                    </Button>
                  </TableCell>
                </TableRow>
                {sortMounts(attachments).map((attachment) => (
                  <AttachmentRow
                    key={attachment.id}
                    attachment={attachment}
                    usage={usageById.get(attachment.volumeId)}
                    scope={scope}
                  />
                ))}
              </TableBody>
            </Table>
            <p className="border-t px-6 py-3 text-xs text-muted-foreground" data-testid="storage-auto-mount-note">
              数据盘和共享存储由平台按授权自动挂载到所有者的每个容器，容量随额度自动调整。
            </p>
          </SectionCard>
          {rootOpen ? (
            <RootSizeDialog
              container={container}
              scope={scope}
              onRequiresStop={setRootOrchestrateSize}
              onOpenChange={(open) => { if (!open) setRootOpen(false); }}
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
        </div>
      )}
    </QueryView>
  );
}

/** Local data disks first, then shared storage, each by mount path. */
function sortMounts(attachments: readonly VolumeAttachmentDto[]): VolumeAttachmentDto[] {
  return [...attachments].sort((left, right) => (
    left.kind === right.kind ? left.containerPath.localeCompare(right.containerPath) : left.kind === 'local' ? -1 : 1
  ));
}

function AttachmentRow({
  attachment,
  usage,
  scope,
}: {
  attachment: VolumeAttachmentDto;
  usage?: VolumeUsage;
  scope: ListScope;
}) {
  const status = mountStatus(attachment);
  return (
    <TableRow data-testid={`mount-${attachment.id}`}>
      <TableCell>
        <ResourceRef
          kind={attachment.kind === 'shared' ? 'shared-volume' : 'volume'}
          id={attachment.volumeId}
          name={attachment.volumeName}
          scope={scope}
        />
      </TableCell>
      <TableCell>{attachment.kind === 'shared' ? '共享存储' : '数据盘'}</TableCell>
      <TableCell className="min-w-32 whitespace-normal">
        <span className="font-mono text-xs [overflow-wrap:anywhere]">{attachment.containerPath}</span>
      </TableCell>
      <TableCell>
        {usage ? <UsageMeter used={usage.usedBytes} total={usage.sizeBytes} /> : '—'}
      </TableCell>
      <TableCell className="max-w-[18rem] whitespace-normal">
        <span className={cn('inline-flex items-center gap-1', status.tone === 'warning' && 'text-warning')}>
          {status.tone === 'pending' ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : null}
          {status.label}
          {attachment.readOnly ? ' · 只读' : ''}
        </span>
        {status.hint ? <p className="mt-0.5 text-xs text-muted-foreground">{status.hint}</p> : null}
      </TableCell>
      <TableCell />
    </TableRow>
  );
}

function UsageMeter({ used, total }: { used: number | null; total: number }) {
  if (!Number.isFinite(total) || total <= 0) return <span>—</span>;
  if (used === null || !Number.isFinite(used)) return <span>{formatCapacity(total)}</span>;
  const pct = Math.min(100, Math.max(0, Math.round((used / total) * 100)));
  return (
    <div className="w-44 space-y-1">
      <div className="flex items-center justify-between gap-2 text-xs">
        <span>{formatCapacity(used)} / {formatCapacity(total)}</span>
        <span className="tabular-nums">{pct}%</span>
      </div>
      <Progress value={pct} className="h-1.5" aria-label={`已用 ${formatCapacity(used)}，共 ${formatCapacity(total)}，${pct}%`} />
    </div>
  );
}
