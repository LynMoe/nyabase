import { Activity, Globe, Wifi } from 'lucide-react';
import type { HttpProxyStatusReport } from '@nyabase/common';
import { Badge } from '../../components/ui/badge.js';
import { MetricTile, SectionCard } from '../../components/layout/section-card.js';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../../components/ui/table.js';
import { TechnicalId } from '../../components/refs/technical-id.js';

export interface HttpProxyAdminStatus {
  connectedProxies: number;
  activeConnections: number;
  totalRequests: number;
  totalRejectedRequests: number;
  updatedAt: string | null;
  proxies: HttpProxyStatusReport[];
}

export const emptyStatus: HttpProxyAdminStatus = {
  connectedProxies: 0,
  activeConnections: 0,
  totalRequests: 0,
  totalRejectedRequests: 0,
  updatedAt: null,
  proxies: [],
};

export function HttpStatusSections({ status }: { status: HttpProxyAdminStatus }) {
  return (
    <div className="space-y-6">
      <section className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <MetricTile icon={Wifi} label="在线代理" value={status.connectedProxies.toString()} sub={`${(status.proxies ?? []).length} 个实例上报`} />
        <MetricTile icon={Activity} label="活跃连接" value={status.activeConnections.toString()} sub={`累计请求 ${status.totalRequests}`} />
        <MetricTile icon={Globe} label="累计请求" value={status.totalRequests.toString()} sub={`拒绝 ${status.totalRejectedRequests}`} />
        <MetricTile icon={Activity} label="拒绝请求" value={status.totalRejectedRequests.toString()} sub="累计拒绝" />
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
          <Table className="min-w-[640px]">
            <TableHeader>
              <TableRow>
                <TableHead>代理</TableHead>
                <TableHead>HTTP</TableHead>
                <TableHead>HTTPS</TableHead>
                <TableHead>连接</TableHead>
                <TableHead>请求</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(status.proxies ?? []).length === 0 ? (
                <TableRow>
                  <TableCell className="py-8 text-center text-muted-foreground" colSpan={5}>暂无在线 HTTP 代理</TableCell>
                </TableRow>
              ) : (status.proxies ?? []).map((proxy) => (
                <TableRow key={proxy.proxyId}>
                  <TableCell>
                    {proxy.hostname ? (
                      <div className="font-medium text-foreground">{proxy.hostname}</div>
                    ) : null}
                    <TechnicalId label="代理" value={proxy.proxyId} kind="opaque" />
                  </TableCell>
                  <TableCell className="font-mono text-xs">{formatListen(proxy.httpListen)}</TableCell>
                  <TableCell className="font-mono text-xs">{formatListen(proxy.httpsListen)}</TableCell>
                  <TableCell>{proxy.activeConnections}</TableCell>
                  <TableCell className="whitespace-nowrap">{proxy.totalRequests} / 拒绝 {proxy.totalRejectedRequests}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
      </SectionCard>
    </div>
  );
}

function formatListen(value: string | null | undefined): string {
  if (!value) return '—';
  return value.startsWith(':') ? `0.0.0.0${value}` : value;
}

export function formatTime(value: string | number): string {
  const date = typeof value === 'number' ? new Date(value) : new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return date.toLocaleString();
}
