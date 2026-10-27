import { Activity, Gauge, PlugZap, RefreshCw, RotateCcw, ShieldAlert, Wifi } from 'lucide-react';
import { Link } from '@tanstack/react-router';
import type { SshProxyHostKeySummaryDto, SshProxySnapshotSummaryDto, SshProxyStatusReport } from '@nyabase/common';
import { useMutation, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { formatBytes, formatRate } from '../../lib/utils.js';
import { Badge } from '../../components/ui/badge.js';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../components/ui/table.js';
import { MetricTile, SectionCard } from '../../components/layout/section-card.js';
import { TechnicalId } from '../../components/refs/technical-id.js';
import { Button } from '../../components/ui/button.js';
import { QueryView } from '../../components/layout/query-view.js';
import { api } from '../../lib/api.js';
import { errorMessage } from '../../lib/api-error.js';
import { toast } from '../../hooks/use-toast.js';
import { queryKeys } from '../../lib/query-keys.js';

export interface SshProxyAdminStatus {
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
  snapshot: SshProxySnapshotSummaryDto | null;
  proxies: SshProxyStatusReport[];
}

/** Above this share of the cap the next growth could make every build fail. */
const SNAPSHOT_WARN_RATIO = 0.75;

export function SshStatusSections({ status, noLines }: { status: SshProxyAdminStatus; noLines: boolean }) {
  const proxies = status.proxies ?? [];
  const connections = proxies.flatMap((proxy) => (proxy.connections ?? []).map((connection) => ({
    ...connection,
    proxyId: proxy.proxyId,
  })));

  const latest = status.snapshot?.generation ?? null;
  return (
    <div className="space-y-6">
      <SnapshotHealth status={status} noLines={noLines} />
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
                <TableHead>连接（当前 / 累计）</TableHead>
                <TableHead>带宽</TableHead>
                <TableHead>流量</TableHead>
                <TableHead>快照</TableHead>
                <TableHead>历史待发</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {proxies.length === 0 ? (
                <TableRow>
                  <TableCell className="py-8 text-center text-muted-foreground" colSpan={7}>暂无在线 SSH 代理</TableCell>
                </TableRow>
              ) : proxies.map((proxy) => (
                <TableRow key={proxy.proxyId}>
                  <TableCell>
                    {proxy.hostname ? (
                      <div className="font-medium text-foreground">{proxy.hostname}</div>
                    ) : null}
                    <TechnicalId label="代理" value={proxy.proxyId} kind="opaque" />
                  </TableCell>
                  <TableCell className="font-mono text-xs">{proxy.listen}</TableCell>
                  <TableCell>{proxy.activeConnections} / {proxy.totalConnections}</TableCell>
                  <TableCell>{formatRate(proxy.bandwidthInBps)} / {formatRate(proxy.bandwidthOutBps)}</TableCell>
                  <TableCell>{formatBytes(proxy.totalBytesFromClient + proxy.totalBytesToClient)}</TableCell>
                  <TableCell>
                    {proxy.lastSnapshotGeneration ?? '-'}
                    {latest !== null && proxy.lastSnapshotGeneration !== null && proxy.lastSnapshotGeneration < latest ? (
                      <Badge variant="outline" className="ml-2">落后于 {latest}</Badge>
                    ) : null}
                  </TableCell>
                  <TableCell>
                    {proxy.historyBacklog ?? '-'}
                    {proxy.historyDropped ? (
                      <Badge variant="warning" className="ml-2">已丢弃 {proxy.historyDropped}</Badge>
                    ) : null}
                  </TableCell>
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
              ) : connections.map((connection) => {
                const targetId = connection.containerId ?? connection.instanceName;
                return (
                  <TableRow key={`${connection.proxyId}:${connection.id}`}>
                    <TableCell>
                      <div className="font-medium text-foreground">{connection.login ?? '未认证'}</div>
                      {connection.username ? (
                        <div className="text-xs text-muted-foreground">{connection.username}</div>
                      ) : null}
                    </TableCell>
                    <TableCell>
                      {connection.bridges && connection.bridges.length > 0 ? (
                        <div className="space-y-1">
                          {connection.bridges.map((bridge) => (
                            <div key={bridge.channelSeq} className="text-sm">
                              {`${bridge.serverSlug}.${bridge.containerName}`}
                              <span className="ml-2 text-xs text-muted-foreground tabular-nums">
                                {formatBytes(bridge.bytesFromClient)} / {formatBytes(bridge.bytesToClient)}
                              </span>
                            </div>
                          ))}
                        </div>
                      ) : connection.serverSlug && connection.containerName ? (
                        <>
                          <div>{`${connection.serverSlug}.${connection.containerName}`}</div>
                          {targetId ? (
                            <TechnicalId
                              label={connection.containerId ? '容器' : '实例名'}
                              value={targetId}
                              kind="opaque"
                            />
                          ) : null}
                        </>
                      ) : (
                        <span className="text-muted-foreground">未绑定容器</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="font-mono text-xs">{connection.peer}</div>
                      <TechnicalId label="代理" value={connection.proxyId} kind="opaque" />
                    </TableCell>
                    <TableCell>{connection.channels ?? '无'}</TableCell>
                    <TableCell>入 {formatBytes(connection.bytesFromClient)} / 出 {formatBytes(connection.bytesToClient)}</TableCell>
                    <TableCell>{formatTime(connection.connectedAt)}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
      </SectionCard>
    </div>
  );
}

/** The facts an operator needs before users notice: no line, a failing or nearly full snapshot. */
function SnapshotHealth({ status, noLines }: { status: SshProxyAdminStatus; noLines: boolean }) {
  const snapshot = status.snapshot;
  const ratio = snapshot && snapshot.maxBytes > 0 ? snapshot.bytes / snapshot.maxBytes : 0;
  return (
    <div className="space-y-3">
      {noLines ? (
        <Notice testId="ssh-proxy-no-lines">
          尚未添加线路，用户无法经代理登录容器。去 <Link to="/ssh-proxy" search={{ tab: 'lines' }} className="font-medium underline underline-offset-4">线路</Link> 添加。
        </Notice>
      ) : null}
      {snapshot?.error ? (
        <Notice testId="ssh-proxy-snapshot-error">
          最近一次路由快照构建失败（{snapshot.failedAt ? formatTime(snapshot.failedAt) : '未知时间'}）：{snapshot.error}。
        </Notice>
      ) : null}
      {snapshot && ratio >= SNAPSHOT_WARN_RATIO ? (
        <Notice testId="ssh-proxy-snapshot-large">
          路由快照已用 {Math.round(ratio * 100)}% 的上限（{formatBytes(snapshot.bytes)} / {formatBytes(snapshot.maxBytes)}）。
        </Notice>
      ) : null}
      {snapshot && snapshot.builtAt ? (
        <div className="rounded-lg border border-border bg-card p-4 grid gap-3 sm:grid-cols-4" data-testid="ssh-proxy-snapshot">
          <InfoCell label="快照版本" value={`${snapshot.generation}（${formatTime(snapshot.builtAt)}）`} />
          <InfoCell label="快照大小" value={`${formatBytes(snapshot.bytes)} / ${formatBytes(snapshot.maxBytes)}`} />
          <InfoCell label="可登录用户" value={snapshot.users.toString()} />
          <InfoCell label="可达容器" value={snapshot.routes.toString()} />
        </div>
      ) : null}
    </div>
  );
}

function Notice({ testId, children }: { testId: string; children: React.ReactNode }) {
  return (
    <p
      className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm"
      data-testid={testId}
    >
      <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden />
      <span>{children}</span>
    </p>
  );
}

export function InfoCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 break-all text-sm font-medium text-foreground">{value}</p>
    </div>
  );
}

export function formatTime(value: string | number): string {
  const date = typeof value === 'number' ? new Date(value) : new Date(value);
  if (Number.isNaN(date.getTime())) return '未知';
  return date.toLocaleString();
}

export const emptyStatus: SshProxyAdminStatus = {
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
  snapshot: null,
  proxies: [],
};

export function HostKeySection({
  query,
  fetching,
  rotating,
  onRefresh,
  onRotate,
  resettingAuthorities,
  onResetAuthorities,
}: {
  query: UseQueryResult<SshProxyHostKeySummaryDto>;
  fetching: boolean;
  rotating: boolean;
  onRefresh: () => void;
  onRotate: () => void;
  resettingAuthorities: boolean;
  onResetAuthorities: () => void;
}) {
  return (
      <section className="space-y-3">
        <div className="flex items-center justify-between gap-4">
          <h2 className="text-base font-semibold text-foreground">SSH 主机密钥</h2>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground" onClick={() => onRefresh()} disabled={fetching}>
              <RefreshCw className={`h-4 w-4 ${fetching ? 'animate-spin' : ''}`} />
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={rotating}
              onClick={() => onRotate()}
            >
              <RotateCcw className="h-4 w-4" />
              轮换
            </Button>
            <Button
              variant="outline-destructive"
              size="sm"
              disabled={resettingAuthorities}
              onClick={() => onResetAuthorities()}
            >
              重置容器证书 CA
            </Button>
          </div>
        </div>
        <QueryView query={query} resourceName="SSH 主机密钥" loadingLabel="加载 SSH 主机密钥...">
          {(hostKey) => (
            <div className="rounded-lg border border-border bg-card p-4 grid gap-3 sm:grid-cols-3">
              <div className="min-w-0">
                <p className="text-xs text-muted-foreground">指纹</p>
                {hostKey.fingerprint ? (
                  <div className="mt-1">
                    <TechnicalId label="指纹" value={hostKey.fingerprint} kind="opaque" />
                  </div>
                ) : (
                  <p className="mt-1 text-sm text-foreground">未配置</p>
                )}
              </div>
              <InfoCell label="版本" value={hostKey.generation?.toString() ?? '未配置'} />
              <InfoCell label="轮换时间" value={hostKey.rotatedAt ? formatTime(hostKey.rotatedAt) : '从未轮换'} />
              {hostKey.publicKey ? (
                <div className="min-w-0 sm:col-span-3">
                  <p className="text-xs text-muted-foreground">公钥</p>
                  <pre className="mt-1 overflow-x-auto rounded-md border bg-muted/50 px-3 py-2 font-mono text-xs">{hostKey.publicKey}</pre>
                </div>
              ) : null}
            </div>
          )}
        </QueryView>
      </section>
  );
}

/** The page actions on the proxy itself: disconnect everyone, rotate its host key, reset every host CA. */
interface DisconnectAllResult {
  requestId: string;
  requested: number;
  disconnected: number;
}

export function useSshProxyMutations({
  onDisconnected,
  onRotated,
  onAuthoritiesReset,
}: {
  onDisconnected: () => void;
  onRotated: () => void;
  onAuthoritiesReset: () => void;
}) {
  const qc = useQueryClient();
  const disconnectAll = useMutation({
    mutationFn: () => api.post<DisconnectAllResult>('/admin/ssh-proxy/disconnect-all'),
    onSuccess: (result) => {
      onDisconnected();
      void qc.invalidateQueries({ queryKey: queryKeys.sshProxy.status });
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
      onRotated();
      qc.setQueryData(queryKeys.sshProxy.hostKey, updated);
      void qc.invalidateQueries({ queryKey: queryKeys.sshProxy.status });
      toast({ title: 'SSH 主机密钥已轮换' });
    },
    onError: (error) => toast({
      title: '轮换失败',
      description: errorMessage(error),
      variant: 'destructive',
    }),
  });

  const resetHostAuthorities = useMutation({
    mutationFn: () => api.post<{ reset: number }>('/admin/ssh-proxy/host-authorities/reset'),
    onSuccess: (result) => {
      onAuthoritiesReset();
      toast({
        title: '容器证书 CA 已重置',
        description: `重置了 ${result.reset} 个用户的 CA，所有容器正在后台重新签发证书。`,
      });
    },
    onError: (error) => toast({
      title: '重置失败',
      description: errorMessage(error),
      variant: 'destructive',
    }),
  });

  return { disconnectAll, rotateHostKey, resetHostAuthorities };
}
