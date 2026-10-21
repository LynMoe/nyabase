import type { UseMutationResult } from '@tanstack/react-query';
import { Pencil, RefreshCw } from 'lucide-react';
import type {
  SharedBackendDto,
  SharedBackendExecutorDiscoverResult,
  SharedBackendExecutorDto,
  SharedVolumeDto,
} from '@nyabase/common';
import { Button } from '../../components/ui/button.js';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card.js';
import { Field } from '../../components/layout/field.js';
import { SectionCard } from '../../components/layout/section-card.js';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../../components/ui/table.js';
import { SharedVolumeTable } from '../../components/storage/shared-volume-table.js';
import { TechnicalId } from '../../components/refs/technical-id.js';
import { formatGib, formatPercent, relativeTime, sharedBackendAvailableBytes } from '../../lib/utils.js';

type PatchExecutorMutation = UseMutationResult<
  SharedBackendExecutorDto,
  Error,
  { executor: SharedBackendExecutorDto; registered: boolean }
>;
type DiscoverMutation = UseMutationResult<SharedBackendExecutorDiscoverResult, Error, void>;

export function BackendOverviewTab({
  backend,
  canManage,
  onEdit,
}: {
  backend: SharedBackendDto;
  canManage: boolean;
  onEdit: () => void;
}) {
  const available = sharedBackendAvailableBytes(backend);
  return (
    <>
      <SectionCard
        title="身份"
        actions={canManage ? (
          <Button size="sm" variant="outline" onClick={onEdit}>
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
    </>
  );
}

export function BackendExecutorsTab({
  executors,
  canManage,
  discoverExecutors,
  patchExecutor,
}: {
  executors: SharedBackendExecutorDto[];
  canManage: boolean;
  discoverExecutors: DiscoverMutation;
  patchExecutor: PatchExecutorMutation;
}) {
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

export function BackendVolumesTab({
  canManageVolumes,
  loaded,
  failed,
  volumes,
  onInspect,
}: {
  canManageVolumes: boolean;
  /** False while the volume list has not arrived yet. */
  loaded: boolean;
  failed: boolean;
  volumes: SharedVolumeDto[];
  onInspect: (volume: SharedVolumeDto) => void;
}) {
  if (!canManageVolumes) {
    return (
      <p className="text-sm text-muted-foreground">
        查看租户共享卷需要「管理共享卷」权限。
      </p>
    );
  }
  if (!loaded && failed) return <p className="text-sm text-destructive">无法加载租户共享卷。</p>;
  if (!loaded) return <p className="text-sm text-muted-foreground">加载租户共享卷...</p>;
  return (
    <SectionCard title="租户共享卷" flush testId="shared-backend-tenant-volumes">
      <SharedVolumeTable volumes={volumes} scope="all" onInspect={onInspect} />
    </SectionCard>
  );
}
