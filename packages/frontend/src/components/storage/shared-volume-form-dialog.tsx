import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  type CreateSharedVolumeRequest,
  type EffectiveAccessDto,
  type EffectiveSharedBackendAccessDto,
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
import { approxGibHint, formatGibInput, sharedBackendAvailableBytes } from '../../lib/utils.js';
import { defaultResourceName } from '../../lib/default-names.js';
import { SizeField } from '../ui/size-slider.js';
import {
  QuotaLine,
  type QuotaLineQuota,
  overQuotaMessage,
  quotaFrom,
  quotaSliderLimits,
} from '../quota/quota-line.js';

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

/**
 * The prefilled name of a new shared volume: `vol-yymmdd`, skipping names the
 * user's shared volumes already use (ignoring case). Typing replaces it.
 */
function useDefaultSharedVolumeName(enabled: boolean, initial: string) {
  const [typed, setTyped] = useState<string | null>(null);
  const volumes = useQuery({
    queryKey: queryKeys.sharedVolumes.user,
    queryFn: () => api.get<SharedVolumeDto[]>('/shared-volumes'),
    enabled,
  }).data;
  const defaultName = useMemo(() => defaultResourceName('vol', (volumes ?? []).map((volume) => volume.name)), [volumes]);
  return { name: typed ?? (enabled ? defaultName : initial), setName: setTyped };
}

/** The user's quota on the chosen backend, for the create form's quota line. */
function sharedQuota(
  failed: boolean,
  access: EffectiveAccessDto | undefined,
  backendAccess: EffectiveSharedBackendAccessDto | undefined,
): QuotaLineQuota {
  if (failed) return { kind: 'unknown' };
  if (!access) return { kind: 'loading' };
  if (!backendAccess) return { kind: 'unknown' };
  return quotaFrom(backendAccess.limitBytes, (backendAccess.limitBytes ?? 0) - backendAccess.usedBytes);
}

/** The size input of an existing shared volume, with why it cannot shrink and the quota left. */
function EditSizeField({
  sizeBytes,
  sizeGiB,
  onSizeChange,
  nextSize,
  shrinkBlocked,
  access,
}: {
  sizeBytes: number;
  sizeGiB: string;
  onSizeChange: (value: string) => void;
  nextSize: number;
  shrinkBlocked: boolean;
  access: EffectiveSharedBackendAccessDto | undefined;
}) {
  return (
    <FormField id="shared-volume-size" label="大小（GiB）">
      <Input
        id="shared-volume-size"
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
      {shrinkBlocked && (
        <p className="text-xs text-muted-foreground" title={shrinkNeverTooltip()}>
          {shrinkNeverTooltip()}
        </p>
      )}
      {access && (
        <p className="text-xs text-muted-foreground">
          剩余 {formatRemainingBytes(access.limitBytes, access.usedBytes)}
          {' / '}
          额度 {formatGrantBytes(access.limitBytes)}
        </p>
      )}
    </FormField>
  );
}

function SharedVolumeFormBody({ sharedVolume: editing, open, onOpenChange }: SharedVolumeFormProps) {
  const { name, setName } = useDefaultSharedVolumeName(open && !editing, editing?.name ?? '');
  const [sizeGiB, setSizeGiB] = useState(editing ? formatGibInput(editing.sizeBytes) : '10');
  const [sharedBackendId, setSharedBackendId] = useState(editing?.sharedBackendId ?? '');
  const [error, setError] = useState<string | null>(null);

  const backendsQuery = useQuery({
    queryKey: queryKeys.sharedBackends.user,
    queryFn: () => api.get<SharedBackendDto[]>('/shared-backends'),
    enabled: open && !editing,
  });
  const backends = backendsQuery.data ?? [];
  const accessQuery = useQuery({
    queryKey: queryKeys.meAccess,
    queryFn: () => api.get<EffectiveAccessDto>('/me/access'),
    enabled: open,
  });
  const access = accessQuery.data;
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
  const createQuota = sharedQuota(accessQuery.isError, access, liveSharedAccess);
  const createLimits = quotaSliderLimits(
    'volume',
    createQuota,
    selectedBackend ? sharedBackendAvailableBytes(selectedBackend) : null,
    Number.isFinite(nextSize) && nextSize > 0 ? nextSize : null,
  );
  const createOver = !editing && createLimits.over;

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
    if (createOver) return fail(overQuotaMessage(createQuota));
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
          {!editing && (
            <SelectField
              id="volume-shared-backend"
              label="共享后端"
              value={sharedBackendId}
              onChange={setSharedBackendId}
              options={backends.map((backend): [string, string] => [backend.id, backend.displayName ?? backend.name])}
              placeholder="选择共享后端"
              loading={backendsQuery.isLoading}
              emptyText="没有可用的共享后端"
              emptyHint="你还没有任何共享后端的授权，请联系管理员。"
            />
          )}
          {editing ? (
            <EditSizeField
              sizeBytes={editing.sizeBytes}
              sizeGiB={sizeGiB}
              onSizeChange={setSizeGiB}
              nextSize={nextSize}
              shrinkBlocked={shrinkBlocked}
              access={liveSharedAccess}
            />
          ) : (
            <SizeField
              id="shared-volume-size"
              label="大小"
              value={sizeGiB}
              onChange={setSizeGiB}
              scale={createLimits.scale}
              availableGib={createLimits.availableGib}
              invalid={createOver}
              error={createOver ? overQuotaMessage(createQuota) : undefined}
            >
              {sharedBackendId ? (
                <QuotaLine quota={createQuota} over={createOver} testId="shared-volume-create-remaining" />
              ) : null}
            </SizeField>
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
            disabled={pending || Boolean(floorError) || Boolean(quotaError) || shrinkBlocked || createOver}
            title={quotaError ?? (shrinkBlocked ? shrinkNeverTooltip() : undefined)}
          >
            {pending ? '提交中...' : '保存'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
