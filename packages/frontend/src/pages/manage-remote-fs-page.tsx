import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../lib/api.js';
import { Button } from '../components/ui/button.js';
import { Input } from '../components/ui/input.js';
import { Label } from '../components/ui/label.js';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '../components/ui/dialog.js';
import { toast } from '../hooks/use-toast.js';
import { Plus, RefreshCw, Network, Trash2, AlertCircle, AlertTriangle, CheckCircle2, Loader2, ServerIcon, Pencil } from 'lucide-react';
import { useAuthStore } from '../store/auth.js';
import { Capability } from '@nyabase/common';
import type { ServerDto, RemoteFsMountDto, DataDirIssueDto } from '@nyabase/common';
import { queryKeys } from '../lib/query-keys.js';
import { QueryErrorState, QueryLoadingState } from '../components/query-state.js';
import {
  createRemoteFsMountDraft,
  type CephFsForm,
  type NfsForm,
  type RemoteFsType,
} from '../lib/remote-fs-form.js';
import { queryPollInterval } from '../lib/query-lifecycle.js';

type FsType = RemoteFsType;
type TaskIdsResponse = { taskIds?: string[] };
type RemoteFsTaskResponse = RemoteFsMountDto & TaskIdsResponse;
type AssignmentTaskResponse = { taskId?: string };

function taskIdsDescription(taskIds?: string[]): string | undefined {
  if (!taskIds || taskIds.length === 0) return undefined;
  return `任务 ${taskIds.map((id) => id.slice(0, 8)).join(', ')}`;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 4) return `${(bytes / 1024 ** 4).toFixed(1)} TB`;
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024).toFixed(0)} KB`;
}

function StatusBadge({ status }: { status?: { status: 'mounted' | 'mounting' | 'error'; error?: string; totalBytes?: number; usedBytes?: number } }) {
  if (!status) return <span className="text-xs text-muted-foreground/70">未知</span>;
  if (status.status === 'mounted') return (
    <span className="flex items-center gap-1 text-xs text-green-600">
      <CheckCircle2 className="h-3 w-3" />已挂载
      {status.totalBytes != null && status.usedBytes != null && status.totalBytes > 0 && (
        <span className="text-muted-foreground/70 ml-0.5">{formatBytes(status.usedBytes)}/{formatBytes(status.totalBytes)}</span>
      )}
    </span>
  );
  if (status.status === 'mounting') return (
    <span className="flex items-center gap-1 text-xs text-blue-500"><Loader2 className="h-3 w-3 animate-spin" />挂载中</span>
  );
  return (
    <span className="flex items-center gap-1 text-xs text-red-500"><AlertCircle className="h-3 w-3 shrink-0" />错误{status.error && <span className="max-w-[160px] truncate" title={status.error}>: {status.error}</span>}</span>
  );
}

function TypeBadge({ type }: { type: string }) {
  const label = type === 'nfs' ? 'NFS' : type === 'cephfs' ? 'CephFS' : type.toUpperCase();
  const cls = type === 'nfs'
    ? 'bg-blue-500/10 border-blue-500/30 text-blue-700 dark:text-blue-300'
    : 'bg-orange-500/10 border-orange-500/30 text-orange-700 dark:text-orange-300';
  return <span className={`text-xs px-1.5 py-0.5 rounded border font-mono ${cls}`}>{label}</span>;
}

function mountSummary(m: RemoteFsMountDto): string {
  const p = m.params;
  if (p.type === 'nfs') return `${p.nfsServer}:${p.exportPath} (v${p.version})`;
  if (p.type === 'cephfs') return `${p.monHosts}:${p.exportPath}${p.fsName ? ` [${p.fsName}]` : ''}`;
  return m.hostMountPoint;
}

export default function RemoteFsMountsPage() {
  const [filterType, setFilterType] = useState<FsType | 'all'>('all');
  const [showCreate, setShowCreate] = useState(false);
  const [editMount, setEditMount] = useState<RemoteFsMountDto | null>(null);
  const [serverAssignMountId, setServerAssignMountId] = useState<string | null>(null);
  const qc = useQueryClient();
  const { user } = useAuthStore();
  const canManageContainers = user?.capabilities.includes(Capability.ManageContainersAny) ?? false;

  const serversQuery = useQuery({ queryKey: queryKeys.servers.admin, queryFn: () => api.get<ServerDto[]>('/admin/servers') });
  const mountsQuery = useQuery({
    queryKey: ['remote-fs-mounts'],
    queryFn: () => api.get<RemoteFsMountDto[]>('/admin/remote-fs-mounts'),
    refetchInterval: (query) => queryPollInterval(query.state, { activeIntervalMs: 15_000 }),
  });
  const servers = serversQuery.data ?? [];
  const allMounts = mountsQuery.data ?? [];
  const { isFetching } = mountsQuery;

  const mounts = filterType === 'all' ? allMounts : allMounts.filter((m) => m.type === filterType);
  const serverAssignMount = serverAssignMountId ? (allMounts.find((m) => m.id === serverAssignMountId) ?? null) : null;

  const deleteMount = useMutation({
    mutationFn: (id: string) => api.delete<TaskIdsResponse>(`/admin/remote-fs-mounts/${id}`),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['remote-fs-mounts'] });
      toast({ title: '挂载删除已排队', description: taskIdsDescription(res.taskIds) });
    },
    onError: (e) => toast({ title: '删除失败', description: e.message, variant: 'destructive' }),
  });

  const serverMap = new Map(servers.map((s) => [s.id, s]));

  if (serversQuery.isLoading || mountsQuery.isLoading) {
    return <QueryLoadingState label="加载远程文件系统..." />;
  }
  const inventoryError = serversQuery.error ?? mountsQuery.error;
  if (inventoryError) return (
    <QueryErrorState
      error={inventoryError}
      resourceName="远程文件系统目录"
      onRetry={() => { void Promise.all([serversQuery.refetch(), mountsQuery.refetch()]); }}
    />
  );

  return (
    <div className="px-4 py-4 md:px-6 space-y-5 w-full">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">远程文件系统</h1>
          <p className="text-sm text-muted-foreground mt-0.5">{allMounts.length} 个挂载</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground"
            onClick={() => qc.invalidateQueries({ queryKey: ['remote-fs-mounts'] })} disabled={isFetching}>
            <RefreshCw className={`h-4 w-4 ${isFetching ? 'animate-spin' : ''}`} />
          </Button>
          <Button onClick={() => setShowCreate(true)}>
            <Plus className="h-4 w-4" />新建挂载
          </Button>
        </div>
      </div>

      {/* Type filter tabs */}
      <div className="flex gap-1 border-b border-border">
        {(['all', 'nfs', 'cephfs'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setFilterType(t)}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              filterType === t
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
          >
            {t === 'all' ? '全部' : t === 'nfs' ? 'NFS' : 'CephFS'}
            <span className="ml-1 text-xs text-muted-foreground/70">
              ({t === 'all' ? allMounts.length : allMounts.filter((m) => m.type === t).length})
            </span>
          </button>
        ))}
      </div>

      {mounts.length === 0 ? (
        <div className="bg-card rounded-lg border border-dashed p-10 text-center text-muted-foreground">
          <Network className="h-8 w-8 text-muted-foreground/40 mx-auto mb-2" />
          暂无挂载
        </div>
      ) : (
        <div className="space-y-3">
          {mounts.map((m) => (
            <div key={m.id} className="bg-card rounded-lg border p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="space-y-2 min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <TypeBadge type={m.type} />
                    <span className="font-medium text-foreground">{m.name}</span>
                    {m.displayName && (
                      <span className="text-xs text-muted-foreground">→ <span className="font-medium">{m.displayName}</span></span>
                    )}
                    {m.options && <span className="text-xs text-muted-foreground/70">{m.options}</span>}
                  </div>
                  {m.description && (
                    <div className="text-xs text-muted-foreground/70 italic">{m.description}</div>
                  )}
                  <div className="text-xs text-muted-foreground font-mono">
                    {mountSummary(m)} → {m.hostMountPoint}
                  </div>
                  <div className="flex flex-wrap gap-1.5 mt-1">
                    {m.serverIds.length === 0 ? (
                      <span className="text-xs text-muted-foreground/50 italic">未分配到任何服务器</span>
                    ) : m.serverIds.map((sid) => {
                      const server = serverMap.get(sid);
                      const status = m.serverStatuses?.[sid];
                      return (
                        <span key={sid}
                          className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 border max-w-full ${
                            status?.status === 'error' ? 'rounded-lg' : 'rounded-full'
                          } ${
                            status?.status === 'mounted'
                              ? 'bg-green-500/10 border-green-500/30 text-green-700 dark:text-green-300'
                              : status?.status === 'error'
                              ? 'bg-red-500/10 border-red-500/30 text-red-600 dark:text-red-300'
                              : status?.status === 'mounting'
                              ? 'bg-blue-500/10 border-blue-500/30 text-blue-600 dark:text-blue-300'
                              : 'bg-muted border-border text-muted-foreground'
                          }`}
                        >
                          <ServerIcon className="h-2.5 w-2.5 shrink-0" />
                          {server?.name ?? sid.slice(0, 8)}
                          {status && <StatusBadge status={status} />}
                        </span>
                      );
                    })}
                  </div>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <Button size="icon" variant="ghost" className="h-8 w-8 text-muted-foreground hover:text-purple-600"
                    title="管理服务器分配" onClick={() => setServerAssignMountId(m.id)}>
                    <ServerIcon className="h-3.5 w-3.5" />
                  </Button>
                  <Button size="icon" variant="ghost" className="h-8 w-8 text-muted-foreground hover:text-blue-600"
                    title="编辑" onClick={() => setEditMount(m)}>
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                  <Button size="icon" variant="ghost" className="h-8 w-8 text-red-400 hover:text-red-600"
                    title="删除" onClick={() => { if (confirm(`删除挂载 "${m.name}"？`)) deleteMount.mutate(m.id); }}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
              {canManageContainers && m.serverIds.length > 0 && (
                <RemoteDanglingDirPanel sourceId={m.id} />
              )}
            </div>
          ))}
        </div>
      )}

      {(showCreate || editMount) && (
        <RemoteFsMountDialog
          key={editMount?.id ?? 'new'}
          open
          mount={editMount ?? undefined}
          servers={servers}
          onClose={() => { setShowCreate(false); setEditMount(null); }}
        />
      )}
      {serverAssignMount && (
        <ServerAssignDialog mount={serverAssignMount} servers={servers}
          onClose={() => setServerAssignMountId(null)} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Create/Edit dialog
// ---------------------------------------------------------------------------

function RemoteFsMountDialog({ open, mount, servers, onClose }: {
  open: boolean;
  mount?: RemoteFsMountDto;
  servers: ServerDto[];
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const isEdit = !!mount;
  const [initial] = useState(() => createRemoteFsMountDraft(mount));
  const [name, setName] = useState(initial.name);
  const [displayName, setDisplayName] = useState(initial.displayName);
  const [description, setDescription] = useState(initial.description);
  const [type, setType] = useState<FsType>(initial.type);
  const [options, setOptions] = useState(initial.options);
  const [serverId, setServerId] = useState(initial.serverId);
  const [nfsForm, setNfsForm] = useState<NfsForm>(initial.nfsForm);
  const [cephForm, setCephForm] = useState<CephFsForm>(initial.cephForm);

  const { mutate, isPending } = useMutation({
    mutationFn: () => {
      if (isEdit) {
        const body: Record<string, unknown> = {
          name,
          displayName: displayName.trim() || null,
          description: description.trim() || null,
        };
        return api.patch<RemoteFsTaskResponse>(`/admin/remote-fs-mounts/${mount!.id}`, body);
      }
      const params = type === 'nfs'
        ? { type: 'nfs' as const, ...nfsForm }
        : {
            type: 'cephfs' as const,
            monHosts: cephForm.monHosts,
            exportPath: cephForm.exportPath,
            fsName: cephForm.fsName || undefined,
            clientName: cephForm.clientName,
            secret: cephForm.secret,
          };
      return api.post<RemoteFsTaskResponse>('/admin/remote-fs-mounts', {
        name,
        displayName: displayName || undefined,
        description: description || undefined,
        serverIds: serverId ? [serverId] : undefined,
        options: options || undefined,
        params,
      });
    },
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['remote-fs-mounts'] });
      toast({
        title: isEdit ? '挂载更新已排队' : '挂载创建已排队',
        description: taskIdsDescription(res.taskIds),
      });
      onClose();
    },
    onError: (e) => toast({ title: '操作失败', description: e.message, variant: 'destructive' }),
  });

  // Each entry: host or host:port, no whitespace allowed, comma-separated
  const monHostsValid = /^[^,\s]+(,[^,\s]+)*$/.test(cephForm.monHosts.trim());
  const monHostsError = cephForm.monHosts.trim() && !monHostsValid
    ? '格式错误：请用逗号分隔多个地址，不能含空格（如 10.0.0.1,10.0.0.2:6789）'
    : null;

  const paramsValid = isEdit || (
    type === 'nfs'
      ? nfsForm.nfsServer.trim().length > 0 && nfsForm.exportPath.trim().length > 0
      : monHostsValid
        && cephForm.exportPath.trim().length > 0
        && cephForm.clientName.trim().length > 0
        && cephForm.secret.trim().length > 0
  );
  const isValid = name.trim().length > 0 && paramsValid;

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader><DialogTitle>{isEdit ? '编辑挂载' : '新建远程文件系统挂载'}</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-sm">内部名称 <span className="text-red-500">*</span></Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="my-shared-storage" />
              <p className="text-xs text-muted-foreground">仅管理员可见</p>
            </div>
            <div className="space-y-1.5">
              <Label className="text-sm">用户显示名称</Label>
              <Input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="共享数据集（留空则显示内部名称）" />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label className="text-sm">描述（对用户显示）</Label>
            <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="可选描述，展示给用户" />
          </div>

          {!isEdit && (
            <>
              <div className="space-y-1.5">
                <Label className="text-sm">类型</Label>
                <div className="flex gap-2">
                  {(['nfs', 'cephfs'] as FsType[]).map((t) => (
                    <button key={t} type="button"
                      onClick={() => setType(t)}
                      className={`flex-1 py-2 rounded-lg text-sm font-medium border transition-colors ${
                        type === t
                          ? 'bg-primary/10 border-primary/40 text-primary'
                          : 'bg-muted border-border text-muted-foreground hover:bg-accent'
                      }`}>
                      {t === 'nfs' ? 'NFS' : 'CephFS'}
                    </button>
                  ))}
                </div>
              </div>

              {/* NFS sub-form */}
              {type === 'nfs' && (
                <div className="space-y-3 p-3 bg-primary/5 rounded-lg border border-primary/20">
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1.5">
                      <Label className="text-sm">NFS 服务器</Label>
                      <Input value={nfsForm.nfsServer} onChange={(e) => setNfsForm({ ...nfsForm, nfsServer: e.target.value })}
                        placeholder="192.168.1.100" />
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-sm">导出路径</Label>
                      <Input value={nfsForm.exportPath} onChange={(e) => setNfsForm({ ...nfsForm, exportPath: e.target.value })}
                        placeholder="/exports/data" />
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-sm">NFS 版本</Label>
                    <select className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                      value={nfsForm.version} onChange={(e) => setNfsForm({ ...nfsForm, version: e.target.value as '3' | '4' | '4.1' | '4.2' })}>
                      {(['3', '4', '4.1', '4.2'] as const).map((v) => <option key={v} value={v}>{v}</option>)}
                    </select>
                  </div>
                </div>
              )}

              {/* CephFS sub-form */}
              {type === 'cephfs' && (
                <div className="space-y-3 p-3 bg-orange-50/50 rounded-lg border border-orange-100">
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1.5">
                      <Label className="text-sm">Monitor 主机</Label>
                      <Input value={cephForm.monHosts} onChange={(e) => setCephForm({ ...cephForm, monHosts: e.target.value })}
                        placeholder="10.0.0.1,10.0.0.2:6789"
                        className={monHostsError ? 'border-red-400 focus-visible:ring-red-400' : ''} />
                      {monHostsError && <p className="text-xs text-red-500">{monHostsError}</p>}
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-sm">导出路径</Label>
                      <Input value={cephForm.exportPath} onChange={(e) => setCephForm({ ...cephForm, exportPath: e.target.value })}
                        placeholder="/" />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1.5">
                      <Label className="text-sm">Client Name</Label>
                      <Input value={cephForm.clientName} onChange={(e) => setCephForm({ ...cephForm, clientName: e.target.value })}
                        placeholder="admin" />
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-sm">FS 名称（多 FS 集群）</Label>
                      <Input value={cephForm.fsName} onChange={(e) => setCephForm({ ...cephForm, fsName: e.target.value })}
                        placeholder="cephfs（可选）" />
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-sm">Secret Key（Base64）</Label>
                    <Input type="password" value={cephForm.secret} onChange={(e) => setCephForm({ ...cephForm, secret: e.target.value })}
                      placeholder="AQA...=="
                      autoComplete="new-password" />
                  </div>
                </div>
              )}

              <div className="space-y-1.5">
                <Label className="text-sm">挂载选项（可选）</Label>
                <Input value={options} onChange={(e) => setOptions(e.target.value)} placeholder="ro,soft" />
                <p className="text-xs text-muted-foreground">宿主挂载点由系统固定生成，物理参数创建后不可修改。</p>
              </div>

              {!isEdit && servers.length > 0 && (
                <div className="space-y-1.5">
                  <Label className="text-sm">立即分配到服务器（可选）</Label>
                  <select
                    value={serverId}
                    onChange={(event) => setServerId(event.target.value)}
                    className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                  >
                    <option value="">暂不分配</option>
                    {servers.map((s) => (
                      <option key={s.id} value={s.id}>{s.name}</option>
                    ))}
                  </select>
                  <p className="text-xs text-muted-foreground">创建时最多分配一台服务器；其余服务器可在创建后逐台分配。</p>
                </div>
              )}
            </>
          )}

          {isEdit && (
            <p className="text-xs text-muted-foreground bg-muted rounded px-3 py-2">
              此处只修改名称和描述。文件系统地址、凭据、挂载选项和宿主路径是不可变身份；需要变更时请取消分配并新建挂载。
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>取消</Button>
          <Button onClick={() => mutate()} disabled={isPending || !isValid}>
            {isPending ? '保存中...' : '保存'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Server assignment dialog
// ---------------------------------------------------------------------------

function ServerAssignDialog({ mount, servers, onClose }: {
  mount: RemoteFsMountDto;
  servers: ServerDto[];
  onClose: () => void;
}) {
  const qc = useQueryClient();

  const assign = useMutation({
    mutationFn: (serverId: string) =>
      api.post<AssignmentTaskResponse>(`/admin/remote-fs-mounts/${mount.id}/servers`, { serverId }),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['remote-fs-mounts'] });
      toast({
        title: '服务器分配已排队',
        description: res.taskId ? `任务 ${res.taskId.slice(0, 8)}` : undefined,
      });
    },
    onError: (e) => toast({ title: '分配失败', description: e.message, variant: 'destructive' }),
  });

  const unassign = useMutation({
    mutationFn: (serverId: string) =>
      api.delete<TaskIdsResponse>(`/admin/remote-fs-mounts/${mount.id}/servers/${serverId}`),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['remote-fs-mounts'] });
      toast({
        title: '服务器取消分配已排队',
        description: taskIdsDescription(res.taskIds),
      });
    },
    onError: (e) => toast({ title: '取消分配失败', description: e.message, variant: 'destructive' }),
  });

  const toggle = (serverId: string) => {
    if (mount.serverIds.includes(serverId)) {
      unassign.mutate(serverId);
    } else {
      assign.mutate(serverId);
    }
  };

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>
            <span className="flex items-center gap-2">
              <TypeBadge type={mount.type} />
              {mount.name} — 服务器分配
            </span>
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">选择此挂载应在哪些服务器上生效</p>
          <div className="space-y-2">
            {servers.length === 0 && (
              <p className="text-sm text-muted-foreground/70 text-center py-4">暂无服务器</p>
            )}
            {servers.map((s) => {
              const isAssigned = mount.serverIds.includes(s.id);
              const status = mount.serverStatuses?.[s.id];
              return (
                <div key={s.id}
                  className={`flex items-center justify-between rounded-lg border px-3 py-2 ${
                    isAssigned ? 'border-primary/30 bg-primary/5' : 'border-border'
                  }`}>
                  <div className="flex items-center gap-2">
                    <span className={`w-2 h-2 rounded-full ${s.status === 'online' ? 'bg-green-500' : 'bg-muted-foreground/40'}`} />
                    <span className="text-sm font-medium text-foreground">{s.name}</span>
                    {isAssigned && status && <StatusBadge status={status} />}
                  </div>
                  <Button size="sm" variant="outline"
                    className={isAssigned ? 'text-red-600 border-red-200 hover:bg-red-50' : undefined}
                    disabled={assign.isPending || unassign.isPending}
                    onClick={() => toggle(s.id)}>
                    {isAssigned ? '取消' : '分配'}
                  </Button>
                </div>
              );
            })}
          </div>
        </div>
        <DialogFooter>
          <Button onClick={onClose}>关闭</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RemoteDanglingDirPanel({ sourceId }: { sourceId: string }) {
  const issuesQuery = useQuery({
    queryKey: ['data-dir-issues', 'remote', sourceId],
    queryFn: () => api.get<DataDirIssueDto[]>(`/admin/data-dirs/issues?sourceKind=remote&sourceId=${sourceId}`),
    refetchInterval: (query) => queryPollInterval(query.state, { activeIntervalMs: 30_000 }),
  });
  const issues = issuesQuery.data ?? [];

  if (issuesQuery.isLoading) {
    return <div className="mt-3 text-xs text-muted-foreground">正在检查远程数据目录一致性...</div>;
  }
  if (issuesQuery.isError) {
    return (
      <div className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
        一致性检查失败，当前不能断言“无问题”。
        <button className="ml-2 underline" onClick={() => { void issuesQuery.refetch(); }}>重试</button>
      </div>
    );
  }

  if (issues.length === 0) return null;

  const orphans = issues.filter((i) => i.kind === 'orphan');
  const missing = issues.filter((i) => i.kind === 'missing');

  return (
    <div className="mt-3 border-t border-dashed border-amber-200 pt-3">
      <div className="flex items-center gap-1.5 mb-2">
        <AlertTriangle className="h-3.5 w-3.5 text-amber-500 shrink-0" />
        <span className="text-xs font-medium text-amber-700">
          悬空目录告警（请在服务器上手动处理）
          {orphans.length > 0 && <span className="ml-1 bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded">{orphans.length} 孤立</span>}
          {missing.length > 0 && <span className="ml-1 bg-red-50 text-red-600 px-1.5 py-0.5 rounded">{missing.length} 缺失</span>}
        </span>
      </div>

      {orphans.length > 0 && (
        <div className="space-y-1 mb-2">
          <p className="text-xs text-muted-foreground/70">FS 有 / DB 无（孤立）</p>
          {orphans.map((issue) => (
            <div key={`${issue.entry.sourceId}-${issue.entry.name}`} className="px-2 py-1 rounded bg-amber-500/10 dark:bg-amber-500/15">
              <span className="font-mono text-xs text-amber-800 dark:text-amber-300">{issue.entry.name}</span>
              <span className="text-xs text-muted-foreground/70 ml-1">{issue.entry.hostPath}</span>
            </div>
          ))}
        </div>
      )}

      {missing.length > 0 && (
        <div className="space-y-1">
          <p className="text-xs text-muted-foreground/70">DB 有 / FS 无（缺失）</p>
          {missing.map((issue) => (
            <div key={`${issue.entry.sourceId}-${issue.entry.name}`} className="px-2 py-1 rounded bg-red-50">
              <span className="font-mono text-xs text-red-700">{issue.entry.name}</span>
              {issue.entry.userId && <span className="text-xs text-muted-foreground/70 ml-1">owner: {issue.entry.userId}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
