import { useQuery, useQueries, useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../lib/api.js';
import { Button } from '../components/ui/button.js';
import { Input } from '../components/ui/input.js';
import { Label } from '../components/ui/label.js';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '../components/ui/dialog.js';
import { toast } from '../hooks/use-toast.js';
import { Plus, Trash2, FolderOpen, Server, Container, RefreshCw, Network } from 'lucide-react';
import {
  AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle,
  AlertDialogDescription, AlertDialogFooter, AlertDialogCancel, AlertDialogAction,
} from '../components/ui/alert-dialog.js';
import type { AgentTaskRefResponse, ServerDto, DataDirDto, ContainerView, MountSourceDto } from '@nyabase/common';
import { dataDiskDisplayName } from '../lib/utils.js';
import { queryKeys } from '../lib/query-keys.js';

type DataDiskInfo = { diskId: string; mountPoint: string; label?: string | null; totalBytes: number; usedBytes: number; pquotaEnabled: boolean };

export default function DataDirsPage() {
  const [showCreate, setShowCreate] = useState(false);
  const [createSource, setCreateSource] = useState<{ kind: 'local' | 'remote'; serverId: string; sourceId: string } | null>(null);
  const qc = useQueryClient();

  const { data: servers = [] } = useQuery({ queryKey: queryKeys.servers.user, queryFn: () => api.get<ServerDto[]>('/servers') });
  const { data: containers = [] } = useQuery({
    queryKey: queryKeys.containers.userList,
    queryFn: () => api.get<ContainerView[]>('/v2/containers'),
    refetchInterval: 15_000,
  });

  const serverDirsResults = useQueries({
    queries: servers.map((s) => ({
      queryKey: queryKeys.dataDirs.byServer('user', s.id),
      queryFn: () => api.get<DataDirDto[]>(`/data-dirs?serverId=${s.id}`),
    })),
  });

  const serverDisksResults = useQueries({
    queries: servers.map((s) => ({
      queryKey: queryKeys.servers.disks('user', s.id),
      queryFn: () => api.get<DataDiskInfo[]>(`/servers/${s.id}/disks`),
      enabled: s.status === 'online',
    })),
  });

  const serverMountSourceResults = useQueries({
    queries: servers.map((s) => ({
      queryKey: queryKeys.mountSources.byServer('user', s.id),
      queryFn: () => api.get<MountSourceDto[]>(`/mount-sources?serverId=${s.id}`),
    })),
  });

  const deleteDir = useMutation({
    mutationFn: ({ serverId, sourceKind, sourceId, name }: { serverId: string; sourceKind: string; sourceId: string; name: string }) =>
      api.delete<AgentTaskRefResponse>(`/data-dirs/${serverId}/${sourceId}/${name}?sourceKind=${sourceKind}`),
    onSuccess: (res) => {
      setTimeout(() => qc.invalidateQueries({ queryKey: queryKeys.dataDirs.allUser }), 800);
      toast({
        title: '目录删除已排队',
        description: res.taskId ? `任务 ${res.taskId.slice(0, 8)}` : undefined,
      });
    },
    onError: (e) => toast({ title: '删除失败', description: e.message, variant: 'destructive' }),
  });

  const openCreate = (kind: 'local' | 'remote', serverId: string, sourceId: string) => {
    setCreateSource({ kind, serverId, sourceId });
    setShowCreate(true);
  };

  // ---------------------------------------------------------------------------
  // Derive unique remote sources and their dirs (server-agnostic)
  // ---------------------------------------------------------------------------

  const uniqueRemoteSources: { source: MountSourceDto; serverId: string }[] = [];
  const seenRemoteSourceIds = new Set<string>();
  servers.forEach((s, i) => {
    const sources = serverMountSourceResults[i]?.data ?? [];
    sources.filter((ms) => ms.kind === 'remote').forEach((ms) => {
      if (!seenRemoteSourceIds.has(ms.id)) {
        seenRemoteSourceIds.add(ms.id);
        uniqueRemoteSources.push({ source: ms, serverId: s.id });
      }
    });
  });

  const seenRemoteDirKeys = new Set<string>();
  const uniqueRemoteDirs: DataDirDto[] = [];
  serverDirsResults.forEach((r) => {
    (r.data ?? []).filter((d) => d.sourceKind === 'remote').forEach((d) => {
      const key = `${d.sourceId}:${d.name}`;
      if (!seenRemoteDirKeys.has(key)) {
        seenRemoteDirKeys.add(key);
        uniqueRemoteDirs.push(d);
      }
    });
  });

  const localDirCount = serverDirsResults.reduce(
    (sum, r) => sum + (r.data?.filter((d) => d.sourceKind === 'local').length ?? 0), 0,
  );
  const totalDirs = localDirCount + uniqueRemoteDirs.length;
  const isRefreshing = serverDirsResults.some((r) => r.isFetching);

  return (
    <div className="px-4 py-4 md:px-6 space-y-5 w-full">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">数据目录</h1>
          <p className="text-sm text-muted-foreground mt-0.5">{totalDirs} 个目录</p>
        </div>
        <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground"
          onClick={() => {
            qc.invalidateQueries({ queryKey: queryKeys.dataDirs.allUser });
            qc.invalidateQueries({ queryKey: queryKeys.mountSources.allUser });
            qc.invalidateQueries({ queryKey: queryKeys.containers.userList });
          }}
          disabled={isRefreshing}>
          <RefreshCw className={`h-4 w-4 ${isRefreshing ? 'animate-spin' : ''}`} />
        </Button>
      </div>

      {servers.length === 0 ? (
        <div className="bg-card rounded-lg border border-dashed border-border p-10 text-center text-muted-foreground/70">
          暂无可访问的数据目录。请联系管理员为你分配服务器或数据源权限。
        </div>
      ) : (
        <div className="space-y-6">

          {/* Remote shared FS — top level, not nested under any server */}
          {uniqueRemoteSources.length > 0 && (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <Network className="h-4 w-4 text-primary shrink-0" />
                <span className="font-semibold text-foreground/90">远程共享存储</span>
              </div>
              <div className="space-y-2 ml-6">
                {uniqueRemoteSources.map(({ source, serverId }) => {
                  const sourceDirs = uniqueRemoteDirs.filter((d) => d.sourceId === source.id);
                  return (
                    <DirSection key={source.id}
                      icon={<Network className="h-3.5 w-3.5 text-primary" />}
                      label={source.label}
                      description={source.description}
                      dirs={sourceDirs}
                      containers={containers}
                      onDelete={(name) => {
                        const dir = sourceDirs.find((d) => d.name === name);
                        deleteDir.mutate({ serverId: dir?.serverId ?? serverId, sourceKind: 'remote', sourceId: source.id, name });
                      }}
                      onNew={() => openCreate('remote', serverId, source.id)}
                    />
                  );
                })}
              </div>
            </div>
          )}

          {/* Per-server local disks */}
          {servers.map((s, i) => {
            const dirs = serverDirsResults[i]?.data ?? [];
            const disks = serverDisksResults[i]?.data ?? [];
            const localDirs = dirs.filter((d) => d.sourceKind === 'local');

            return (
              <div key={s.id} className="space-y-3">
                <div className="flex items-center gap-2">
                  <Server className="h-4 w-4 text-muted-foreground shrink-0" />
                  <span className="font-semibold text-foreground/90">{s.name}</span>
                  <span className={`text-xs px-1.5 py-0.5 rounded-full font-medium shrink-0 ${s.status === 'online' ? 'bg-green-50 text-green-700' : 'bg-muted text-muted-foreground/70'}`}>
                    {s.status === 'online' ? '在线' : '离线'}
                  </span>
                </div>

                <div className="space-y-2 ml-6">
                  {disks.length > 0 ? (
                    disks.map((disk) => {
                      const diskDirs = localDirs.filter((d) => d.sourceId === disk.diskId);
                      return (
                        <DirSection key={disk.diskId}
                          icon={<FolderOpen className="h-3.5 w-3.5 text-muted-foreground" />}
                          label={dataDiskDisplayName(disk.mountPoint, disk.label)}
                          dirs={diskDirs}
                          containers={containers}
                          onDelete={(name) => deleteDir.mutate({ serverId: s.id, sourceKind: 'local', sourceId: disk.diskId, name })}
                          onNew={() => openCreate('local', s.id, disk.diskId)}
                        />
                      );
                    })
                  ) : (
                    <div className="text-sm text-muted-foreground/70 italic">
                      该服务器暂无可用本地数据盘，或当前账号未获得本地数据盘权限
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {showCreate && createSource && (
        <CreateDirDialog
          sourceKind={createSource.kind}
          serverId={createSource.serverId}
          sourceId={createSource.sourceId}
          open={showCreate}
          onOpenChange={(v) => { setShowCreate(v); if (!v) setCreateSource(null); }}
        />
      )}
    </div>
  );
}

function DirSection({
  icon, label, description, dirs, containers, onDelete, onNew,
}: {
  icon: React.ReactNode;
  label: string;
  description?: string;
  dirs: DataDirDto[];
  containers: ContainerView[];
  onDelete: (name: string) => void;
  onNew: () => void;
}) {
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);

  return (
    <div className="rounded-lg border border-border bg-card p-3 space-y-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 min-w-0">
          {icon}
          <div className="min-w-0">
            <span className="text-sm font-medium text-foreground/90">{label}</span>
            {description && (
              <p className="text-xs text-muted-foreground/70 truncate">{description}</p>
            )}
          </div>
        </div>
        <Button size="sm" variant="outline" className="shrink-0" onClick={onNew}>
          <Plus className="h-4 w-4" />新建
        </Button>
      </div>
      {dirs.length === 0 ? (
        <p className="text-xs text-muted-foreground/70 italic px-2">暂无目录</p>
      ) : (
        <div className="space-y-1">
          {dirs.map((d) => {
            const usingContainers = containers.filter(
              (c) => c.mounts.some((m) => m.sourceId === d.sourceId && m.dirName === d.name),
            );
            return (
              <div key={`${d.sourceId}-${d.name}`} className="flex items-center justify-between px-2 py-1 rounded-lg hover:bg-accent">
                <div className="flex items-center gap-2 min-w-0">
                  <FolderOpen className="h-3.5 w-3.5 text-muted-foreground/70 shrink-0" />
                  <span className="font-mono text-sm text-foreground">{d.name}</span>
                  {d.desiredState !== 'active' && (
                    <span className="text-xs px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-600">
                      {d.desiredState === 'creating' ? '创建中' : d.desiredState === 'removing' ? '删除中' : '失败，可重试删除'}
                    </span>
                  )}
                  {usingContainers.length > 0 && usingContainers.map((c) => (
                    <span key={c.id} className="text-xs px-1.5 py-0.5 rounded bg-primary/10 text-primary">
                      <Container className="inline h-2.5 w-2.5 mr-0.5" />{c.name}
                    </span>
                  ))}
                </div>
                <Button size="icon" variant="ghost" className="h-8 w-8 text-red-400 hover:text-red-500"
                  onClick={() => setPendingDelete(d.name)}>
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            );
          })}
        </div>
      )}

      <AlertDialog open={pendingDelete !== null} onOpenChange={(v) => { if (!v) setPendingDelete(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除目录</AlertDialogTitle>
            <AlertDialogDescription>
              确定要删除目录 &ldquo;{pendingDelete}&rdquo;？此操作不可恢复。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                if (pendingDelete) {
                  onDelete(pendingDelete);
                  setPendingDelete(null);
                }
              }}
            >
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function CreateDirDialog({ sourceKind, serverId, sourceId, open, onOpenChange }: {
  sourceKind: 'local' | 'remote';
  serverId: string;
  sourceId: string;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const qc = useQueryClient();
  const [name, setName] = useState('');

  const { mutate, isPending } = useMutation({
    mutationFn: () => api.post<DataDirDto & { taskId?: string }>('/data-dirs', { serverId, sourceKind, sourceId, name }),
    onSuccess: (res) => {
      setTimeout(() => qc.invalidateQueries({ queryKey: queryKeys.dataDirs.allUser }), 800);
      toast({
        title: '目录创建已排队',
        description: res.taskId ? `任务 ${res.taskId.slice(0, 8)}` : undefined,
      });
      onOpenChange(false);
      setName('');
    },
    onError: (e) => toast({ title: '创建失败', description: e.message, variant: 'destructive' }),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>新建数据目录</DialogTitle>
          <p className="text-xs text-muted-foreground mt-1">
            {sourceKind === 'remote' ? '远程文件系统目录，不参与配额统计' : '本地 XFS 目录'}
          </p>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label className="text-sm text-foreground/90">目录名</Label>
            <Input placeholder="my-datasets" value={name} onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && name && mutate()} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
          <Button onClick={() => mutate()} disabled={isPending || !name}>
            {isPending ? '创建中...' : '创建'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
