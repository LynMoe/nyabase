import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  ChevronLeft,
  ChevronRight,
  Eye,
  RefreshCw,
} from 'lucide-react';
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
  DialogHeader,
  DialogTitle,
} from '../components/ui/dialog.js';
import { cn } from '../lib/utils.js';
import { QueryErrorState } from '../components/query-state.js';
import { queryPollInterval } from '../lib/query-lifecycle.js';
import { auditActionLabel, auditResourceTypeLabel } from '../lib/audit-labels.js';

const PAGE_SIZES = [25, 50, 100] as const;

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
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState<(typeof PAGE_SIZES)[number]>(50);
  const [detailId, setDetailId] = useState<string | null>(null);
  const offset = page * pageSize;

  const auditQuery = useQuery({
    queryKey: ['audit', pageSize, offset],
    queryFn: () => api.get<AuditListResponse>(`/audit?limit=${pageSize}&offset=${offset}`),
    refetchInterval: (query) => queryPollInterval(query.state, { activeIntervalMs: 30_000 }),
  });
  const { data, isLoading, isFetching, refetch } = auditQuery;
  const logs = data?.items ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
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
    queryKey: ['audit-detail', detailId],
    queryFn: () => {
      if (!detailId) throw new Error('Missing audit log id');
      return api.get<AuditLogDto>(`/audit/${encodeURIComponent(detailId)}`);
    },
    enabled: detailId !== null,
  });
  const dialogLog = detailLog ?? selectedLog;

  return (
    <div className="px-4 py-4 md:px-6 space-y-5 w-full">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">审计日志</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            {data ? `共 ${total} 条，当前显示 ${currentStart}-${currentEnd}` : '审计记录数量尚未加载'}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            每页
            <select
              value={pageSize}
              onChange={(event) => {
                setPageSize(Number(event.target.value) as (typeof PAGE_SIZES)[number]);
                setPage(0);
              }}
              className="h-9 rounded-md border border-input bg-background px-2 text-sm text-foreground"
            >
              {PAGE_SIZES.map((size) => (
                <option key={size} value={size}>{size}</option>
              ))}
            </select>
          </label>
          <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground" onClick={() => refetch()} disabled={isFetching}>
            <RefreshCw className={cn('h-4 w-4', isFetching && 'animate-spin')} />
          </Button>
        </div>
      </div>

      {isLoading ? (
        <div className="space-y-2">
          {[1, 2, 3].map((i) => <div key={i} className="h-14 bg-muted rounded-lg animate-pulse" />)}
        </div>
      ) : auditQuery.isError ? (
        <QueryErrorState error={auditQuery.error} resourceName="审计记录" onRetry={() => { void auditQuery.refetch(); }} />
      ) : logs.length === 0 ? (
        <div className="bg-card rounded-lg border border-border p-10 text-center text-muted-foreground/70">
          暂无审计记录
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-border bg-card">
          <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] table-fixed text-sm">
            <thead>
              <tr className="bg-muted/50 border-b border-border">
                <th className="text-left py-3 px-4 font-medium text-muted-foreground w-44">时间</th>
                <th className="text-left py-3 px-4 font-medium text-muted-foreground w-48">操作者</th>
                <th className="text-left py-3 px-4 font-medium text-muted-foreground w-48">操作</th>
                <th className="text-left py-3 px-4 font-medium text-muted-foreground">目标</th>
                <th className="text-right py-3 px-4 font-medium text-muted-foreground w-28">查看</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {logs.map((log) => (
                <tr key={log.id} className="hover:bg-accent/50">
                  <td className="py-3 px-4 text-muted-foreground/70 text-xs whitespace-nowrap">
                    {formatTimestamp(log.ts)}
                  </td>
                  <td className="py-3 px-4 min-w-0">
                    <ResourceSummary
                      primary={actorLabel(log)}
                      secondary={log.actorId}
                    />
                  </td>
                  <td className="py-3 px-4">
                    <span className={cn(
                      'inline-block max-w-full truncate text-xs px-2 py-0.5 rounded font-medium',
                      ACTION_COLORS[log.action] ?? 'bg-muted text-muted-foreground',
                    )}>
                      {auditActionLabel(log.action)}
                    </span>
                  </td>
                  <td className="py-3 px-4 min-w-0">
                    <ResourceSummary
                      primary={targetLabel(log)}
                      secondary={targetSecondary(log)}
                    />
                  </td>
                  <td className="py-3 px-4 text-right">
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
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </div>
      )}

      <div className="flex flex-col gap-3 rounded-lg border border-border bg-background px-4 py-3 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
        <span>第 {Math.min(page + 1, totalPages)} / {totalPages} 页</span>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={page === 0 || isFetching}
            onClick={() => setPage((value) => Math.max(0, value - 1))}
          >
            <ChevronLeft className="h-4 w-4" />
            上一页
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={page + 1 >= totalPages || isFetching}
            onClick={() => setPage((value) => value + 1)}
          >
            下一页
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <AuditDetailDialog
        log={dialogLog}
        loading={isDetailLoading && !dialogLog}
        refreshing={isDetailFetching && Boolean(dialogLog)}
        error={detailError ? errorMessage(detailError) : null}
        open={detailId !== null}
        onOpenChange={(open) => {
          if (!open) setDetailId(null);
        }}
      />
    </div>
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
      <DialogContent className="max-h-[90vh] max-w-4xl overflow-hidden bg-background">
        <DialogHeader>
          <DialogTitle>审计详情</DialogTitle>
        </DialogHeader>
        {loading ? (
          <div className="py-8 text-center text-sm text-muted-foreground">正在加载详情...</div>
        ) : error && !log ? (
          <div className="py-8 text-center text-sm text-destructive">{error}</div>
        ) : log ? (
          <div className="max-h-[calc(90vh-5rem)] space-y-5 overflow-y-auto pr-1">
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
              <DetailItem label="目标 ID" value={log.targetId ?? '-'} mono />
            </section>

            <section className="space-y-2">
              <h3 className="text-sm font-semibold text-foreground">资源快照</h3>
              <div className="grid gap-3 lg:grid-cols-2">
                <SnapshotPanel title="操作者" snapshot={log.actorSnapshot} fallback={log.actorId ? { id: log.actorId, type: 'user', name: log.actorName } : null} />
                <SnapshotPanel title="目标" snapshot={log.targetSnapshot} fallback={log.targetId ? { id: log.targetId, type: log.targetType, name: log.targetName } : null} />
              </div>
              {log.related.length > 0 && (
                <div className="rounded-lg border border-border bg-muted/20 p-3">
                  <div className="mb-2 text-xs font-medium text-muted-foreground">相关资源</div>
                  <div className="flex flex-wrap gap-2">
                    {log.related.map((snapshot, index) => (
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
              <pre className="max-h-96 overflow-auto rounded-lg border border-border bg-muted/30 p-3 text-xs leading-5 text-foreground">
                {JSON.stringify(log, null, 2)}
              </pre>
            </section>
          </div>
        ) : (
          <div className="py-8 text-center text-sm text-muted-foreground">记录不在当前页</div>
        )}
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
      <div className="rounded-lg border border-border bg-muted/20 p-3 text-sm text-muted-foreground">
        {title}：-
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
  return log.targetName ?? log.targetSnapshot?.name ?? (log.targetId ? `${resourceTypeLabel(log.targetType)} ${shortId(log.targetId)}` : '-');
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '加载审计详情失败';
}
