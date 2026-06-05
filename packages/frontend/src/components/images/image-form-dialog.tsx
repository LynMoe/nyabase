import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ImageDto } from '@nyabase/common';

import { api } from '../../lib/api.js';
import { queryKeys } from '../../lib/query-keys.js';
import { toast } from '../../hooks/use-toast.js';
import { Button } from '../ui/button.js';
import { Input } from '../ui/input.js';
import { Label } from '../ui/label.js';
import { Separator } from '../ui/separator.js';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '../ui/dialog.js';

interface FormState {
  name: string;
  dockerImage: string;
  uid: string;
  entrypoint: string;
  cmd: string;
  init: boolean;
  description: string;
}

const EMPTY_FORM: FormState = {
  name: '',
  dockerImage: '',
  uid: '0',
  entrypoint: '',
  cmd: '',
  init: false,
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
  image?: ImageDto | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ImageFormDialog({ mode, image, open, onOpenChange }: ImageFormDialogProps) {
  const qc = useQueryClient();
  const [form, setForm] = useState<FormState>(EMPTY_FORM);

  useEffect(() => {
    if (mode === 'edit' && image) {
      setForm({
        name: image.name,
        dockerImage: image.dockerImage,
        uid: String(image.runtimeOverrides?.uid ?? image.defaultUid),
        entrypoint: linesFromArgs(image.runtimeOverrides?.entrypoint),
        cmd: linesFromArgs(image.runtimeOverrides?.cmd),
        init: image.runtimeOverrides?.init ?? false,
        description: image.description ?? '',
      });
    } else if (mode === 'create' && open) {
      setForm(EMPTY_FORM);
    }
  }, [mode, image, open]);

  const { mutate, isPending } = useMutation({
    mutationFn: () => {
      const runtimeOverrides = {
        uid: parseInt(form.uid, 10),
        entrypoint: argsFromLines(form.entrypoint),
        cmd: argsFromLines(form.cmd),
        init: form.init,
      };
      if (mode === 'create') {
        return api.post('/admin/images', {
          name: form.name,
          dockerImage: form.dockerImage,
          runtimeOverrides,
          description: form.description.trim() || undefined,
        });
      }
      return api.patch(`/admin/images/${image!.id}`, {
        name: form.name,
        runtimeOverrides,
        description: form.description.trim() || undefined,
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.images.admin });
      toast({ title: mode === 'create' ? '镜像已添加' : '镜像已更新' });
      onOpenChange(false);
    },
    onError: (e) =>
      toast({
        title: mode === 'create' ? '添加失败' : '更新失败',
        description: (e as Error).message,
        variant: 'destructive',
      }),
  });

  if (mode === 'edit' && !image) return null;

  const isCreate = mode === 'create';
  const uid = Number(form.uid);
  const submittable = !!form.name && (!isCreate || !!form.dockerImage) && Number.isInteger(uid) && uid >= 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{isCreate ? '添加镜像' : '编辑镜像'}</DialogTitle>
          <DialogDescription>
            {isCreate
              ? '添加后可在各服务器上 pull，容器创建时选择该镜像。'
              : '镜像地址不可修改，其他参数均可更新。'}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {isCreate ? (
            <PresetPicker
              onPick={(value, label) =>
                setForm((f) => ({ ...f, dockerImage: value, name: f.name || label }))
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
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              />
            </div>

            {isCreate && (
              <div className="space-y-1.5">
                <Label htmlFor="image-docker">Docker 镜像 <span className="text-destructive">*</span></Label>
                <Input
                  id="image-docker"
                  placeholder="ubuntu:22.04"
                  value={form.dockerImage}
                  onChange={(e) => setForm((f) => ({ ...f, dockerImage: e.target.value }))}
                  className="font-mono text-sm"
                />
              </div>
            )}

            <div className="space-y-3 rounded-md border border-border p-3">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="image-uid">UID override</Label>
                  <Input
                    id="image-uid"
                    type="number" min="0"
                    value={form.uid}
                    onChange={(e) => setForm((f) => ({ ...f, uid: e.target.value }))}
                    placeholder="0"
                  />
                </div>
                <label className="flex items-center gap-2 pt-6 text-sm">
                  <input
                    type="checkbox"
                    checked={form.init}
                    onChange={(e) => setForm((f) => ({ ...f, init: e.target.checked }))}
                    className="h-4 w-4 rounded border-input"
                  />
                  Init mode
                </label>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="image-entrypoint">Entrypoint override</Label>
                <textarea
                  id="image-entrypoint"
                  value={form.entrypoint}
                  onChange={(e) => setForm((f) => ({ ...f, entrypoint: e.target.value }))}
                  placeholder="/usr/local/bin/start.sh"
                  rows={2}
                  className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="image-cmd">CMD override</Label>
                <textarea
                  id="image-cmd"
                  value={form.cmd}
                  onChange={(e) => setForm((f) => ({ ...f, cmd: e.target.value }))}
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
                onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                placeholder="用于深度学习开发..."
              />
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
          <Button onClick={() => mutate()} disabled={isPending || !submittable}>
            {isPending
              ? (isCreate ? '添加中...' : '保存中...')
              : (isCreate ? '添加' : '保存')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function argsFromLines(value: string): string[] | null {
  const args = value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  return args.length > 0 ? args : null;
}

function linesFromArgs(value: string[] | null | undefined): string {
  return value?.join('\n') ?? '';
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
