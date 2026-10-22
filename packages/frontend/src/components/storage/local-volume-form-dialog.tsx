import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  type CreateVolumeRequest,
  type IntentAcceptedDto,
  IntentResourceType,
  type ListScope,
  type PatchVolumeRequest,
  type ServerDto,
  type StorageCapacityDto,
  type StoragePoolDto,
  type UserServerDto,
  type VolumeDto,
  zCreateVolumeRequest,
  zPatchVolumeRequest,
} from '@nyabase/common';
import { Button } from '../ui/button.js';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog.js';
import { Input } from '../ui/input.js';
import { FormField, SelectField } from '../layout/form-field.js';
import { toast } from '../../hooks/use-toast.js';
import { api } from '../../lib/api.js';
import { errorMessage } from '../../lib/api-error.js';
import { formatGrantBytes } from '../../lib/grant-quota.js';
import { isIntentAccepted, resourceIntentsPath, waitForResourceIntent } from '../../lib/intent-visibility.js';
import { queryKeys } from '../../lib/query-keys.js';
import { scopedPath } from '../../lib/scoped-paths.js';
import {
  deriveSizeChange,
  quotaIneffectiveCreateHint,
  quotaIneffectiveResizeHint,
  shrinkNeverTooltip,
} from '../../lib/storage-shrink.js';
import { useOpenSession } from '../../hooks/use-dom-state.js';
import { approxGibHint, formatGib, formatGibInput, grantAvailableLabel } from '../../lib/utils.js';
import { VolumeShrinkOrchestrationDialog } from './volume-shrink-orchestration-dialog.js';

export interface LocalVolumeFormProps {
  volume?: VolumeDto;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  scope?: ListScope;
  lockedServerId?: string;
  lockedPoolId?: string;
}

/** Create / edit a local volume; a shrink that needs it detached hands over to the orchestration dialog. */
export function LocalVolumeFormDialog(props: LocalVolumeFormProps) {
  return <LocalVolumeFormBody key={useOpenSession(props.open)} {...props} />;
}

function storageSuffix(scope: ListScope): string {
  return scope === 'all' ? '?scope=all' : '';
}

function useLocalPools(scope: ListScope, serverId: string, enabled: boolean) {
  return useQuery({
    queryKey: scope === 'all'
      ? queryKeys.servers.pools(serverId, 'all')
      : queryKeys.volumeForm.pools(serverId),
    queryFn: () => api.get<StoragePoolDto[]>(`/servers/${serverId}/storage-pools${storageSuffix(scope)}`),
    enabled: enabled && serverId.length > 0,
  });
}

/** The create and edit requests of the local volume form; success closes the dialog. */
function useLocalVolumeSave(
  editing: VolumeDto | undefined,
  scope: ListScope,
  onOpenChange: (open: boolean) => void,
  setError: (message: string) => void,
) {
  const queryClient = useQueryClient();
  const invalidateVolumeLists = () => {
    void queryClient.invalidateQueries({ queryKey: scope === 'all' ? queryKeys.volumes.admin : queryKeys.volumes.user });
    void queryClient.invalidateQueries({ queryKey: ['resource-intent-failures'] });
  };
  const createLocal = useMutation({
    mutationFn: (body: CreateVolumeRequest) => api.post<unknown>('/volumes', body),
    onSuccess: () => {
      toast({ title: '创建已提交' });
      invalidateVolumeLists();
      onOpenChange(false);
    },
    onError: (mutationError) => setError(errorMessage(mutationError)),
  });
  const patch = useMutation({
    mutationFn: async (body: PatchVolumeRequest) => {
      const volumeId = editing?.id ?? '';
      const accepted = await api.patch<IntentAcceptedDto | VolumeDto>(scopedPath(`/volumes/${volumeId}`, scope), body);
      if (isIntentAccepted(accepted)) {
        await waitForResourceIntent(resourceIntentsPath(scope, IntentResourceType.Volume, volumeId), accepted.intentId);
      }
    },
    onSuccess: () => {
      toast({ title: '已更新' });
      invalidateVolumeLists();
      onOpenChange(false);
    },
    onError: (mutationError) => {
      setError(errorMessage(mutationError));
      invalidateVolumeLists();
    },
  });
  return { createLocal, patch, invalidateVolumeLists };
}

function LocalVolumeFormBody({
  volume: editing,
  open,
  onOpenChange,
  scope = 'mine',
  lockedServerId,
  lockedPoolId,
}: LocalVolumeFormProps) {
  const [name, setName] = useState(editing?.name ?? '');
  const [sizeGiB, setSizeGiB] = useState(editing ? formatGibInput(editing.sizeBytes) : '10');
  const [serverId, setServerId] = useState(editing?.serverId ?? lockedServerId ?? '');
  const [poolId, setPoolId] = useState(editing?.poolId ?? lockedPoolId ?? '');
  const [error, setError] = useState<string | null>(null);
  const [orchestrate, setOrchestrate] = useState(false);

  const pools = useLocalPools(scope, serverId, open && !editing).data ?? [];
  const selectedPool = pools.filter((pool) => pool.registered).find((pool) => pool.id === poolId);
  const { nextSize, path, floorError, editQuotaBlocked } = deriveSizeChange(editing, sizeGiB);
  const createQuotaBlocked = !editing && selectedPool != null && selectedPool.quotaEffective !== true;
  const quotaError = createQuotaBlocked
    ? quotaIneffectiveCreateHint()
    : editQuotaBlocked ? quotaIneffectiveResizeHint() : null;
  const description = !editing
    ? quotaError
    : editQuotaBlocked ? quotaError : path === 'never' ? shrinkNeverTooltip() : null;
  const shrinkBlocked = path === 'never';

  const { createLocal, patch, invalidateVolumeLists } = useLocalVolumeSave(editing, scope, onOpenChange, setError);
  const pending = createLocal.isPending || patch.isPending;

  const submit = () => {
    setError(null);
    const fail = (message: string) => setError(message);
    if (!Number.isFinite(nextSize) || nextSize <= 0) return fail('请输入有效的容量（GiB）');
    if (createQuotaBlocked) return fail(quotaIneffectiveCreateHint());
    if (editing) {
      if (editQuotaBlocked) return fail(quotaIneffectiveResizeHint());
      if (path === 'never') return fail(shrinkNeverTooltip());
      if (floorError) return fail(floorError);
      if (path === 'requires_stop') return setOrchestrate(true);
      const parsed = zPatchVolumeRequest.safeParse({
        expectedRevision: editing.revision,
        name: name.trim(),
        sizeBytes: nextSize,
      });
      if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? '请检查数据卷参数');
      return patch.mutate(parsed.data);
    }
    if (scope === 'all') return;
    if (!poolId) return fail('请选择存储池');
    const parsed = zCreateVolumeRequest.safeParse({
      name: name.trim(),
      sizeBytes: nextSize,
      scope: { kind: 'local', serverId, poolId },
    });
    if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? '请检查数据卷参数');
    createLocal.mutate(parsed.data);
  };

  return (
    <>
      <Dialog open={open && !orchestrate} onOpenChange={onOpenChange}>
        <DialogContent data-testid="volume-form">
          <DialogHeader>
            <DialogTitle>{editing ? '编辑数据卷' : '新建数据卷'}</DialogTitle>
            {description ? <DialogDescription>{description}</DialogDescription> : null}
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
                {Number.isFinite(nextSize) && nextSize > 0 ? approxGibHint(nextSize) : '请输入正数 GiB'}
              </p>
              <CapacityHint scope={scope} serverId={serverId} poolId={poolId} />
              {shrinkBlocked && (
                <p className="text-xs text-muted-foreground" title={shrinkNeverTooltip()}>
                  {shrinkNeverTooltip()}
                </p>
              )}
            </FormField>
            {!editing && (
              <PlacementFields
                scope={scope}
                serverId={serverId}
                poolId={poolId}
                selectedPool={selectedPool}
                serverLocked={Boolean(lockedServerId)}
                poolLocked={Boolean(lockedPoolId)}
                onServerChange={(value) => {
                  setServerId(value);
                  setPoolId(lockedPoolId ?? '');
                }}
                onPoolChange={setPoolId}
              />
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
              disabled={pending || Boolean(floorError) || Boolean(quotaError) || shrinkBlocked}
              title={quotaError ?? (shrinkBlocked ? shrinkNeverTooltip() : undefined)}
            >
              {pending ? '提交中...' : path === 'requires_stop' ? '继续缩容编排' : '保存'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {editing && orchestrate && Number.isFinite(nextSize) && (
        <VolumeShrinkOrchestrationDialog
          scope={scope}
          volume={{ ...editing, name: name.trim() || editing.name }}
          sizeBytes={nextSize}
          open={orchestrate}
          onOpenChange={(next) => {
            setOrchestrate(next);
            if (!next) onOpenChange(false);
          }}
          onComplete={invalidateVolumeLists}
        />
      )}
    </>
  );
}

/** Remaining capacity under the size field: physical for administrators, grant-based for owners. */
function CapacityHint({ scope, serverId, poolId }: { scope: ListScope; serverId: string; poolId: string }) {
  const capacity = useQuery({
    queryKey: scope === 'all'
      ? (['storage-capacity', 'admin', serverId] as const)
      : queryKeys.storageCapacity(serverId),
    queryFn: () => api.get<StorageCapacityDto>(`/servers/${serverId}/storage-capacity${storageSuffix(scope)}`),
    enabled: serverId.length > 0,
  }).data;
  if (scope === 'all') {
    const pool = (capacity?.pools ?? []).find((row) => row.poolId === poolId);
    return (
      <div className="space-y-1">
        <p className="text-xs text-muted-foreground">
          池剩余（物理，含超分；不是该用户的磁盘额度）。
        </p>
        {pool ? (
          <p className="text-xs text-muted-foreground">
            {pool.availableBytes === null ? '物理剩余未知' : `物理剩余 ${formatGib(pool.availableBytes)}`}
            {pool.quotaEffective === true ? ' · 配额生效' : ' · 配额未生效'}
          </p>
        ) : null}
      </div>
    );
  }
  if (!capacity) return null;
  return (
    <p className="text-xs text-muted-foreground">
      {capacity.grantLimitBytes === null || capacity.grantLimitBytes === 0
        ? '额度不限'
        : `剩余 ${grantAvailableLabel(capacity.availableBytes, capacity.grantLimitBytes)} / 额度 ${formatGrantBytes(capacity.grantLimitBytes)}`}
    </p>
  );
}

/** Server and pool pickers (creation only), with the selected pool's usage. */
function PlacementFields({
  scope,
  serverId,
  poolId,
  selectedPool,
  serverLocked,
  poolLocked,
  onServerChange,
  onPoolChange,
}: {
  scope: ListScope;
  serverId: string;
  poolId: string;
  selectedPool: StoragePoolDto | undefined;
  serverLocked: boolean;
  poolLocked: boolean;
  onServerChange: (serverId: string) => void;
  onPoolChange: (poolId: string) => void;
}) {
  const servers = useQuery({
    queryKey: queryKeys.volumeForm.servers,
    queryFn: () => api.get<Array<ServerDto | UserServerDto>>('/servers'),
    enabled: scope !== 'all',
  }).data ?? [];
  const localPools = (useLocalPools(scope, serverId, true).data ?? []).filter((pool) => pool.registered);
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2">
        <SelectField
          id="volume-server"
          label="服务器"
          value={serverId}
          onChange={onServerChange}
          options={servers.map((server): [string, string] => [server.id, server.name])}
          disabled={serverLocked}
        />
        <SelectField
          key={serverId || 'no-server'}
          id="volume-pool"
          label="存储池"
          value={poolId}
          onChange={onPoolChange}
          options={localPools.map((pool): [string, string] => [pool.id, pool.displayName ?? pool.incusName])}
          disabled={!serverId || poolLocked}
        />
      </div>
      {selectedPool && (
        <p className="text-xs text-muted-foreground">
          已选池：{selectedPool.displayName ?? selectedPool.incusName}
          {selectedPool.totalBytes === null
            ? ' · 容量未知'
            : ` · ${formatGib(selectedPool.usedBytes ?? 0)} / ${formatGib(selectedPool.totalBytes)}`}
          {selectedPool.quotaEffective === true ? ' · 配额生效' : ' · 配额未生效'}
        </p>
      )}
    </>
  );
}
