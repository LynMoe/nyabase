import { useEffect, useState } from 'react';
import {
  zCreateVolumeRequest,
  zPatchVolumeRequest,
  type ListScope,
  type VolumeDto,
} from '@nyabase/common';
import {
  quotaIneffectiveCreateHint,
  quotaIneffectiveResizeHint,
  shrinkNeverTooltip,
} from '../../../lib/storage-shrink.js';
import { bytesToGiBInput } from '../volume-form-fields.js';
import { deriveLocalVolumeState } from './derive-local-volume-state.js';
import { useLocalVolumeData } from './use-local-volume-data.js';

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
  const [sizeGiB, setSizeGiB] = useState(editing ? bytesToGiBInput(editing.sizeBytes) : '10');
  const [serverId, setServerId] = useState(volume?.serverId ?? lockedServerId ?? '');
  const [poolId, setPoolId] = useState(volume?.poolId ?? lockedPoolId ?? '');
  const [error, setError] = useState<string | null>(null);
  const [orchestrate, setOrchestrate] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(volume?.name ?? '');
    setSizeGiB(volume ? bytesToGiBInput(volume.sizeBytes) : '10');
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
