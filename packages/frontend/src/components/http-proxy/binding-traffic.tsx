import type { HttpProxyBindingStatsDto } from '@nyabase/common';
import { TableCell, TableHead } from '../ui/table.js';
import { formatBytesCompact, formatRate } from '../../lib/utils.js';
import { formatRequestCount } from '../../lib/http-proxy.js';

/** Binding lists refresh this often while open, so the live columns move. */
export const HTTP_PROXY_BINDINGS_POLL_MS = 5_000;

const DIRECTION_HINT = '入：访客发往容器；出：容器返回访客';

/** Header cells matching `BindingTrafficCells`, shared by the user and admin tables. */
export function BindingTrafficHeads() {
  return (
    <>
      <TableHead className="text-right">累计请求</TableHead>
      <TableHead className="text-right">活跃连接</TableHead>
      <TableHead title={DIRECTION_HINT}>实时流量 / 累计流量</TableHead>
    </>
  );
}

function rateLabel(bytesPerSec: number | null): string {
  return bytesPerSec === null ? '—' : formatRate(bytesPerSec);
}

export function BindingTrafficCells({ stats }: { stats: HttpProxyBindingStatsDto }) {
  const live = stats.rxBytesPerSec !== null || stats.txBytesPerSec !== null;
  return (
    <>
      <TableCell
        className="whitespace-nowrap text-right tabular-nums"
        title={`${stats.totalRequests.toLocaleString('zh-CN')} 次请求`}
      >
        {formatRequestCount(stats.totalRequests)}
      </TableCell>
      <TableCell className="whitespace-nowrap text-right tabular-nums">
        {stats.activeConnections.toLocaleString('zh-CN')}
      </TableCell>
      <TableCell className="whitespace-nowrap tabular-nums" title={DIRECTION_HINT}>
        <div className={live ? undefined : 'text-muted-foreground'}>
          入 {rateLabel(stats.rxBytesPerSec)} · 出 {rateLabel(stats.txBytesPerSec)}
        </div>
        <div className="text-xs text-muted-foreground">
          累计 入 {formatBytesCompact(stats.totalRxBytes)} · 出 {formatBytesCompact(stats.totalTxBytes)}
        </div>
      </TableCell>
    </>
  );
}
