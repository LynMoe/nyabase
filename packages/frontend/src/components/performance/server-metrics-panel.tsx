import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { PerformanceAdminUsageResponse, PerformanceMultiSeriesResponse, PerformanceRange } from '@nyabase/common';
import { api } from '../../lib/api.js';
import { queryKeys } from '../../lib/query-keys.js';
import { queryPollInterval } from '../../lib/query-lifecycle.js';
import { Button } from '../ui/button.js';
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from '../ui/select.js';
import { QueryErrorState } from '../query-state.js';
import { LinkedCharts } from './linked-charts.js';
import { useGpuNames } from './gpu-names.js';

const RANGES: Array<{ id: PerformanceRange; label: string }> = [
  { id: '15m', label: '15分钟' },
  { id: '1h', label: '1小时' },
  { id: '6h', label: '6小时' },
  { id: '24h', label: '24小时' },
];
const METRICS = 'cpu,memory,disk,gpu,network';

export function ServerMetricsPanel({ serverId }: { serverId: string }) {
  const [range, setRange] = useState<PerformanceRange>('1h');
  const [subject, setSubject] = useState('all');
  const gpuNames = useGpuNames(serverId, true);
  const usageQuery = useQuery({
    queryKey: queryKeys.performance.scoped('admin', serverId),
    queryFn: () => api.get<PerformanceAdminUsageResponse>(`/admin/performance/usage?serverId=${serverId}`),
    refetchInterval: (query) => queryPollInterval(query.state, { activeIntervalMs: 15_000 }),
  });
  const userId = subject.startsWith('user:') ? subject.slice(5) : '';
  const containerId = subject.startsWith('container:') ? subject.slice(10) : '';
  const seriesQuery = useQuery({
    queryKey: queryKeys.performance.multi('admin', serverId, subject, range),
    queryFn: () => {
      const params = new URLSearchParams({ serverId, metrics: METRICS, range });
      if (userId) params.set('userId', userId);
      if (containerId) params.set('containerId', containerId);
      return api.get<PerformanceMultiSeriesResponse>(`/admin/performance/series?${params.toString()}`);
    },
    refetchInterval: (query) => queryPollInterval(query.state, { activeIntervalMs: 15_000 }),
  });
  const server = usageQuery.data?.servers[0];
  const people = server?.people ?? [];
  const containers = server?.containers ?? [];
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Select value={subject} onValueChange={setSubject}>
          <SelectTrigger className="h-8 w-auto min-w-40 text-sm" aria-label="对象">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部</SelectItem>
            {people.length > 0 ? <SelectSeparator /> : null}
            {people.map((person) => (
              <SelectItem key={person.userId} value={`user:${person.userId}`}>{person.displayName}</SelectItem>
            ))}
            {containers.length > 0 ? <SelectSeparator /> : null}
            {containers.map((container) => (
              <SelectItem key={container.containerId} value={`container:${container.containerId}`}>{container.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        {RANGES.map((item) => (
          <Button key={item.id} type="button" size="sm" variant={range === item.id ? 'secondary' : 'ghost'} onClick={() => setRange(item.id)}>{item.label}</Button>
        ))}
      </div>
      {seriesQuery.isError
        ? <QueryErrorState error={seriesQuery.error} resourceName="监控" onRetry={() => { void seriesQuery.refetch(); }} />
        : seriesQuery.data
          ? <LinkedCharts series={seriesQuery.data} syncId={`nyabase-server-${serverId}`} height="h-72" gpuNames={gpuNames} />
          : <p className="text-sm text-muted-foreground">加载图表...</p>}
    </div>
  );
}
