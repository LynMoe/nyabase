import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ComponentType } from 'react';
import {
  Activity,
  Gauge,
  PlugZap,
  RefreshCw,
  RotateCcw,
  Unplug,
  Wifi,
} from 'lucide-react';
import { Capability, type SshProxyHostKeySummaryDto, type SshProxyStatusReport } from '@nyabase/common';
import { api } from '../lib/api.js';
import { Badge } from '../components/ui/badge.js';
import { Button } from '../components/ui/button.js';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '../components/ui/alert-dialog.js';
import { toast } from '../hooks/use-toast.js';
import { useAuthStore } from '../store/auth.js';
import { QueryErrorState, QueryLoadingState } from '../components/query-state.js';
import { canViewSshProxyStatus } from '../lib/ssh-proxy-access.js';
import { queryPollInterval } from '../lib/query-lifecycle.js';

interface SshProxyAdminStatus {
  connectedProxies: number;
  activeConnections: number;
  totalConnections: number;
  totalRejectedConnections: number;
  totalClosedConnections: number;
  totalBytesFromClient: number;
  totalBytesToClient: number;
  bandwidthInBps: number;
  bandwidthOutBps: number;
  updatedAt: string | null;
  proxies: SshProxyStatusReport[];
}

interface DisconnectAllResult {
  requestId: string;
  requested: number;
  disconnected: number;
}

export default function SshProxyPage() {
  const qc = useQueryClient();
  const user = useAuthStore((state) => state.user);
  const canViewStatus = canViewSshProxyStatus(user?.capabilities ?? []);
  const canManageSettings = user?.capabilities.includes(Capability.ManageSystemSettings) ?? false;
  const statusQuery = useQuery({
    queryKey: ['ssh-proxy-status'],
    queryFn: () => api.get<SshProxyAdminStatus>('/admin/ssh-proxy/status'),
    refetchInterval: (query) => queryPollInterval(query.state, {
      activeIntervalMs: 1_000,
      transientBaseIntervalMs: 2_000,
      transientMaxIntervalMs: 30_000,
    }),
    enabled: canViewStatus,
  });
  const hostKeyQuery = useQuery({
    queryKey: ['ssh-proxy-host-key'],
    queryFn: () => api.get<SshProxyHostKeySummaryDto>('/admin/ssh-proxy/host-key'),
    enabled: canManageSettings,
  });
  const { data, isFetching, refetch } = statusQuery;
  const { data: hostKey, isFetching: hostKeyFetching, refetch: refetchHostKey } = hostKeyQuery;

  const disconnectAll = useMutation({
    mutationFn: () => api.post<DisconnectAllResult>('/admin/ssh-proxy/disconnect-all'),
    onSuccess: (result) => {
      qc.invalidateQueries({ queryKey: ['ssh-proxy-status'] });
      toast({
        title: '已发送断开命令',
        description: `已断开 ${result.disconnected} 个会话，目标代理 ${result.requested} 个。`,
      });
    },
    onError: (error) => toast({
      title: '断开失败',
      description: error instanceof Error ? error.message : '请稍后重试',
      variant: 'destructive',
    }),
  });

  const rotateHostKey = useMutation({
    mutationFn: () => api.post<SshProxyHostKeySummaryDto>('/admin/ssh-proxy/host-key/rotate'),
    onSuccess: (updated) => {
      qc.setQueryData(['ssh-proxy-host-key'], updated);
      qc.invalidateQueries({ queryKey: ['ssh-proxy-status'] });
      toast({ title: 'SSH 主机密钥已轮换' });
    },
    onError: (error) => toast({
      title: '轮换失败',
      description: error instanceof Error ? error.message : '请稍后重试',
      variant: 'destructive',
    }),
  });

  const status = data ?? emptyStatus;
  const connections = status.proxies.flatMap((proxy) => proxy.connections.map((connection) => ({
    ...connection,
    proxyId: proxy.proxyId,
  })));

  return (
    <div className="px-4 py-4 md:px-6 space-y-5 w-full">
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">SSH 代理</h1>
          {canViewStatus && (
            <p className="text-sm text-muted-foreground mt-0.5">
              {statusQuery.isError
                ? '代理状态加载失败'
                : status.updatedAt ? `最后更新 ${formatTime(status.updatedAt)}` : '等待代理上报实时状态'}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          {canViewStatus && (
            <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground" onClick={() => refetch()} disabled={isFetching}>
              <RefreshCw className={`h-4 w-4 ${isFetching ? 'animate-spin' : ''}`} />
            </Button>
          )}
          {canManageSettings && (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="destructive" disabled={(canViewStatus && Boolean(data) && status.activeConnections === 0) || disconnectAll.isPending}>
                  <Unplug className="h-4 w-4" />
                  断开全部
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>断开所有 SSH 代理会话？</AlertDialogTitle>
                  <AlertDialogDescription>
                    {canViewStatus && data
                      ? `当前有 ${status.activeConnections} 个活跃连接。`
                      : '当前连接数不可见或尚未加载。'}
                    确认后会向所有在线 SSH 代理实例发送断开命令。
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>取消</AlertDialogCancel>
                  <AlertDialogAction onClick={() => disconnectAll.mutate()} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
                    断开全部
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
        </div>
      </div>

      {canViewStatus && statusQuery.isLoading && <QueryLoadingState label="加载 SSH 代理状态..." />}
      {canViewStatus && statusQuery.isError && (
        <QueryErrorState error={statusQuery.error} resourceName="SSH 代理状态" onRetry={() => { void statusQuery.refetch(); }} />
      )}

      {canViewStatus && statusQuery.isSuccess && (
        <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <MetricTile icon={Wifi} label="在线代理" value={status.connectedProxies.toString()} sub={`${status.proxies.length} 个实例上报`} />
          <MetricTile icon={Activity} label="活跃连接" value={status.activeConnections.toString()} sub={`累计 ${status.totalConnections} 次`} />
          <MetricTile icon={Gauge} label="实时带宽" value={`${formatRate(status.bandwidthInBps)} / ${formatRate(status.bandwidthOutBps)}`} sub="入站 / 出站" />
          <MetricTile icon={PlugZap} label="累计流量" value={`${formatBytes(status.totalBytesFromClient + status.totalBytesToClient)}`} sub={`入 ${formatBytes(status.totalBytesFromClient)} 出 ${formatBytes(status.totalBytesToClient)}`} />
        </section>
      )}

      {canManageSettings && (
        <section className="space-y-3">
          <div className="flex items-center justify-between gap-4">
            <h2 className="text-base font-semibold text-foreground">SSH 主机密钥</h2>
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground" onClick={() => refetchHostKey()} disabled={hostKeyFetching}>
                <RefreshCw className={`h-4 w-4 ${hostKeyFetching ? 'animate-spin' : ''}`} />
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => rotateHostKey.mutate()}
                disabled={rotateHostKey.isPending}
              >
                <RotateCcw className="h-4 w-4" />
                轮换
              </Button>
            </div>
          </div>
          {hostKeyQuery.isLoading ? (
            <QueryLoadingState label="加载 SSH 主机密钥..." />
          ) : hostKeyQuery.isError ? (
            <QueryErrorState error={hostKeyQuery.error} resourceName="SSH 主机密钥" onRetry={() => { void hostKeyQuery.refetch(); }} />
          ) : hostKey ? (
            <div className="rounded-lg border border-border bg-card p-4 grid gap-3 sm:grid-cols-3">
              <InfoCell label="指纹" value={hostKey.fingerprint ?? '未配置'} mono />
              <InfoCell label="版本" value={hostKey.generation?.toString() ?? '未配置'} />
              <InfoCell label="轮换时间" value={hostKey.rotatedAt ? formatTime(hostKey.rotatedAt) : '从未轮换'} />
            </div>
          ) : null}
        </section>
      )}

      {canViewStatus && statusQuery.isSuccess && (
        <>
          <section className="space-y-3">
            <div className="flex items-center justify-between gap-4">
              <h2 className="text-base font-semibold text-foreground">代理实例</h2>
              <Badge variant={status.connectedProxies > 0 ? 'success' : 'outline'}>
                {status.connectedProxies > 0 ? '在线' : '离线'}
              </Badge>
            </div>
            <div className="overflow-hidden rounded-lg border border-border bg-card">
              <table className="w-full text-sm">
                <thead className="bg-muted/60 text-xs text-muted-foreground">
                  <tr>
                    <th className="text-left font-medium px-3 py-2">代理</th>
                    <th className="text-left font-medium px-3 py-2">监听</th>
                    <th className="text-left font-medium px-3 py-2">连接</th>
                    <th className="text-left font-medium px-3 py-2">带宽</th>
                    <th className="text-left font-medium px-3 py-2">流量</th>
                    <th className="text-left font-medium px-3 py-2">快照</th>
                  </tr>
                </thead>
                <tbody>
                  {status.proxies.length === 0 ? (
                    <tr>
                      <td className="px-3 py-8 text-center text-muted-foreground" colSpan={6}>暂无在线 SSH 代理</td>
                    </tr>
                  ) : status.proxies.map((proxy) => (
                    <tr key={proxy.proxyId} className="border-t border-border">
                      <td className="px-3 py-2">
                        <div className="font-medium text-foreground">{proxy.hostname ?? proxy.proxyId}</div>
                        <div className="font-mono text-xs text-muted-foreground break-all">{proxy.proxyId}</div>
                      </td>
                      <td className="px-3 py-2 font-mono text-xs">{proxy.listen}</td>
                      <td className="px-3 py-2">{proxy.activeConnections} / {proxy.totalConnections}</td>
                      <td className="px-3 py-2">{formatRate(proxy.bandwidthInBps)} / {formatRate(proxy.bandwidthOutBps)}</td>
                      <td className="px-3 py-2">{formatBytes(proxy.totalBytesFromClient + proxy.totalBytesToClient)}</td>
                      <td className="px-3 py-2">{proxy.lastSnapshotGeneration ?? '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="space-y-3">
            <h2 className="text-base font-semibold text-foreground">当前连接</h2>
            <div className="overflow-hidden rounded-lg border border-border bg-card">
              <table className="w-full text-sm">
                <thead className="bg-muted/60 text-xs text-muted-foreground">
                  <tr>
                    <th className="text-left font-medium px-3 py-2">登录</th>
                    <th className="text-left font-medium px-3 py-2">目标</th>
                    <th className="text-left font-medium px-3 py-2">来源</th>
                    <th className="text-left font-medium px-3 py-2">通道</th>
                    <th className="text-left font-medium px-3 py-2">流量</th>
                    <th className="text-left font-medium px-3 py-2">连接时间</th>
                  </tr>
                </thead>
                <tbody>
                  {connections.length === 0 ? (
                    <tr>
                      <td className="px-3 py-8 text-center text-muted-foreground" colSpan={6}>暂无活跃连接</td>
                    </tr>
                  ) : connections.map((connection) => (
                    <tr key={`${connection.proxyId}:${connection.id}`} className="border-t border-border">
                      <td className="px-3 py-2">
                        <div className="font-medium text-foreground">{connection.login ?? '未认证'}</div>
                        <div className="text-xs text-muted-foreground">{connection.username ?? '-'}</div>
                      </td>
                      <td className="px-3 py-2">
                        <div>{connection.serverSlug && connection.containerName ? `${connection.serverSlug}.${connection.containerName}` : '-'}</div>
                        <div className="font-mono text-xs text-muted-foreground break-all">{connection.containerId ?? connection.runtimeId ?? '-'}</div>
                      </td>
                      <td className="px-3 py-2">
                        <div className="font-mono text-xs">{connection.peer}</div>
                        <div className="text-xs text-muted-foreground truncate max-w-56">{connection.proxyId}</div>
                      </td>
                      <td className="px-3 py-2">{connection.channels}</td>
                      <td className="px-3 py-2">入 {formatBytes(connection.bytesFromClient)} / 出 {formatBytes(connection.bytesToClient)}</td>
                      <td className="px-3 py-2">{formatTime(connection.connectedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </div>
  );
}

function MetricTile({
  icon: Icon,
  label,
  value,
  sub,
}: {
  icon: ComponentType<{ className?: string }>;
  label: string;
  value: string;
  sub: string;
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">{label}</p>
        <Icon className="h-4 w-4 text-muted-foreground" />
      </div>
      <p className="mt-2 text-xl font-semibold text-foreground break-words">{value}</p>
      <p className="mt-1 text-xs text-muted-foreground">{sub}</p>
    </div>
  );
}

function InfoCell({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={`mt-1 text-sm break-all ${mono ? 'font-mono' : 'font-medium text-foreground'}`}>{value}</p>
    </div>
  );
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let current = value;
  let index = 0;
  while (current >= 1024 && index < units.length - 1) {
    current /= 1024;
    index += 1;
  }
  return `${current >= 10 || index === 0 ? current.toFixed(0) : current.toFixed(1)} ${units[index]}`;
}

function formatRate(value: number): string {
  return `${formatBytes(value)}/s`;
}

function formatTime(value: string | number): string {
  const date = typeof value === 'number' ? new Date(value) : new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return date.toLocaleString();
}

const emptyStatus: SshProxyAdminStatus = {
  connectedProxies: 0,
  activeConnections: 0,
  totalConnections: 0,
  totalRejectedConnections: 0,
  totalClosedConnections: 0,
  totalBytesFromClient: 0,
  totalBytesToClient: 0,
  bandwidthInBps: 0,
  bandwidthOutBps: 0,
  updatedAt: null,
  proxies: [],
};
