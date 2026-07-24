import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { AdminImageDto } from '@nyabase/common';

import { api, ApiError, apiErrorCurrent } from '../../lib/api.js';
import { queryKeys } from '../../lib/query-keys.js';
import { toast } from '../../hooks/use-toast.js';
import { Button } from '../ui/button.js';
import { Input } from '../ui/input.js';
import { Label } from '../ui/label.js';
import { Separator } from '../ui/separator.js';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '../ui/dialog.js';
import {
  minimalImageEditPayload,
  normalizeImageRuntimeOverridesForUi,
  parseImageFormPayload,
  type ImageFormPayloadInput,
} from '../../lib/image-form-payload.js';
import {
  createRevisionedServerBackedDraft,
  editRevisionedServerBackedDraft,
  mergeAuthoritativeRevisionedServerBackedDraft,
  mergeRevisionedServerBackedDraft,
  resolveRevisionedDraftConflicts,
  type RevisionedServerBackedDraft,
} from '../../lib/server-backed-draft.js';
import { isAdminImageDto } from '../../lib/conflict-snapshots.js';

type FormState = ImageFormPayloadInput;

const EMPTY_FORM: FormState = {
  name: '',
  dockerImage: '',
  uid: '0',
  entrypoint: '',
  cmd: '',
  init: false,
  disableSsh: false,
  description: '',
};

const PRESETS = [
  { label: 'Ubuntu 24.04', value: 'ubuntu:24.04' },
  { label: 'Ubuntu 22.04', value: 'ubuntu:22.04' },
  { label: 'Debian 12', value: 'debian:12' },
  { label: 'PyTorch (CUDA)', value: 'pytorch/pytorch:latest' },
  { label: 'NVIDIA CUDA', value: 'nvidia/cuda:12.4.0-base-ubuntu22.04' },
];

interface ImageFormDialogProps {
  mode: 'create' | 'edit';
  image?: AdminImageDto | null;
  serverImage?: AdminImageDto | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ImageFormDialog({ mode, image, serverImage, open, onOpenChange }: ImageFormDialogProps) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState<RevisionedServerBackedDraft<FormState>>(
    () => createRevisionedServerBackedDraft(EMPTY_FORM, 0),
  );

  useEffect(() => {
    if (mode === 'edit' && image) {
      setDraft(createRevisionedServerBackedDraft(formFromImage(image), image.revision));
    } else if (mode === 'create' && open) {
      setDraft(createRevisionedServerBackedDraft(EMPTY_FORM, 0));
    }
  }, [mode, image?.id, open]);

  useEffect(() => {
    if (mode !== 'edit' || !open || !serverImage || serverImage.id !== image?.id) return;
    setDraft((current) => mergeRevisionedServerBackedDraft(
      current,
      formFromImage(serverImage),
      serverImage.revision,
    ));
  }, [mode, open, image?.id, serverImage?.id, serverImage?.revision]);

  const form = draft.values;
  const setField = <K extends keyof FormState>(field: K, value: FormState[K]) => {
    setDraft((current) => editRevisionedServerBackedDraft(current, field, value));
  };

  const { mutate, isPending } = useMutation({
    mutationFn: () => {
      const parsed = mode === 'create'
        ? parseImageFormPayload('create', form)
        : parseImageFormPayload('edit', form);
      if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? '镜像参数无效');
      if (mode === 'create') return api.post('/admin/images', parsed.data);
      const payload = minimalImageEditPayload(parsed.data, draft.dirtyFields);
      if (Object.keys(payload).length === 0) throw new Error('没有需要保存的镜像字段');
      return api.patch(`/admin/images/${image!.id}`, {
        ...payload,
        expectedRevision: draft.revision,
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.images.admin });
      toast({ title: mode === 'create' ? '镜像已添加' : '镜像已更新' });
      onOpenChange(false);
    },
    onError: async (e) => {
      if (e instanceof ApiError && e.code === 'IMAGE_REVISION_CONFLICT') {
        const current = apiErrorCurrent(e, 'IMAGE_REVISION_CONFLICT', isAdminImageDto);
        if (current) {
          qc.setQueryData<AdminImageDto[]>(queryKeys.images.admin, (images) => images?.map(
            (candidate) => candidate.id === current.id ? current : candidate,
          ));
          setDraft((draftState) => mergeAuthoritativeRevisionedServerBackedDraft(
            draftState,
            formFromImage(current),
            current.revision,
          ));
        } else {
          await qc.refetchQueries({ queryKey: queryKeys.images.admin, type: 'active' });
        }
      }
      toast({
        title: e instanceof ApiError && e.code === 'IMAGE_REVISION_CONFLICT'
          ? '服务器镜像已变化'
          : mode === 'create' ? '添加失败' : '更新失败',
        description: (e as Error).message,
        variant: 'destructive',
      });
    },
  });

  if (mode === 'edit' && !image) return null;

  const isCreate = mode === 'create';
  const parsedForm = isCreate
    ? parseImageFormPayload('create', form)
    : parseImageFormPayload('edit', form);
  const submittable = parsedForm.success;
  const hasChanges = mode === 'create' || draft.dirtyFields.size > 0;
  const hasConflicts = draft.conflictFields.size > 0;
  const serverChanged = mode === 'edit' && Boolean(
    image?.revision && serverImage?.revision && image.revision !== serverImage.revision,
  );
  const uidError = parsedForm.success
    ? null
    : parsedForm.error.issues.find((issue) => issue.path.join('.') === 'runtimeOverrides.uid')?.message;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-md overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isCreate ? '添加镜像' : '编辑镜像'}</DialogTitle>
          <DialogDescription>
            {isCreate
              ? '添加后可在各服务器上 pull，容器创建时选择该镜像。'
              : '镜像地址不可修改，其他参数均可更新。'}
          </DialogDescription>
        </DialogHeader>

        {serverChanged && (
          <div className="space-y-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
            <p>
              服务器上的镜像已更新。未修改字段已同步，本地修改已保留
              {hasConflicts ? `；${draft.conflictFields.size} 个字段发生冲突。` : '。'}
            </p>
            {hasConflicts && (
              <div className="flex gap-2">
                <Button size="sm" variant="outline" onClick={() => setDraft(resolveRevisionedDraftConflicts(draft, 'use-server'))}>
                  使用服务器值
                </Button>
                <Button size="sm" onClick={() => setDraft(resolveRevisionedDraftConflicts(draft, 'keep-local'))}>
                  保留本地并覆盖
                </Button>
              </div>
            )}
          </div>
        )}

        <div className="space-y-4">
          {isCreate ? (
            <PresetPicker
              onPick={(value, label) =>
                setDraft((current) => {
                  const withImage = editRevisionedServerBackedDraft(current, 'dockerImage', value);
                  return current.values.name
                    ? withImage
                    : editRevisionedServerBackedDraft(withImage, 'name', label);
                })
              }
            />
          ) : (
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">镜像地址（只读）</Label>
              <div className="px-3 py-2 rounded-md border bg-muted font-mono text-sm text-muted-foreground">
                {form.dockerImage}
              </div>
            </div>
          )}

          <Separator />

          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="image-name">名称 <span className="text-destructive">*</span></Label>
              <Input
                id="image-name"
                placeholder="Ubuntu 22.04 Dev"
                value={form.name}
                onChange={(e) => setField('name', e.target.value)}
              />
            </div>

            {isCreate && (
              <div className="space-y-1.5">
                <Label htmlFor="image-docker">Docker 镜像 <span className="text-destructive">*</span></Label>
                <Input
                  id="image-docker"
                  placeholder="ubuntu:22.04"
                  value={form.dockerImage}
                  onChange={(e) => setField('dockerImage', e.target.value)}
                  className="font-mono text-sm"
                />
              </div>
            )}

            <div className="space-y-3 rounded-md border border-border p-3">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="image-uid">UID 覆盖</Label>
                  <Input
                    id="image-uid"
                    type="number" min="0" max="4294967294" step="1"
                    value={form.uid}
                    onChange={(e) => setField('uid', e.target.value)}
                    placeholder="0"
                    aria-invalid={Boolean(uidError)}
                  />
                  {uidError && <p className="text-xs text-destructive">UID 必须是 0 到 4294967294 的十进制整数</p>}
                </div>
                <label className="flex items-center gap-2 pt-6 text-sm">
                  <input
                    type="checkbox"
                    checked={form.init}
                    onChange={(e) => setField('init', e.target.checked)}
                    className="h-4 w-4 rounded border-input"
                  />
                  启用 init
                </label>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="image-entrypoint">入口命令覆盖</Label>
                <textarea
                  id="image-entrypoint"
                  value={form.entrypoint}
                  onChange={(e) => setField('entrypoint', e.target.value)}
                  placeholder="/usr/local/bin/start.sh"
                  rows={2}
                  className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="image-cmd">默认命令覆盖</Label>
                <textarea
                  id="image-cmd"
                  value={form.cmd}
                  onChange={(e) => setField('cmd', e.target.value)}
                  placeholder={'sleep\ninfinity'}
                  rows={2}
                  className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="image-desc">描述（可选）</Label>
              <Input
                id="image-desc"
                value={form.description}
                onChange={(e) => setField('description', e.target.value)}
                placeholder="用于深度学习开发..."
              />
            </div>

            <label className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2.5">
              <span className="min-w-0">
                <span className="block text-sm font-medium text-foreground">禁用 SSH</span>
                <span className="block text-xs text-muted-foreground">下次同步或生命周期操作时移除容器 SSH 运行时</span>
              </span>
              <input
                type="checkbox"
                checked={form.disableSsh}
                onChange={(e) => setField('disableSsh', e.target.checked)}
                className="h-4 w-4 shrink-0 accent-primary"
              />
            </label>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
          <Button onClick={() => mutate()} disabled={isPending || !submittable || !hasChanges || hasConflicts}>
            {isPending
              ? (isCreate ? '添加中...' : '保存中...')
              : (isCreate ? '添加' : '保存')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function linesFromArgs(value: string[] | null | undefined): string {
  return value?.join('\n') ?? '';
}

function formFromImage(image: AdminImageDto): FormState {
  const runtimeOverrides = normalizeImageRuntimeOverridesForUi(image.runtimeOverrides);
  return {
    name: image.name,
    dockerImage: image.dockerImage,
    uid: String(runtimeOverrides.uid),
    entrypoint: linesFromArgs(runtimeOverrides.entrypoint),
    cmd: linesFromArgs(runtimeOverrides.cmd),
    init: runtimeOverrides.init,
    disableSsh: image.disableSsh ?? false,
    description: image.description ?? '',
  };
}

function PresetPicker({ onPick }: { onPick: (value: string, label: string) => void }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs text-muted-foreground">快速选择</Label>
      <div className="flex flex-wrap gap-1.5">
        {PRESETS.map((p) => (
          <button
            key={p.value}
            type="button"
            onClick={() => onPick(p.value, p.label)}
            className="text-xs px-2.5 py-1 rounded-md border border-input bg-background hover:bg-accent hover:text-accent-foreground transition-colors"
          >
            {p.label}
          </button>
        ))}
      </div>
    </div>
  );
}
