import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Pencil, RefreshCw } from 'lucide-react';
import {
  Capability,
  FailureCode,
  type SharedBackendDto,
  type SharedBackendExecutorDiscoverResult,
  type SharedBackendExecutorDto,
  type SharedVolumeDto,
} from '@nyabase/common';
import { Button } from '../../components/ui/button.js';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card.js';
import { Field } from '../../components/layout/form-field.js';
import { SectionCard } from '../../components/layout/section-card.js';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../../components/ui/table.js';
import { SharedVolumeCatalogInspectDialog } from '../../components/storage/shared-volume-catalog-inspect.js';
import { SharedVolumeTable } from '../../components/storage/shared-volume-table.js';
import { TechnicalId } from '../../components/refs/technical-id.js';
import { toast } from '../../hooks/use-toast.js';
import { api } from '../../lib/api.js';
import { errorMessage } from '../../lib/api-error.js';
import { volumeInProgress } from '../../lib/in-progress.js';
import { queryKeys } from '../../lib/query-keys.js';
import { refetchWhileInProgress } from '../../lib/query-lifecycle.js';
import { failureCodeLabel } from '../../lib/status-labels.js';
import { identityConflictFromDiscoverIssue, type SharedBackendFsidConflict } from '../../lib/storage-shrink.js';
import { useAuthStore } from '../../store/auth.js';
import { EditBackendDialog, reportFsidConflict, useInvalidateBackend } from './backend-dialogs.js';
import { formatGib, formatPercent, relativeTime, sharedBackendAvailableBytes } from '../../lib/utils.js';

export function BackendOverviewTab({
  backend,
  onConflict,
}: {
  backend: SharedBackendDto;
  onConflict: (conflict: SharedBackendFsidConflict) => void;
}) {
  const canManage = useAuthStore(
    (state) => state.user?.capabilities.includes(Capability.ManageSharedBackends) ?? false,
  );
  const [editOpen, setEditOpen] = useState(false);
  const available = sharedBackendAvailableBytes(backend);
  return (
    <>
      <SectionCard
        title="身份"
        actions={canManage ? (
          <Button size="sm" variant="outline" onClick={() => setEditOpen(true)}>
            <Pencil className="h-3.5 w-3.5" />编辑
          </Button>
        ) : undefined}
      >
        <div className="grid gap-3 text-sm sm:grid-cols-2">
          <Field label="名称" value={backend.name} />
          <Field label="显示名称" value={backend.displayName ?? '—'} />
          <Field label="identity key" value={<TechnicalId label="identity key" value={backend.identityKey} />} />
          <Field label="Ceph FSID" value={<TechnicalId label="Ceph FSID" value={backend.cephFsid} />} />
          <Field label="超分比例" value={formatPercent(backend.overcommitRatio)} />
          <Field label="最近更新" value={relativeTime(backend.updatedAt)} />
        </div>
      </SectionCard>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">容量</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
          <Field label="容量" value={formatGib(backend.totalBytes)} />
          <Field label="已用" value={formatGib(backend.usedBytes)} />
          <Field label="可用" value={formatGib(available)} />
          <Field label="在线执行端" value={backend.hasOnlineExecutor ? '有' : '无'} />
          <Field label="服务器" value={`${backend.serverIds.length} 台`} />
        </CardContent>
      </Card>
      {editOpen ? (
        <EditBackendDialog backend={backend} onConflict={onConflict} onClose={() => setEditOpen(false)} />
      ) : null}
    </>
  );
}

export function BackendExecutorsTab({
  backend,
  onConflict,
}: {
  backend: SharedBackendDto;
  onConflict: (conflict: SharedBackendFsidConflict) => void;
}) {
  const id = backend.id;
  const executors = backend.executors ?? [];
  const canManage = useAuthStore(
    (state) => state.user?.capabilities.includes(Capability.ManageSharedBackends) ?? false,
  );
  const invalidate = useInvalidateBackend(id);
  const patchExecutor = useMutation({
    mutationFn: ({ executor, registered }: { executor: SharedBackendExecutorDto; registered: boolean }) =>
      api.patch<SharedBackendExecutorDto>(
        `/shared-backends/${id}/executors/${executor.id}`,
        { expectedRevision: executor.revision, registered },
      ),
    onSuccess: (_data, variables) => {
      toast({ title: variables.registered ? '执行端已登记' : '已取消执行端登记' });
      invalidate();
    },
    onError: (error) => toast({ title: '执行端登记失败', description: errorMessage(error), variant: 'destructive' }),
  });
  const discoverExecutors = useMutation({
    mutationFn: () => api.post<SharedBackendExecutorDiscoverResult>(`/shared-backends/${id}/executors/discover`, {}),
    onSuccess: (result) => {
      for (const issue of result.identityConflicts) {
        const conflict = identityConflictFromDiscoverIssue(issue);
        if (conflict) {
          onConflict(conflict);
          continue;
        }
        if (issue.code === FailureCode.StoragePoolInUse || issue.code === FailureCode.ServerUnreachable) {
          toast({
            title: failureCodeLabel(issue.code) ?? issue.code,
            description: issue.message,
            variant: 'destructive',
          });
        }
      }
      if (result.identityConflicts.length === 0) {
        toast({ title: '执行端发现已完成', description: `发现 ${result.executors.length} 个执行端。` });
      }
      invalidate();
    },
    onError: (error) => {
      reportFsidConflict(error, onConflict);
      toast({ title: '发现执行端失败', description: errorMessage(error), variant: 'destructive' });
    },
  });
  const busy = discoverExecutors.isPending || patchExecutor.isPending;
  return (
    <SectionCard
      title="执行端"
      actions={
        canManage ? (
          <Button
            size="sm"
            variant="outline"
            onClick={() => discoverExecutors.mutate()}
            disabled={busy}
          >
            <RefreshCw className={discoverExecutors.isPending ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
            发现执行端
          </Button>
        ) : undefined
      }
      flush={executors.length > 0}
    >
      <div data-testid="shared-backend-executors">
        {executors.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            尚未发现执行端。先登记后端，再对在线服务器发现执行端。
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>服务器</TableHead>
                <TableHead>Incus 名</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>容量</TableHead>
                <TableHead>已用</TableHead>
                {canManage ? <TableHead className="text-right">操作</TableHead> : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {executors.map((executor) => (
                <TableRow key={executor.id}>
                  <TableCell>{executor.serverName}</TableCell>
                  <TableCell className="font-mono">{executor.incusName}</TableCell>
                  <TableCell>{executor.registered ? '已登记' : '未登记'}</TableCell>
                  <TableCell>{formatGib(executor.totalBytes)}</TableCell>
                  <TableCell>{formatGib(executor.usedBytes)}</TableCell>
                  {canManage ? (
                    <TableCell className="text-right">
                      <Button
                        size="sm"
                        variant={executor.registered ? 'outline' : 'default'}
                        disabled={busy}
                        onClick={() => patchExecutor.mutate({
                          executor,
                          registered: !executor.registered,
                        })}
                      >
                        {executor.registered ? '取消登记' : '登记'}
                      </Button>
                    </TableCell>
                  ) : null}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    </SectionCard>
  );
}

export function BackendVolumesTab({ backendId }: { backendId: string }) {
  const canManageVolumes = useAuthStore(
    (state) => state.user?.capabilities.includes(Capability.ManageSharedVolumes) ?? false,
  );
  const [inspectTarget, setInspectTarget] = useState<SharedVolumeDto | null>(null);
  const volumesQuery = useQuery({
    queryKey: queryKeys.sharedVolumes.admin,
    queryFn: () => api.get<SharedVolumeDto[]>('/shared-volumes?scope=all'),
    enabled: canManageVolumes,
    refetchInterval: (query) => refetchWhileInProgress(query.state, {
      steadyIntervalMs: 5_000,
      isSettled: (volumes) => volumes.every((volume) => !volumeInProgress(volume)),
    }),
  });
  if (!canManageVolumes) {
    return (
      <p className="text-sm text-muted-foreground">
        查看租户共享卷需要「管理共享卷」权限。
      </p>
    );
  }
  if (!volumesQuery.data && volumesQuery.isError) return <p className="text-sm text-destructive">无法加载租户共享卷。</p>;
  if (!volumesQuery.data) return <p className="text-sm text-muted-foreground">加载租户共享卷...</p>;
  return (
    <SectionCard title="租户共享卷" flush testId="shared-backend-tenant-volumes">
      <SharedVolumeTable
        volumes={volumesQuery.data.filter((volume) => volume.sharedBackendId === backendId)}
        scope="all"
        onInspect={setInspectTarget}
      />
      <SharedVolumeCatalogInspectDialog
        volume={inspectTarget}
        open={Boolean(inspectTarget)}
        onOpenChange={(open) => { if (!open) setInspectTarget(null); }}
      />
    </SectionCard>
  );
}
