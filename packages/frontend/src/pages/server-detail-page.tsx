import { Link, getRouteApi } from '@tanstack/react-router';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, useEffect } from 'react';
import { api } from '../lib/api.js';
import { Button } from '../components/ui/button.js';
import { Input } from '../components/ui/input.js';
import { Label } from '../components/ui/label.js';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '../components/ui/dialog.js';
import {
  AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle,
  AlertDialogDescription, AlertDialogFooter, AlertDialogCancel, AlertDialogAction,
} from '../components/ui/alert-dialog.js';
import { Separator } from '../components/ui/separator.js';
import { toast } from '../hooks/use-toast.js';
import { formatBytes, relativeTime, dataDiskDisplayName } from '../lib/utils.js';
import { queryKeys } from '../lib/query-keys.js';
import { HardDrive, Plus, Trash2, Cpu, ArrowLeft, Wifi, WifiOff, RefreshCw, Settings, Pencil, ShieldCheck, CheckCircle2, XCircle, AlertTriangle, Play, Container } from 'lucide-react';
import { GpuGrantMode, Capability, DockerDaemonState } from '@nyabase/common';
import type { ServerDto, DataDiskDto, SelfCheckResult, SelfCheckItem, DockerDaemonStatus, DataDirIssueDto } from '@nyabase/common';
import { useAuthStore } from '../store/auth.js';
import {
  ResourceGrantForm, ResourceFormValue,
  serverDefaultsToForm, formToServerDefaultsPayload,
} from '../components/resource-grant-form.js';
import { HostSection, GpuSection, TimeRangeSelector } from '../components/dashboard/server-metrics.js';

const routeApi = getRouteApi('/servers/$id');
type DiskOperationResponse = DataDiskDto & { operationId?: string; status?: string };
type OperationRef = { ok: true; operationId?: string; status?: string };

export default function ServerDetailPage() {
  const { id } = routeApi.useParams();
  const { user } = useAuthStore();
  const canManage = user?.capabilities.includes(Capability.ManageServers) ?? false;
  const canManageContainers = user?.capabilities.includes(Capability.ManageContainersAny) ?? false;
  const qc = useQueryClient();
  const [showAddDisk, setShowAddDisk] = useState(false);
  const [showEditServer, setShowEditServer] = useState(false);
  const [editingDisk, setEditingDisk] = useState<DataDiskDto | null>(null);
  const [regenerating, setRegenerating] = useState(false);
  const [newToken, setNewToken] = useState<string | null>(null);
  const [showRegenConfirm, setShowRegenConfirm] = useState(false);

  const { data: server } = useQuery({
    queryKey: queryKeys.servers.detail(id),
    queryFn: () => api.get<ServerDto>(`/admin/servers/${id}`),
    refetchInterval: 15_000,
  });

  const { data: disks = [] } = useQuery({
    queryKey: queryKeys.servers.disks('admin', id),
    queryFn: () => api.get<DataDiskDto[]>(`/admin/servers/${id}/disks`),
    refetchInterval: 15_000,
  });

  const removeDisk = useMutation({
    mutationFn: (diskId: string) => api.delete<OperationRef>(`/admin/servers/${id}/disks/${diskId}`),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: queryKeys.servers.disks('admin', id) });
      toast({
        title: '数据盘移除已排队',
        description: res.operationId ? `操作 ${res.operationId.slice(0, 8)}` : undefined,
      });
    },
    onError: (e) => toast({ title: '操作失败', description: e.message, variant: 'destructive' }),
  });

  const regenerateToken = async () => {
    setRegenerating(true);
    try {
      const res = await api.post<{ token: string }>(`/admin/servers/${id}/regenerate-token`);
      setNewToken(res.token);
    } catch (e) {
      toast({ title: '失败', description: (e as Error).message, variant: 'destructive' });
    } finally {
      setRegenerating(false);
    }
  };

  if (!server) return (
    <div className="px-4 py-4 md:px-6 flex items-center gap-2 text-muted-foreground/70">
      <div className="w-4 h-4 border-2 border-muted border-t-primary rounded-full animate-spin" />
      加载中...
    </div>
  );

  const online = server.status === 'online';
  const statusLabel = online ? '在线' : server.status === 'offline' ? '离线' : '未知';
  const networkSummary = [server.slug, server.ipCidr].filter(Boolean).join(' · ');
  const gpus = server.gpus ?? [];

  return (
    <div className="px-4 py-4 md:px-6 space-y-5 w-full">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-3">
          <Link to="/servers">
            <Button variant="outline" size="icon" className="h-8 w-8">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-foreground">{server.name}</h1>
            <p className="text-sm text-muted-foreground/70 font-mono mt-0.5">{networkSummary || '-'}</p>
          </div>
        </div>
        <div className={`flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-full font-medium
          ${online ? 'bg-green-50 text-green-700 border border-green-200'
            : server.status === 'offline' ? 'bg-red-50 text-red-600 border border-red-200'
            : 'bg-muted text-muted-foreground border border-border'}`}>
          {online ? <Wifi className="h-4 w-4" /> : <WifiOff className="h-4 w-4" />}
          {statusLabel}
        </div>
      </div>

      {/* Info grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <InfoCard
          title="配置信息"
          action={canManage ? (
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setShowEditServer(true)}>
              <Pencil className="h-4 w-4 text-muted-foreground" />
            </Button>
          ) : undefined}
        >
          <InfoRow label="名称" value={server.name} />
          <InfoRow label="路由标识" value={server.slug} mono />
          <InfoRow label="物理网卡" value={server.parentIface} mono />
          <InfoRow label="CIDR" value={server.ipCidr} mono />
          <InfoRow label="网关" value={server.gateway} mono />
          <InfoRow label="最近活跃" value={relativeTime(server.lastSeenAt)} />
          {canManage && (
            <div className="pt-2 mt-2">
              <Button
                variant="outline" size="sm"
                onClick={() => setShowRegenConfirm(true)} disabled={regenerating}
              >
                <RefreshCw className={`h-4 w-4 ${regenerating ? 'animate-spin' : ''}`} />
                重新生成 Agent 令牌
              </Button>
            </div>
          )}
        </InfoCard>

        {canManage && <DockerDaemonCard serverId={id} online={online} daemonStatus={server.dockerDaemon ?? null} />}

        {gpus.length > 0 && (
          <InfoCard title="GPU" icon={<Cpu className="h-4 w-4 text-purple-500" />}>
            <div className="space-y-2">
              {gpus.map((g) => (
                <div key={g.index} className="flex items-center justify-between py-1">
                  <div className="flex items-center gap-2">
                    <span className="text-xs bg-purple-500/15 text-purple-700 dark:text-purple-300 px-1.5 py-0.5 rounded font-mono">
                      #{g.index}
                    </span>
                    <span className="text-sm text-foreground/90">{g.model}</span>
                  </div>
                  <span className="text-xs text-muted-foreground/70">{g.totalMemMiB} MiB</span>
                </div>
              ))}
            </div>
          </InfoCard>
        )}
      </div>

      {/* New token display — terminal-style dark chip kept fixed across themes */}
      {newToken && (
        <div className="bg-amber-500/10 dark:bg-amber-500/15 border border-amber-500/30 rounded-lg p-4">
          <div className="text-sm font-medium text-amber-800 dark:text-amber-300 mb-2">新 Agent 令牌（仅显示一次）</div>
          {/* terminal-style: literal dark colors required for green-on-black look */}
          <div className="bg-zinc-900 rounded-lg p-3 text-xs text-green-400 font-mono break-all mb-2">
            {newToken}
          </div>
          <div className="flex gap-2">
            <Button size="sm" variant="outline"
              onClick={() => navigator.clipboard.writeText(newToken)}>
              复制令牌
            </Button>
            <Button size="sm" variant="ghost"
              onClick={() => setNewToken(null)}>
              关闭
            </Button>
          </div>
        </div>
      )}

      <div className={`grid grid-cols-1 gap-4 items-start ${canManage ? 'lg:grid-cols-3' : ''}`}>
        <DataDisksCard
          disks={disks}
          canManage={canManage}
          canManageContainers={canManageContainers}
          onAdd={() => setShowAddDisk(true)}
          onEdit={setEditingDisk}
          onRemove={(diskId) => removeDisk.mutate(diskId)}
        />
        {canManage && <ServerDefaultsCard server={server} serverId={id} />}
        {canManage && <SelfCheckCard serverId={id} online={online} />}
      </div>

      {/* Host & GPU metrics */}
      {online && <ServerMetricsSection serverId={id} isGpuServer={server.isGpuServer} />}

      {canManage && <AddDiskDialog serverId={id} open={showAddDisk} onOpenChange={setShowAddDisk} />}
      {canManage && (
        <EditDiskDialog
          serverId={id}
          disk={editingDisk}
          open={editingDisk !== null}
          onOpenChange={(v) => { if (!v) setEditingDisk(null); }}
        />
      )}
      {canManage && <EditServerDialog server={server} open={showEditServer} onOpenChange={setShowEditServer} />}

      <AlertDialog open={showRegenConfirm} onOpenChange={setShowRegenConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>重新生成 Agent 令牌</AlertDialogTitle>
            <AlertDialogDescription>
              重新生成后，旧 agent 令牌立即失效，需要更新服务器上的 agent 配置。确定继续？
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction onClick={() => { setShowRegenConfirm(false); void regenerateToken(); }}>
              确定重新生成
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function ServerMetricsSection({ serverId, isGpuServer }: { serverId: string; isGpuServer: boolean }) {
  const [range, setRange] = useState('1h');
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <Separator className="flex-1 mr-4" />
        <TimeRangeSelector value={range} onChange={setRange} />
      </div>
      <HostSection serverId={serverId} range={range} admin />
      {isGpuServer && <GpuSection serverId={serverId} range={range} admin />}
    </div>
  );
}

function DockerDaemonCard({
  serverId, online, daemonStatus,
}: {
  serverId: string;
  online: boolean;
  daemonStatus: DockerDaemonStatus | null;
}) {
  const qc = useQueryClient();
  const { mutate, isPending } = useMutation({
    mutationFn: () => api.post<DockerDaemonStatus>(`/admin/servers/${serverId}/docker-daemon/reconcile`),
    onSuccess: (fresh) => {
      qc.setQueryData(queryKeys.servers.detail(serverId), (old: ServerDto | undefined) =>
        old ? { ...old, dockerDaemon: fresh } : old,
      );
      toast({ title: 'Docker 守护进程协调完成' });
    },
    onError: (e) => toast({ title: '协调失败', description: e.message, variant: 'destructive' }),
  });

  const stateColor = (s: DockerDaemonStatus | null) => {
    if (!s) return 'bg-muted text-muted-foreground border-border';
    switch (s.state) {
      case DockerDaemonState.Active: return 'bg-green-50 text-green-700 border-green-200';
      case DockerDaemonState.Failed: return 'bg-red-50 text-red-600 border-red-200';
      case DockerDaemonState.Activating: return 'bg-yellow-50 text-yellow-700 border-yellow-200';
      case DockerDaemonState.Inactive: return 'bg-orange-50 text-orange-600 border-orange-200';
      default: return 'bg-muted text-muted-foreground border-border';
    }
  };

  const stateLabel = (s: DockerDaemonStatus | null) => {
    if (!s) return '未知';
    switch (s.state) {
      case DockerDaemonState.Active: return '运行中';
      case DockerDaemonState.Failed: return '失败';
      case DockerDaemonState.Activating: return '启动中';
      case DockerDaemonState.Inactive: return '已停止';
      default: return '未知';
    }
  };

  return (
    <div className="bg-card rounded-lg border border-border p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2 text-sm font-medium text-foreground/90">
          <Container className="h-4 w-4 text-muted-foreground" />Docker 守护进程
        </div>
        <div className="flex items-center gap-2">
          {daemonStatus && (
            <span className={`text-xs px-2 py-0.5 rounded-full border font-medium ${stateColor(daemonStatus)}`}>
              {stateLabel(daemonStatus)}
            </span>
          )}
          <Button
            size="sm" variant="outline"
            onClick={() => mutate()}
            disabled={isPending || !online}
            title={!online ? 'Agent 离线，无法协调' : '重新检查并同步 systemd unit 文件'}
          >
            <RefreshCw className={`h-4 w-4 ${isPending ? 'animate-spin' : ''}`} />
            {isPending ? '协调中...' : '重新协调'}
          </Button>
        </div>
      </div>

      {!daemonStatus && (
        <div className="text-sm text-muted-foreground/70 text-center py-2">
          {online ? 'Agent 已连接，等待状态上报...' : 'Agent 离线'}
        </div>
      )}

      {daemonStatus && (
        <div className="space-y-0.5 text-sm">
          <DaemonRow label="Unit 文件" value={daemonStatus.unitFileInSync ? '已同步' : '配置漂移'} highlight={!daemonStatus.unitFileInSync} />
          <DaemonRow label="开机自启" value={daemonStatus.enabled ? '已启用' : '未启用'} highlight={!daemonStatus.enabled} />
          <DaemonRow label="服务端版本" value={daemonStatus.serverVersion ?? '—'} />
          <DaemonRow label="存储驱动" value={daemonStatus.storageDriver ?? '—'} mono />
          <DaemonRow label="PID" value={daemonStatus.pid !== null ? String(daemonStatus.pid) : '—'} mono />
          <DaemonRow label="Docker 根目录" value={daemonStatus.dockerRoot} mono />
          <DaemonRow label="套接字路径" value={daemonStatus.socketPath} mono />
          {daemonStatus.lastError && (
            <div className="mt-2 text-xs bg-red-50 text-red-700 border border-red-200 rounded-lg px-3 py-2 break-all">
              {daemonStatus.lastError}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function DaemonRow({ label, value, mono, highlight }: { label: string; value: string; mono?: boolean; highlight?: boolean }) {
  return (
    <div className="flex justify-between py-1.5 border-b border-border last:border-0 gap-2">
      <span className="text-muted-foreground shrink-0">{label}</span>
      <span className={`text-right break-all ${mono ? 'font-mono text-xs' : ''} ${highlight ? 'text-amber-600 font-medium' : 'text-foreground/90'}`}>
        {value}
      </span>
    </div>
  );
}

function DataDisksCard({
  disks,
  canManage,
  canManageContainers,
  onAdd,
  onEdit,
  onRemove,
}: {
  disks: DataDiskDto[];
  canManage: boolean;
  canManageContainers: boolean;
  onAdd: () => void;
  onEdit: (disk: DataDiskDto) => void;
  onRemove: (diskId: string) => void;
}) {
  return (
    <div className="bg-card rounded-lg border border-border p-4">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-medium text-foreground/90 flex items-center gap-2">
          <HardDrive className="h-4 w-4 text-muted-foreground" />数据盘
        </h2>
        {canManage && (
          <Button size="sm" variant="outline" onClick={onAdd}>
            <Plus className="h-4 w-4" />添加
          </Button>
        )}
      </div>

      {disks.length === 0 ? (
        <div className="bg-muted/50 rounded-lg border border-dashed border-border p-6 text-center">
          <div className="text-sm text-muted-foreground/70">
            {canManage ? '还没有数据盘，点击"添加"注册挂载点' : '暂无数据盘'}
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          {disks.map((disk) => {
            const total = disk.totalBytes ?? 0;
            const used = disk.usedBytes ?? 0;
            const pct = total > 0 ? (used / total) * 100 : 0;

            return (
              <div key={disk.diskId} className="rounded-lg border border-border bg-muted/20 p-3">
                <div className="flex items-start justify-between mb-2 gap-2">
                  <div className="flex flex-col gap-0.5 min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2 min-w-0">
                      <span className="font-medium text-foreground text-sm truncate">
                        {dataDiskDisplayName(disk.mountPoint, disk.label)}
                      </span>
                      {disk.pquotaEnabled && (
                        <span className="text-xs text-green-600 bg-green-50 px-2 py-0.5 rounded border border-green-200 shrink-0">
                          pquota
                        </span>
                      )}
                    </div>
                    <span className="font-mono text-xs text-muted-foreground/70 truncate">{disk.mountPoint}</span>
                  </div>
                  {canManage && (
                    <div className="flex items-center gap-0.5 shrink-0">
                      <Button
                        size="icon" variant="ghost"
                        className="h-8 w-8 text-muted-foreground hover:text-foreground"
                        onClick={() => onEdit(disk)}
                        title="编辑名称"
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button
                        size="icon" variant="ghost"
                        className="h-8 w-8 text-red-400 hover:text-red-600 hover:bg-red-50"
                        onClick={() => onRemove(disk.diskId)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  )}
                </div>
                {total > 0 ? (
                  <div className="text-xs text-muted-foreground/70">
                    {formatBytes(used)} / {formatBytes(total)}, {pct.toFixed(1)}%
                  </div>
                ) : (
                  <div className="text-xs text-muted-foreground/70">等待 agent 上报容量信息</div>
                )}
                {canManageContainers && (
                  <DanglingDirPanel
                    sourceKind="local"
                    sourceId={disk.diskId}
                  />
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function SelfCheckCard({ serverId, online }: { serverId: string; online: boolean }) {
  const { mutate, isPending, data, error, reset } = useMutation({
    mutationFn: () => api.get<SelfCheckResult>(`/admin/servers/${serverId}/self-check`),
  });

  const statusIcon = (item: SelfCheckItem) => {
    if (item.status === 'ok') return <CheckCircle2 className="h-4 w-4 text-green-500 shrink-0" />;
    if (item.status === 'fail') return <XCircle className="h-4 w-4 text-red-500 shrink-0" />;
    return <AlertTriangle className="h-4 w-4 text-yellow-500 shrink-0" />;
  };

  const statusBadge = (status: SelfCheckItem['status']) => {
    if (status === 'ok') return 'bg-green-50 text-green-700 border-green-200';
    if (status === 'fail') return 'bg-red-50 text-red-600 border-red-200';
    return 'bg-yellow-50 text-yellow-700 border-yellow-200';
  };

  const statusLabel = (status: SelfCheckItem['status']) => {
    if (status === 'ok') return '正常';
    if (status === 'fail') return '失败';
    return '警告';
  };

  return (
    <div className="bg-card rounded-lg border border-border p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2 text-sm font-medium text-foreground/90">
          <ShieldCheck className="h-4 w-4 text-muted-foreground" />系统自检
        </div>
        <Button
          size="sm" variant="outline"
          onClick={() => { reset(); mutate(); }}
          disabled={isPending || !online}
          title={!online ? 'Agent 离线，无法运行自检' : undefined}
        >
          {isPending
            ? <div className="w-3 h-3 border-2 border-muted border-t-primary rounded-full animate-spin" />
            : <Play className="h-3 w-3" />
          }
          {isPending ? '检测中...' : '运行自检'}
        </Button>
      </div>

      {!online && !data && (
        <div className="text-sm text-muted-foreground/70 text-center py-2">Agent 离线，无法运行自检</div>
      )}

      {error && (
        <div className="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">
          {(error as Error).message}
        </div>
      )}

      {data && (
        <div className="space-y-1.5">
          {data.items.map((item) => (
            <div key={item.id} className="flex items-center gap-3 rounded-lg border border-border px-3 py-2 text-sm">
              {statusIcon(item)}
              <span className="flex-1 text-foreground/90">{item.label}</span>
              <span className={`text-xs px-1.5 py-0.5 rounded border ${statusBadge(item.status)}`}>
                {statusLabel(item.status)}
              </span>
              <span className="text-xs text-muted-foreground/70 max-w-[40%] text-right truncate" title={item.message}>
                {item.message}
              </span>
            </div>
          ))}
        </div>
      )}

      {!data && !error && !isPending && online && (
        <div className="text-sm text-muted-foreground/70 text-center py-2">点击「运行自检」检测依赖与环境配置</div>
      )}
    </div>
  );
}

function InfoCard({ title, icon, action, children }: {
  title: string; icon?: React.ReactNode; action?: React.ReactNode; children: React.ReactNode;
}) {
  return (
    <div className="bg-card rounded-lg border border-border p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2 text-sm font-medium text-foreground/90">
          {icon}{title}
        </div>
        {action}
      </div>
      {children}
    </div>
  );
}

function InfoRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex justify-between py-1.5 text-sm border-b border-border last:border-0">
      <span className="text-muted-foreground">{label}</span>
      <span className={`text-foreground/90 ${mono ? 'font-mono text-xs' : ''}`}>{value}</span>
    </div>
  );
}

function AddDiskDialog({ serverId, open, onOpenChange }: {
  serverId: string; open: boolean; onOpenChange: (v: boolean) => void;
}) {
  const qc = useQueryClient();
  const [mountPoint, setMountPoint] = useState('');
  const [label, setLabel] = useState('');

  const { mutate, isPending } = useMutation({
    mutationFn: () => api.post<DiskOperationResponse>(`/admin/servers/${serverId}/disks`, {
      mountPoint, label: label || undefined,
    }),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: queryKeys.servers.disks('admin', serverId) });
      toast({
        title: '数据盘添加已排队',
        description: res.operationId ? `操作 ${res.operationId.slice(0, 8)}` : undefined,
      });
      setMountPoint(''); setLabel('');
      onOpenChange(false);
    },
    onError: (e) => toast({ title: '添加失败', description: e.message, variant: 'destructive' }),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader><DialogTitle>添加数据盘</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label className="text-sm text-foreground/90">挂载点</Label>
            <Input placeholder="/data" value={mountPoint} onChange={(e) => setMountPoint(e.target.value)} />
            <p className="text-xs text-muted-foreground/70">必须为 XFS 文件系统并启用 pquota 选项</p>
          </div>
          <div className="space-y-1.5">
            <Label className="text-sm text-foreground/90">名称（可选）</Label>
            <Input placeholder="例如：主存储" value={label} onChange={(e) => setLabel(e.target.value)} />
            <p className="text-xs text-muted-foreground/70">用于在界面中识别该数据盘；留空则使用挂载路径末级名称</p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
          <Button onClick={() => mutate()} disabled={isPending || !mountPoint}>
            {isPending ? '添加中...' : '添加'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EditDiskDialog({ serverId, disk, open, onOpenChange }: {
  serverId: string;
  disk: DataDiskDto | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const qc = useQueryClient();
  const [label, setLabel] = useState('');

  useEffect(() => {
    if (open && disk) setLabel(disk.label ?? '');
  }, [open, disk]);

  const { mutate, isPending } = useMutation({
    mutationFn: () =>
      api.patch<DiskOperationResponse>(
        `/admin/servers/${encodeURIComponent(serverId.trim())}/disks/${encodeURIComponent(disk!.diskId.trim())}`,
        {
          label: label.trim() === '' ? null : label.trim(),
        },
      ),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: queryKeys.servers.disks('admin', serverId) });
      toast({
        title: '数据盘更新已排队',
        description: res.operationId ? `操作 ${res.operationId.slice(0, 8)}` : undefined,
      });
      onOpenChange(false);
    },
    onError: (e) => toast({ title: '更新失败', description: e.message, variant: 'destructive' }),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader><DialogTitle>编辑数据盘名称</DialogTitle></DialogHeader>
        {disk && (
          <>
            <p className="text-xs text-muted-foreground font-mono truncate" title={disk.mountPoint}>{disk.mountPoint}</p>
            <div className="space-y-3 pt-2">
              <div className="space-y-1.5">
                <Label className="text-sm text-foreground/90">名称</Label>
                <Input placeholder="例如：主存储" value={label} onChange={(e) => setLabel(e.target.value)} />
                <p className="text-xs text-muted-foreground/70">留空则回到默认显示（挂载路径末级）</p>
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
              <Button onClick={() => mutate()} disabled={isPending || !disk}>
                {isPending ? '保存中...' : '保存'}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function ServerDefaultsCard({ server, serverId }: { server: ServerDto; serverId: string }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<ResourceFormValue>(() => serverDefaultsToForm(server));

  const { mutate, isPending } = useMutation({
    mutationFn: () => api.patch(`/admin/servers/${serverId}/defaults`, formToServerDefaultsPayload(form)),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.servers.detail(serverId) });
      toast({ title: '默认资源已更新' });
      setEditing(false);
    },
    onError: (e) => toast({ title: '更新失败', description: e.message, variant: 'destructive' }),
  });

  return (
    <div className="bg-card rounded-lg border border-border p-4">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-medium text-foreground/90 flex items-center gap-2">
          <Settings className="h-4 w-4 text-muted-foreground" />默认资源限制
        </h2>
        <Button size="sm" variant="outline"
          onClick={() => {
            if (!editing) setForm(serverDefaultsToForm(server));
            setEditing(!editing);
          }}>
          {editing ? '取消' : '编辑'}
        </Button>
      </div>

      {!editing ? (
        <div className="grid grid-cols-2 gap-2 text-sm">
          <div className="flex justify-between py-1 border-b border-border">
            <span className="text-muted-foreground">默认 CPU</span>
            <span className="text-foreground/90 font-mono text-xs">{server.defaultCpuMillis > 0 ? `${server.defaultCpuMillis / 1000} 核` : '不限制'}</span>
          </div>
          <div className="flex justify-between py-1 border-b border-border">
            <span className="text-muted-foreground">默认内存</span>
            <span className="text-foreground/90 font-mono text-xs">{server.defaultMemBytes > 0 ? formatBytes(server.defaultMemBytes) : '不限制'}</span>
          </div>
          <div className="flex justify-between py-1 border-b border-border">
            <span className="text-muted-foreground">默认磁盘</span>
            <span className="text-foreground/90 font-mono text-xs">{server.defaultDiskBytes > 0 ? formatBytes(server.defaultDiskBytes) : '不限制'}</span>
          </div>
          {server.isGpuServer && (
            <div className="flex justify-between py-1">
              <span className="text-muted-foreground">GPU 默认模式</span>
              <span className="text-foreground/90 font-mono text-xs">{server.defaultGpuMode}
                {server.defaultGpuMode === GpuGrantMode.Indices ? ` [${server.defaultGpuIndices?.join(',')}]` : ''}
              </span>
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          <ResourceGrantForm value={form} onChange={setForm} showGpu={server.isGpuServer} />
          <Button size="sm" onClick={() => mutate()} disabled={isPending}>
            {isPending ? '保存中...' : '保存默认值'}
          </Button>
        </div>
      )}
    </div>
  );
}

function EditServerDialog({ server, open, onOpenChange }: {
  server: ServerDto; open: boolean; onOpenChange: (v: boolean) => void;
}) {
  const qc = useQueryClient();
  const [name, setName] = useState(server.name);
  const [slug, setSlug] = useState(server.slug);
  const [parentIface, setParentIface] = useState(server.parentIface);
  const [ipCidr, setIpCidr] = useState(server.ipCidr);
  const [gateway, setGateway] = useState(server.gateway);
  const [isGpuServer, setIsGpuServer] = useState(server.isGpuServer);

  const { mutate, isPending } = useMutation({
    mutationFn: () => api.patch(`/admin/servers/${server.id}`, { name, slug, parentIface, ipCidr, gateway, isGpuServer }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.servers.detail(server.id) });
      qc.invalidateQueries({ queryKey: queryKeys.servers.admin });
      toast({ title: '服务器配置已更新' });
      onOpenChange(false);
    },
    onError: (e) => toast({ title: '更新失败', description: e.message, variant: 'destructive' }),
  });

  const handleOpen = (v: boolean) => {
    if (v) {
      setName(server.name);
      setSlug(server.slug);
      setParentIface(server.parentIface);
      setIpCidr(server.ipCidr);
      setGateway(server.gateway);
      setIsGpuServer(server.isGpuServer);
    }
    onOpenChange(v);
  };

  const changed = name !== server.name || slug !== server.slug || parentIface !== server.parentIface
    || ipCidr !== server.ipCidr || gateway !== server.gateway
    || isGpuServer !== server.isGpuServer;

  return (
    <Dialog open={open} onOpenChange={handleOpen}>
      <DialogContent className="max-w-sm">
        <DialogHeader><DialogTitle>编辑服务器配置</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label className="text-sm text-foreground/90">名称</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="gpu-server-1" />
          </div>
          <div className="space-y-1.5">
            <Label className="text-sm text-foreground/90">路由标识</Label>
            <Input value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="gpu-server-1" className="font-mono" />
          </div>
          <div className="space-y-1.5">
            <Label className="text-sm text-foreground/90">物理网卡</Label>
            <Input value={parentIface} onChange={(e) => setParentIface(e.target.value)} placeholder="eth0" className="font-mono" />
          </div>
          <div className="space-y-1.5">
            <Label className="text-sm text-foreground/90">网段 CIDR</Label>
            <Input value={ipCidr} onChange={(e) => setIpCidr(e.target.value)} placeholder="192.168.100.0/24" className="font-mono" />
          </div>
          <div className="space-y-1.5">
            <Label className="text-sm text-foreground/90">网关</Label>
            <Input value={gateway} onChange={(e) => setGateway(e.target.value)} placeholder="192.168.100.1" className="font-mono" />
          </div>
          <div className="flex items-center gap-2 pt-1">
            <input
              id="edit-is-gpu-server"
              type="checkbox"
              checked={isGpuServer}
              onChange={(e) => setIsGpuServer(e.target.checked)}
              className="h-4 w-4 rounded border-border"
            />
            <Label htmlFor="edit-is-gpu-server" className="text-sm text-foreground/90 cursor-pointer">
              GPU 服务器（启用 GPU 监控与配额）
            </Label>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
          <Button onClick={() => mutate()} disabled={isPending || !changed || !name || !slug || !parentIface || !ipCidr || !gateway}>
            {isPending ? '保存中...' : '保存'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DanglingDirPanel({ sourceKind, sourceId }: {
  sourceKind: 'local' | 'remote';
  sourceId: string;
}) {
  const { data: issues = [] } = useQuery({
    queryKey: ['data-dir-issues', sourceKind, sourceId],
    queryFn: () => api.get<DataDirIssueDto[]>(`/admin/data-dirs/issues?sourceKind=${sourceKind}&sourceId=${sourceId}`),
    refetchInterval: 30_000,
  });

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
          <p className="text-xs text-muted-foreground/70">FS 有 / DB 无（孤立目录）</p>
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
          <p className="text-xs text-muted-foreground/70">DB 有 / FS 无（缺失目录）</p>
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
