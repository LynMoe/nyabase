import { useMemo, useState } from 'react';
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
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog.js';
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
import { defaultResourceName } from '../../lib/default-names.js';
import { useFittedDefaultSize } from '../../hooks/use-fitted-default-size.js';
import { type QuotaLineQuota, quotaFrom, quotaSliderLimits } from '../quota/quota-line.js';
import { VolumeShrinkOrchestrationDialog } from './volume-shrink-orchestration-dialog.js';
import { CreateSizeField, VolumeFormError, VolumeFormFooter } from './volume-form-parts.js';

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

function useStorageCapacity(scope: ListScope, serverId: string) {
  return useQuery({
    queryKey: scope === 'all'
      ? (['storage-capacity', 'admin', serverId] as const)
      : queryKeys.storageCapacity(serverId),
    queryFn: () => api.get<StorageCapacityDto>(`/servers/${serverId}/storage-capacity${storageSuffix(scope)}`),
    enabled: serverId.length > 0,
  });
}

/**
 * The prefilled name of a new volume: `vol-yymmdd`, skipping names the user's
 * local volumes already use (ignoring case). Typing replaces it.
 */
function useDefaultVolumeName(enabled: boolean, initial: string) {
  const [typed, setTyped] = useState<string | null>(null);
  const volumes = useQuery({
    queryKey: queryKeys.volumes.user,
    queryFn: () => api.get<VolumeDto[]>('/volumes'),
    enabled,
  }).data;
  const defaultName = useMemo(() => defaultResourceName('vol', (volumes ?? []).map((volume) => volume.name)), [volumes]);
  return { name: typed ?? (enabled ? defaultName : initial), setName: setTyped };
}

/**
 * The quota a new volume on `poolId` counts against: the owner's data-disk
 * grant on that pool (administrators acting for others are not limited by it).
 */
function poolQuota(scope: ListScope, capacity: StorageCapacityDto | undefined, poolId: string): QuotaLineQuota {
  if (scope === 'all') return { kind: 'unlimited' };
  if (!capacity || !poolId) return { kind: 'loading' };
  const grant = capacity.pools.find((pool) => pool.poolId === poolId)?.grant;
  if (!grant) return { kind: 'unknown' };
  return quotaFrom(grant.limitBytes, grant.availableBytes);
}

/**
 * Slider limits of a new volume on the chosen server and pool: the data-disk
 * grant on the pool, or the pool's free space when the grant is unlimited.
 */
function useCreateSizeLimits(scope: ListScope, serverId: string, poolId: string, sizeBytes: number) {
  const capacityQuery = useStorageCapacity(scope, serverId);
  const capacity = capacityQuery.data;
  const quota: QuotaLineQuota = capacityQuery.isError ? { kind: 'unknown' } : poolQuota(scope, capacity, poolId);
  const poolFree = capacity?.pools.find((pool) => pool.poolId === poolId)?.availableBytes ?? null;
  const selected = Number.isFinite(sizeBytes) && sizeBytes > 0 ? sizeBytes : null;
  return { quota, ...quotaSliderLimits('volume', quota, poolFree, selected) };
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
  const { name, setName } = useDefaultVolumeName(open && !editing && scope === 'mine', editing?.name ?? '');
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
  const createLimits = useCreateSizeLimits(scope, editing ? '' : serverId, poolId, nextSize);
  const createOver = !editing && createLimits.over;
  const sizeDefault = useFittedDefaultSize({
    enabled: open && !editing,
    fallbackGib: 10,
    scale: createLimits.scale,
    availableGib: createLimits.availableGib,
    setText: setSizeGiB,
  });

  const { createLocal, patch, invalidateVolumeLists } = useLocalVolumeSave(editing, scope, onOpenChange, setError);
  const pending = createLocal.isPending || patch.isPending;

  const submit = () => {
    setError(null);
    const fail = (message: string) => setError(message);
    if (!Number.isFinite(nextSize) || nextSize <= 0) return fail('请输入有效的容量（GiB）');
    if (createQuotaBlocked) return fail(quotaIneffectiveCreateHint());
    if (createOver) return fail('超出剩余额度');
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
              <Input id="volume-name" value={name} autoComplete="off" onChange={(event) => setName(event.target.value)} />
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
            {!editing ? (
              <CreateSizeField
                id="volume-size"
                value={sizeGiB}
                onChange={(value) => {
                  sizeDefault.markTouched();
                  setSizeGiB(value);
                }}
                limits={createLimits}
                quota={createLimits.quota}
                over={createOver}
                showQuota={Boolean(serverId)}
                quotaTestId="volume-create-remaining"
              />
            ) : (
              <EditSizeField
                scope={scope}
                serverId={serverId}
                poolId={poolId}
                sizeBytes={editing.sizeBytes}
                sizeGiB={sizeGiB}
                onSizeChange={setSizeGiB}
                nextSize={nextSize}
                shrinkBlocked={shrinkBlocked}
              />
            )}
            <VolumeFormError message={error ?? floorError ?? quotaError} testId={quotaError ? 'volume-quota-ineffective' : undefined} />
          </div>
          <VolumeFormFooter
            onCancel={() => onOpenChange(false)}
            onSubmit={submit}
            disabled={pending || Boolean(floorError) || Boolean(quotaError) || shrinkBlocked || createOver}
            blockedReason={quotaError ?? (shrinkBlocked ? shrinkNeverTooltip() : undefined)}
            label={pending ? '提交中...' : path === 'requires_stop' ? '继续缩容编排' : '保存'}
          />
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

/** The size input of an existing volume, with the capacity hint and why it cannot shrink. */
function EditSizeField({
  scope,
  serverId,
  poolId,
  sizeBytes,
  sizeGiB,
  onSizeChange,
  nextSize,
  shrinkBlocked,
}: {
  scope: ListScope;
  serverId: string;
  poolId: string;
  sizeBytes: number;
  sizeGiB: string;
  onSizeChange: (value: string) => void;
  nextSize: number;
  shrinkBlocked: boolean;
}) {
  return (
    <FormField id="volume-size" label="大小（GiB）">
      <Input
        id="volume-size"
        type="number"
        min="0.001"
        step="any"
        value={sizeGiB}
        onChange={(event) => onSizeChange(event.target.value)}
        disabled={shrinkBlocked && Number.isFinite(nextSize) && nextSize < sizeBytes}
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
  );
}

/** Remaining capacity under the size field: physical for administrators, grant-based for owners. */
function CapacityHint({ scope, serverId, poolId }: { scope: ListScope; serverId: string; poolId: string }) {
  const capacity = useStorageCapacity(scope, serverId).data;
  if (scope === 'all') {
    const pool = (capacity?.pools ?? []).find((row) => row.poolId === poolId);
    return (
      <div className="space-y-1">
        {pool ? (
          <p className="text-xs text-muted-foreground">
            {pool.availableBytes === null ? '物理剩余未知' : `物理剩余 ${formatGib(pool.availableBytes)}`}
            {pool.quotaEffective === true ? ' · 配额生效' : ' · 配额未生效'}
          </p>
        ) : null}
      </div>
    );
  }
  const grant = capacity?.pools.find((row) => row.poolId === poolId)?.grant;
  if (!grant) return null;
  return (
    <p className="text-xs text-muted-foreground">
      {grant.limitBytes === null
        ? '数据盘额度不限'
        : `剩余 ${grantAvailableLabel(grant.availableBytes, grant.limitBytes)} / 数据盘额度 ${formatGrantBytes(grant.limitBytes)}`}
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
  const serversQuery = useQuery({
    queryKey: queryKeys.volumeForm.servers,
    queryFn: () => api.get<Array<ServerDto | UserServerDto>>('/servers'),
    enabled: scope !== 'all',
  });
  const servers = serversQuery.data ?? [];
  const poolsQuery = useLocalPools(scope, serverId, true);
  const localPools = (poolsQuery.data ?? []).filter((pool) => pool.registered);
  const capacity = useStorageCapacity(scope, serverId).data;
  const poolLabel = (pool: StoragePoolDto): string => {
    const name = pool.displayName ?? pool.incusName;
    const grant = capacity?.pools.find((row) => row.poolId === pool.id)?.grant;
    return grant ? `${name} · 数据盘额度 ${formatGrantBytes(grant.limitBytes)}` : name;
  };
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2">
        <SelectField
          id="volume-server"
          label="服务器"
          value={serverId}
          onChange={onServerChange}
          options={servers.map((server): [string, string] => [server.id, server.name])}
          placeholder="选择服务器"
          disabled={serverLocked}
          loading={serversQuery.isLoading}
          emptyText={serverLocked ? undefined : '没有可用的服务器'}
        />
        <SelectField
          key={serverId || 'no-server'}
          id="volume-pool"
          label="存储池"
          value={poolId}
          onChange={onPoolChange}
          options={localPools.map((pool): [string, string] => [pool.id, poolLabel(pool)])}
          placeholder={serverId ? '选择存储池' : '先选择服务器'}
          disabled={!serverId || poolLocked}
          loading={Boolean(serverId) && poolsQuery.isLoading}
          emptyText={serverId && !poolLocked ? '没有可用的存储池' : undefined}
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
