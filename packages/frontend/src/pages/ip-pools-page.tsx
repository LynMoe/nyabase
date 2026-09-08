import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react';
import {
  zCreateIpPoolRequest,
  zPatchIpPoolRequest,
  type CreateIpPoolRequest,
  type IpPoolDto,
  type PatchIpPoolRequest,
  type ServerDto,
} from '@nyabase/common';
import { api } from '../lib/api.js';
import { errorMessage } from '../lib/api-error.js';
import { Button } from '../components/ui/button.js';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../components/ui/dialog.js';
import { Checkbox } from '../components/ui/checkbox.js';
import { Input } from '../components/ui/input.js';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../components/ui/table.js';
import { ConfirmDialog } from '../components/layout/confirm-dialog.js';
import { SectionCard } from '../components/layout/section-card.js';
import { FormField } from '../components/layout/form-field.js';
import { EmptyState } from '../components/layout/empty-state.js';
import { Page } from '../components/layout/page.js';
import { PageHeader } from '../components/layout/page-header.js';
import { QueryView } from '../components/layout/query-view.js';
import { toast } from '../hooks/use-toast.js';
import { queryKeys } from '../lib/query-keys.js';

function splitList(value: string): string[] {
  return value.split(/[\s,]+/).map((item) => item.trim()).filter(Boolean);
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
      toast({ title: '删除失败', description: errorMessage(error, '操作失败'), variant: 'destructive' });
    },
  });
  const serverNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const server of serversQuery.data ?? []) map.set(server.id, server.name);
    return map;
  }, [serversQuery.data]);

  return (
    <Page testId="ip-pools">
      <PageHeader
        title="IP 池"
        description="管理局域网段与可分配子网。可将同一局域网绑定到多台服务器，创建容器时只从可分配子网取地址，销毁后自动释放。"
        actions={
          <>
            <Button variant="outline" size="icon" onClick={() => { void poolsQuery.refetch(); }} aria-label="刷新 IP 池">
              <RefreshCw className="h-4 w-4" />
            </Button>
            <Button onClick={() => setCreateOpen(true)}><Plus className="h-4 w-4" />创建 IP 池</Button>
          </>
        }
      />
      <QueryView
        query={poolsQuery}
        resourceName="IP 池"
        loadingLabel="加载 IP 池..."
        showEmpty={poolsQuery.data?.length === 0}
        empty={
          <EmptyState
            title="暂无 IP 池。创建后可勾选服务器共享同一地址段。"
            action={<Button onClick={() => setCreateOpen(true)}><Plus className="h-4 w-4" />创建 IP 池</Button>}
          />
        }
      >
        {(pools) => (
          <SectionCard flush>
          <Table className="min-w-[880px]">
            <TableHeader>
              <TableRow>
                <TableHead>名称</TableHead>
                <TableHead>局域网</TableHead>
                <TableHead>可分配</TableHead>
                <TableHead>网关</TableHead>
                <TableHead>已分配 / 可用</TableHead>
                <TableHead>保留</TableHead>
                <TableHead>绑定服务器</TableHead>
                <TableHead className="text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {pools.map((pool) => (
                <TableRow
                  key={pool.id}
                  className="cursor-pointer"
                  onClick={() => setEditTarget(pool)}
                >
                  <TableCell className="font-medium">{pool.name}</TableCell>
                  <TableCell className="font-mono">{pool.cidr}</TableCell>
                  <TableCell className="font-mono">{pool.allocationCidr}</TableCell>
                  <TableCell className="font-mono">{pool.gateway}</TableCell>
                  <TableCell>{pool.allocatedCount} / {pool.usableCount}</TableCell>
                  <TableCell className="max-w-[10rem] truncate font-mono" title={pool.reservedIps.join(', ') || '无'}>
                    {pool.reservedIps.join(', ') || '无'}
                  </TableCell>
                  <TableCell className="max-w-[12rem] truncate whitespace-normal">
                    {pool.serverIds.map((id) => serverNameById.get(id) ?? id).join('、') || '未绑定'}
                  </TableCell>
                  <TableCell className="text-right" onClick={(event) => event.stopPropagation()}>
                    <div className="flex justify-end gap-2">
                      <Button size="sm" variant="outline" onClick={() => setEditTarget(pool)}>
                        <Pencil className="h-3.5 w-3.5" />编辑
                      </Button>
                      <Button
                        size="sm"
                        variant="destructive"
                        onClick={() => setDeleteTarget(pool)}
                        disabled={deletePool.isPending}
                      >
                        <Trash2 className="h-3.5 w-3.5" />删除
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          </SectionCard>
        )}
      </QueryView>
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
      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title="删除 IP 池？"
        description={`将删除「${deleteTarget?.name}」（${deleteTarget?.cidr}）。仍有地址占用时会拒绝删除。`}
        confirmLabel="确认删除"
        pendingLabel="删除中..."
        pending={deletePool.isPending}
        testId="ip-pool-delete-confirm"
        onConfirm={() => { if (deleteTarget) deletePool.mutate(deleteTarget.id); }}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}
      />
    </Page>
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


