import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Capability, type PerformanceMultiSeriesResponse, type PerformanceRange, type PerformanceSelfResponse } from '@nyabase/common';
import { api } from '../lib/api.js';
import { queryKeys } from '../lib/query-keys.js';
import { queryPollInterval } from '../lib/query-lifecycle.js';
import { useAuthStore } from '../store/auth.js';
import { Page } from '../components/layout/page.js';
import { PageHeader } from '../components/layout/page-header.js';
import { Button } from '../components/ui/button.js';
import { LinkedCharts } from '../components/performance/linked-charts.js';
import { useGpuNames } from '../components/performance/gpu-names.js';
import { QueryErrorState } from '../components/query-state.js';

const RANGES: Array<{ id: PerformanceRange; label: string }> = [
  { id: '15m', label: '15分钟' },
  { id: '1h', label: '1小时' },
  { id: '6h', label: '6小时' },
  { id: '24h', label: '24小时' },
];

export default function ContainerUsagePage({
  containerId,
  admin,
}: {
  containerId: string;
  admin: boolean;
}) {
  const canView = useAuthStore((state) => state.user?.capabilities.includes(Capability.ViewMetricsAll) ?? false);
  const [range, setRange] = useState<PerformanceRange>('1h');
  const usagePath = admin ? '/admin/performance/usage' : '/performance/usage';
  const seriesPath = admin ? '/admin/performance/series' : '/performance/series';
  const selfQuery = useQuery({
    queryKey: queryKeys.performance.self(admin ? 'admin' : 'user', containerId),
    queryFn: () => api.get<PerformanceSelfResponse>(`${usagePath}?containerId=${containerId}`),
    enabled: !admin || canView,
    refetchInterval: (query) => queryPollInterval(query.state, { activeIntervalMs: 15_000 }),
  });
  const serverId = selfQuery.data?.serverId;
  const gpuNames = useGpuNames(serverId, admin);
  const seriesQuery = useQuery({
    queryKey: queryKeys.performance.multi(admin ? 'admin' : 'user', serverId ?? '', containerId, range),
    queryFn: () => api.get<PerformanceMultiSeriesResponse>(
      `${seriesPath}?serverId=${serverId}&containerId=${containerId}&metrics=cpu,memory,disk,gpu,network&range=${range}`,
    ),
    enabled: Boolean(serverId) && (!admin || canView),
    refetchInterval: (query) => queryPollInterval(query.state, { activeIntervalMs: 15_000 }),
  });
  if (admin && !canView) {
    return (
      <Page>
        <PageHeader title="使用情况" />
        <p className="text-sm text-muted-foreground">没有查看指标的权限</p>
      </Page>
    );
  }
  return (
    <Page>
      <PageHeader
        title={selfQuery.data?.container.name ?? '使用情况'}
        actions={(
          <Button asChild variant="ghost" size="sm">
            <Link
              to={admin ? '/manage/containers/$containerId' : '/containers/$containerId'}
              params={{ containerId }}
              search={{ tab: 'overview' }}
            >
              概况
            </Link>
          </Button>
        )}
      />
      <div className="flex flex-wrap gap-1">
        {RANGES.map((item) => (
          <Button key={item.id} type="button" size="sm" variant={range === item.id ? 'secondary' : 'ghost'} onClick={() => setRange(item.id)}>{item.label}</Button>
        ))}
      </div>
      {selfQuery.isError || seriesQuery.isError ? (
        <QueryErrorState
          error={seriesQuery.isError ? seriesQuery.error : selfQuery.error}
          resourceName="使用情况"
          onRetry={() => {
            if (selfQuery.isError) void selfQuery.refetch();
            if (seriesQuery.isError) void seriesQuery.refetch();
          }}
        />
      ) : seriesQuery.data
        ? <LinkedCharts series={seriesQuery.data} syncId={`nyabase-container-${containerId}`} gpuNames={gpuNames} />
        : <p className="text-sm text-muted-foreground">加载图表...</p>}
    </Page>
  );
}
