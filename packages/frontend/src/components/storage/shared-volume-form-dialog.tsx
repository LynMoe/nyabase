import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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
import { Button } from '../ui/button.js';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog.js';
import { Input } from '../ui/input.js';
import { FormField, SelectField } from '../layout/form-field.js';
import { toast } from '../../hooks/use-toast.js';
import { api } from '../../lib/api.js';
import { errorMessage } from '../../lib/api-error.js';
import { formatGrantBytes, formatRemainingBytes } from '../../lib/grant-quota.js';
import { isIntentAccepted, resourceIntentsPath, waitForResourceIntent } from '../../lib/intent-visibility.js';
import { queryKeys } from '../../lib/query-keys.js';
import {
  backendLacksOnlineExecutor,
  deriveSizeChange,
  quotaIneffectiveResizeHint,
  shrinkNeverTooltip,
} from '../../lib/storage-shrink.js';
import { useOpenSession } from '../../hooks/use-dom-state.js';
import { approxGibHint, formatGibInput } from '../../lib/utils.js';

export interface SharedVolumeFormProps {
  sharedVolume?: SharedVolumeDto;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const NO_ONLINE_EXECUTOR_HINT = '现在还不能挂载或销毁已有目录';

export function SharedVolumeFormDialog(props: SharedVolumeFormProps) {
  return <SharedVolumeFormBody key={useOpenSession(props.open)} {...props} />;
}

function useSharedVolumeSave(
  editing: SharedVolumeDto | undefined,
  onOpenChange: (open: boolean) => void,
  setError: (message: string) => void,
) {
  const queryClient = useQueryClient();
  const refreshLists = () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.sharedVolumes.all });
  };
  const createShared = useMutation({
    mutationFn: (body: CreateSharedVolumeRequest) => api.post<unknown>('/shared-volumes', body),
    onSuccess: () => {
      toast({ title: '已创建' });
      refreshLists();
      onOpenChange(false);
    },
    onError: (mutationError) => setError(errorMessage(mutationError)),
  });
  const patch = useMutation({
    mutationFn: async (body: PatchVolumeRequest) => {
      const volumeId = editing?.id ?? '';
      const accepted = await api.patch<IntentAcceptedDto | SharedVolumeDto>(`/shared-volumes/${volumeId}`, body);
      if (isIntentAccepted(accepted)) {
        await waitForResourceIntent(
          resourceIntentsPath('mine', IntentResourceType.Volume, volumeId),
          accepted.intentId,
        );
      }
    },
    onSuccess: () => {
      toast({ title: '已保存' });
      refreshLists();
      void queryClient.invalidateQueries({ queryKey: ['resource-intent-failures'] });
      onOpenChange(false);
    },
    onError: (mutationError) => {
      setError(errorMessage(mutationError));
      refreshLists();
      void queryClient.invalidateQueries({ queryKey: ['resource-intent-failures'] });
    },
  });
  return { createShared, patch };
}

function SharedVolumeFormBody({ sharedVolume: editing, open, onOpenChange }: SharedVolumeFormProps) {
  const [name, setName] = useState(editing?.name ?? '');
  const [sizeGiB, setSizeGiB] = useState(editing ? formatGibInput(editing.sizeBytes) : '10');
  const [sharedBackendId, setSharedBackendId] = useState(editing?.sharedBackendId ?? '');
  const [error, setError] = useState<string | null>(null);

  const backends = useQuery({
    queryKey: queryKeys.sharedBackends.user,
    queryFn: () => api.get<SharedBackendDto[]>('/shared-backends'),
    enabled: open && !editing,
  }).data ?? [];
  const access = useQuery({
    queryKey: queryKeys.meAccess,
    queryFn: () => api.get<EffectiveAccessDto>('/me/access'),
    enabled: open,
  }).data;
  const selectedBackend = backends.find((backend) => backend.id === sharedBackendId);
  const liveSharedAccess = (access?.sharedBackends ?? []).find((item) => item.sharedBackendId === sharedBackendId);
  const noOnlineExecutor = editing
    ? false
    : selectedBackend
      ? backendLacksOnlineExecutor(selectedBackend)
      : backends.length > 0 && backends.every((backend) => backendLacksOnlineExecutor(backend));
  const { nextSize, path, floorError, editQuotaBlocked } = deriveSizeChange(editing, sizeGiB);
  const shrinkBlocked = path === 'never';
  const quotaError = editQuotaBlocked ? quotaIneffectiveResizeHint() : null;
  const description = !editing ? null : editQuotaBlocked ? quotaError : shrinkBlocked ? shrinkNeverTooltip() : null;

  const { createShared, patch } = useSharedVolumeSave(editing, onOpenChange, setError);
  const pending = createShared.isPending || patch.isPending;

  const submit = () => {
    setError(null);
    const fail = (message: string) => setError(message);
    if (!Number.isFinite(nextSize) || nextSize <= 0) return fail('请输入有效的容量（GiB）');
    if (editing) {
      if (editQuotaBlocked) return fail(quotaIneffectiveResizeHint());
      if (shrinkBlocked) return fail(shrinkNeverTooltip());
      if (floorError) return fail(floorError);
      if (path === 'requires_stop') return fail('缩容需要先卸载全部挂载');
      const parsed = zPatchVolumeRequest.safeParse({
        expectedRevision: editing.revision,
        name: name.trim(),
        sizeBytes: nextSize,
      });
      if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? '请检查共享卷参数');
      return patch.mutate(parsed.data);
    }
    if (!sharedBackendId) return fail('请选择共享后端');
    const parsed = zCreateSharedVolumeRequest.safeParse({
      name: name.trim(),
      sizeBytes: nextSize,
      scope: { kind: 'shared', sharedBackendId },
    });
    if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? '请检查共享卷参数');
    createShared.mutate(parsed.data);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="shared-volume-form">
        <DialogHeader>
          <DialogTitle>{editing ? '编辑共享卷' : '新建共享卷'}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
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
              {Number.isFinite(nextSize) && nextSize > 0 ? approxGibHint(nextSize) : '请输入正数 GiB'}
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
              options={backends.map((backend): [string, string] => [backend.id, backend.displayName ?? backend.name])}
            />
          )}
          {liveSharedAccess && (
            <p className="text-xs text-muted-foreground">
              剩余 {formatRemainingBytes(liveSharedAccess.limitBytes, liveSharedAccess.usedBytes)}
              {' / '}
              额度 {formatGrantBytes(liveSharedAccess.limitBytes)}
            </p>
          )}
          {noOnlineExecutor && (
            <p className="text-xs text-muted-foreground" data-testid="shared-volume-no-executor">
              {NO_ONLINE_EXECUTOR_HINT}
            </p>
          )}
          {(error || floorError || quotaError) && (
            <p className="text-sm text-destructive">{error ?? floorError ?? quotaError}</p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
          <Button
            onClick={submit}
            disabled={pending || Boolean(floorError) || Boolean(quotaError) || shrinkBlocked}
            title={quotaError ?? (shrinkBlocked ? shrinkNeverTooltip() : undefined)}
          >
            {pending ? '提交中...' : '保存'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
