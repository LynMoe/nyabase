import { useState } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import {
  Capability,
  type IntentKind,
  type IntentResourceType,
  type CursorPaginatedResponse,
  type IntentDto,
  type ServerDto,
} from '@nyabase/common';
import { Activity } from 'lucide-react';
import { api } from '../lib/api.js';
import { Button } from '../components/ui/button.js';
import { IntentDetailDialog } from '../components/intents/intent-detail-dialog.js';
import { Page } from '../components/layout/page-header.js';
import { PageHeader } from '../components/layout/page-header.js';
import { QueryView } from '../components/layout/query-view.js';
import { SectionCard } from '../components/layout/section-card.js';
import { useAuthStore } from '../store/auth.js';
import { intentPending } from '../lib/in-progress.js';
import { queryKeys } from '../lib/query-keys.js';
import { refetchWhileInProgress } from '../lib/query-lifecycle.js';
import { IntentFilters, type StatusSegment } from './ops-page/intent-filters.js';
import { IntentsTable } from './ops-page/intents-table.js';

const PAGE_SIZE = 50;

function adminIntentsPath(filters: {
  segment: StatusSegment;
  kind?: IntentKind;
  resourceType?: IntentResourceType;
  serverId?: string;
  cursor?: string;
}): string {
  const params = new URLSearchParams({ scope: 'all' });
  params.set('limit', String(PAGE_SIZE));
  if (filters.segment === 'pending') params.set('status', 'pending');
  if (filters.segment === 'failed') params.set('status', 'failed');
  if (filters.kind) params.set('kind', filters.kind);
  if (filters.resourceType) params.set('resourceType', filters.resourceType);
  if (filters.serverId) params.set('serverId', filters.serverId);
  if (filters.cursor) params.set('cursor', filters.cursor);
  return `/intents?${params.toString()}`;
}

export default function OpsPage() {
  const user = useAuthStore((state) => state.user);
  const canManageServers = user?.capabilities.includes(Capability.ManageServers) ?? false;
  const [segment, setSegment] = useState<StatusSegment>('all');
  const [kind, setKind] = useState<IntentKind | undefined>(undefined);
  const [resourceType, setResourceType] = useState<IntentResourceType | undefined>(undefined);
  const [serverId, setServerId] = useState<string | undefined>(undefined);
  const [selected, setSelected] = useState<IntentDto | null>(null);

  const serversQuery = useQuery({
    queryKey: queryKeys.servers.admin,
    queryFn: () => api.get<ServerDto[]>('/servers?scope=all'),
    enabled: canManageServers,
  });
  const intentsQuery = useInfiniteQuery({
    queryKey: queryKeys.adminIntents({
      status: segment === 'all' ? undefined : segment,
      kind,
      resourceType,
      serverId: canManageServers ? serverId : undefined,
    }),
    queryFn: ({ pageParam }) => api.get<CursorPaginatedResponse<IntentDto>>(adminIntentsPath({
      segment,
      kind,
      resourceType,
      serverId: canManageServers ? serverId : undefined,
      cursor: pageParam,
    })),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    refetchInterval: (query) => refetchWhileInProgress(query.state, {
      steadyIntervalMs: 15_000,
      isSettled: (data) => data.pages.every((page) => page.items.every((item) => !intentPending(item.status))),
    }),
  });

  return (
    <Page testId="ops-page">
      <PageHeader title="操作记录" description="控制面对容器、存储、服务器等资源发起的所有异步操作。" />

      <SectionCard
        toolbar={
          <IntentFilters
            segment={segment}
            onSegment={setSegment}
            kind={kind}
            onKind={setKind}
            resourceType={resourceType}
            onResourceType={setResourceType}
            serverId={serverId}
            onServerId={setServerId}
            servers={serversQuery.data ?? []}
            showServerFilter={canManageServers}
          />
        }
        flush
      >
        <QueryView query={intentsQuery} resourceName="操作记录" loadingLabel="加载操作记录...">
          {(data) => {
            const items = data.pages.flatMap((page) => page.items);
            if (items.length === 0) {
              return (
                <div className="flex flex-col items-center gap-2 px-6 py-12 text-center">
                  <Activity className="h-10 w-10 text-muted-foreground/40" />
                  <p className="text-sm font-medium">暂无操作记录。</p>
                </div>
              );
            }
            return (
              <>
                <IntentsTable items={items} linkServers={canManageServers} onSelect={setSelected} />
                {intentsQuery.hasNextPage && (
                  <div className="border-t px-6 py-3">
                    <Button
                      variant="outline"
                      disabled={intentsQuery.isFetchingNextPage}
                      onClick={() => { void intentsQuery.fetchNextPage(); }}
                    >
                      {intentsQuery.isFetchingNextPage ? '加载中...' : '加载更多'}
                    </Button>
                  </div>
                )}
              </>
            );
          }}
        </QueryView>
      </SectionCard>
      <IntentDetailDialog
        intent={selected}
        open={selected != null}
        onOpenChange={(open) => { if (!open) setSelected(null); }}
        onRetried={() => { void intentsQuery.refetch(); }}
      />
    </Page>
  );
}
