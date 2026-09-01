import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  zCreateSharedVolumeRequest,
  zPatchVolumeRequest,
  type CreateSharedVolumeRequest,
  type PatchVolumeRequest,
  type SharedBackendDto,
  type SharedVolumeDto,
} from '@nyabase/common';
import { api } from '../../lib/api.js';
import { errorMessage } from '../../lib/api-error.js';
import { Button } from '../ui/button.js';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog.js';
import { Input } from '../ui/input.js';
import { FormField } from '../layout/form-field.js';
import { bytesToGiBInput, GIB, SelectField } from './volume-form-fields.js';
import { approxGibHint } from '../../lib/utils.js';
import { queryKeys } from '../../lib/query-keys.js';
import { backendLacksOnlineExecutor } from '../../lib/shared-backend-executor.js';
import { toast } from '../../hooks/use-toast.js';
import {
  classifySizeChange,
  isQuotaIneffectiveCapability,
  quotaIneffectiveResizeHint,
  shrinkNeverTooltip,
  validateShrinkFloor,
} from '../../lib/storage-shrink.js';

const NO_ONLINE_EXECUTOR_HINT = '现在还不能挂载或销毁已有目录';

export function SharedVolumeFormDialog({
  sharedVolume,
  open,
  onOpenChange,
}: {
  sharedVolume?: SharedVolumeDto;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const editing = sharedVolume;
  const [name, setName] = useState(editing?.name ?? '');
  const [sizeGiB, setSizeGiB] = useState(editing ? bytesToGiBInput(editing.sizeBytes) : '10');
  const [sharedBackendId, setSharedBackendId] = useState(sharedVolume?.sharedBackendId ?? '');
  const [error, setError] = useState<string | null>(null);
  const backendsQuery = useQuery({
    queryKey: queryKeys.sharedBackends.user,
    queryFn: () => api.get<SharedBackendDto[]>('/shared-backends'),
    enabled: open && !editing,
  });
  const createShared = useMutation({
    mutationFn: (body: CreateSharedVolumeRequest) => api.post<unknown>('/shared-volumes', body),
    onSuccess: () => {
      toast({ title: '已创建' });
      void queryClient.invalidateQueries({ queryKey: queryKeys.sharedVolumes.all });
      onOpenChange(false);
    },
    onError: (mutationError) => setError(errorMessage(mutationError)),
  });
  const patch = useMutation({
    mutationFn: (body: PatchVolumeRequest) => api.patch<unknown>(
      `/shared-volumes/${sharedVolume?.id ?? ''}`,
      body,
    ),
    onSuccess: () => {
      toast({ title: '已保存' });
      void queryClient.invalidateQueries({ queryKey: queryKeys.sharedVolumes.all });
      onOpenChange(false);
    },
    onError: (mutationError) => setError(errorMessage(mutationError)),
  });
  const backends = backendsQuery.data ?? [];
  const selectedBackend = backends.find((backend) => backend.id === sharedBackendId);
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
  const pending = createShared.isPending || patch.isPending;

  const submit = () => {
    setError(null);
    if (!Number.isFinite(nextSize) || nextSize <= 0) {
      setError('请输入有效的容量（G）');
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
        setError('缩容需要先卸载全部挂载');
        return;
      }
      const parsed = zPatchVolumeRequest.safeParse({
        expectedRevision: editing.generation,
        name: name.trim(),
        sizeBytes: nextSize,
      });
      if (!parsed.success) {
        setError(parsed.error.issues[0]?.message ?? '请检查共享卷参数');
        return;
      }
      patch.mutate(parsed.data);
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
    createShared.mutate(parsed.data);
  };

  const description = !editing
    ? '选择共享后端并预订容量。创建后即可挂载到能看见该后端的容器。'
    : editQuotaBlocked
      ? quotaIneffectiveResizeHint()
      : path === 'never'
        ? shrinkNeverTooltip()
        : path === 'requires_stop'
          ? '缩容需要先卸载全部挂载。'
          : path === 'online'
            ? '在线缩容：仅校验目标容量不小于已用量。'
            : '扩容在线执行；同名或同容量保存会直接更新。';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="shared-volume-form">
        <DialogHeader>
          <DialogTitle>{editing ? '编辑共享卷' : '新建共享卷'}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <FormField id="shared-volume-name" label="名称">
            <Input id="shared-volume-name" value={name} onChange={(event) => setName(event.target.value)} />
          </FormField>
          <FormField id="shared-volume-size" label="大小（GiB）">
            <Input
              id="shared-volume-size"
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
            <SelectField
              id="volume-shared-backend"
              label="共享后端"
              value={sharedBackendId}
              onChange={setSharedBackendId}
              options={backends.map((backend) => [backend.id, backend.displayName ?? backend.name])}
            />
          )}
          {noOnlineExecutor && (
            <p className="text-xs text-muted-foreground" data-testid="shared-volume-no-executor">
              {NO_ONLINE_EXECUTOR_HINT}
            </p>
          )}
          {(error || floorError || quotaError) && (
            <p className="text-sm text-destructive">
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
            {pending ? '提交中...' : '保存'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
