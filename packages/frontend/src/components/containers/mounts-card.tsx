import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api.js';
import { Button } from '../ui/button.js';
import { Input } from '../ui/input.js';
import { Label } from '../ui/label.js';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '../ui/dialog.js';
import {
  AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle,
  AlertDialogDescription, AlertDialogFooter, AlertDialogCancel, AlertDialogAction,
} from '../ui/alert-dialog.js';
import { toast } from '../../hooks/use-toast.js';
import { queryKeys } from '../../lib/query-keys.js';
import { FolderOpen, Network, Plus, X } from 'lucide-react';
import type { ContainerMountView, DataDirDto, MountSourceDto, ContainerView } from '@nyabase/common';
import { QueryErrorState, QueryLoadingState } from '../query-state.js';

type MountInput = {
  sourceKind: 'local' | 'remote';
  sourceId: string;
  dirName: string;
  containerPath: string;
};

export function MountsCard({
  serverId,
  containerId,
  isRunning,
  readonly = false,
  readonlyReason,
  apiBasePath = '/v2/containers',
  plane = 'user',
}: {
  serverId: string;
  containerId: string;
  isRunning: boolean;
  readonly?: boolean;
  readonlyReason?: string;
  apiBasePath?: string;
  plane?: 'admin' | 'user';
}) {
  const qc = useQueryClient();
  const [addOpen, setAddOpen] = useState(false);
  const [pendingRemoveIndex, setPendingRemoveIndex] = useState<number | null>(null);

  const mountsQuery = useQuery<ContainerMountView[]>({
    queryKey: ['container-mounts', plane, containerId],
    queryFn: () => api.get<ContainerView>(`${apiBasePath}/${containerId}`).then((c) => c.mounts),
  });
  const mounts = mountsQuery.data ?? [];

  const serverDirsQuery = useQuery<DataDirDto[]>({
    queryKey: queryKeys.dataDirs.byServer('user', serverId),
    queryFn: () => api.get<DataDirDto[]>(`/data-dirs?serverId=${serverId}`),
    enabled: addOpen && !readonly,
  });
  const serverDirs = serverDirsQuery.data ?? [];

  const mountSourcesQuery = useQuery<MountSourceDto[]>({
    queryKey: queryKeys.mountSources.byServer('user', serverId),
    queryFn: () => api.get<MountSourceDto[]>(`/mount-sources?serverId=${serverId}`),
    enabled: !readonly,
  });
  const mountSources = mountSourcesQuery.data ?? [];

  const patchMounts = useMutation({
    mutationFn: (newList: MountInput[]) =>
      api.post(`${apiBasePath}/${containerId}/actions/update-mounts`, newList),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['container-mounts', plane, containerId] });
      qc.invalidateQueries({ queryKey: queryKeys.containers.detail(plane, containerId) });
      toast({ title: isRunning ? '挂载更新已排队' : '挂载已保存（下次启动同步）' });
    },
    onError: (e) => toast({ title: '操作失败', description: e.message, variant: 'destructive' }),
  });

  const confirmRemove = () => {
    if (pendingRemoveIndex === null) return;
    const newList = mounts
      .filter((_, i) => i !== pendingRemoveIndex)
      .map((m): MountInput => ({
        sourceKind: m.sourceKind,
        sourceId: m.sourceId,
        dirName: m.dirName,
        containerPath: m.containerPath,
      }));
    patchMounts.mutate(newList);
    setPendingRemoveIndex(null);
  };

  const handleAdd = (entry: MountInput) => {
    const newList: MountInput[] = [
      ...mounts.map((m): MountInput => ({
        sourceKind: m.sourceKind,
        sourceId: m.sourceId,
        dirName: m.dirName,
        containerPath: m.containerPath,
      })),
      entry,
    ];
    patchMounts.mutate(newList);
    setAddOpen(false);
  };

  const sourceMap = new Map(mountSources.map((s) => [`${s.kind}:${s.id}`, s]));
  const mountedSourceKeys = new Set(
    mounts.map((m) => `${m.sourceKind}:${m.sourceId}:${m.dirName}`),
  );

  const pendingMount = pendingRemoveIndex !== null ? mounts[pendingRemoveIndex] : null;

  return (
    <div className="bg-card rounded-lg border border-border p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-foreground/90">数据目录挂载</h3>
        {!readonly && (
          <Button size="sm" variant="outline" onClick={() => setAddOpen(true)}>
            <Plus className="h-4 w-4" />添加
          </Button>
        )}
      </div>

      {readonly && readonlyReason && (
        <p className="mb-3 rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground">{readonlyReason}</p>
      )}

      {mountsQuery.isLoading ? (
        <QueryLoadingState label="加载挂载信息..." />
      ) : mountsQuery.error ? (
        <QueryErrorState
          error={mountsQuery.error}
          resourceName="容器挂载"
          onRetry={() => { void mountsQuery.refetch(); }}
        />
      ) : mounts.length === 0 ? (
        <p className="text-xs text-muted-foreground/70 italic">暂无挂载</p>
      ) : (
        <div className="space-y-2">
          {mounts.map((m, i) => {
            const src = sourceMap.get(`${m.sourceKind}:${m.sourceId}`);
            return (
              <div key={m.id}
                className="flex items-center justify-between gap-3 rounded-lg border border-border bg-muted/50 px-3 py-2">
                <div className="flex items-center gap-2.5 min-w-0">
                  {m.sourceKind === 'remote'
                    ? <Network className="h-3.5 w-3.5 text-primary shrink-0" />
                    : <FolderOpen className="h-3.5 w-3.5 text-muted-foreground shrink-0" />}
                  <div className="min-w-0">
                    <div className="text-xs font-medium text-foreground/90 truncate">
                      {src ? `${src.label} / ` : ''}{m.dirName}
                    </div>
                    <div className="text-xs text-muted-foreground/70 font-mono truncate">{m.containerPath}</div>
                  </div>
                </div>
                {!readonly && (
                  <Button size="icon" variant="ghost" className="h-8 w-8 text-red-400 hover:text-red-600 shrink-0"
                    disabled={patchMounts.isPending}
                    onClick={() => setPendingRemoveIndex(i)}>
                    <X className="h-3.5 w-3.5" />
                  </Button>
                )}
              </div>
            );
          })}
        </div>
      )}

      {!readonly && <AlertDialog open={pendingRemoveIndex !== null} onOpenChange={(v) => { if (!v) setPendingRemoveIndex(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>移除挂载</AlertDialogTitle>
            <AlertDialogDescription>
              确定要移除目录 &ldquo;{pendingMount?.dirName}&rdquo; 的挂载（容器路径：{pendingMount?.containerPath}）？
              {isRunning ? '即时生效。' : '下次启动时生效。'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={confirmRemove}
            >
              移除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>}

      {!readonly && <AddMountDialog
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onConfirm={handleAdd}
        serverDirs={serverDirs}
        mountSources={mountSources}
        mountedSourceKeys={mountedSourceKeys}
        isPending={patchMounts.isPending}
        isLoading={serverDirsQuery.isLoading || mountSourcesQuery.isLoading}
        error={serverDirsQuery.error ?? mountSourcesQuery.error}
        onRetry={() => { void Promise.all([serverDirsQuery.refetch(), mountSourcesQuery.refetch()]); }}
      />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Add mount dialog
// ---------------------------------------------------------------------------

function AddMountDialog({
  open,
  onClose,
  onConfirm,
  serverDirs,
  mountSources,
  mountedSourceKeys,
  isPending,
  isLoading,
  error,
  onRetry,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: (entry: MountInput) => void;
  serverDirs: DataDirDto[];
  mountSources: MountSourceDto[];
  mountedSourceKeys: Set<string>;
  isPending: boolean;
  isLoading: boolean;
  error: unknown;
  onRetry: () => void;
}) {
  const [dataDirPick, setDataDirPick] = useState('');
  const [containerPath, setContainerPath] = useState('');

  const sourceMap = new Map(mountSources.map((s) => [`${s.kind}:${s.id}`, s]));
  const dataDirKey = (d: DataDirDto) => `${d.sourceKind}:${d.sourceId}:${d.name}`;
  const activeDirs = serverDirs.filter((d) => d.desiredState === 'active');
  const uniqueDirs = activeDirs.filter(
    (d, i) => activeDirs.findIndex((x) => dataDirKey(x) === dataDirKey(d)) === i,
  );
  const formatLabel = (d: DataDirDto) => {
    const src = sourceMap.get(`${d.sourceKind}:${d.sourceId}`);
    return src ? `${src.label} / ${d.name}` : `${d.sourceKind === 'local' ? '本地' : '远程'} / ${d.name}`;
  };

  const selectedDir = dataDirPick !== '' ? uniqueDirs[parseInt(dataDirPick, 10)] : undefined;
  const alreadyMounted = selectedDir ? mountedSourceKeys.has(dataDirKey(selectedDir)) : false;
  const canConfirm = !!selectedDir && !alreadyMounted && containerPath.trim().length > 0;

  const reset = () => { setDataDirPick(''); setContainerPath(''); };

  const handleConfirm = () => {
    if (!selectedDir || !containerPath.trim()) return;
    onConfirm({
      sourceKind: selectedDir.sourceKind,
      sourceId: selectedDir.sourceId,
      dirName: selectedDir.name,
      containerPath: containerPath.trim(),
    });
    reset();
  };

  const handleClose = () => { reset(); onClose(); };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && handleClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader><DialogTitle>添加数据目录挂载</DialogTitle></DialogHeader>
        <div className="space-y-4">
          {isLoading ? (
            <QueryLoadingState label="加载可用数据目录..." />
          ) : error ? (
            <QueryErrorState error={error} resourceName="可用数据目录" onRetry={onRetry} />
          ) : uniqueDirs.length === 0 ? (
            <p className="text-sm text-muted-foreground/70">暂无已注册的数据目录，请先在「数据目录」页面创建。</p>
          ) : (
            <>
              <div className="space-y-1.5">
                <Label className="text-sm">数据目录</Label>
                <select
                  className="flex h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                  value={dataDirPick}
                  onChange={(e) => setDataDirPick(e.target.value)}
                >
                  <option value="">选择数据目录</option>
                  {uniqueDirs.map((d, i) => {
                    const mounted = mountedSourceKeys.has(dataDirKey(d));
                    return (
                      <option key={dataDirKey(d)} value={String(i)} disabled={mounted}>
                        {formatLabel(d)}{mounted ? '（已挂载）' : ''}
                      </option>
                    );
                  })}
                </select>
              </div>
              <div className="space-y-1.5">
                <Label className="text-sm">容器内路径</Label>
                <Input
                  placeholder="/home/user/data"
                  value={containerPath}
                  onChange={(e) => setContainerPath(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && canConfirm && handleConfirm()}
                />
                <p className="text-xs text-muted-foreground/70">数据目录必须先登记；容器内挂载点由运行时处理</p>
              </div>
            </>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={handleClose}>取消</Button>
          <Button onClick={handleConfirm} disabled={!canConfirm || isPending || isLoading || Boolean(error)}>
            {isPending ? '添加中...' : '确认添加'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
