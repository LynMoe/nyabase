import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  zCreateIpPoolRequest,
  zPatchIpPoolRequest,
  type CreateIpPoolRequest,
  type IpPoolDto,
  type PatchIpPoolRequest,
  type ServerDto,
} from '@nyabase/common';
import { api } from '../../lib/api.js';
import { errorMessage } from '../../lib/api-error.js';
import { Button } from '../../components/ui/button.js';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../components/ui/dialog.js';
import { Checkbox } from '../../components/ui/checkbox.js';
import { Input } from '../../components/ui/input.js';
import { FormField } from '../../components/layout/form-field.js';
import { toast } from '../../hooks/use-toast.js';
import { queryKeys } from '../../lib/query-keys.js';

function splitList(value: string): string[] {
  return value.split(/[\s,]+/).map((item) => item.trim()).filter(Boolean);
}

interface EditorArgs {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: 'create' | 'edit';
  pool?: IpPoolDto | null;
}

function useIpPoolEditor({ open, onOpenChange, mode, pool }: EditorArgs) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState({
    name: '',
    cidr: '',
    allocationCidr: '',
    gateway: '',
    reservedIps: '',
    serverIds: [] as string[],
  });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    if (mode === 'edit' && pool) {
      setForm({
        name: pool.name,
        cidr: pool.cidr,
        allocationCidr: pool.allocationCidr,
        gateway: pool.gateway,
        reservedIps: pool.reservedIps.join(', '),
        serverIds: [...pool.serverIds],
      });
    } else {
      setForm({
        name: '',
        cidr: '',
        allocationCidr: '',
        gateway: '',
        reservedIps: '',
        serverIds: [],
      });
    }
    setError(null);
  }, [open, mode, pool]);

  const create = useMutation({
    mutationFn: (body: CreateIpPoolRequest) => api.post<IpPoolDto>('/admin/ip-pools', body),
    onSuccess: () => {
      toast({ title: 'IP 池已创建' });
      void queryClient.invalidateQueries({ queryKey: queryKeys.ipPools.admin });
      onOpenChange(false);
    },
    onError: (mutationError) => setError(errorMessage(mutationError, '操作失败')),
  });
  const patch = useMutation({
    mutationFn: (body: PatchIpPoolRequest) => api.patch<IpPoolDto>(`/admin/ip-pools/${pool!.id}`, body),
    onSuccess: () => {
      toast({ title: 'IP 池已更新' });
      void queryClient.invalidateQueries({ queryKey: queryKeys.ipPools.admin });
      onOpenChange(false);
    },
    onError: (mutationError) => setError(errorMessage(mutationError, '操作失败')),
  });

  const toggleServer = (serverId: string, checked: boolean) => {
    setForm((current) => ({
      ...current,
      serverIds: checked
        ? [...new Set([...current.serverIds, serverId])]
        : current.serverIds.filter((id) => id !== serverId),
    }));
    setError(null);
  };

  const submit = () => {
    if (mode === 'create') {
      const parsed = zCreateIpPoolRequest.safeParse({
        name: form.name,
        cidr: form.cidr,
        allocationCidr: form.allocationCidr,
        gateway: form.gateway,
        reservedIps: splitList(form.reservedIps),
        serverIds: form.serverIds,
      });
      if (!parsed.success) {
        setError(parsed.error.issues[0]?.message ?? '请检查 IP 池参数');
        return;
      }
      create.mutate(parsed.data);
      return;
    }
    if (!pool) return;
    const parsed = zPatchIpPoolRequest.safeParse({
      expectedRevision: pool.revision,
      name: form.name,
      cidr: form.cidr,
      allocationCidr: form.allocationCidr,
      gateway: form.gateway,
      reservedIps: splitList(form.reservedIps),
      serverIds: form.serverIds,
    });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? '请检查 IP 池参数');
      return;
    }
    patch.mutate(parsed.data);
  };

  const pending = create.isPending || patch.isPending;
  return { form, setForm, error, toggleServer, submit, pending };
}

export function IpPoolEditorDialog({
  open,
  onOpenChange,
  servers,
  mode,
  pool,
}: EditorArgs & { servers: ServerDto[] }) {
  const { form, setForm, error, toggleServer, submit, pending } = useIpPoolEditor({ open, onOpenChange, mode, pool });


  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="ip-pool-editor">
        <DialogHeader>
          <DialogTitle>{mode === 'create' ? '创建 IP 池' : '编辑 IP 池'}</DialogTitle>
          <DialogDescription>
            可分配 CIDR 必须落在局域网内。绑定的服务器共享此池。
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField id="ip-pool-name" label="名称">
            <Input id="ip-pool-name" value={form.name} onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))} />
          </FormField>
          <FormField id="ip-pool-cidr" label="局域网 CIDR">
            <Input id="ip-pool-cidr" className="font-mono" value={form.cidr} placeholder="10.8.0.0/16" onChange={(event) => setForm((current) => ({ ...current, cidr: event.target.value }))} />
          </FormField>
          <FormField id="ip-pool-allocation-cidr" label="可分配 CIDR">
            <Input id="ip-pool-allocation-cidr" className="font-mono" value={form.allocationCidr} placeholder="10.8.100.0/24" onChange={(event) => setForm((current) => ({ ...current, allocationCidr: event.target.value }))} />
          </FormField>
          <FormField id="ip-pool-gateway" label="网关">
            <Input id="ip-pool-gateway" className="font-mono" value={form.gateway} placeholder="10.8.0.1" onChange={(event) => setForm((current) => ({ ...current, gateway: event.target.value }))} />
          </FormField>
          <div className="sm:col-span-2">
            <FormField id="ip-pool-reserved" label="保留地址（逗号分隔）">
              <Input id="ip-pool-reserved" className="font-mono" value={form.reservedIps} placeholder="10.8.0.2,10.8.96.92" onChange={(event) => setForm((current) => ({ ...current, reservedIps: event.target.value }))} />
            </FormField>
          </div>
        </div>
        <div className="space-y-2 rounded-md border p-3">
          <p className="text-sm font-medium">绑定服务器</p>
          {servers.length === 0 ? (
            <p className="text-xs text-muted-foreground">暂无服务器可绑定。</p>
          ) : (
            <div className="grid gap-2 sm:grid-cols-2">
              {servers.map((server) => {
                const checked = form.serverIds.includes(server.id);
                return (
                  <label key={server.id} className="flex items-center gap-2 text-sm">
                    <Checkbox
                      id={`ip-pool-server-${server.id}`}
                      checked={checked}
                      onCheckedChange={(nextChecked) => toggleServer(server.id, nextChecked === true)}
                    />
                    <span className="truncate">{server.name}</span>
                    {server.slug && server.slug !== server.name && (
                      <span className="truncate font-mono text-xs text-muted-foreground">{server.slug}</span>
                    )}
                  </label>
                );
              })}
            </div>
          )}
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>取消</Button>
          <Button onClick={submit} disabled={pending}>{pending ? '保存中...' : '保存'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}


