import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  zCreateVolumeRequest,
  zPatchVolumeRequest,
  type CreateVolumeRequest,
  type PatchVolumeRequest,
  type ServerDto,
  type StoragePoolDto,
  type UserServerDto,
  type VolumeDto,
} from '@nyabase/common';
import { api } from '../../lib/api.js';
import { errorMessage } from '../../lib/api-error.js';
import { Button } from '../ui/button.js';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog.js';
import { Input } from '../ui/input.js';
import { FormField } from '../layout/form-field.js';
import { VolumeShrinkOrchestrationDialog } from './volume-shrink-orchestration-dialog.js';
import { bytesToGiBInput, GIB, SelectField } from './volume-form-fields.js';
import { approxGibHint } from '../../lib/utils.js';
import { queryKeys } from '../../lib/query-keys.js';
import { toast } from '../../hooks/use-toast.js';
import {
  classifySizeChange,
  isQuotaIneffectiveCapability,
  quotaIneffectiveCreateHint,
  quotaIneffectiveResizeHint,
  shrinkNeverTooltip,
  validateShrinkFloor,
} from '../../lib/storage-shrink.js';

export function LocalVolumeFormDialog({
  volume,
  open,
  onOpenChange,
}: {
  volume?: VolumeDto;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const editing = volume;
  const [name, setName] = useState(editing?.name ?? '');
  const [sizeGiB, setSizeGiB] = useState(editing ? bytesToGiBInput(editing.sizeBytes) : '10');
  const [serverId, setServerId] = useState(volume?.serverId ?? '');
  const [poolId, setPoolId] = useState(volume?.poolId ?? '');
  const [error, setError] = useState<string | null>(null);
  const [orchestrate, setOrchestrate] = useState(false);
  const serversQuery = useQuery({
    queryKey: queryKeys.volumeForm.servers,
    queryFn: () => api.get<Array<ServerDto | UserServerDto>>('/servers'),
    enabled: open && !editing,
  });
  const poolsQuery = useQuery({
    queryKey: queryKeys.volumeForm.pools(serverId),
    queryFn: () => api.get<StoragePoolDto[]>(`/servers/${serverId}/storage-pools`),
    enabled: open && !editing && serverId.length > 0,
  });
  const createLocal = useMutation({
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
  const localPools = (poolsQuery.data ?? []).filter((pool) => pool.registered && !pool.sharedBackendId);
  const selectedPool = localPools.find((pool) => pool.id === poolId);
  const parsedGiB = Number(sizeGiB);
  const nextSize = Number.isFinite(parsedGiB) && parsedGiB > 0
    ? Math.round(parsedGiB * GIB)
    : NaN;
  const path = editing && Number.isFinite(nextSize)
    ? classifySizeChange(editing.capability, editing.sizeBytes, nextSize)
    : 'unchanged';
  const floorError = editing && (path === 'online' || path === 'requires_stop')
    ? validateShrinkFloor(editing.capability, nextSize, editing.usedBytes, editing.sizeBytes)
    : null;
  const shrinkBlocked = path === 'never';
  const createQuotaBlocked = !editing && selectedPool != null && selectedPool.quotaEffective !== true;
  const editQuotaBlocked = editing != null
    && path !== 'unchanged'
    && isQuotaIneffectiveCapability(editing.capability);
  const quotaError = createQuotaBlocked
    ? quotaIneffectiveCreateHint()
    : editQuotaBlocked
      ? quotaIneffectiveResizeHint()
      : null;
  const pending = createLocal.isPending || patch.isPending;

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
    if (editing) {
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
        expectedRevision: editing.generation,
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
      setError('请选择存储池');
      return;
    }
    const parsed = zCreateVolumeRequest.safeParse({
      name: name.trim(),
      sizeBytes: nextSize,
      scope: { kind: 'local', serverId, poolId },
    });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? '请检查数据卷参数');
      return;
    }
    createLocal.mutate(parsed.data);
  };

  const description = !editing
    ? (createQuotaBlocked
      ? quotaIneffectiveCreateHint()
      : '选择服务器和存储池创建本地数据卷。')
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
            <DialogTitle>{editing ? '编辑数据卷' : '新建数据卷'}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <FormField id="volume-name" label="名称">
              <Input id="volume-name" value={name} onChange={(event) => setName(event.target.value)} />
            </FormField>
            <FormField id="volume-size" label="大小（GiB）">
              <Input
                id="volume-size"
                type="number"
                min="0.001"
                step="any"
                value={sizeGiB}
                onChange={(event) => setSizeGiB(event.target.value)}
                disabled={shrinkBlocked && Number.isFinite(nextSize) && nextSize < (editing?.sizeBytes ?? 0)}
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
            </FormField>
            {!editing && (
              <>
                <div className="grid gap-3 sm:grid-cols-2">
                  <SelectField
                    id="volume-server"
                    label="服务器"
                    value={serverId}
                    onChange={(value) => { setServerId(value); setPoolId(''); }}
                    options={servers.map((server) => [server.id, server.name])}
                  />
                  <SelectField
                    key={serverId || 'no-server'}
                    id="volume-pool"
                    label="存储池"
                    value={poolId}
                    onChange={setPoolId}
                    options={localPools.map((pool) => [pool.id, pool.displayName ?? pool.incusName])}
                    disabled={!serverId}
                  />
                </div>
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
              disabled={pending || Boolean(floorError) || Boolean(quotaError) || (shrinkBlocked && path === 'never')}
              title={quotaError ?? (shrinkBlocked && path === 'never' ? shrinkNeverTooltip() : undefined)}
            >
              {pending ? '提交中...' : path === 'requires_stop' ? '继续缩容编排' : '保存'}
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
