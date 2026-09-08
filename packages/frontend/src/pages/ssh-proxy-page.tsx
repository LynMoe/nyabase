import { useState } from 'react';
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
import { errorMessage } from '../lib/api-error.js';
import { Badge } from '../components/ui/badge.js';
import { Button } from '../components/ui/button.js';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../components/ui/table.js';
import { ConfirmDialog } from '../components/layout/confirm-dialog.js';
import { Page } from '../components/layout/page.js';
import { PageHeader } from '../components/layout/page-header.js';
import { QueryView } from '../components/layout/query-view.js';
import { SectionCard } from '../components/layout/section-card.js';
import { toast } from '../hooks/use-toast.js';
import { useAuthStore } from '../store/auth.js';
import { canViewSshProxyStatus } from '../lib/ssh-proxy-access.js';
import { queryPollInterval } from '../lib/query-lifecycle.js';
import { queryKeys } from '../lib/query-keys.js';

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
  const [disconnectOpen, setDisconnectOpen] = useState(false);
  const [rotateOpen, setRotateOpen] = useState(false);
  const statusQuery = useQuery({
    queryKey: queryKeys.sshProxy.status,
    queryFn: () => api.get<SshProxyAdminStatus>('/admin/ssh-proxy/status'),
    refetchInterval: (query) => queryPollInterval(query.state, {
      activeIntervalMs: 1_000,
      transientBaseIntervalMs: 2_000,
      transientMaxIntervalMs: 30_000,
    }),
    enabled: canViewStatus,
  });
  const hostKeyQuery = useQuery({
    queryKey: queryKeys.sshProxy.hostKey,
    queryFn: () => api.get<SshProxyHostKeySummaryDto>('/admin/ssh-proxy/host-key'),
    enabled: canManageSettings,
  });
  const { data, isFetching, refetch } = statusQuery;
  const { isFetching: hostKeyFetching, refetch: refetchHostKey } = hostKeyQuery;

  const disconnectAll = useMutation({
    mutationFn: () => api.post<DisconnectAllResult>('/admin/ssh-proxy/disconnect-all'),
    onSuccess: (result) => {
      setDisconnectOpen(false);
      qc.invalidateQueries({ queryKey: queryKeys.sshProxy.status });
      toast({
        title: '已发送断开命令',
        description: `已断开 ${result.disconnected} 个会话，目标代理 ${result.requested} 个。`,
      });
    },
    onError: (error) => toast({
      title: '断开失败',
      description: errorMessage(error),
      variant: 'destructive',
    }),
  });

  const rotateHostKey = useMutation({
    mutationFn: () => api.post<SshProxyHostKeySummaryDto>('/admin/ssh-proxy/host-key/rotate'),
    onSuccess: (updated) => {
      setRotateOpen(false);
      qc.setQueryData(queryKeys.sshProxy.hostKey, updated);
      qc.invalidateQueries({ queryKey: queryKeys.sshProxy.status });
      toast({ title: 'SSH 主机密钥已轮换' });
    },
    onError: (error) => toast({
      title: '轮换失败',
      description: errorMessage(error),
      variant: 'destructive',
    }),
  });

  const status = data ?? emptyStatus;
  const statusDescription = !canViewStatus
    ? undefined
    : statusQuery.isError
      ? '代理状态加载失败'
      : status.updatedAt ? `最后更新 ${formatTime(status.updatedAt)}` : '等待代理上报实时状态';

  return (
    <Page>
      <PageHeader
        title="SSH 代理"
        description={statusDescription}
        actions={
          <>
            {canViewStatus && (
              <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground" onClick={() => refetch()} disabled={isFetching}>
                <RefreshCw className={`h-4 w-4 ${isFetching ? 'animate-spin' : ''}`} />
              </Button>
            )}
            {canManageSettings && (
              <Button
                variant="destructive"
                disabled={(canViewStatus && Boolean(data) && status.activeConnections === 0) || disconnectAll.isPending}
                onClick={() => setDisconnectOpen(true)}
              >
                <Unplug className="h-4 w-4" />
                断开全部
              </Button>
            )}
          </>
        }
      />

      {canViewStatus && (
        <QueryView query={statusQuery} resourceName="SSH 代理状态" loadingLabel="加载 SSH 代理状态...">
          {(loaded) => <SshStatusSections status={loaded} />}
        </QueryView>
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
                disabled={rotateHostKey.isPending}
                onClick={() => setRotateOpen(true)}
              >
                <RotateCcw className="h-4 w-4" />
                轮换
              </Button>
            </div>
          </div>
          <QueryView query={hostKeyQuery} resourceName="SSH 主机密钥" loadingLabel="加载 SSH 主机密钥...">
            {(hostKey) => (
              <div className="rounded-lg border border-border bg-card p-4 grid gap-3 sm:grid-cols-3">
                <InfoCell label="指纹" value={hostKey.fingerprint ?? '未配置'} mono />
                <InfoCell label="版本" value={hostKey.generation?.toString() ?? '未配置'} />
                <InfoCell label="轮换时间" value={hostKey.rotatedAt ? formatTime(hostKey.rotatedAt) : '从未轮换'} />
              </div>
            )}
          </QueryView>
        </section>
      )}

      {canManageSettings && (
        <ConfirmDialog
          open={disconnectOpen}
          onOpenChange={setDisconnectOpen}
          title="断开所有 SSH 代理会话？"
          description={`${canViewStatus && data ? `当前有 ${status.activeConnections} 个活跃连接。` : '当前连接数不可见或尚未加载。'} 确认后会向所有在线 SSH 代理实例发送断开命令。`}
          confirmLabel="断开全部"
          pendingLabel="断开全部"
          pending={disconnectAll.isPending}
          onConfirm={() => disconnectAll.mutate()}
        />
      )}
      {canManageSettings && (
        <ConfirmDialog
          open={rotateOpen}
          onOpenChange={setRotateOpen}
          title="轮换 SSH 主机密钥？"
          description="轮换后所有客户端将失去对当前主机密钥的信任，需要更新 known_hosts 后才能再次连接。确认继续？"
          confirmLabel="确认轮换"
          pendingLabel="确认轮换"
          pending={rotateHostKey.isPending}
          onConfirm={() => rotateHostKey.mutate()}
        />
      )}
    </Page>
  );
}

function SshStatusSections({ status }: { status: SshProxyAdminStatus }) {
  const proxies = status.proxies ?? [];
  const connections = proxies.flatMap((proxy) => (proxy.connections ?? []).map((connection) => ({
    ...connection,
    proxyId: proxy.proxyId,
  })));

  return (
    <div className="space-y-6">
      <section className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <MetricTile icon={Wifi} label="在线代理" value={status.connectedProxies.toString()} sub={`${proxies.length} 个实例上报`} />
        <MetricTile icon={Activity} label="活跃连接" value={status.activeConnections.toString()} sub={`累计 ${status.totalConnections} 次`} />
        <MetricTile icon={Gauge} label="实时带宽" value={`${formatRate(status.bandwidthInBps)} / ${formatRate(status.bandwidthOutBps)}`} sub="入站 / 出站" />
        <MetricTile icon={PlugZap} label="累计流量" value={`${formatBytes(status.totalBytesFromClient + status.totalBytesToClient)}`} sub={`入 ${formatBytes(status.totalBytesFromClient)} 出 ${formatBytes(status.totalBytesToClient)}`} />
      </section>

      <SectionCard
        title="代理实例"
        actions={
          <Badge variant={status.connectedProxies > 0 ? 'success' : 'outline'}>
            {status.connectedProxies > 0 ? '在线' : '离线'}
          </Badge>
        }
        flush
      >
          <Table className="min-w-[720px]">
            <TableHeader>
              <TableRow>
                <TableHead>代理</TableHead>
                <TableHead>监听</TableHead>
                <TableHead>连接</TableHead>
                <TableHead>带宽</TableHead>
                <TableHead>流量</TableHead>
                <TableHead>快照</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {proxies.length === 0 ? (
                <TableRow>
                  <TableCell className="py-8 text-center text-muted-foreground" colSpan={6}>暂无在线 SSH 代理</TableCell>
                </TableRow>
              ) : proxies.map((proxy) => (
                <TableRow key={proxy.proxyId}>
                  <TableCell>
                    <div className="font-medium text-foreground">{proxy.hostname || proxy.proxyId}</div>
                    <div className="whitespace-normal break-all font-mono text-xs text-muted-foreground">{proxy.proxyId}</div>
                  </TableCell>
                  <TableCell className="font-mono text-xs">{proxy.listen}</TableCell>
                  <TableCell>{proxy.activeConnections} / {proxy.totalConnections}</TableCell>
                  <TableCell>{formatRate(proxy.bandwidthInBps)} / {formatRate(proxy.bandwidthOutBps)}</TableCell>
                  <TableCell>{formatBytes(proxy.totalBytesFromClient + proxy.totalBytesToClient)}</TableCell>
                  <TableCell>{proxy.lastSnapshotGeneration ?? '-'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
      </SectionCard>

      <SectionCard title="当前连接" flush>
          <Table className="min-w-[720px]">
            <TableHeader>
              <TableRow>
                <TableHead>登录</TableHead>
                <TableHead>目标</TableHead>
                <TableHead>来源</TableHead>
                <TableHead>通道</TableHead>
                <TableHead>流量</TableHead>
                <TableHead>连接时间</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {connections.length === 0 ? (
                <TableRow>
                  <TableCell className="py-8 text-center text-muted-foreground" colSpan={6}>暂无活跃连接</TableCell>
                </TableRow>
              ) : connections.map((connection) => (
                <TableRow key={`${connection.proxyId}:${connection.id}`}>
                  <TableCell>
                    <div className="font-medium text-foreground">{connection.login ?? '未认证'}</div>
                    {connection.username ? (
                      <div className="text-xs text-muted-foreground">{connection.username}</div>
                    ) : null}
                  </TableCell>
                  <TableCell>
                    {connection.serverSlug && connection.containerName ? (
                      <>
                        <div>{`${connection.serverSlug}.${connection.containerName}`}</div>
                        {connection.containerId || connection.instanceName ? (
                          <div className="break-all font-mono text-xs text-muted-foreground">
                            {connection.containerId ?? connection.instanceName}
                          </div>
                        ) : null}
                      </>
                    ) : (
                      <span className="text-muted-foreground">未绑定容器</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="font-mono text-xs">{connection.peer}</div>
                    <div className="text-xs text-muted-foreground truncate max-w-56">{connection.proxyId}</div>
                  </TableCell>
                  <TableCell>{connection.channels ?? '无'}</TableCell>
                  <TableCell>入 {formatBytes(connection.bytesFromClient)} / 出 {formatBytes(connection.bytesToClient)}</TableCell>
                  <TableCell>{formatTime(connection.connectedAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
      </SectionCard>
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
  if (Number.isNaN(date.getTime())) return '未知';
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
