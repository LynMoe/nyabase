import { useEffect, useState } from 'react';
import { formatGibInput, GIB } from '../../lib/utils.js';
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
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  classifySizeChange,
  isQuotaIneffectiveCapability,
  quotaIneffectiveCreateHint,
  quotaIneffectiveResizeHint,
  shrinkNeverTooltip,
  validateShrinkFloor,
} from '../../lib/storage-shrink.js';
import { api } from '../../lib/api.js';
import { errorMessage } from '../../lib/api-error.js';
import { queryKeys } from '../../lib/query-keys.js';
import { toast } from '../../hooks/use-toast.js';
import { isIntentAccepted, resourceIntentsPath, waitForResourceIntent } from '../../lib/intent-visibility.js';

export interface LocalVolumeFormProps {
  volume?: VolumeDto;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  scope?: ListScope;
  lockedServerId?: string;
  lockedPoolId?: string;
}

/**
 * State and validation of the create / edit local volume form. Editing a
 * shrink that needs the volume detached hands over to the orchestration dialog.
 */
export function useLocalVolumeForm({
  volume,
  open,
  onOpenChange,
  scope = 'mine',
  lockedServerId,
  lockedPoolId,
}: LocalVolumeFormProps) {
  const editing = volume;
  const [name, setName] = useState(editing?.name ?? '');
  const [sizeGiB, setSizeGiB] = useState(editing ? formatGibInput(editing.sizeBytes) : '10');
  const [serverId, setServerId] = useState(volume?.serverId ?? lockedServerId ?? '');
  const [poolId, setPoolId] = useState(volume?.poolId ?? lockedPoolId ?? '');
  const [error, setError] = useState<string | null>(null);
  const [orchestrate, setOrchestrate] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(volume?.name ?? '');
    setSizeGiB(volume ? formatGibInput(volume.sizeBytes) : '10');
    setServerId(volume?.serverId ?? lockedServerId ?? '');
    setPoolId(volume?.poolId ?? lockedPoolId ?? '');
    setError(null);
    setOrchestrate(false);
  }, [open, volume, lockedServerId, lockedPoolId]);

  const data = useLocalVolumeData({
    open,
    volume,
    scope,
    serverId,
    onSaved: () => onOpenChange(false),
    onError: setError,
  });
  const { createLocal, patch } = data;
  const servers = data.serversQuery.data ?? [];
  const localPools = (data.poolsQuery.data ?? []).filter((pool) => pool.registered);
  const selectedPool = localPools.find((pool) => pool.id === poolId);
  const selectedCapacityPool = (data.capacityQuery.data?.pools ?? []).find((pool) => pool.poolId === poolId);
  const {
    nextSize,
    path,
    floorError,
    shrinkBlocked,
    createQuotaBlocked,
    editQuotaBlocked,
    quotaError,
    description,
  } = deriveLocalVolumeState({ editing, sizeGiB, selectedPool });

  /** The first reason an edit cannot be submitted, or null. */
  const editBlockedReason = (): string | null => {
    if (editQuotaBlocked) return quotaIneffectiveResizeHint();
    if (path === 'never') return shrinkNeverTooltip();
    return floorError;
  };

  const submitEdit = (current: VolumeDto) => {
    const blocked = editBlockedReason();
    if (blocked) {
      setError(blocked);
      return;
    }
    if (path === 'requires_stop') {
      setOrchestrate(true);
      return;
    }
    const parsed = zPatchVolumeRequest.safeParse({
      expectedRevision: current.revision,
      name: name.trim(),
      sizeBytes: nextSize,
    });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? '请检查数据卷参数');
      return;
    }
    patch.mutate(parsed.data);
  };

  const submitCreate = () => {
    if (scope === 'all') return;
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

  const submit = () => {
    setError(null);
    if (!Number.isFinite(nextSize) || nextSize <= 0) {
      setError('请输入有效的容量（GiB）');
      return;
    }
    if (createQuotaBlocked) {
      setError(quotaIneffectiveCreateHint());
      return;
    }
    if (editing) submitEdit(editing);
    else submitCreate();
  };

  return {
    editing,
    scope,
    name,
    sizeGiB,
    serverId,
    poolId,
    error,
    orchestrate,
    setName,
    setSizeGiB,
    setServerId,
    setPoolId,
    setOrchestrate,
    data,
    servers,
    localPools,
    selectedPool,
    selectedCapacityPool,
    nextSize,
    path,
    floorError,
    shrinkBlocked,
    quotaError,
    description,
    pending: createLocal.isPending || patch.isPending,
    serverLocked: Boolean(lockedServerId),
    poolLocked: Boolean(lockedPoolId),
    lockedPoolId,
    submit,
  };
}

export type LocalVolumeForm = ReturnType<typeof useLocalVolumeForm>;

function storagePoolsPath(scope: ListScope, serverId: string): string {
  return `/servers/${serverId}/storage-pools${scope === 'all' ? '?scope=all' : ''}`;
}

function storageCapacityPath(scope: ListScope, serverId: string): string {
  return `/servers/${serverId}/storage-capacity${scope === 'all' ? '?scope=all' : ''}`;
}

/** The queries and mutations behind the local volume form. */
export function useLocalVolumeData({
  open,
  volume,
  scope,
  serverId,
  onSaved,
  onError,
}: {
  open: boolean;
  volume: VolumeDto | undefined;
  scope: ListScope;
  serverId: string;
  /** Called after a save succeeded and the lists were refreshed. */
  onSaved: () => void;
  onError: (message: string) => void;
}) {
  const queryClient = useQueryClient();
  const editing = volume;

  const invalidateVolumeLists = () => {
    if (scope === 'all') {
      void queryClient.invalidateQueries({ queryKey: queryKeys.volumes.admin });
    } else {
      void queryClient.invalidateQueries({ queryKey: queryKeys.volumes.user });
    }
    void queryClient.invalidateQueries({ queryKey: ['resource-intent-failures'] });
  };

  const serversQuery = useQuery({
    queryKey: queryKeys.volumeForm.servers,
    queryFn: () => api.get<Array<ServerDto | UserServerDto>>('/servers'),
    enabled: open && !editing && scope !== 'all',
  });
  const poolsQuery = useQuery({
    queryKey: scope === 'all'
      ? queryKeys.servers.pools(serverId, 'all')
      : queryKeys.volumeForm.pools(serverId),
    queryFn: () => api.get<StoragePoolDto[]>(storagePoolsPath(scope, serverId)),
    enabled: open && !editing && serverId.length > 0,
  });
  const capacityQuery = useQuery({
    queryKey: scope === 'all'
      ? (['storage-capacity', 'admin', serverId] as const)
      : queryKeys.storageCapacity(serverId),
    queryFn: () => api.get<StorageCapacityDto>(storageCapacityPath(scope, serverId)),
    enabled: open && serverId.length > 0,
  });
  const createLocal = useMutation({
    mutationFn: (body: CreateVolumeRequest) => api.post<unknown>('/volumes', body),
    onSuccess: () => {
      toast({ title: '创建已提交' });
      invalidateVolumeLists();
      onSaved();
    },
    onError: (mutationError) => onError(errorMessage(mutationError)),
  });
  const patch = useMutation({
    mutationFn: async (body: PatchVolumeRequest) => {
      const volumeId = volume?.id ?? '';
      const accepted = await api.patch<IntentAcceptedDto | VolumeDto>(`/volumes/${volumeId}`, body);
      if (isIntentAccepted(accepted)) {
        await waitForResourceIntent(resourceIntentsPath(scope, IntentResourceType.Volume, volumeId), accepted.intentId);
      }
    },
    onSuccess: () => {
      toast({ title: '已更新' });
      invalidateVolumeLists();
      onSaved();
    },
    onError: (mutationError) => {
      onError(errorMessage(mutationError));
      invalidateVolumeLists();
    },
  });

  return { serversQuery, poolsQuery, capacityQuery, createLocal, patch, invalidateVolumeLists };
}

/**
 * What the typed size means for this volume: the new byte size, whether the
 * change is a plain resize, a shrink that needs the volume detached or one that
 * is not allowed, and the quota / floor problems that block saving.
 */
export function deriveLocalVolumeState({
  editing,
  sizeGiB,
  selectedPool,
}: {
  editing: VolumeDto | undefined;
  sizeGiB: string;
  selectedPool: StoragePoolDto | undefined;
}) {
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
  const description = !editing
    ? (createQuotaBlocked ? quotaIneffectiveCreateHint() : null)
    : editQuotaBlocked
      ? quotaIneffectiveResizeHint()
      : path === 'never'
        ? shrinkNeverTooltip()
        : null;
  return {
    nextSize,
    path,
    floorError,
    shrinkBlocked,
    createQuotaBlocked,
    editQuotaBlocked,
    quotaError,
    description,
  };
}
