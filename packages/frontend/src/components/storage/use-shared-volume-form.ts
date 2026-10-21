import { useState } from 'react';
import {
  type CreateSharedVolumeRequest,
  type EffectiveAccessDto,
  type IntentAcceptedDto,
  IntentResourceType,
  type PatchVolumeRequest,
  type SharedBackendDto,
  type SharedVolumeDto,
  zCreateSharedVolumeRequest,
  zPatchVolumeRequest,
} from '@nyabase/common';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { backendLacksOnlineExecutor } from '../../lib/storage-shrink.js';
import {
  classifySizeChange,
  isQuotaIneffectiveCapability,
  quotaIneffectiveResizeHint,
  shrinkNeverTooltip,
  validateShrinkFloor,
} from '../../lib/storage-shrink.js';
import { bytesToGiBInput, GIB } from './volume-form-fields.js';
import { api } from '../../lib/api.js';
import { errorMessage } from '../../lib/api-error.js';
import { queryKeys } from '../../lib/query-keys.js';
import { toast } from '../../hooks/use-toast.js';
import { isIntentAccepted, resourceIntentsPath, waitForResourceIntent } from '../../lib/intent-visibility.js';

export interface SharedVolumeFormProps {
  sharedVolume?: SharedVolumeDto;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** State and validation of the create / edit shared volume form. */
export function useSharedVolumeForm({ sharedVolume, open, onOpenChange }: SharedVolumeFormProps) {
  const editing = sharedVolume;
  const [name, setName] = useState(editing?.name ?? '');
  const [sizeGiB, setSizeGiB] = useState(editing ? bytesToGiBInput(editing.sizeBytes) : '10');
  const [sharedBackendId, setSharedBackendId] = useState(sharedVolume?.sharedBackendId ?? '');
  const [error, setError] = useState<string | null>(null);
  const data = useSharedVolumeData({
    open,
    sharedVolume,
    onSaved: () => onOpenChange(false),
    onError: setError,
  });
  const backends = data.backendsQuery.data ?? [];
  const selectedBackend = backends.find((backend) => backend.id === sharedBackendId);
  const liveSharedAccess = (data.accessQuery.data?.sharedBackends ?? [])
    .find((item) => item.sharedBackendId === sharedBackendId);
  const noOnlineExecutor = editing
    ? false
    : selectedBackend
      ? backendLacksOnlineExecutor(selectedBackend)
      : backends.length > 0 && backends.every((backend) => backendLacksOnlineExecutor(backend));
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
  const editQuotaBlocked = editing != null
    && path !== 'unchanged'
    && isQuotaIneffectiveCapability(editing.capability);
  const quotaError = editQuotaBlocked ? quotaIneffectiveResizeHint() : null;
  const description = !editing
    ? null
    : editQuotaBlocked
      ? quotaIneffectiveResizeHint()
      : path === 'never'
        ? shrinkNeverTooltip()
        : null;

  const submitEdit = (current: SharedVolumeDto) => {
    const blocked = editQuotaBlocked
      ? quotaIneffectiveResizeHint()
      : path === 'never'
        ? shrinkNeverTooltip()
        : floorError;
    if (blocked) {
      setError(blocked);
      return;
    }
    if (path === 'requires_stop') {
      setError('缩容需要先卸载全部挂载');
      return;
    }
    const parsed = zPatchVolumeRequest.safeParse({
      expectedRevision: current.revision,
      name: name.trim(),
      sizeBytes: nextSize,
    });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? '请检查共享卷参数');
      return;
    }
    data.patch.mutate(parsed.data);
  };

  const submit = () => {
    setError(null);
    if (!Number.isFinite(nextSize) || nextSize <= 0) {
      setError('请输入有效的容量（GiB）');
      return;
    }
    if (editing) {
      submitEdit(editing);
      return;
    }
    if (!sharedBackendId) {
      setError('请选择共享后端');
      return;
    }
    const parsed = zCreateSharedVolumeRequest.safeParse({
      name: name.trim(),
      sizeBytes: nextSize,
      scope: { kind: 'shared', sharedBackendId },
    });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? '请检查共享卷参数');
      return;
    }
    data.createShared.mutate(parsed.data);
  };

  return {
    editing,
    name,
    sizeGiB,
    sharedBackendId,
    error,
    setName,
    setSizeGiB,
    setSharedBackendId,
    backends,
    liveSharedAccess,
    noOnlineExecutor,
    nextSize,
    path,
    floorError,
    shrinkBlocked,
    quotaError,
    description,
    pending: data.createShared.isPending || data.patch.isPending,
    submit,
  };
}

export type SharedVolumeForm = ReturnType<typeof useSharedVolumeForm>;

/** The queries and mutations behind the shared volume form. */
export function useSharedVolumeData({
  open,
  sharedVolume,
  onSaved,
  onError,
}: {
  open: boolean;
  sharedVolume: SharedVolumeDto | undefined;
  onSaved: () => void;
  onError: (message: string) => void;
}) {
  const queryClient = useQueryClient();
  const editing = sharedVolume;
  const backendsQuery = useQuery({
    queryKey: queryKeys.sharedBackends.user,
    queryFn: () => api.get<SharedBackendDto[]>('/shared-backends'),
    enabled: open && !editing,
  });
  const accessQuery = useQuery({
    queryKey: queryKeys.meAccess,
    queryFn: () => api.get<EffectiveAccessDto>('/me/access'),
    enabled: open,
  });
  const createShared = useMutation({
    mutationFn: (body: CreateSharedVolumeRequest) => api.post<unknown>('/shared-volumes', body),
    onSuccess: () => {
      toast({ title: '已创建' });
      void queryClient.invalidateQueries({ queryKey: queryKeys.sharedVolumes.all });
      onSaved();
    },
    onError: (mutationError) => onError(errorMessage(mutationError)),
  });
  const patch = useMutation({
    mutationFn: async (body: PatchVolumeRequest) => {
      const volumeId = sharedVolume?.id ?? '';
      const accepted = await api.patch<IntentAcceptedDto | SharedVolumeDto>(
        `/shared-volumes/${volumeId}`,
        body,
      );
      if (isIntentAccepted(accepted)) {
        await waitForResourceIntent(
          resourceIntentsPath('mine', IntentResourceType.Volume, volumeId),
          accepted.intentId,
        );
      }
    },
    onSuccess: () => {
      toast({ title: '已保存' });
      void queryClient.invalidateQueries({ queryKey: queryKeys.sharedVolumes.all });
      void queryClient.invalidateQueries({ queryKey: ['resource-intent-failures'] });
      onSaved();
    },
    onError: (mutationError) => {
      onError(errorMessage(mutationError));
      void queryClient.invalidateQueries({ queryKey: queryKeys.sharedVolumes.all });
      void queryClient.invalidateQueries({ queryKey: ['resource-intent-failures'] });
    },
  });
  return { backendsQuery, accessQuery, createShared, patch };
}
