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
import { zCreateContainerRequest, type AgentTaskRefResponse, type UserServerDto, type ImageDto, type EffectiveAccessDto, type DataDirDto, type MountSourceDto, type CreateContainerRequest } from '@nyabase/common';
import { Plus, X, FolderOpen, Network, ChevronDown, ChevronUp, RefreshCw } from 'lucide-react';

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

const emptyForm = {
  serverId: '',
  imageId: '',
  name: '',
};

type FormFieldName = keyof typeof emptyForm;
type FormErrors = Partial<Record<FormFieldName, string>>;

export function CreateContainerDialog({ open, onOpenChange, defaultServerId }: Props) {
  const qc = useQueryClient();
  const [form, setForm] = useState(emptyForm);
  const [formErrors, setFormErrors] = useState<FormErrors>({});
  const [mounts, setMounts] = useState<MountEntry[]>([]);
  const [addMount, setAddMount] = useState<Partial<MountEntry>>({});
  const [dataDirPick, setDataDirPick] = useState<string>('');
  const [showAdvanced, setShowAdvanced] = useState(false);

  const serversQuery = useQuery({
    queryKey: queryKeys.servers.user, queryFn: () => api.get<UserServerDto[]>('/servers'),
  });
  const accessQuery = useQuery({
    queryKey: ['me-access'],
    queryFn: () => api.get<EffectiveAccessDto>('/me/access'),
  });
  const imagesQuery = useQuery({
    queryKey: queryKeys.images.userActive, queryFn: () => api.get<ImageDto[]>('/images?activeOnly=true'),
  });
  const serverDirsQuery = useQuery<DataDirDto[]>({
    queryKey: queryKeys.dataDirs.byServer('user', form.serverId),
    queryFn: () => api.get<DataDirDto[]>(`/data-dirs?serverId=${form.serverId}`),
    enabled: !!form.serverId,
  });
  const mountSourcesQuery = useQuery<MountSourceDto[]>({
    queryKey: queryKeys.mountSources.byServer('user', form.serverId),
    queryFn: () => api.get<MountSourceDto[]>(`/mount-sources?serverId=${form.serverId}`),
    enabled: !!form.serverId,
  });

  const servers = serversQuery.data ?? [];
  const access = accessQuery.data;
  const allImages = imagesQuery.data ?? [];
  const serverDirs = serverDirsQuery.data ?? [];
  const mountSources = mountSourcesQuery.data ?? [];

  const resetDialogState = () => {
    setForm(emptyForm);
    setFormErrors({});
    setMounts([]);
    setAddMount({});
    setDataDirPick('');
    setShowAdvanced(false);
  };

  useEffect(() => {
    if (!open) resetDialogState();
  }, [open]);

  useEffect(() => {
    setMounts([]);
    setDataDirPick('');
    setAddMount({});
  }, [form.serverId]);

  const { mutate: create, isPending } = useMutation({
    mutationFn: (payload: CreateContainerRequest) => api.post<AgentTaskRefResponse>('/v2/containers', payload),
    onSuccess: (res) => {
      toast({
        title: '容器创建已排队',
        description: res.taskId ? `任务 ${res.taskId.slice(0, 8)}` : '正在初始化，稍后刷新查看状态',
      });
      qc.invalidateQueries({ queryKey: queryKeys.containers.userList });
      resetDialogState();
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
  const activeServerDirs = serverDirs.filter((d) => d.desiredState === 'active');
  const uniqueServerDirs = activeServerDirs.filter(
    (d, i) => activeServerDirs.findIndex((x) => dataDirSourceKey(x) === dataDirSourceKey(d)) === i,
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
    const normalizedPath = normalizeContainerMountPath(addMount.containerPath);
    if (!normalizedPath) {
      toast({ title: '挂载路径无效', description: '容器内路径必须是非根绝对路径，且不能包含 . 或 .. 路径段', variant: 'destructive' });
      return;
    }
    const mountEntry: MountEntry = {
      sourceKind: addMount.sourceKind,
      sourceId: addMount.sourceId,
      dirName: addMount.dirName,
      containerPath: normalizedPath,
    };
    if (mountedSourceKeys.has(mountSourceKey(mountEntry))) {
      toast({ title: '数据目录已挂载', description: '同一个容器不能重复挂载同一个数据目录', variant: 'destructive' });
      return;
    }
    if (mounts.some((mount) => mount.containerPath === normalizedPath)) {
      toast({ title: '挂载路径已占用', description: '同一个容器内路径只能挂载一个数据目录', variant: 'destructive' });
      return;
    }
    setMounts((m) => [...m, mountEntry]);
    setAddMount({});
    setDataDirPick('');
  };

  const set = (k: keyof typeof form, v: string) => {
    setForm((f) => ({ ...f, [k]: v }));
    setFormErrors((errors) => withoutFieldError(errors, k));
  };

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) resetDialogState();
    onOpenChange(nextOpen);
  };

  const handleCreate = () => {
    const result = validateCreateForm(form, mounts);
    setFormErrors(result.errors);
    if (!result.payload) {
      toast({
        title: '请检查容器字段',
        description: result.message,
        variant: 'destructive',
      });
      return;
    }
    create(result.payload);
  };

  const accessibleServerIds = new Set(
    (access?.servers ?? [])
      .filter((s) => s.accessPhase === 'full')
      .map((s) => s.serverId),
  );
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

  const canCreate = Boolean(form.serverId && form.imageId && form.name && !isPending);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>新建容器</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            {serversQuery.isError && (
              <QueryErrorNotice title="服务器列表加载失败" error={serversQuery.error} onRetry={() => serversQuery.refetch()} isRetrying={serversQuery.isFetching} />
            )}
            {accessQuery.isError && (
              <QueryErrorNotice title="权限信息加载失败" error={accessQuery.error} onRetry={() => accessQuery.refetch()} isRetrying={accessQuery.isFetching} />
            )}
            {imagesQuery.isError && (
              <QueryErrorNotice title="镜像列表加载失败" error={imagesQuery.error} onRetry={() => imagesQuery.refetch()} isRetrying={imagesQuery.isFetching} />
            )}
          </div>

          {/* Server & Image */}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="create-container-server" className="text-sm text-foreground/90">服务器 <span className="text-red-500">*</span></Label>
              <select
                id="create-container-server"
                className={`flex h-10 w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring ${formErrors.serverId ? 'border-destructive' : 'border-input'}`}
                value={form.serverId}
                onChange={(e) => {
                  set('serverId', e.target.value);
                  set('imageId', '');
                  setMounts([]);
                  setDataDirPick('');
                  setAddMount({});
                }}
                aria-invalid={!!formErrors.serverId}
                aria-describedby={formErrors.serverId ? 'create-container-server-error' : undefined}
              >
                <option value="">选择服务器</option>
                {onlineServers.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
                {onlineServers.length === 0 && (
                  <option disabled>暂无可用服务器或授权</option>
                )}
              </select>
              {formErrors.serverId && <p id="create-container-server-error" className="text-xs text-destructive">{formErrors.serverId}</p>}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="create-container-image" className="text-sm text-foreground/90">镜像 <span className="text-red-500">*</span></Label>
              <select
                id="create-container-image"
                className={`flex h-10 w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring ${formErrors.imageId ? 'border-destructive' : 'border-input'}`}
                value={form.imageId}
                onChange={(e) => set('imageId', e.target.value)}
                disabled={!form.serverId}
                aria-invalid={!!formErrors.imageId}
                aria-describedby={formErrors.imageId ? 'create-container-image-error' : undefined}
              >
                <option value="">{form.serverId ? '选择镜像' : '先选服务器'}</option>
                {availableImages.map((img) => (
                  <option key={img.id} value={img.id}>{img.name}</option>
                ))}
                {form.serverId && availableImages.length === 0 && (
                  <option disabled>此服务器暂无可用镜像授权</option>
                )}
              </select>
              {formErrors.imageId && <p id="create-container-image-error" className="text-xs text-destructive">{formErrors.imageId}</p>}
              {onlineServers.length === 0 && (
                <p className="text-xs text-muted-foreground/70">
                  当前账号没有可用于创建容器的在线服务器授权，请联系管理员分配服务器和镜像权限。
                </p>
              )}
            </div>
          </div>

          {/* Name */}
          <div className="space-y-1.5">
            <Label htmlFor="create-container-name" className="text-sm text-foreground/90">容器名称 <span className="text-red-500">*</span></Label>
            <Input
              id="create-container-name"
              placeholder="my-dev-env"
              value={form.name}
              onChange={(e) => set('name', e.target.value)}
              aria-invalid={!!formErrors.name}
              aria-describedby={formErrors.name ? 'create-container-name-error' : 'create-container-name-help'}
              className={formErrors.name ? 'border-destructive focus-visible:ring-destructive' : undefined}
            />
            {formErrors.name && <p id="create-container-name-error" className="text-xs text-destructive">{formErrors.name}</p>}
            <p id="create-container-name-help" className="text-xs text-muted-foreground/70">只能包含小写字母、数字、下划线或连字符，最长 64 个字符</p>
          </div>

          {/* Advanced options — collapsible */}
          <div className="rounded-lg border border-border">
            <button
              type="button"
              className="w-full flex items-center justify-between px-3 py-2.5 text-sm font-medium text-muted-foreground hover:bg-accent rounded-lg transition-colors"
              onClick={() => setShowAdvanced((v) => !v)}
              aria-expanded={showAdvanced}
              aria-controls="create-container-advanced-panel"
            >
              <span>高级选项</span>
              {showAdvanced
                ? <ChevronUp className="h-4 w-4 text-muted-foreground" />
                : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
            </button>

            {showAdvanced && (
              <div id="create-container-advanced-panel" className="px-3 pb-3 space-y-3 border-t border-border pt-3">
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
          {form.serverId && (
            <div className="space-y-2">
              <div className="text-sm font-medium leading-none text-foreground/90">数据目录挂载（可选）</div>
              <div className="space-y-2">
                {serverDirsQuery.isError && (
                  <QueryErrorNotice title="数据目录加载失败" error={serverDirsQuery.error} onRetry={() => serverDirsQuery.refetch()} isRetrying={serverDirsQuery.isFetching} />
                )}
                {mountSourcesQuery.isError && (
                  <QueryErrorNotice title="挂载源加载失败" error={mountSourcesQuery.error} onRetry={() => mountSourcesQuery.refetch()} isRetrying={mountSourcesQuery.isFetching} />
                )}
              </div>

              {(serverDirsQuery.isLoading || mountSourcesQuery.isLoading) && (
                <p className="text-xs text-muted-foreground/70">正在加载可用数据目录...</p>
              )}

              {uniqueServerDirs.length === 0
                && !serverDirsQuery.isLoading
                && !mountSourcesQuery.isLoading
                && !serverDirsQuery.isError
                && !mountSourcesQuery.isError && (
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
                        aria-label={`移除挂载 ${m.dirName}`}
                        onClick={() => setMounts((prev) => prev.filter((_, j) => j !== i))}>
                        <X className="h-4 w-4" />
                      </Button>
                    </div>
                  ))}
                </div>
              )}

              {uniqueServerDirs.length > 0 && (
                <>
                  <Label htmlFor="create-container-data-dir" className="text-xs text-muted-foreground">数据目录</Label>
                  <select
                    id="create-container-data-dir"
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
                    <Label htmlFor="create-container-mount-path" className="sr-only">容器挂载路径</Label>
                    <Input id="create-container-mount-path" className="h-9 text-xs flex-1" placeholder="容器挂载路径 (如 /home/user/data)"
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
          <Button variant="outline" onClick={() => handleOpenChange(false)} disabled={isPending}>取消</Button>
          <Button onClick={handleCreate} disabled={!canCreate}>
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

function validateCreateForm(form: typeof emptyForm, mounts: MountEntry[]): { errors: FormErrors; payload: CreateContainerRequest | null; message: string } {
  const errors: FormErrors = {};
  const name = form.name.trim();

  if (!form.serverId) errors.serverId = '请选择服务器';
  if (!form.imageId) errors.imageId = '请选择镜像';

  const nameResult = zCreateContainerRequest.shape.name.safeParse(name);
  if (!nameResult.success) {
    errors.name = '容器名称只能包含小写字母、数字、下划线或连字符，最长 64 个字符';
  }

  const normalizedMounts = mounts.map((mount) => ({
    ...mount,
    containerPath: normalizeContainerMountPath(mount.containerPath),
  }));
  if (normalizedMounts.some((mount) => !mount.containerPath)) {
    return { errors, payload: null, message: '挂载路径必须是非根绝对路径，且不能包含 . 或 .. 路径段' };
  }
  const pathKeys = normalizedMounts.map((mount) => mount.containerPath as string);
  if (new Set(pathKeys).size !== pathKeys.length) {
    return { errors, payload: null, message: '同一个容器内路径只能挂载一个数据目录' };
  }

  const payload = {
    serverId: form.serverId,
    imageId: form.imageId,
    name,
    dataDirs: normalizedMounts.length > 0
      ? normalizedMounts.map((mount) => ({ ...mount, containerPath: mount.containerPath as string }))
      : undefined,
  };
  const parsed = zCreateContainerRequest.safeParse(payload);
  if (!parsed.success) {
    const dataDirIssue = parsed.error.issues.find((issue) => issue.path[0] === 'dataDirs');
    if (dataDirIssue) {
      return {
        errors,
        payload: null,
        message: dataDirIssue.path.includes('containerPath')
          ? '挂载路径必须以 / 开头'
          : dataDirIssue.message,
      };
    }
  }

  const message = firstError(errors) ?? '请修正高亮字段后再创建';
  if (Object.keys(errors).length > 0) return { errors, payload: null, message };
  if (!parsed.success) return { errors, payload: null, message: parsed.error.issues[0]?.message ?? '请检查表单字段' };
  return { errors, payload: parsed.data, message: '' };
}

function normalizeContainerMountPath(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed.startsWith('/')) return null;
  const parts = trimmed.split('/').filter(Boolean);
  if (parts.length === 0 || parts.some((part) => part === '.' || part === '..')) return null;
  return `/${parts.join('/')}`;
}

function withoutFieldError<T extends string>(errors: Partial<Record<T, string>>, field: T): Partial<Record<T, string>> {
  const next = { ...errors };
  delete next[field];
  return next;
}

function firstError(errors: Record<string, string | undefined>): string | undefined {
  return Object.values(errors).find(Boolean);
}

function QueryErrorNotice({ title, error, onRetry, isRetrying }: { title: string; error: unknown; onRetry: () => void; isRetrying: boolean }) {
  return (
    <div className="rounded-md border border-destructive/30 bg-destructive/10 px-2.5 py-2 text-xs text-destructive">
      <div className="flex items-center justify-between gap-2">
        <span><span className="font-medium">{title}</span>：{errorMessage(error)}</span>
        <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-destructive" onClick={onRetry} disabled={isRetrying}>
          <RefreshCw className={`h-3.5 w-3.5 ${isRetrying ? 'animate-spin' : ''}`} />
          重试
        </Button>
      </div>
    </div>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '请稍后重试';
}
