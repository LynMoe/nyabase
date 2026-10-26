import { useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import {
  roleAtLeast,
  Role,
  type IntentKind,
  type IntentResourceType,
  type CursorPaginatedResponse,
  type IntentDto,
} from '@nyabase/common';
import { Activity } from 'lucide-react';
import { api } from '../lib/api.js';
import { Pagination } from '../components/ui/pagination.js';
import { IntentDetailDialog } from '../components/intents/intent-detail-dialog.js';
import { Page, PageHeader } from '../components/layout/page-header.js';
import { QueryView } from '../components/layout/query-view.js';
import { SectionCard } from '../components/layout/section-card.js';
import { useAuthStore } from '../store/auth.js';
import { useCursorPages } from '../hooks/use-cursor-pages.js';
import { intentPending } from '../lib/in-progress.js';
import { queryKeys } from '../lib/query-keys.js';
import { refetchWhileInProgress } from '../lib/query-lifecycle.js';
import { IntentFilters, type IntentFilterState, type StatusSegment } from './ops-page/ops-parts.js';
import { IntentsTable } from './ops-page/ops-parts.js';
import { ACCESS } from '../lib/route-access.js';

const PAGE_SIZES = [25, 50, 100] as const;
type OpsPageSize = (typeof PAGE_SIZES)[number];

function adminIntentsPath(filters: {
  segment: StatusSegment;
  kind?: IntentKind;
  resourceType?: IntentResourceType;
  serverId?: string;
  limit: number;
  cursor?: string;
}): string {
  const params = new URLSearchParams({ scope: 'all' });
  params.set('limit', String(filters.limit));
  if (filters.segment === 'pending') params.set('status', 'pending');
  if (filters.segment === 'failed') params.set('status', 'failed');
  if (filters.kind) params.set('kind', filters.kind);
  if (filters.resourceType) params.set('resourceType', filters.resourceType);
  if (filters.serverId) params.set('serverId', filters.serverId);
  if (filters.cursor) params.set('cursor', filters.cursor);
  return `/intents?${params.toString()}`;
}

/**
 * The list API is keyset-paginated without a total (counting the whole intent
 * history per filter is not cheap), so pages are walked with a cursor stack:
 * 上一页 / 下一页, back to page 1 whenever a filter or the page size changes.
 * Only the page on screen is polled.
 */
export default function OpsPage() {
  const user = useAuthStore((state) => state.user);
  const canManageServers = user ? roleAtLeast(user.role, Role.UserAdmin) : false;
  // The server pages themselves are admin-only; user admins only filter by server.
  const canOpenServers = user ? roleAtLeast(user.role, ACCESS.servers) : false;
  const [filters, setFilters] = useState<IntentFilterState>({ segment: 'all' });
  const [pageSize, setPageSize] = useState<OpsPageSize>(50);
  const [selected, setSelected] = useState<IntentDto | null>(null);
  const { segment, kind, resourceType } = filters;
  const serverId = canManageServers ? filters.serverId : undefined;
  const pages = useCursorPages(JSON.stringify([segment, kind, resourceType, serverId, pageSize]));

  const intentsQuery = useQuery({
    queryKey: queryKeys.adminIntents({
      status: segment === 'all' ? undefined : segment,
      kind,
      resourceType,
      serverId,
      limit: pageSize,
      cursor: pages.cursor,
    }),
    queryFn: () => api.get<CursorPaginatedResponse<IntentDto>>(adminIntentsPath({
      segment,
      kind,
      resourceType,
      serverId,
      limit: pageSize,
      cursor: pages.cursor,
    })),
    placeholderData: keepPreviousData,
    refetchInterval: (query) => refetchWhileInProgress(query.state, {
      steadyIntervalMs: 15_000,
      isSettled: (data) => data.items.every((item) => !intentPending(item.status)),
    }),
  });
  const turning = intentsQuery.isPlaceholderData;

  return (
    <Page testId="ops-page">
      <PageHeader title="操作记录" description="控制面对容器、存储、服务器等资源发起的所有异步操作。" />

      <SectionCard
        toolbar={
          <IntentFilters
            filters={filters}
            onChange={(change) => setFilters((current) => ({ ...current, ...change }))}
            showServerFilter={canManageServers}
          />
        }
        flush
      >
        <QueryView query={intentsQuery} resourceName="操作记录" loadingLabel="加载操作记录...">
          {(data) => data.items.length === 0 ? (
            <div className="flex flex-col items-center gap-2 px-6 py-12 text-center">
              <Activity className="h-10 w-10 text-muted-foreground/40" />
              <p className="text-sm font-medium">{pages.page > 0 ? '这一页已没有操作记录。' : '暂无操作记录。'}</p>
            </div>
          ) : (
            <div className={turning ? 'opacity-60 transition-opacity' : undefined} aria-busy={turning}>
              <IntentsTable items={data.items} linkServers={canOpenServers} onSelect={setSelected} />
            </div>
          )}
        </QueryView>
      </SectionCard>
      {intentsQuery.data && (
        <Pagination
          page={pages.page}
          pageSize={pageSize}
          pageSizes={PAGE_SIZES}
          hasNext={intentsQuery.data.nextCursor != null}
          busy={turning}
          onPageChange={(next) => {
            if (next < pages.page) pages.previous();
            else pages.next(intentsQuery.data?.nextCursor);
          }}
          onPageSizeChange={(size) => {
            setPageSize(size === 25 || size === 100 ? size : 50);
          }}
        />
      )}
      <IntentDetailDialog
        intent={selected}
        open={selected != null}
        onOpenChange={(open) => { if (!open) setSelected(null); }}
        onRetried={() => { void intentsQuery.refetch(); }}
      />
    </Page>
  );
}
