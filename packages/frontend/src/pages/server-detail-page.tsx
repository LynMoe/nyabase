import { Link, getRouteApi } from '@tanstack/react-router';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
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
import { HardDrive, Cpu, ArrowLeft, Wifi, WifiOff, RefreshCw, Pencil, ShieldCheck, CheckCircle2, XCircle, AlertTriangle, Play, Container } from 'lucide-react';
import { Capability, DockerDaemonState, ServerStatus } from '@nyabase/common';
import type { ServerDto, DataDiskDto, SelfCheckResult, SelfCheckItem, DockerDaemonStatus, DataDirIssueDto } from '@nyabase/common';
import { useAuthStore } from '../store/auth.js';
import { HostSection, GpuSection, TimeRangeSelector } from '../components/dashboard/server-metrics.js';

const routeApi = getRouteApi('/servers/$id');

export default function ServerDetailPage() {
  const { id } = routeApi.useParams();
  const { user } = useAuthStore();
  const canManage = user?.capabilities.includes(Capability.ManageServers) ?? false;
  const canManageContainers = user?.capabilities.includes(Capability.ManageContainersAny) ?? false;
  const [showEditServer, setShowEditServer] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [newToken, setNewToken] = useState<string | null>(null);
  const [showRegenConfirm, setShowRegenConfirm] = useState(false);
  const queryClient = useQueryClient();

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

  const retryAgentQuarantine = useMutation({
    mutationFn: () => api.post<{ taskIds: string[] }>(
      `/admin/servers/${id}/agent-quarantine/retry`,
    ),
    onSuccess: ({ taskIds }) => {
      toast({
        title: 'Agent 隔离已解除',
        description: `将重新协调 ${taskIds.length} 个保留任务，请启动已修复的 Agent。`,
      });
      queryClient.invalidateQueries({ queryKey: queryKeys.servers.detail(id) });
      queryClient.invalidateQueries({ queryKey: queryKeys.servers.admin });
    },
    onError: (error) => toast({
      title: '解除隔离失败',
      description: error.message,
      variant: 'destructive',
    }),
  });

  if (!server) return (
    <div className="px-4 py-4 md:px-6 flex items-center gap-2 text-muted-foreground/70">
      <div className="w-4 h-4 border-2 border-muted border-t-primary rounded-full animate-spin" />
      加载中...
    </div>
  );

  const online = server.status === 'online';
  const quarantined = server.status === ServerStatus.AgentQuarantined;
  const inventoryQuarantined = server.quarantineCode === 'AGENT_INVENTORY_FAULT';
  const statusLabel = online
    ? '在线'
    : quarantined
      ? '已隔离'
      : server.status === ServerStatus.AgentStateUnready
        ? '状态未就绪'
        : server.status === 'offline'
          ? '离线'
          : '未知';
  const gpus = server.gpus ?? [];
  const hasGpu = gpus.length > 0;

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
            <p className="text-sm text-muted-foreground/70 font-mono mt-0.5">{server.slug}</p>
          </div>
        </div>
        <div className={`flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-full font-medium
          ${online ? 'bg-green-50 text-green-700 border border-green-200'
            : quarantined ? 'bg-red-50 text-red-700 border border-red-300'
            : server.status === 'offline' ? 'bg-red-50 text-red-600 border border-red-200'
            : 'bg-muted text-muted-foreground border border-border'}`}>
          {online ? <Wifi className="h-4 w-4" /> : <WifiOff className="h-4 w-4" />}
          {statusLabel}
        </div>
      </div>

      {quarantined && (
        <div className="flex flex-col gap-3 rounded-lg border border-red-300 bg-red-50 p-4 text-red-900 dark:border-red-900 dark:bg-red-950/30 dark:text-red-200 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="font-medium">
              {inventoryQuarantined ? 'Agent 权威资源清单失败，服务器已安全隔离' : 'Agent 任务结果不可信，服务器已安全隔离'}
            </div>
            <p className="mt-1 text-sm opacity-80">
              {inventoryQuarantined
                ? `${server.quarantineMessage ?? '无法证明当前物理资源清单。'} 同一网络的新 IP 分配已冻结；请先修复或清理物理资源，再允许 Agent 重连。只有新的完整清单成功提交后才会解除冻结。`
                : `${server.quarantineMessage ?? '任务的物理结果无法被安全确认。'} 相关物理资源锁仍被保留；请先修复 Agent 或 Backend 投影，再显式重试同一任务。`}
            </p>
          </div>
          {canManage && (
            <Button
              variant="destructive"
              onClick={() => retryAgentQuarantine.mutate()}
              disabled={retryAgentQuarantine.isPending}
            >
              <RefreshCw className={`h-4 w-4 ${retryAgentQuarantine.isPending ? 'animate-spin' : ''}`} />
              {retryAgentQuarantine.isPending
                ? '解除中...'
                : inventoryQuarantined
                  ? '允许重连并重新采集'
                  : '解除隔离并重试'}
            </Button>
          )}
        </div>
      )}

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

        {canManage && <DockerDaemonCard online={online} daemonStatus={server.dockerDaemon ?? null} />}

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
          canManageContainers={canManageContainers}
        />
        {canManage && <SelfCheckCard serverId={id} online={online} />}
      </div>

      {/* Host & GPU metrics */}
      {online && <ServerMetricsSection serverId={id} hasGpu={hasGpu} />}

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

function ServerMetricsSection({ serverId, hasGpu }: { serverId: string; hasGpu: boolean }) {
  const [range, setRange] = useState('1h');
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <Separator className="flex-1 mr-4" />
        <TimeRangeSelector value={range} onChange={setRange} />
      </div>
      <HostSection serverId={serverId} range={range} admin />
      {hasGpu && <GpuSection serverId={serverId} range={range} admin />}
    </div>
  );
}

function DockerDaemonCard({
  online, daemonStatus,
}: {
  online: boolean;
  daemonStatus: DockerDaemonStatus | null;
}) {
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
  canManageContainers,
}: {
  disks: DataDiskDto[];
  canManageContainers: boolean;
}) {
  return (
    <div className="bg-card rounded-lg border border-border p-4">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-medium text-foreground/90 flex items-center gap-2">
          <HardDrive className="h-4 w-4 text-muted-foreground" />数据盘
        </h2>
      </div>

      {disks.length === 0 ? (
        <div className="bg-muted/50 rounded-lg border border-dashed border-border p-6 text-center">
          <div className="text-sm text-muted-foreground/70">
            暂无 agent 配置的数据盘
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

function EditServerDialog({ server, open, onOpenChange }: {
  server: ServerDto; open: boolean; onOpenChange: (v: boolean) => void;
}) {
  const qc = useQueryClient();
  const [name, setName] = useState(server.name);
  const [slug, setSlug] = useState(server.slug);

  const { mutate, isPending } = useMutation({
    mutationFn: () => api.patch(`/admin/servers/${server.id}`, { name, slug }),
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
    }
    onOpenChange(v);
  };

  const changed = name !== server.name || slug !== server.slug;

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
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
          <Button onClick={() => mutate()} disabled={isPending || !changed || !name || !slug}>
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
