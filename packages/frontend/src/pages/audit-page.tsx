import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getRouteApi, useNavigate } from '@tanstack/react-router';
import { RefreshCw } from 'lucide-react';
import type { AuditListResponse, AuditLogDto } from '@nyabase/common';
import { api } from '../lib/api.js';
import { Button } from '../components/ui/button.js';
import { Pagination } from '../components/ui/pagination.js';
import { Page } from '../components/layout/page.js';
import { SectionCard } from '../components/layout/section-card.js';
import { PageHeader } from '../components/layout/page-header.js';
import { QueryView } from '../components/layout/query-view.js';
import { EmptyState } from '../components/layout/empty-state.js';
import { cn } from '../lib/utils.js';
import { queryPollInterval } from '../lib/query-lifecycle.js';
import { queryKeys } from '../lib/query-keys.js';
import { errorMessage } from '../lib/api-error.js';
import { auditActionOptions, auditResourceTypeOptions } from '../lib/audit-labels.js';
import { AuditDetailDialog, AuditTable, FilterSelect } from './audit-page/audit-parts.js';

const PAGE_SIZES = [25, 50, 100] as const;
type AuditPageSize = (typeof PAGE_SIZES)[number];
const auditRouteApi = getRouteApi('/audit/');

export default function AuditPage() {
  const { page, pageSize, action, targetType } = auditRouteApi.useSearch();
  const navigate = useNavigate({ from: '/audit/' });
  const [detailId, setDetailId] = useState<string | null>(null);
  const offset = page * pageSize;

  const auditQuery = useQuery({
    queryKey: queryKeys.audit.list(pageSize, offset, { action, targetType }),
    queryFn: () => {
      const params = new URLSearchParams({ limit: String(pageSize), offset: String(offset) });
      if (action) params.set('action', action);
      if (targetType) params.set('targetType', targetType);
      return api.get<AuditListResponse>(`/audit?${params.toString()}`);
    },
    refetchInterval: (query) => queryPollInterval(query.state, { activeIntervalMs: 30_000 }),
  });
  const { data, isFetching, refetch } = auditQuery;
  const logs = data?.items ?? [];
  const total = data?.total ?? 0;
  const currentStart = total === 0 ? 0 : offset + 1;
  const currentEnd = Math.min(offset + logs.length, total);
  const selectedLog = useMemo(
    () => logs.find((log) => log.id === detailId) ?? null,
    [detailId, logs],
  );
  const {
    data: detailLog,
    error: detailError,
    isFetching: isDetailFetching,
    isLoading: isDetailLoading,
  } = useQuery({
    queryKey: queryKeys.audit.detail(detailId ?? ''),
    queryFn: () => {
      if (!detailId) throw new Error('Missing audit log id');
      return api.get<AuditLogDto>(`/audit/${encodeURIComponent(detailId)}`);
    },
    enabled: detailId !== null,
  });
  const dialogLog = detailLog ?? selectedLog;

  const setSearch = (next: { page: number; pageSize: AuditPageSize }) => {
    void navigate({ search: (prev) => ({ ...prev, ...next }) });
  };
  const setFilter = (next: { action?: string; targetType?: string }) => {
    void navigate({ search: (prev) => ({ ...prev, ...next, page: 0 }) });
  };
  const filtered = Boolean(action || targetType);

  return (
    <Page>
      <PageHeader
        title="审计日志"
        description={data ? `共 ${total} 条，当前显示 ${currentStart}-${currentEnd}` : '审计记录数量尚未加载'}
        actions={
          <Button variant="outline" size="icon" aria-label="刷新审计日志" onClick={() => refetch()} disabled={isFetching}>
            <RefreshCw className={cn('h-4 w-4', isFetching && 'animate-spin')} />
          </Button>
        }
      />

      <QueryView
        query={auditQuery}
        resourceName="审计记录"
        loadingLabel="加载审计记录..."
        skeleton={
          <div className="space-y-2">
            {[1, 2, 3].map((i) => <div key={i} className="h-14 bg-muted rounded-lg animate-pulse" />)}
          </div>
        }
        showEmpty={logs.length === 0 && !filtered}
        empty={<EmptyState title="暂无审计记录" />}
      >
        {(list) => (
          <SectionCard
            flush
            toolbar={(
              <div className="flex flex-wrap items-center gap-2">
                <FilterSelect
                  label="操作"
                  allLabel="全部操作"
                  value={action}
                  options={auditActionOptions()}
                  onChange={(value) => setFilter({ action: value })}
                />
                <FilterSelect
                  label="对象类型"
                  allLabel="全部对象"
                  value={targetType}
                  options={auditResourceTypeOptions()}
                  onChange={(value) => setFilter({ targetType: value })}
                />
                {filtered ? (
                  <Button variant="ghost" size="sm" onClick={() => setFilter({ action: undefined, targetType: undefined })}>
                    清除筛选
                  </Button>
                ) : null}
              </div>
            )}
          >
            <AuditTable items={list.items} onView={setDetailId} />
          </SectionCard>
        )}
      </QueryView>

      <Pagination
        page={page}
        pageSize={pageSize}
        total={total}
        pageSizes={PAGE_SIZES}
        onPageChange={(nextPage) => setSearch({ page: Math.max(0, nextPage), pageSize })}
        onPageSizeChange={(nextSize) => {
          const parsed: AuditPageSize = nextSize === 25 || nextSize === 50 || nextSize === 100 ? nextSize : 50;
          setSearch({ page: 0, pageSize: parsed });
        }}
      />

      <AuditDetailDialog
        log={dialogLog}
        loading={isDetailLoading && !dialogLog}
        refreshing={isDetailFetching && Boolean(dialogLog)}
        error={detailError ? errorMessage(detailError, '加载审计详情失败') : null}
        open={detailId !== null}
        onOpenChange={(open) => {
          if (!open) setDetailId(null);
        }}
      />
    </Page>
  );
}
