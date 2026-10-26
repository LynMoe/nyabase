import { useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { SshProxyRefusalsDto } from '@nyabase/common';
import { api } from '../../lib/api.js';
import { queryKeys } from '../../lib/query-keys.js';
import { formatTime, sortedCounts, sshHistoryLabel } from '../../lib/ssh-sessions.js';
import { Badge } from '../../components/ui/badge.js';
import { SegmentedFilter } from '../../components/layout/list-search.js';
import { QueryView } from '../../components/layout/query-view.js';
import { SectionCard } from '../../components/layout/section-card.js';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../components/ui/table.js';

const RANGES = [
  { value: '24', label: '24 小时' },
  { value: '168', label: '7 天' },
  { value: '720', label: '30 天' },
] as const;
type Range = (typeof RANGES)[number]['value'];

/** Connections that never authenticated, summed per source address and reason. */
export function RefusalsSection() {
  const [range, setRange] = useState<Range>('24');
  const hours = Number(range);
  const refusalsQuery = useQuery({
    queryKey: queryKeys.sshProxy.refusals(hours),
    queryFn: () => api.get<SshProxyRefusalsDto>(`/admin/ssh-proxy/refusals?hours=${hours}`),
    placeholderData: keepPreviousData,
  });
  return (
    <SectionCard
      title="未认证连接"
      description="没有通过公钥认证的连接（未知公钥、扫描器、超过连接上限等），按来源地址与原因汇总，不逐条记录。"
      actions={<SegmentedFilter label="时间范围" value={range} options={RANGES} onChange={setRange} />}
      flush
      testId="ssh-proxy-refusals"
    >
      <QueryView query={refusalsQuery} resourceName="未认证连接" loadingLabel="加载未认证连接...">
        {(data) => (
          <div>
            <div className="flex flex-wrap items-center gap-1.5 px-4 py-3 text-sm">
              <span className="mr-1">共 {data.total} 次</span>
              {sortedCounts(data.reasons).map(([reason, count]) => (
                <Badge key={reason} variant="outline" className="font-normal">{sshHistoryLabel(reason)} × {count}</Badge>
              ))}
            </div>
            <Table className="min-w-[620px]">
              <TableHeader>
                <TableRow>
                  <TableHead>来源地址</TableHead>
                  <TableHead>原因</TableHead>
                  <TableHead className="text-right">次数</TableHead>
                  <TableHead>最近一次（所在汇总窗口结束）</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.topSources.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={4} className="py-8 text-center text-muted-foreground">这段时间没有未认证连接</TableCell>
                  </TableRow>
                ) : data.topSources.map((source) => (
                  <TableRow key={`${source.peerIp ?? ''}:${source.reason}`}>
                    <TableCell className="font-mono text-xs">{source.peerIp ?? '其他地址（超出单窗口上限）'}</TableCell>
                    <TableCell>{sshHistoryLabel(source.reason)}</TableCell>
                    <TableCell className="text-right tabular-nums">{source.count}</TableCell>
                    <TableCell>{formatTime(source.lastSeenAt)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </QueryView>
    </SectionCard>
  );
}
