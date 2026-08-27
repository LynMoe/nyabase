import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Network, Plus, RefreshCw } from 'lucide-react';
import {
  zCreateIpPoolRequest,
  zPatchIpPoolRequest,
  type CreateIpPoolRequest,
  type IpPoolDto,
  type PatchIpPoolRequest,
  type ServerDto,
} from '@nyabase/common';
import { api } from '../lib/api.js';
import { Badge } from '../components/ui/badge.js';
import { Button } from '../components/ui/button.js';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card.js';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../components/ui/dialog.js';
import { Input } from '../components/ui/input.js';
import { Label } from '../components/ui/label.js';
import { QueryErrorState, QueryLoadingState } from '../components/query-state.js';
import { toast } from '../hooks/use-toast.js';
import { queryKeys } from '../lib/query-keys.js';

function splitList(value: string): string[] {
  return value.split(/[\s,]+/).map((item) => item.trim()).filter(Boolean);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '操作失败';
}

export default function IpPoolsPage() {
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<IpPoolDto | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<IpPoolDto | null>(null);
  const poolsQuery = useQuery({
    queryKey: queryKeys.ipPools.admin,
    queryFn: () => api.get<IpPoolDto[]>('/admin/ip-pools'),
  });
  const serversQuery = useQuery({
    queryKey: queryKeys.servers.admin,
    queryFn: () => api.get<ServerDto[]>('/admin/servers'),
  });
  const deletePool = useMutation({
    mutationFn: (id: string) => api.delete<void>(`/admin/ip-pools/${id}`),
    onSuccess: () => {
      toast({ title: 'IP 池已删除' });
      setDeleteTarget(null);
      void queryClient.invalidateQueries({ queryKey: queryKeys.ipPools.admin });
    },
    onError: (error) => {
      toast({ title: '删除失败', description: errorMessage(error), variant: 'destructive' });
    },
  });
  const serverNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const server of serversQuery.data ?? []) map.set(server.id, server.name);
    return map;
  }, [serversQuery.data]);

  return (
    <div className="space-y-5 px-4 py-4 md:px-6" data-testid="ip-pools">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">IP 池</h1>
          <p className="text-sm text-muted-foreground">
            管理局域网段与可分配子网。可将同一局域网绑定到多台服务器，创建容器时只从可分配子网取地址，销毁后自动释放。
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="icon" onClick={() => { void poolsQuery.refetch(); }} aria-label="刷新 IP 池">
            <RefreshCw className="h-4 w-4" />
          </Button>
          <Button onClick={() => setCreateOpen(true)}><Plus className="h-4 w-4" />创建 IP 池</Button>
        </div>
      </div>
      {poolsQuery.isLoading ? (
        <QueryLoadingState label="加载 IP 池..." />
      ) : poolsQuery.isError ? (
        <QueryErrorState error={poolsQuery.error} resourceName="IP 池" onRetry={() => { void poolsQuery.refetch(); }} />
      ) : (poolsQuery.data ?? []).length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
            <p className="text-sm text-muted-foreground">暂无 IP 池。创建后可勾选服务器共享同一地址段。</p>
            <Button onClick={() => setCreateOpen(true)}><Plus className="h-4 w-4" />创建 IP 池</Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 xl:grid-cols-2">
          {(poolsQuery.data ?? []).map((pool) => (
            <Card key={pool.id}>
              <CardHeader>
                <div className="flex items-start justify-between gap-3">
                  <CardTitle className="flex min-w-0 items-center gap-2 text-base">
                    <Network className="h-4 w-4 shrink-0" />
                    <span className="truncate">{pool.name}</span>
                  </CardTitle>
                  <Badge variant="outline">{pool.serverIds.length} 台服务器</Badge>
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="grid gap-3 sm:grid-cols-2">
                  <Info label="局域网 CIDR" value={pool.cidr} mono />
                  <Info label="可分配 CIDR" value={pool.allocationCidr} mono />
                  <Info label="网关" value={pool.gateway} mono />
                  <Info label="已分配 / 可用" value={`${pool.allocatedCount} / ${pool.usableCount}`} />
                  <Info label="保留地址" value={pool.reservedIps.join(', ') || '无'} mono />
                  <Info
                    label="绑定服务器"
                    value={pool.serverIds.map((id) => serverNameById.get(id) ?? id).join(', ') || '未绑定'}
                  />
                </div>
                <div className="flex justify-end gap-2">
                  <Button size="sm" variant="outline" onClick={() => setEditTarget(pool)}>编辑</Button>
                  <Button
                    size="sm"
                    variant="destructive"
                    onClick={() => setDeleteTarget(pool)}
                    disabled={deletePool.isPending}
                  >
                    删除
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
      <IpPoolEditorDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        servers={serversQuery.data ?? []}
        mode="create"
      />
      <IpPoolEditorDialog
        open={Boolean(editTarget)}
        onOpenChange={(open) => { if (!open) setEditTarget(null); }}
        servers={serversQuery.data ?? []}
        mode="edit"
        pool={editTarget}
      />
      <Dialog open={Boolean(deleteTarget)} onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}>
        <DialogContent data-testid="ip-pool-delete-confirm">
          <DialogHeader>
            <DialogTitle>删除 IP 池？</DialogTitle>
            <DialogDescription>
              将删除「{deleteTarget?.name}」（{deleteTarget?.cidr}）。仍有地址占用时会拒绝删除。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)} disabled={deletePool.isPending}>
              取消
            </Button>
            <Button
              variant="destructive"
              onClick={() => { if (deleteTarget) deletePool.mutate(deleteTarget.id); }}
              disabled={deletePool.isPending}
            >
              {deletePool.isPending ? '删除中...' : '确认删除'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function IpPoolEditorDialog({
  open,
  onOpenChange,
  servers,
  mode,
  pool,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  servers: ServerDto[];
  mode: 'create' | 'edit';
  pool?: IpPoolDto | null;
}) {
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
    onError: (mutationError) => setError(errorMessage(mutationError)),
  });
  const patch = useMutation({
    mutationFn: (body: PatchIpPoolRequest) => api.patch<IpPoolDto>(`/admin/ip-pools/${pool!.id}`, body),
    onSuccess: () => {
      toast({ title: 'IP 池已更新' });
      void queryClient.invalidateQueries({ queryKey: queryKeys.ipPools.admin });
      onOpenChange(false);
    },
    onError: (mutationError) => setError(errorMessage(mutationError)),
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto" data-testid="ip-pool-editor">
        <DialogHeader>
          <DialogTitle>{mode === 'create' ? '创建 IP 池' : '编辑 IP 池'}</DialogTitle>
          <DialogDescription>
            局域网 CIDR 决定容器前缀与网关；可分配 CIDR 必须落在局域网内，容器地址只从该子网分配。绑定多台服务器后共享同一池；多池时按创建时间优先。
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="ip-pool-name">名称</Label>
            <Input id="ip-pool-name" value={form.name} onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ip-pool-cidr">局域网 CIDR</Label>
            <Input id="ip-pool-cidr" className="font-mono" value={form.cidr} placeholder="10.8.0.0/16" onChange={(event) => setForm((current) => ({ ...current, cidr: event.target.value }))} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ip-pool-allocation-cidr">可分配 CIDR</Label>
            <Input id="ip-pool-allocation-cidr" className="font-mono" value={form.allocationCidr} placeholder="10.8.100.0/24" onChange={(event) => setForm((current) => ({ ...current, allocationCidr: event.target.value }))} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ip-pool-gateway">网关</Label>
            <Input id="ip-pool-gateway" className="font-mono" value={form.gateway} placeholder="10.8.0.1" onChange={(event) => setForm((current) => ({ ...current, gateway: event.target.value }))} />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="ip-pool-reserved">保留地址（逗号分隔）</Label>
            <Input id="ip-pool-reserved" className="font-mono" value={form.reservedIps} placeholder="10.8.0.2,10.8.96.92" onChange={(event) => setForm((current) => ({ ...current, reservedIps: event.target.value }))} />
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
                    <input
                      type="checkbox"
                      className="h-4 w-4"
                      checked={checked}
                      onChange={(event) => toggleServer(server.id, event.target.checked)}
                    />
                    <span className="truncate">{server.name}</span>
                    <span className="truncate font-mono text-xs text-muted-foreground">{server.slug}</span>
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

function Info({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={mono ? 'break-all font-mono text-sm' : 'text-sm'}>{value}</p>
    </div>
  );
}
