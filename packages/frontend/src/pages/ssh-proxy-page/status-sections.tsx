import type { ComponentType } from 'react';
import { Activity, Gauge, PlugZap, Wifi } from 'lucide-react';
import type { SshProxyStatusReport } from '@nyabase/common';
import { formatBytes, formatRate } from '../../lib/utils.js';
import { Badge } from '../../components/ui/badge.js';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../../components/ui/table.js';
import { SectionCard } from '../../components/layout/section-card.js';
import { TechnicalId } from '../../components/refs/technical-id.js';

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
  proxies: SshProxyStatusReport[];
}

export function SshStatusSections({ status }: { status: SshProxyAdminStatus }) {
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
                    {proxy.hostname ? (
                      <div className="font-medium text-foreground">{proxy.hostname}</div>
                    ) : null}
                    <TechnicalId label="代理" value={proxy.proxyId} kind="opaque" />
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
                      {connection.serverSlug && connection.containerName ? (
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
  proxies: [],
};
