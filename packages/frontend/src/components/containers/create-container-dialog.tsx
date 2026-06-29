import { useState, useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api.js';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '../ui/dialog.js';
import { Button } from '../ui/button.js';
import { Input } from '../ui/input.js';
import { Label } from '../ui/label.js';
import { toast } from '../../hooks/use-toast.js';
import { formatBytes } from '../../lib/utils.js';
import { queryKeys } from '../../lib/query-keys.js';
import type { ServerDto, ImageDto, EffectiveAccessDto, DataDirDto, MountSourceDto, OperationRefResponse } from '@nyabase/common';
import { Plus, X, FolderOpen, Network, ChevronDown, ChevronUp } from 'lucide-react';

interface MountEntry {
  sourceKind: 'local' | 'remote';
  sourceId: string;
  dirName: string;
  containerPath: string;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** When the dialog opens, pre-select this server (must be online and granted). */
  defaultServerId?: string;
}

export function CreateContainerDialog({ open, onOpenChange, defaultServerId }: Props) {
  const qc = useQueryClient();
  const [form, setForm] = useState({
    serverId: '',
    imageId: '',
    name: '',
  });
  const [mounts, setMounts] = useState<MountEntry[]>([]);
  const [addMount, setAddMount] = useState<Partial<MountEntry>>({});
  const [dataDirPick, setDataDirPick] = useState<string>('');
  const [showAdvanced, setShowAdvanced] = useState(false);

  const { data: servers = [] } = useQuery({
    queryKey: queryKeys.servers.user, queryFn: () => api.get<ServerDto[]>('/servers'),
  });
  const { data: access } = useQuery({
    queryKey: ['me-access'],
    queryFn: () => api.get<EffectiveAccessDto>('/me/access'),
  });
  const { data: allImages = [] } = useQuery({
    queryKey: queryKeys.images.userActive, queryFn: () => api.get<ImageDto[]>('/images?activeOnly=true'),
  });
  const { data: serverDirs = [] } = useQuery<DataDirDto[]>({
    queryKey: queryKeys.dataDirs.byServer('user', form.serverId),
    queryFn: () => api.get<DataDirDto[]>(`/data-dirs?serverId=${form.serverId}`),
    enabled: !!form.serverId,
  });
  const { data: mountSources = [] } = useQuery<MountSourceDto[]>({
    queryKey: queryKeys.mountSources.byServer('user', form.serverId),
    queryFn: () => api.get<MountSourceDto[]>(`/mount-sources?serverId=${form.serverId}`),
    enabled: !!form.serverId,
  });

  useEffect(() => {
    if (!open) return;
    setMounts([]);
    setAddMount({});
    setDataDirPick('');
    setShowAdvanced(false);
    setForm((f) => ({ ...f, serverId: '', imageId: '' }));
  }, [open, defaultServerId]);

  useEffect(() => {
    setDataDirPick('');
    setAddMount({});
  }, [form.serverId]);

  const { mutate: create, isPending } = useMutation({
    mutationFn: () => {
      return api.post<OperationRefResponse>('/v2/containers', {
        serverId: form.serverId,
        imageId: form.imageId,
        name: form.name,
        dataDirs: mounts.length > 0 ? mounts : undefined,
      });
    },
    onSuccess: (res) => {
      toast({
        title: '容器创建已排队',
        description: res.operationId ? `操作 ${res.operationId.slice(0, 8)}` : '正在初始化，稍后刷新查看状态',
      });
      qc.invalidateQueries({ queryKey: queryKeys.containers.userList });
      onOpenChange(false);
    },
    onError: (e) => toast({ title: '创建失败', description: e.message, variant: 'destructive' }),
  });

  const sourceMap = new Map(mountSources.map((s) => [`${s.kind}:${s.id}`, s]));

  const formatDataDirLabel = (d: DataDirDto) => {
    const src = sourceMap.get(`${d.sourceKind}:${d.sourceId}`);
    if (src) return `${src.label} / ${d.name}`;
    return `${d.sourceKind === 'local' ? '本地' : '远程'} / ${d.name}`;
  };

  const mountSourceKey = (m: Pick<MountEntry, 'sourceKind' | 'sourceId' | 'dirName'>) =>
    `${m.sourceKind}:${m.sourceId}:${m.dirName}`;
  const dataDirSourceKey = (d: DataDirDto) => `${d.sourceKind}:${d.sourceId}:${d.name}`;
  const uniqueServerDirs = serverDirs.filter(
    (d, i) => serverDirs.findIndex((x) => dataDirSourceKey(x) === dataDirSourceKey(d)) === i,
  );
  const mountedSourceKeys = new Set(mounts.map(mountSourceKey));
  const selectedDataDir = dataDirPick === '' ? undefined : uniqueServerDirs[parseInt(dataDirPick, 10)];
  const selectedDataDirAlreadyMounted = selectedDataDir ? mountedSourceKeys.has(mountSourceKey({
    sourceKind: selectedDataDir.sourceKind,
    sourceId: selectedDataDir.sourceId,
    dirName: selectedDataDir.name,
  })) : false;

  const addMountEntry = () => {
    if (!addMount.sourceKind || !addMount.sourceId || !addMount.dirName || !addMount.containerPath) return;
    const mountEntry: MountEntry = {
      sourceKind: addMount.sourceKind,
      sourceId: addMount.sourceId,
      dirName: addMount.dirName,
      containerPath: addMount.containerPath,
    };
    if (mountedSourceKeys.has(mountSourceKey(mountEntry))) {
      toast({ title: '数据目录已挂载', description: '同一个容器不能重复挂载同一个数据目录', variant: 'destructive' });
      return;
    }
    setMounts((m) => [...m, mountEntry]);
    setAddMount({});
    setDataDirPick('');
  };

  const set = (k: keyof typeof form, v: string) => setForm((f) => ({ ...f, [k]: v }));

  const accessibleServerIds = new Set(access?.servers.map((s) => s.serverId) ?? []);
  const onlineServers = servers.filter(
    (s) => s.status === 'online' && accessibleServerIds.has(s.id),
  );
  const onlineServerIds = onlineServers.map((server) => server.id).join('|');

  useEffect(() => {
    if (!open) return;
    const validServerIds = new Set(onlineServerIds ? onlineServerIds.split('|') : []);
    if (form.serverId && !validServerIds.has(form.serverId)) {
      setForm((f) => ({ ...f, serverId: '', imageId: '' }));
      return;
    }
    if (!form.serverId && defaultServerId && validServerIds.has(defaultServerId)) {
      setForm((f) => ({ ...f, serverId: defaultServerId, imageId: '' }));
    }
  }, [open, form.serverId, defaultServerId, onlineServerIds]);

  const serverAccess = access?.servers.find((s) => s.serverId === form.serverId);
  const allowedImageIds = new Set(serverAccess?.allowedImageIds ?? []);
  const availableImages = form.serverId
    ? allImages.filter((img) => allowedImageIds.has(img.id))
    : allImages;

  const canCreate = form.serverId && form.imageId && form.name && !isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>新建容器</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {/* Server & Image */}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label className="text-sm text-foreground/90">服务器 <span className="text-red-500">*</span></Label>
              <select
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                value={form.serverId}
                onChange={(e) => { set('serverId', e.target.value); set('imageId', ''); }}
              >
                <option value="">选择服务器</option>
                {onlineServers.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
                {onlineServers.length === 0 && (
                  <option disabled>暂无可用服务器或授权</option>
                )}
              </select>
            </div>

            <div className="space-y-1.5">
              <Label className="text-sm text-foreground/90">镜像 <span className="text-red-500">*</span></Label>
              <select
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                value={form.imageId}
                onChange={(e) => set('imageId', e.target.value)}
                disabled={!form.serverId}
              >
                <option value="">{form.serverId ? '选择镜像' : '先选服务器'}</option>
                {availableImages.map((img) => (
                  <option key={img.id} value={img.id}>{img.name}</option>
                ))}
                {form.serverId && availableImages.length === 0 && (
                  <option disabled>此服务器暂无可用镜像授权</option>
                )}
              </select>
              {onlineServers.length === 0 && (
                <p className="text-xs text-muted-foreground/70">
                  当前账号没有可用于创建容器的在线服务器授权，请联系管理员分配服务器和镜像权限。
                </p>
              )}
            </div>
          </div>

          {/* Name */}
          <div className="space-y-1.5">
            <Label className="text-sm text-foreground/90">容器名称 <span className="text-red-500">*</span></Label>
            <Input
              placeholder="my-dev-env"
              value={form.name}
              onChange={(e) => set('name', e.target.value)}
            />
            <p className="text-xs text-muted-foreground/70">只能包含小写字母、数字、连字符</p>
          </div>

          {/* Advanced options — collapsible */}
          <div className="rounded-lg border border-border">
            <button
              type="button"
              className="w-full flex items-center justify-between px-3 py-2.5 text-sm font-medium text-muted-foreground hover:bg-accent rounded-lg transition-colors"
              onClick={() => setShowAdvanced((v) => !v)}
            >
              <span>高级选项</span>
              {showAdvanced
                ? <ChevronUp className="h-4 w-4 text-muted-foreground" />
                : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
            </button>

            {showAdvanced && (
              <div className="px-3 pb-3 space-y-3 border-t border-border pt-3">
                {serverAccess && (
                  <div className="bg-primary/10 rounded-lg p-3 text-xs text-primary">
                    <strong>磁盘配额：</strong>
                    {serverAccess.diskBytes > 0 ? ` ${formatBytes(serverAccess.diskBytes)}` : '不限'}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Data dir mounts — only already-registered dirs from 数据目录 */}
          {form.serverId && (serverDirs.length > 0 || mountSources.length > 0) && (
            <div className="space-y-2">
              <Label className="text-sm text-foreground/90">数据目录挂载（可选）</Label>

              {uniqueServerDirs.length === 0 && (
                <p className="text-xs text-muted-foreground/70">
                  暂无已注册的数据目录，请先在「数据目录」页面创建后再挂载。
                </p>
              )}

              {/* Existing mount list */}
              {mounts.length > 0 && (
                <div className="space-y-1.5 rounded-lg border border-border p-2">
                  {mounts.map((m, i) => (
                    <div key={i} className="flex items-center justify-between text-xs bg-muted/50 rounded px-2 py-1.5">
                      <span className="font-mono text-foreground/90 truncate">
                        {m.sourceKind === 'remote' ? <Network className="inline h-3 w-3 mr-1 text-primary" /> : <FolderOpen className="inline h-3 w-3 mr-1 text-muted-foreground" />}
                        {m.dirName} → {m.containerPath}
                      </span>
                      <Button size="icon" variant="ghost" className="h-8 w-8 text-muted-foreground hover:text-red-500 shrink-0"
                        onClick={() => setMounts((prev) => prev.filter((_, j) => j !== i))}>
                        <X className="h-4 w-4" />
                      </Button>
                    </div>
                  ))}
                </div>
              )}

              {uniqueServerDirs.length > 0 && (
                <>
              <select
                className="flex h-9 w-full rounded-md border border-input bg-background px-2 text-xs"
                value={dataDirPick}
                onChange={(e) => {
                  const v = e.target.value;
                  setDataDirPick(v);
                  if (v === '') {
                    setAddMount({});
                    return;
                  }
                  const idx = parseInt(v, 10);
                  const row = uniqueServerDirs[idx];
                  if (row) {
                    setAddMount({
                      sourceKind: row.sourceKind,
                      sourceId: row.sourceId,
                      dirName: row.name,
                    });
                  }
                }}
              >
                <option value="">选择数据目录</option>
                {uniqueServerDirs.map((d, i) => {
                  const alreadyMounted = mountedSourceKeys.has(dataDirSourceKey(d));
                  return (
                  <option key={`${d.sourceKind}-${d.sourceId}-${d.name}`} value={String(i)} disabled={alreadyMounted}>
                    {formatDataDirLabel(d)}{alreadyMounted ? '（已挂载）' : ''}
                  </option>
                  );
                })}
              </select>

              <div className="flex gap-2">
                <Input className="h-9 text-xs flex-1" placeholder="容器挂载路径 (如 /home/user/data)"
                  value={addMount.containerPath ?? ''}
                  onChange={(e) => setAddMount((a) => ({ ...a, containerPath: e.target.value }))} />
                <Button size="sm" className="h-9 shrink-0" variant="outline"
                  onClick={addMountEntry}
                  disabled={
                    dataDirPick === '' ||
                    selectedDataDirAlreadyMounted ||
                    !addMount.dirName ||
                    !addMount.containerPath
                  }>
                  <Plus className="h-3.5 w-3.5 mr-1" />添加
                </Button>
              </div>
              <p className="text-xs text-muted-foreground/70">
                数据目录必须先登记；容器内挂载点由运行时处理。
              </p>
                </>
              )}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
          <Button onClick={() => create()} disabled={!canCreate}>
            {isPending ? (
              <span className="flex items-center gap-2">
                <span className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                创建中...
              </span>
            ) : '创建容器'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
