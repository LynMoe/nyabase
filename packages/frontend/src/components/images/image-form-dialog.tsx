import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  zCreateImageRequest,
  zPatchImageRequest,
  type AdminImageDto,
  type CreateImageRequest,
  type PatchImageRequest,
} from '@nyabase/common';
import { api } from '../../lib/api.js';
import { Button } from '../ui/button.js';
import { Checkbox } from '../ui/checkbox.js';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog.js';
import { Input } from '../ui/input.js';
import { FormField } from '../layout/form-field.js';
import { toast } from '../../hooks/use-toast.js';
import { queryKeys } from '../../lib/query-keys.js';
import { formatGibInput, gibToBytes } from '../../lib/utils.js';

type ImageForm = {
  name: string;
  alias: string;
  description: string;
  loginUser: string;
  minRootSizeGib: string;
  networkManagedExternally: boolean;
};

const emptyForm: ImageForm = {
  name: '',
  alias: '',
  description: '',
  loginUser: 'root',
  minRootSizeGib: '',
  networkManagedExternally: true,
};

export function ImageFormDialog({
  mode,
  image,
  open,
  onOpenChange,
}: {
  mode: 'create' | 'edit';
  image?: AdminImageDto;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState<ImageForm>(emptyForm);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setForm(image ? {
      name: image.name,
      alias: image.alias,
      description: image.description ?? '',
      loginUser: image.loginUser,
      minRootSizeGib: image.minRootSizeBytes === null ? '' : formatGibInput(image.minRootSizeBytes),
      networkManagedExternally: image.networkManagedExternally,
    } : emptyForm);
    setError(null);
  }, [image, open]);

  const mutation = useMutation({
    mutationFn: (body: CreateImageRequest | PatchImageRequest) => mode === 'create'
      ? api.post<AdminImageDto>('/admin/images', body)
      : api.patch<AdminImageDto>(`/admin/images/${image?.id ?? ''}`, body),
    onSuccess: () => {
      toast({ title: mode === 'create' ? '镜像已创建' : '镜像已更新' });
      void queryClient.invalidateQueries({ queryKey: queryKeys.images.admin });
      onOpenChange(false);
    },
    onError: (mutationError) => setError(mutationError instanceof Error ? mutationError.message : '镜像保存失败'),
  });

  const update = <K extends keyof ImageForm>(key: K, value: ImageForm[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
    setError(null);
  };

  const submit = () => {
    const parsedGiB = form.minRootSizeGib.trim() ? Number(form.minRootSizeGib) : null;
    if (parsedGiB !== null && (!Number.isFinite(parsedGiB) || parsedGiB <= 0)) {
      setError('请输入有效的最小系统盘容量（GiB）');
      return;
    }
    const common = {
      name: form.name,
      alias: form.alias,
      description: form.description || null,
      loginUser: form.loginUser,
      minRootSizeBytes: parsedGiB === null ? null : gibToBytes(parsedGiB),
      networkManagedExternally: form.networkManagedExternally,
    };
    if (mode === 'create') {
      const parsed = zCreateImageRequest.safeParse(common);
      if (!parsed.success) {
        setError(parsed.error.issues[0]?.message ?? '请检查镜像参数');
        return;
      }
      mutation.mutate(parsed.data);
      return;
    }
    const parsed = zPatchImageRequest.safeParse({ expectedRevision: image?.revision ?? 0, ...common });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? '请检查镜像参数');
      return;
    }
    mutation.mutate(parsed.data);
  };

  const field = (key: keyof ImageForm, label: string, placeholder: string) => (
    <FormField id={`image-${key}`} label={label}>
      <Input
        id={`image-${key}`}
        value={typeof form[key] === 'boolean' ? '' : String(form[key])}
        placeholder={placeholder}
        onChange={(event) => update(key, event.target.value as ImageForm[typeof key])}
      />
    </FormField>
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="incus-image-form">
        <DialogHeader>
          <DialogTitle>{mode === 'create' ? '添加镜像' : '编辑镜像'}</DialogTitle>
          <DialogDescription>镜像按指纹分配到各服务器；不配置旧的运行时覆盖字段。</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            {field('name', '名称', 'Ubuntu 24.04')}
            {field('alias', '别名', 'ubuntu-24.04')}
            {field('loginUser', '登录用户', 'ubuntu')}
            <FormField id="image-minRootSizeGib" label="最小系统盘容量（GiB）">
              <Input
                id="image-minRootSizeGib"
                type="number"
                min="0.001"
                step="any"
                value={form.minRootSizeGib}
                placeholder="20"
                onChange={(event) => update('minRootSizeGib', event.target.value)}
              />
            </FormField>
          </div>
          {field('description', '描述', '可选描述')}
          <FormField id="image-networkManagedExternally" label="网络由平台管理" orientation="inline">
            <Checkbox
              id="image-networkManagedExternally"
              checked={form.networkManagedExternally}
              onCheckedChange={(checked) => update('networkManagedExternally', checked === true)}
            />
          </FormField>
          <p className="text-xs text-muted-foreground">由平台写入容器 IP；取消勾选的镜像不能用于创建容器</p>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
          <Button onClick={submit} disabled={mutation.isPending}>{mutation.isPending ? '保存中...' : '保存'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
