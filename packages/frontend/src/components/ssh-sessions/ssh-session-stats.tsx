import { useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Activity, Boxes, PlugZap, Users } from 'lucide-react';
import type { ListScope, SshSessionDailyUsageDto, SshSessionStatsDto } from '@nyabase/common';
import { api } from '../../lib/api.js';
import { queryKeys } from '../../lib/query-keys.js';
import { sortedCounts, sshHistoryLabel, sshSessionStatsPath } from '../../lib/ssh-sessions.js';
import { formatBytes, formatBytesCompact } from '../../lib/utils.js';
import { SegmentedFilter } from '../layout/list-search.js';
import { QueryView } from '../layout/query-view.js';
import { MetricTile, SectionCard } from '../layout/section-card.js';
import { Badge } from '../ui/badge.js';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../ui/table.js';

const RANGES = [
  { value: '7', label: '7 天' },
  { value: '30', label: '30 天' },
  { value: '90', label: '90 天' },
] as const;
type Range = (typeof RANGES)[number]['value'];

/** The one series' color; matches the performance charts' primary series. */
const SERIES_COLOR = 'hsl(221 83% 53%)';

export function SshSessionStats({ scope, containerId }: { scope: ListScope; containerId?: string }) {
  const [range, setRange] = useState<Range>('30');
  const days = Number(range);
  const statsQuery = useQuery({
    queryKey: queryKeys.sshSessions.stats(scope, days, containerId),
    queryFn: () => api.get<SshSessionStatsDto>(sshSessionStatsPath(scope, days, containerId)),
    placeholderData: keepPreviousData,
  });
  return (
    <SectionCard
      title="SSH 使用统计"
      description="按天（UTC）"
      actions={<SegmentedFilter label="时间范围" value={range} options={RANGES} onChange={setRange} />}
      testId="ssh-session-stats"
    >
      <QueryView query={statsQuery} resourceName="SSH 使用统计" loadingLabel="加载 SSH 使用统计...">
        {(stats) => <StatsBody stats={stats} scope={scope} containerScoped={containerId !== undefined} />}
      </QueryView>
    </SectionCard>
  );
}

function StatsBody({
  stats,
  scope,
  containerScoped,
}: {
  stats: SshSessionStatsDto;
  scope: ListScope;
  containerScoped: boolean;
}) {
  const { totals } = stats;
  const closeReasons = sortedCounts(stats.closeReasons);
  const rejected = sortedCounts(stats.rejectedRequests);
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <MetricTile icon={PlugZap} label="连接" value={totals.connections.toString()} sub={`${stats.days} 天内`} />
        <MetricTile icon={Activity} label="通道" value={totals.channels.toString()} sub="成功打开的通道" />
        <MetricTile
          icon={Boxes}
          label="流量"
          value={formatBytes(totals.bytesFromClient + totals.bytesToClient)}
          sub={`上行 ${formatBytes(totals.bytesFromClient)} / 下行 ${formatBytes(totals.bytesToClient)}`}
        />
        <MetricTile
          icon={Users}
          label={scope === 'all' ? '用户 / 容器' : '容器'}
          value={scope === 'all' ? `${totals.users} / ${totals.containers}` : totals.containers.toString()}
          sub="有过连接的"
        />
      </div>

      <DailyTrafficChart daily={stats.daily} />

      <div className="grid gap-4 lg:grid-cols-2">
        {!containerScoped ? (
          <TopTable
            title="流量最多的容器"
            empty="没有打开过通道"
            rows={stats.topContainers.map((entry) => ({
              key: entry.containerId,
              name: `${entry.serverSlug}.${entry.containerName}`,
              count: `${entry.channels} 个通道`,
              bytes: entry.bytes,
            }))}
          />
        ) : null}
        {scope === 'all' ? (
          <TopTable
            title="流量最多的用户"
            empty="没有连接"
            rows={stats.topUsers.map((entry) => ({
              key: entry.userId,
              name: entry.username,
              count: `${entry.connections} 次连接`,
              bytes: entry.bytes,
            }))}
          />
        ) : null}
        <CountList title="连接结束原因" counts={closeReasons} empty="这段时间没有结束的连接" />
        <CountList title="被拒绝的请求" counts={rejected} empty="没有被拒绝的请求" />
      </div>
    </div>
  );
}

function DailyTrafficChart({ daily }: { daily: SshSessionDailyUsageDto[] }) {
  const data = daily.map((row) => ({ ...row, bytes: row.bytesFromClient + row.bytesToClient }));
  const hasTraffic = data.some((row) => row.bytes > 0 || row.connections > 0);
  return (
    <div>
      <p className="mb-2 text-sm font-medium">每日流量</p>
      {hasTraffic ? (
        <div className="h-56" data-testid="ssh-daily-traffic">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} barCategoryGap={2}>
              <CartesianGrid stroke="hsl(var(--border))" vertical={false} />
              <XAxis
                dataKey="day"
                tickFormatter={(value: string) => value.slice(5).replace('-', '/')}
                tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }}
                minTickGap={24}
                axisLine={false}
                tickLine={false}
              />
              <YAxis
                width={64}
                tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }}
                tickFormatter={(value: number) => formatBytesCompact(value)}
                axisLine={false}
                tickLine={false}
              />
              <Tooltip
                isAnimationActive={false}
                cursor={{ fill: 'hsl(var(--muted))', opacity: 0.6 }}
                wrapperStyle={{ outline: 'none', zIndex: 30 }}
                content={(props) => <DayHover active={props.active} payload={props.payload} />}
              />
              <Bar dataKey="bytes" fill={SERIES_COLOR} radius={[4, 4, 0, 0]} maxBarSize={28} isAnimationActive={false} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <p className="rounded-md border border-dashed px-3 py-8 text-center text-sm text-muted-foreground">这段时间没有 SSH 连接</p>
      )}
    </div>
  );
}

function DayHover({
  active,
  payload,
}: {
  active?: boolean;
  payload?: ReadonlyArray<{ payload?: SshSessionDailyUsageDto }>;
}) {
  const row = payload?.[0]?.payload;
  if (!active || !row) return null;
  return (
    <div className="rounded-md border bg-popover px-2 py-1.5 text-xs text-popover-foreground shadow-md">
      <p className="tabular-nums text-muted-foreground">{row.day}</p>
      <p className="mt-1 tabular-nums">上行 {formatBytes(row.bytesFromClient)} · 下行 {formatBytes(row.bytesToClient)}</p>
      <p className="tabular-nums text-muted-foreground">{row.connections} 次连接 · {row.channels} 个通道</p>
    </div>
  );
}

function TopTable({
  title,
  empty,
  rows,
}: {
  title: string;
  empty: string;
  rows: Array<{ key: string; name: string; count: string; bytes: number }>;
}) {
  return (
    <div className="overflow-hidden rounded-lg border">
      <p className="border-b px-3 py-2 text-sm font-medium">{title}</p>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>名称</TableHead>
            <TableHead>次数</TableHead>
            <TableHead className="text-right">流量</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.length === 0 ? (
            <TableRow><TableCell colSpan={3} className="py-6 text-center text-muted-foreground">{empty}</TableCell></TableRow>
          ) : rows.map((row) => (
            <TableRow key={row.key}>
              <TableCell className="max-w-[220px] truncate">{row.name}</TableCell>
              <TableCell className="text-muted-foreground">{row.count}</TableCell>
              <TableCell className="text-right tabular-nums">{formatBytes(row.bytes)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function CountList({ title, counts, empty }: { title: string; counts: Array<[string, number]>; empty: string }) {
  return (
    <div className="rounded-lg border p-3">
      <p className="mb-2 text-sm font-medium">{title}</p>
      {counts.length === 0 ? (
        <p className="text-sm text-muted-foreground">{empty}</p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {counts.map(([code, count]) => (
            <Badge key={code} variant="outline" className="font-normal">{sshHistoryLabel(code)} × {count}</Badge>
          ))}
        </div>
      )}
    </div>
  );
}
