import { useState } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import {
  Capability,
  IntentKind,
  IntentResourceType,
  IntentStatus,
  type CursorPaginatedResponse,
  type IntentDto,
  type ServerDto,
} from '@nyabase/common';
import { Activity } from 'lucide-react';
import { api } from '../lib/api.js';
import { Button } from '../components/ui/button.js';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../components/ui/select.js';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../components/ui/table.js';
import {
  IntentDetailDialog,
  IntentResourceName,
  IntentServerRef,
} from '../components/intents/intent-detail-dialog.js';
import { ResourceRef } from '../components/refs/resource-ref.js';
import { Page } from '../components/layout/page.js';
import { PageHeader } from '../components/layout/page-header.js';
import { QueryView } from '../components/layout/query-view.js';
import { SectionCard } from '../components/layout/section-card.js';
import { StatusBadge } from '../components/layout/status-badge.js';
import { useAuthStore } from '../store/auth.js';
import { intentPending } from '../lib/in-progress.js';
import { queryKeys } from '../lib/query-keys.js';
import { refetchWhileInProgress } from '../lib/query-lifecycle.js';
import {
  failureCodeLabel,
  intentKindLabel,
  intentResourceTypeLabel,
  intentStatusLabel,
} from '../lib/status-labels.js';
import { formatIntentAttempt } from '../lib/intent-visibility.js';

const ALL = '__all__';
const PAGE_SIZE = 50;
const SEGMENTS = [
  { id: 'all', label: '全部' },
  { id: 'pending', label: '进行中' },
  { id: 'failed', label: '失败' },
] as const;

type StatusSegment = (typeof SEGMENTS)[number]['id'];

function adminIntentsPath(filters: {
  segment: StatusSegment;
  kind?: IntentKind;
  resourceType?: IntentResourceType;
  serverId?: string;
  cursor?: string;
}): string {
  const params = new URLSearchParams();
  params.set('limit', String(PAGE_SIZE));
  if (filters.segment === 'pending') params.set('status', 'pending');
  if (filters.segment === 'failed') params.set('status', 'failed');
  if (filters.kind) params.set('kind', filters.kind);
  if (filters.resourceType) params.set('resourceType', filters.resourceType);
  if (filters.serverId) params.set('serverId', filters.serverId);
  if (filters.cursor) params.set('cursor', filters.cursor);
  return `/admin/intents?${params.toString()}`;
}

function statusBadgeVariant(status: string) {
  if (status === IntentStatus.Succeeded) return 'success' as const;
  if (status === IntentStatus.Failed) return 'destructive' as const;
  return 'warning' as const;
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
    queryFn: () => api.get<ServerDto[]>('/admin/servers'),
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
      <PageHeader title="运维" />

      <SectionCard
        title="意图"
        toolbar={
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex flex-wrap rounded-md bg-muted p-1">
              {SEGMENTS.map((item) => (
                <Button
                  key={item.id}
                  type="button"
                  size="sm"
                  variant={segment === item.id ? 'secondary' : 'ghost'}
                  className="h-8"
                  onClick={() => setSegment(item.id)}
                >
                  {item.label}
                </Button>
              ))}
            </div>
            <Select
              value={kind ?? ALL}
              onValueChange={(value) => setKind(value === ALL ? undefined : value as IntentKind)}
            >
              <SelectTrigger className="h-9 w-[160px]" aria-label="意图类型">
                <SelectValue placeholder="全部类型" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>全部类型</SelectItem>
                {Object.values(IntentKind).map((value) => (
                  <SelectItem key={value} value={value}>{intentKindLabel(value)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={resourceType ?? ALL}
              onValueChange={(value) => setResourceType(value === ALL ? undefined : value as IntentResourceType)}
            >
              <SelectTrigger className="h-9 w-[160px]" aria-label="资源类型">
                <SelectValue placeholder="全部资源" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>全部资源</SelectItem>
                {Object.values(IntentResourceType).map((value) => (
                  <SelectItem key={value} value={value}>{intentResourceTypeLabel(value)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            {canManageServers && (
              <Select
                value={serverId ?? ALL}
                onValueChange={(value) => setServerId(value === ALL ? undefined : value)}
              >
                <SelectTrigger className="h-9 w-[180px]" aria-label="服务器">
                  <SelectValue placeholder="全部服务器" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>全部服务器</SelectItem>
                  {(serversQuery.data ?? []).map((server) => (
                    <SelectItem key={server.id} value={server.id}>{server.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
        }
        flush
      >
        <QueryView query={intentsQuery} resourceName="意图" loadingLabel="加载意图...">
          {(data) => {
            const items = data.pages.flatMap((page) => page.items);
            if (items.length === 0) {
              return (
                <div className="flex flex-col items-center gap-2 px-6 py-12 text-center">
                  <Activity className="h-10 w-10 text-muted-foreground/40" />
                  <p className="text-sm font-medium">暂无意图。</p>
                </div>
              );
            }
            return (
              <>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>时间</TableHead>
                      <TableHead>类型</TableHead>
                      <TableHead>状态</TableHead>
                      <TableHead>资源类型</TableHead>
                      <TableHead>资源名称</TableHead>
                      <TableHead>服务器</TableHead>
                      <TableHead>请求人</TableHead>
                      <TableHead>尝试</TableHead>
                      <TableHead>失败码</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {items.map((intent) => (
                      <TableRow
                        key={intent.id}
                        className="cursor-pointer"
                        onClick={() => setSelected(intent)}
                      >
                        <TableCell>{new Date(intent.createdAt).toLocaleString()}</TableCell>
                        <TableCell>{intentKindLabel(intent.kind)}</TableCell>
                        <TableCell>
                          <StatusBadge
                            label={intentStatusLabel(intent.status)}
                            raw={intent.status}
                            pending={intentPending(intent.status)}
                            variant={statusBadgeVariant(intent.status)}
                          />
                        </TableCell>
                        <TableCell>{intentResourceTypeLabel(intent.resourceType)}</TableCell>
                        <TableCell title={intent.resourceId}>
                          <IntentResourceName intent={intent} />
                        </TableCell>
                        <TableCell>
                          <IntentServerRef serverId={intent.serverId} link={canManageServers} />
                        </TableCell>
                        <TableCell>
                          {intent.requestedBy
                            ? <ResourceRef kind="user" id={intent.requestedBy} />
                            : '系统'}
                        </TableCell>
                        <TableCell>{formatIntentAttempt(intent)}</TableCell>
                        <TableCell>{failureCodeLabel(intent.failureCode) ?? '—'}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
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
