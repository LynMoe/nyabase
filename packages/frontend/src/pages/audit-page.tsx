import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getRouteApi, useNavigate } from '@tanstack/react-router';
import { Eye, RefreshCw } from 'lucide-react';
import type {
  AuditListResponse,
  AuditLogDto,
  AuditResourceSnapshotDto,
} from '@nyabase/common';
import { api } from '../lib/api.js';
import { Button } from '../components/ui/button.js';
import { Badge } from '../components/ui/badge.js';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../components/ui/dialog.js';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../components/ui/table.js';
import { Pagination } from '../components/ui/pagination.js';
import { Page } from '../components/layout/page.js';
import { PageHeader } from '../components/layout/page-header.js';
import { QueryView } from '../components/layout/query-view.js';
import { EmptyState } from '../components/layout/empty-state.js';
import { cn } from '../lib/utils.js';
import { queryPollInterval } from '../lib/query-lifecycle.js';
import { queryKeys } from '../lib/query-keys.js';
import { errorMessage } from '../lib/api-error.js';
import { auditActionLabel, auditResourceTypeLabel } from '../lib/audit-labels.js';

const PAGE_SIZES = [25, 50, 100] as const;
type AuditPageSize = (typeof PAGE_SIZES)[number];
const auditRouteApi = getRouteApi('/audit/');

// Action badges keep semantic colour buckets — these are state pills, not generic grays.
// Tinted backgrounds use the /10 token so they read correctly in both themes;
// foreground colors gain a `dark:` variant to stay legible on dark cards.
const ACTION_COLORS: Record<string, string> = {
  'container.create': 'bg-green-500/10 text-green-700 dark:text-green-300',
  'container.delete': 'bg-red-500/10 text-red-700 dark:text-red-300',
  'container.start': 'bg-blue-500/10 text-blue-700 dark:text-blue-300',
  'container.stop': 'bg-orange-500/10 text-orange-700 dark:text-orange-300',
  'container.restart': 'bg-yellow-500/10 text-yellow-700 dark:text-yellow-300',
  'container.exec_session.create': 'bg-sky-500/10 text-sky-700 dark:text-sky-300',
  'user.create': 'bg-purple-500/10 text-purple-700 dark:text-purple-300',
  'user.delete': 'bg-red-500/10 text-red-700 dark:text-red-300',
  'user.update': 'bg-violet-500/10 text-violet-700 dark:text-violet-300',
  'server.create': 'bg-indigo-500/10 text-indigo-700 dark:text-indigo-300',
  'server.update': 'bg-blue-500/10 text-blue-700 dark:text-blue-300',
  'server.delete': 'bg-red-500/10 text-red-700 dark:text-red-300',
  'grant.server.upsert': 'bg-teal-500/10 text-teal-700 dark:text-teal-300',
  'grant.server.delete': 'bg-red-500/10 text-red-700 dark:text-red-300',
  'grant.storage_pool.upsert': 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
  'grant.storage_pool.delete': 'bg-red-500/10 text-red-700 dark:text-red-300',
  'grant.shared_backend.upsert': 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
  'grant.shared_backend.delete': 'bg-red-500/10 text-red-700 dark:text-red-300',
  'volume.create': 'bg-green-500/10 text-green-700 dark:text-green-300',
  'volume.delete': 'bg-red-500/10 text-red-700 dark:text-red-300',
  'http_proxy.binding.create': 'bg-teal-500/10 text-teal-700 dark:text-teal-300',
  'http_proxy.binding.delete': 'bg-red-500/10 text-red-700 dark:text-red-300',
  'ip_pool.create': 'bg-indigo-500/10 text-indigo-700 dark:text-indigo-300',
  'ip_pool.delete': 'bg-red-500/10 text-red-700 dark:text-red-300',
  'ssh_proxy.sessions.disconnect_all': 'bg-orange-500/10 text-orange-700 dark:text-orange-300',
  'ssh_proxy.host_key.rotate': 'bg-yellow-500/10 text-yellow-700 dark:text-yellow-300',
};

export default function AuditPage() {
  const { page, pageSize } = auditRouteApi.useSearch();
  const navigate = useNavigate({ from: '/audit/' });
  const [detailId, setDetailId] = useState<string | null>(null);
  const offset = page * pageSize;

  const auditQuery = useQuery({
    queryKey: queryKeys.audit.list(pageSize, offset),
    queryFn: () => api.get<AuditListResponse>(`/audit?limit=${pageSize}&offset=${offset}`),
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
    void navigate({ search: next });
  };

  return (
    <Page>
      <PageHeader
        title="审计日志"
        description={data ? `共 ${total} 条，当前显示 ${currentStart}-${currentEnd}` : '审计记录数量尚未加载'}
        actions={
          <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground" onClick={() => refetch()} disabled={isFetching}>
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
        showEmpty={logs.length === 0}
        empty={<EmptyState title="暂无审计记录" />}
      >
        {(list) => (
          <div className="rounded-lg border border-border bg-card">
            <Table className="min-w-[760px]">
              <TableHeader>
                <TableRow className="bg-muted/50 hover:bg-muted/50">
                  <TableHead className="w-44">时间</TableHead>
                  <TableHead className="w-48">操作者</TableHead>
                  <TableHead className="w-48">操作</TableHead>
                  <TableHead>目标</TableHead>
                  <TableHead className="w-28 text-right">查看</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {list.items.map((log) => (
                  <TableRow key={log.id} className="hover:bg-accent/50">
                    <TableCell className="text-muted-foreground/70 text-xs whitespace-nowrap">
                      {formatTimestamp(log.ts)}
                    </TableCell>
                    <TableCell className="min-w-0">
                      <ResourceSummary
                        primary={actorLabel(log)}
                        secondary={log.actorId}
                      />
                    </TableCell>
                    <TableCell>
                      <span className={cn(
                        'inline-block max-w-full truncate text-xs px-2 py-0.5 rounded font-medium',
                        ACTION_COLORS[log.action] ?? 'bg-muted text-muted-foreground',
                      )}>
                        {auditActionLabel(log.action)}
                      </span>
                    </TableCell>
                    <TableCell className="min-w-0">
                      <ResourceSummary
                        primary={targetLabel(log)}
                        secondary={targetSecondary(log)}
                      />
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-8 gap-1.5"
                        onClick={() => setDetailId(log.id)}
                        title="原始 JSON"
                      >
                        <Eye className="h-4 w-4" />
                        查看
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
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

function AuditDetailDialog({
  log,
  loading,
  refreshing,
  error,
  open,
  onOpenChange,
}: {
  log: AuditLogDto | null;
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle>审计详情</DialogTitle>
          <DialogDescription>查看该条操作的主体、目标和原始记录。</DialogDescription>
        </DialogHeader>
        {loading ? (
          <div className="py-8 text-center text-sm text-muted-foreground">正在加载详情...</div>
        ) : error && !log ? (
          <div className="py-8 text-center text-sm text-destructive">{error}</div>
        ) : log ? (
          <div className="space-y-5">
            {error && (
              <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {error}
              </div>
            )}
            <section className="grid gap-3 lg:grid-cols-2">
              <DetailItem label="时间" value={new Date(log.ts).toLocaleString('zh-CN')} />
              <DetailItem label="操作" value={auditActionLabel(log.action)} />
              <DetailItem label="操作者" value={actorLabel(log)} />
              <DetailItem label="操作者 ID" value={log.actorId ?? 'system'} mono />
              <DetailItem label="目标" value={targetLabel(log)} />
              <DetailItem label="目标 ID" value={log.targetId ?? '无'} mono />
            </section>

            <section className="space-y-2">
              <h3 className="text-sm font-semibold text-foreground">资源快照</h3>
              <div className="grid items-start gap-3 lg:grid-cols-2">
                <SnapshotPanel title="操作者" snapshot={log.actorSnapshot} fallback={log.actorId ? { id: log.actorId, type: 'user', name: log.actorName } : null} />
                <SnapshotPanel title="目标" snapshot={log.targetSnapshot} fallback={targetFallback(log)} />
              </div>
              {(log.related ?? []).length > 0 && (
                <div className="rounded-lg border border-border bg-muted/20 p-3">
                  <div className="mb-2 text-xs font-medium text-muted-foreground">相关资源</div>
                  <div className="flex flex-wrap gap-2">
                    {(log.related ?? []).map((snapshot, index) => (
                      <Badge key={`${snapshot.type}:${snapshot.id}:${index}`} variant="outline" className="max-w-full gap-1 rounded-md">
                        <span>{resourceTypeLabel(snapshot.type)}</span>
                        <span className="min-w-0 truncate font-normal text-muted-foreground">{snapshot.name ?? snapshot.id ?? '-'}</span>
                      </Badge>
                    ))}
                  </div>
                </div>
              )}
            </section>

            <section className="space-y-2">
              <div className="flex items-center justify-between gap-3">
                <h3 className="text-sm font-semibold text-foreground">原始 JSON</h3>
                {refreshing && (
                  <span className="text-xs text-muted-foreground">刷新中...</span>
                )}
              </div>
              <pre className="overflow-auto rounded-lg border border-border bg-muted/30 p-3 text-xs leading-5 text-foreground">
                {JSON.stringify(log, null, 2)}
              </pre>
            </section>
          </div>
        ) : (
          <div className="py-8 text-center text-sm text-muted-foreground">记录不在当前页</div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>关闭</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ResourceSummary({
  primary,
  secondary,
}: {
  primary: string;
  secondary: string | null;
}) {
  return (
    <div className="min-w-0">
      <div className="truncate text-sm text-foreground">{primary}</div>
      {secondary && (
        <div className="mt-0.5 truncate font-mono text-xs text-muted-foreground">{secondary}</div>
      )}
    </div>
  );
}

function SnapshotPanel({
  title,
  snapshot,
  fallback,
}: {
  title: string;
  snapshot: AuditResourceSnapshotDto | null;
  fallback: Pick<AuditResourceSnapshotDto, 'id' | 'type' | 'name'> | null;
}) {
  const value = snapshot ?? fallback;
  if (!value) {
    return (
      <div className="rounded-lg border border-border bg-muted/20 p-3">
        <div className="text-xs font-medium text-muted-foreground">{title}</div>
        <div className="mt-1 text-sm text-muted-foreground">无</div>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border bg-muted/20 p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-muted-foreground">{title}</span>
        <Badge variant="outline" className="rounded-md">{resourceTypeLabel(value.type)}</Badge>
      </div>
      <div className="truncate text-sm font-medium text-foreground">{value.name ?? value.id ?? '-'}</div>
      {value.id && <div className="mt-1 break-all font-mono text-xs text-muted-foreground">{value.id}</div>}
      {snapshot?.labels && Object.keys(snapshot.labels).length > 0 && (
        <dl className="mt-3 grid gap-2 text-xs">
          {Object.entries(snapshot.labels).map(([key, labelValue]) => (
            <div key={key} className="grid gap-1 sm:grid-cols-[7rem_minmax(0,1fr)] sm:gap-2">
              <dt className="text-muted-foreground">{key}</dt>
              <dd className="break-all text-foreground">{String(labelValue ?? '-')}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

function DetailItem({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="rounded-lg border border-border bg-muted/20 p-3">
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <div className={cn('mt-1 break-all text-sm text-foreground', mono && 'font-mono text-xs')}>
        {value}
      </div>
    </div>
  );
}

function actorLabel(log: AuditLogDto): string {
  return log.actorName ?? log.actorUsername ?? (log.actorId ? `用户 ${shortId(log.actorId)}` : 'system');
}

function targetLabel(log: AuditLogDto): string {
  return log.targetName
    ?? log.targetSnapshot?.name
    ?? (log.targetId ? `${resourceTypeLabel(log.targetType)} ${shortId(log.targetId)}` : '无目标');
}

function targetFallback(log: AuditLogDto): Pick<AuditResourceSnapshotDto, 'id' | 'type' | 'name'> | null {
  if (!log.targetId && !log.targetName) return null;
  return { id: log.targetId, type: log.targetType, name: log.targetName };
}

function targetSecondary(log: AuditLogDto): string | null {
  if (!log.targetId) return null;
  return `${resourceTypeLabel(log.targetType)}:${log.targetId}`;
}

function resourceTypeLabel(type: string | null | undefined): string {
  return auditResourceTypeLabel(type);
}

function formatTimestamp(value: string): string {
  return new Date(value).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function shortId(id: string): string {
  return id.slice(0, 8);
}


