import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Database, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react';
import {
  zCreateVolumeRequest,
  zPatchVolumeRequest,
  type CreateVolumeRequest,
  type PatchVolumeRequest,
  type ServerDto,
  type SharedBackendDto,
  type StoragePoolDto,
  type UserServerDto,
  type VolumeDto,
  type VolumeScope,
} from '@nyabase/common';
import { api } from '../lib/api.js';
import { Badge } from '../components/ui/badge.js';
import { Button } from '../components/ui/button.js';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card.js';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../components/ui/dialog.js';
import { Input } from '../components/ui/input.js';
import { Label } from '../components/ui/label.js';
import { QueryErrorState, QueryLoadingState } from '../components/query-state.js';
import { VolumeShrinkOrchestrationDialog } from '../components/storage/volume-shrink-orchestration-dialog.js';
import { approxGibHint, relativeTime } from '../lib/utils.js';
import { queryKeys } from '../lib/query-keys.js';
import { toast } from '../hooks/use-toast.js';
import {
  classifySizeChange,
  isQuotaIneffectiveCapability,
  quotaIneffectiveCreateHint,
  quotaIneffectiveResizeHint,
  shrinkNeverTooltip,
  validateShrinkFloor,
} from '../lib/storage-shrink.js';
import {
  failureCodeLabel,
  volumeAttentionHint,
  volumeLifecycleLabel,
} from '../lib/status-labels.js';
import { ResourceIntentFailures } from '../components/intents/resource-intent-failures.js';

const GIB = 1024 ** 3;

function bytesToGiBInput(bytes: number): string {
  const gib = bytes / GIB;
  return Number.isInteger(gib) ? String(gib) : gib.toFixed(3).replace(/\.?0+$/, '');
}

export default function VolumesPage() {
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<VolumeDto | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<VolumeDto | null>(null);
  const volumesQuery = useQuery({
    queryKey: queryKeys.volumes.user,
    queryFn: () => api.get<VolumeDto[]>('/volumes'),
  });
  const deleteVolume = useMutation({
    mutationFn: (volumeId: string) => api.delete<unknown>(`/volumes/${volumeId}`),
    onSuccess: () => {
      toast({
        title: '删除已提交',
        description: '列表状态稍后更新；若出现「需要关注」，请查看卡片上的说明。',
      });
      setDeleteTarget(null);
      void queryClient.invalidateQueries({ queryKey: queryKeys.volumes.user });
    },
    onError: (error) => toast({ title: '删除失败', description: errorMessage(error), variant: 'destructive' }),
  });
  const volumes = volumesQuery.data ?? [];
  return (
    <div className="space-y-5 px-4 py-4 md:px-6" data-testid="volumes">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">数据卷</h1>
          <p className="text-sm text-muted-foreground">
            为容器准备可挂载的持久存储；扩缩容是否需先卸载，取决于所选存储池的能力。
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="icon" onClick={() => { void volumesQuery.refetch(); }} aria-label="刷新数据卷">
            <RefreshCw className="h-4 w-4" />
          </Button>
          <Button onClick={() => setCreateOpen(true)}><Plus className="h-4 w-4" />新建数据卷</Button>
        </div>
      </div>
      {volumesQuery.isLoading ? (
        <QueryLoadingState label="加载数据卷..." />
      ) : volumesQuery.isError ? (
        <QueryErrorState error={volumesQuery.error} resourceName="数据卷" onRetry={() => { void volumesQuery.refetch(); }} />
      ) : volumes.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
            <p className="text-sm text-muted-foreground">暂无数据卷。创建后即可挂载到容器。</p>
            <Button onClick={() => setCreateOpen(true)}><Plus className="h-4 w-4" />新建数据卷</Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 xl:grid-cols-2">
          {volumes.map((volume) => (
            <VolumeCard key={volume.id} volume={volume} onEdit={() => setEditTarget(volume)} onDelete={() => setDeleteTarget(volume)} />
          ))}
        </div>
      )}
      <VolumeFormDialog open={createOpen} onOpenChange={setCreateOpen} />
      {editTarget && (
        <VolumeFormDialog
          volume={editTarget}
          open
          onOpenChange={(open) => { if (!open) setEditTarget(null); }}
        />
      )}
      <Dialog open={Boolean(deleteTarget)} onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>删除数据卷？</DialogTitle>
            <DialogDescription>
              将删除「{deleteTarget?.name}」。若该卷仍挂载在容器上，后端会拒绝删除；请先卸载后再试。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>取消</Button>
            <Button
              variant="destructive"
              onClick={() => { if (deleteTarget) deleteVolume.mutate(deleteTarget.id); }}
              disabled={deleteVolume.isPending}
            >
              {deleteVolume.isPending ? '提交中...' : '确认删除'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function VolumeCard({ volume, onEdit, onDelete }: { volume: VolumeDto; onEdit: () => void; onDelete: () => void }) {
  const shrinkLabel = volume.capability.shrinkNever
    ? '不可缩容'
    : volume.capability.shrinkRequiresStop
      ? '缩容需卸载'
      : volume.capability.shrinkOnline
        ? '可在线缩容'
        : '缩容受用量约束';
  const phaseLabel = volume.needsAttention
    ? '需要关注'
    : volumeLifecycleLabel(volume.lifecyclePhase);
  const codeLabel = failureCodeLabel(volume.failureCode);
  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3">
          <CardTitle className="flex min-w-0 items-center gap-2 text-base">
            <Database className="h-4 w-4 shrink-0" />
            <span className="truncate">{volume.name}</span>
          </CardTitle>
          <Badge variant={volume.needsAttention ? 'destructive' : volume.lifecyclePhase === 'active' ? 'success' : 'secondary'}>
            {phaseLabel}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <Info label="范围" value={volume.scope.kind === 'shared' ? `共享后端 ${volume.sharedBackendId ?? volume.scope.sharedBackendId}` : `本地服务器 ${volume.serverId ?? volume.scope.serverId}`} />
          <Info label="存储池" value={volume.poolName} />
          <Info label="容量" value={`${approxGibHint(volume.sizeBytes).replace(/^约 /, '')} · 已用 ${volume.usedBytes === null ? '未知' : approxGibHint(volume.usedBytes).replace(/^约 /, '')}`} />
          <Info label="缩容能力" value={shrinkLabel} />
          <Info label="实例名" value={volume.incusName} mono />
          <Info label="最近更新" value={relativeTime(volume.updatedAt)} />
        </div>
        {volume.needsAttention && (
          <p className="text-xs text-destructive">{volumeAttentionHint(volume.failureCode)}</p>
        )}
        {!volume.needsAttention && volume.failureCode && (
          <p className="break-all text-xs text-destructive">
            {codeLabel}
            {codeLabel !== volume.failureCode ? `（${volume.failureCode}）` : null}
          </p>
        )}
        <ResourceIntentFailures listPath={`/volumes/${volume.id}/intents`} admin={false} />
        <div className="flex flex-wrap items-center justify-between gap-2">
          {volume.attachments.length === 0 ? (
            <p className="text-xs text-muted-foreground">请打开目标容器详情 → 存储 → 热挂载</p>
          ) : (
            <p className="text-xs text-muted-foreground" data-testid="volume-attachments">
              挂载于 {volume.attachments.map((item) => `${item.containerName}（${item.containerPath}）`).join('、')}
            </p>
          )}
          <Button size="sm" variant="link" className="h-auto px-0" asChild>
            <Link to="/containers">到容器挂载</Link>
          </Button>
        </div>
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="outline" onClick={onEdit}><Pencil className="h-3.5 w-3.5" />编辑/扩缩</Button>
          <Button size="sm" variant="destructive" onClick={onDelete}><Trash2 className="h-3.5 w-3.5" />删除</Button>
        </div>
      </CardContent>
    </Card>
  );
}

function VolumeFormDialog({
  volume,
  open,
  onOpenChange,
}: {
  volume?: VolumeDto;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(volume?.name ?? '');
  const [sizeGiB, setSizeGiB] = useState(volume ? bytesToGiBInput(volume.sizeBytes) : '10');
  const [serverId, setServerId] = useState(volume?.serverId ?? '');
  const [poolId, setPoolId] = useState(volume?.poolId ?? '');
  const [sharedBackendId, setSharedBackendId] = useState(
    volume?.sharedBackendId
      ?? (volume?.scope.kind === 'shared' ? volume.scope.sharedBackendId : ''),
  );
  const [scopeKind, setScopeKind] = useState<'local' | 'shared'>(volume?.scope.kind ?? 'local');
  const [error, setError] = useState<string | null>(null);
  const [orchestrate, setOrchestrate] = useState(false);
  const serversQuery = useQuery({
    queryKey: ['volume-form', 'servers'],
    queryFn: () => api.get<Array<ServerDto | UserServerDto>>('/servers'),
    enabled: open && !volume,
  });
  const backendsQuery = useQuery({
    queryKey: queryKeys.sharedBackends.user,
    queryFn: () => api.get<SharedBackendDto[]>('/shared-backends'),
    enabled: open && !volume && scopeKind === 'shared',
  });
  const poolsQuery = useQuery({
    queryKey: ['volume-form', 'pools', serverId],
    queryFn: () => api.get<StoragePoolDto[]>(`/servers/${serverId}/storage-pools`),
    enabled: open && !volume && scopeKind === 'local' && serverId.length > 0,
  });
  const sharedPoolsQuery = useQuery({
    queryKey: ['volume-form', 'shared-pools', sharedBackendId],
    queryFn: async () => {
      const servers = serversQuery.data ?? [];
      const rows = await Promise.all(
        servers.map((server) => api.get<StoragePoolDto[]>(
          `/servers/${server.id}/storage-pools`,
        ).catch(() => [] as StoragePoolDto[])),
      );
      return rows.flat().filter((pool) => pool.registered && pool.sharedBackendId === sharedBackendId);
    },
    enabled: open && !volume && scopeKind === 'shared' && sharedBackendId.length > 0 && serversQuery.isSuccess,
  });
  const create = useMutation({
    mutationFn: (body: CreateVolumeRequest) => api.post<unknown>('/volumes', body),
    onSuccess: () => {
      toast({
        title: '创建已提交',
        description: '列表状态稍后更新；若出现「需要关注」，请查看卡片上的说明。',
      });
      void queryClient.invalidateQueries({ queryKey: queryKeys.volumes.user });
      onOpenChange(false);
    },
    onError: (mutationError) => setError(errorMessage(mutationError)),
  });
  const patch = useMutation({
    mutationFn: (body: PatchVolumeRequest) => api.patch<unknown>(`/volumes/${volume?.id ?? ''}`, body),
    onSuccess: () => {
      toast({
        title: '更新已提交',
        description: '列表状态稍后更新；若出现「需要关注」，请查看卡片上的说明。',
      });
      void queryClient.invalidateQueries({ queryKey: queryKeys.volumes.user });
      onOpenChange(false);
    },
    onError: (mutationError) => setError(errorMessage(mutationError)),
  });
  const servers = serversQuery.data ?? [];
  const backends = backendsQuery.data ?? [];
  const localPools = (poolsQuery.data ?? []).filter((pool) => pool.registered && !pool.sharedBackendId);
  const sharedPools = sharedPoolsQuery.data ?? [];
  const selectedPool = scopeKind === 'local'
    ? localPools.find((pool) => pool.id === poolId)
    : sharedPools.find((pool) => pool.id === poolId);
  const parsedGiB = Number(sizeGiB);
  const nextSize = Number.isFinite(parsedGiB) && parsedGiB > 0
    ? Math.round(parsedGiB * GIB)
    : NaN;
  const path = volume && Number.isFinite(nextSize)
    ? classifySizeChange(volume.capability, volume.sizeBytes, nextSize)
    : 'unchanged';
  const floorError = volume && (path === 'online' || path === 'requires_stop')
    ? validateShrinkFloor(volume.capability, nextSize, volume.usedBytes, volume.sizeBytes)
    : null;
  const shrinkBlocked = path === 'never';
  const createQuotaBlocked = !volume && selectedPool != null && selectedPool.quotaEffective !== true;
  const editQuotaBlocked = volume != null
    && path !== 'unchanged'
    && isQuotaIneffectiveCapability(volume.capability);
  const quotaError = createQuotaBlocked
    ? quotaIneffectiveCreateHint()
    : editQuotaBlocked
      ? quotaIneffectiveResizeHint()
      : null;

  const submit = () => {
    setError(null);
    if (!Number.isFinite(nextSize) || nextSize <= 0) {
      setError('请输入有效的容量（G）');
      return;
    }
    if (createQuotaBlocked) {
      setError(quotaIneffectiveCreateHint());
      return;
    }
    if (volume) {
      if (editQuotaBlocked) {
        setError(quotaIneffectiveResizeHint());
        return;
      }
      if (path === 'never') {
        setError(shrinkNeverTooltip());
        return;
      }
      if (floorError) {
        setError(floorError);
        return;
      }
      if (path === 'requires_stop') {
        setOrchestrate(true);
        return;
      }
      const parsed = zPatchVolumeRequest.safeParse({
        expectedRevision: volume.generation,
        name: name.trim(),
        sizeBytes: nextSize,
      });
      if (!parsed.success) {
        setError(parsed.error.issues[0]?.message ?? '请检查数据卷参数');
        return;
      }
      patch.mutate(parsed.data);
      return;
    }
    if (!poolId) {
      setError(scopeKind === 'shared' ? '请选择锚定存储池' : '请选择存储池');
      return;
    }
    const scope: VolumeScope = scopeKind === 'shared'
      ? { kind: 'shared', sharedBackendId, poolId }
      : { kind: 'local', serverId, poolId };
    const parsed = zCreateVolumeRequest.safeParse({
      name: name.trim(),
      sizeBytes: nextSize,
      scope,
    });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? '请检查数据卷参数');
      return;
    }
    create.mutate(parsed.data);
  };

  const description = !volume
    ? (createQuotaBlocked
      ? quotaIneffectiveCreateHint()
      : '先选择本地空间或共享空间，再指定存储池创建数据卷。')
    : editQuotaBlocked
      ? quotaIneffectiveResizeHint()
      : path === 'never'
        ? shrinkNeverTooltip()
        : path === 'requires_stop'
          ? '缩容需要先卸载全部挂载；将引导一键卸载 → 缩容 → 可选挂回。'
          : path === 'online'
            ? '在线缩容：仅校验目标容量不小于已用量。'
            : '扩容在线执行；同名或同容量保存会直接更新。';

  return (
    <>
      <Dialog open={open && !orchestrate} onOpenChange={onOpenChange}>
        <DialogContent data-testid="volume-form">
          <DialogHeader>
            <DialogTitle>{volume ? '编辑数据卷' : '新建数据卷'}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="volume-name">名称</Label>
              <Input id="volume-name" value={name} onChange={(event) => setName(event.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="volume-size">大小（GiB）</Label>
              <Input
                id="volume-size"
                type="number"
                min="0.001"
                step="any"
                value={sizeGiB}
                onChange={(event) => setSizeGiB(event.target.value)}
                disabled={shrinkBlocked && Number.isFinite(nextSize) && nextSize < (volume?.sizeBytes ?? 0)}
                title={shrinkBlocked ? shrinkNeverTooltip() : undefined}
              />
              <p className="text-xs text-muted-foreground">
                {Number.isFinite(nextSize) && nextSize > 0
                  ? approxGibHint(nextSize)
                  : '请输入正数 GiB'}
              </p>
              {shrinkBlocked && (
                <p className="text-xs text-muted-foreground" title={shrinkNeverTooltip()}>
                  {shrinkNeverTooltip()}
                </p>
              )}
            </div>
            {!volume && (
              <>
                <fieldset className="space-y-2">
                  <legend className="text-sm font-medium">空间类型</legend>
                  <div className="flex flex-wrap gap-4 text-sm">
                    <label className="flex items-center gap-2">
                      <input
                        type="radio"
                        name="volume-scope"
                        checked={scopeKind === 'local'}
                        onChange={() => {
                          setScopeKind('local');
                          setSharedBackendId('');
                          setPoolId('');
                        }}
                      />
                      本地空间
                    </label>
                    <label className="flex items-center gap-2">
                      <input
                        type="radio"
                        name="volume-scope"
                        checked={scopeKind === 'shared'}
                        onChange={() => {
                          setScopeKind('shared');
                          setServerId('');
                          setPoolId('');
                        }}
                      />
                      共享空间
                    </label>
                  </div>
                </fieldset>
                {scopeKind === 'local' ? (
                  <div className="grid gap-3 sm:grid-cols-2">
                    <SelectField
                      id="volume-server"
                      label="服务器"
                      value={serverId}
                      onChange={(value) => { setServerId(value); setPoolId(''); }}
                      options={servers.map((server) => [server.id, server.name])}
                    />
                    <SelectField
                      id="volume-pool"
                      label="存储池"
                      value={poolId}
                      onChange={setPoolId}
                      options={localPools.map((pool) => [pool.id, pool.displayName ?? pool.incusName])}
                      disabled={!serverId}
                    />
                  </div>
                ) : (
                  <div className="grid gap-3 sm:grid-cols-2">
                    <SelectField
                      id="volume-shared-backend"
                      label="共享后端"
                      value={sharedBackendId}
                      onChange={(value) => { setSharedBackendId(value); setPoolId(''); }}
                      options={backends.map((backend) => [backend.id, backend.displayName ?? backend.name])}
                    />
                    <SelectField
                      id="volume-anchor-pool"
                      label="锚定存储池"
                      value={poolId}
                      onChange={setPoolId}
                      options={sharedPools.map((pool) => {
                        const server = servers.find((item) => item.id === pool.serverId);
                        return [pool.id, `${pool.displayName ?? pool.incusName}${server ? ` · ${server.name}` : ''}`];
                      })}
                      disabled={!sharedBackendId}
                    />
                  </div>
                )}
                {selectedPool && (
                  <p className="text-xs text-muted-foreground">
                    已选池：{selectedPool.displayName ?? selectedPool.incusName}
                    {selectedPool.totalBytes === null
                      ? ' · 容量未知'
                      : ` · ${approxGibHint(selectedPool.usedBytes ?? 0).replace(/^约 /, '')} / ${approxGibHint(selectedPool.totalBytes).replace(/^约 /, '')}`}
                    {selectedPool.quotaEffective === true ? ' · 配额生效' : ' · 配额未生效'}
                  </p>
                )}
              </>
            )}
            {(error || floorError || quotaError) && (
              <p className="text-sm text-destructive" data-testid={quotaError ? 'volume-quota-ineffective' : undefined}>
                {error ?? floorError ?? quotaError}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
            <Button
              onClick={submit}
              disabled={create.isPending || patch.isPending || Boolean(floorError) || Boolean(quotaError) || (shrinkBlocked && path === 'never')}
              title={quotaError ?? (shrinkBlocked && path === 'never' ? shrinkNeverTooltip() : undefined)}
            >
              {create.isPending || patch.isPending ? '提交中...' : path === 'requires_stop' ? '继续缩容编排' : '保存'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {volume && orchestrate && Number.isFinite(nextSize) && (
        <VolumeShrinkOrchestrationDialog
          volume={{ ...volume, name: name.trim() || volume.name }}
          sizeBytes={nextSize}
          open={orchestrate}
          onOpenChange={(next) => {
            setOrchestrate(next);
            if (!next) onOpenChange(false);
          }}
          onComplete={() => {
            void queryClient.invalidateQueries({ queryKey: queryKeys.volumes.user });
          }}
        />
      )}
    </>
  );
}

function SelectField({
  id,
  label,
  value,
  onChange,
  options,
  disabled = false,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: Array<[string, string]>;
  disabled?: boolean;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <select
        id={id}
        className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
      >
        <option value="">请选择</option>
        {options.map(([optionValue, optionLabel]) => (
          <option key={optionValue} value={optionValue}>{optionLabel}</option>
        ))}
      </select>
    </div>
  );
}

function Info({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={mono ? 'break-all font-mono text-xs' : 'break-all text-sm'}>{value}</p>
    </div>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '请稍后重试';
}
