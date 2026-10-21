import type { AuditLogDto, AuditResourceSnapshotDto } from '@nyabase/common';
import { Eye } from 'lucide-react';
import { Button } from '../../components/ui/button.js';
import { Badge } from '../../components/ui/badge.js';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../components/ui/dialog.js';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../../components/ui/table.js';
import { TechnicalId } from '../../components/refs/technical-id.js';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../components/ui/select.js';
import { Field } from '../../components/layout/field.js';
import { cn } from '../../lib/utils.js';
import { auditActionLabel, auditResourceTypeLabel } from '../../lib/audit-labels.js';

// Action pills carry one meaning: removals read as destructive, additions as
// success, everything else stays neutral. Per-action hues were noise.
function auditActionTone(action: string): string {
  if (/\.(delete|disconnect_all|revoke)$/.test(action)) return 'bg-destructive/10 text-destructive';
  if (/\.(create|upsert)$/.test(action)) return 'bg-success/10 text-success';
  return 'bg-muted text-muted-foreground';
}


export function AuditTable({ items, onView }: { items: AuditLogDto[]; onView: (id: string) => void }) {
  return (
      <Table className="min-w-[760px]">
        <TableHeader>
          <TableRow>
            <TableHead className="w-44">时间</TableHead>
            <TableHead className="w-48">操作者</TableHead>
            <TableHead className="w-48">操作</TableHead>
            <TableHead>目标</TableHead>
            <TableHead className="w-28 text-right">查看</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.length === 0 ? (
            <TableRow>
              <TableCell colSpan={5} className="py-8 text-center text-muted-foreground">没有符合条件的记录</TableCell>
            </TableRow>
          ) : null}
          {items.map((log) => (
            <TableRow key={log.id} className="hover:bg-accent/50">
              <TableCell className="text-muted-foreground/70 text-xs whitespace-nowrap">
                {formatTimestamp(log.ts)}
              </TableCell>
              <TableCell className="min-w-0">
                <ResourceSummary
                  primary={actorLabel(log)}
                  secondary={log.actorId}
                  secondaryLabel="操作者 ID"
                />
              </TableCell>
              <TableCell>
                <span className={cn(
                  'inline-block max-w-full truncate text-xs px-2 py-0.5 rounded font-medium',
                  auditActionTone(log.action),
                )}>
                  {auditActionLabel(log.action)}
                </span>
              </TableCell>
              <TableCell className="min-w-0">
                <ResourceSummary
                  primary={targetLabel(log)}
                  secondary={targetSecondary(log)}
                  secondaryLabel="目标"
                />
              </TableCell>
              <TableCell className="text-right">
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 gap-1.5"
                  onClick={() => onView(log.id)}
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
  );
}

export function AuditDetailDialog({
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
      <DialogContent className="sm:max-w-4xl">
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
              <Field label="时间" value={new Date(log.ts).toLocaleString('zh-CN')} />
              <Field label="操作" value={auditActionLabel(log.action)} />
              <Field label="操作者" value={actorLabel(log)} />
              <Field label="操作者 ID" value={log.actorId ?? 'system'} mono />
              <Field label="目标" value={targetLabel(log)} />
              <Field label="目标 ID" value={log.targetId ?? '无'} mono />
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
                        <span className="min-w-0 break-all font-normal text-muted-foreground">{snapshot.name ?? snapshot.id ?? '-'}</span>
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

export function ResourceSummary({
  primary,
  secondary,
  secondaryLabel,
}: {
  primary: string;
  secondary: string | null;
  secondaryLabel: string;
}) {
  return (
    <div className="min-w-0">
      <div className="truncate text-sm text-foreground">{primary}</div>
      {secondary ? (
        <div className="mt-0.5">
          <TechnicalId label={secondaryLabel} value={secondary} kind="opaque" />
        </div>
      ) : null}
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
      <div className="break-all text-sm font-medium text-foreground" title={value.id ?? undefined}>
        {value.name ?? value.id ?? '-'}
      </div>
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

export function actorLabel(log: AuditLogDto): string {
  return log.actorName ?? log.actorUsername ?? (log.actorId ? `用户 ${shortId(log.actorId)}` : 'system');
}

export function targetLabel(log: AuditLogDto): string {
  return log.targetName
    ?? log.targetSnapshot?.name
    ?? (log.targetId ? `${resourceTypeLabel(log.targetType)} ${shortId(log.targetId)}` : '无目标');
}

function targetFallback(log: AuditLogDto): Pick<AuditResourceSnapshotDto, 'id' | 'type' | 'name'> | null {
  if (!log.targetId && !log.targetName) return null;
  return { id: log.targetId, type: log.targetType, name: log.targetName };
}

export function targetSecondary(log: AuditLogDto): string | null {
  if (!log.targetId) return null;
  return `${resourceTypeLabel(log.targetType)}:${log.targetId}`;
}

function resourceTypeLabel(type: string | null | undefined): string {
  return auditResourceTypeLabel(type);
}

export function formatTimestamp(value: string): string {
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

const ALL = '__all__';

export function FilterSelect({
  label,
  allLabel,
  value,
  options,
  onChange,
}: {
  label: string;
  allLabel: string;
  value: string | undefined;
  options: Array<[string, string]>;
  onChange: (value: string | undefined) => void;
}) {
  return (
    <Select value={value ?? ALL} onValueChange={(next) => onChange(next === ALL ? undefined : next)}>
      <SelectTrigger className="h-9 w-full sm:w-[11rem]" aria-label={label}>
        <SelectValue placeholder={allLabel} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL}>{allLabel}</SelectItem>
        {options.map(([optionValue, optionLabel]) => (
          <SelectItem key={optionValue} value={optionValue}>{optionLabel}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
