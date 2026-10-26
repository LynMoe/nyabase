import { useMutation, useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import {
  Role,
  IntentResourceType,
  type IntentDto,
  type SharedVolumeDto,
  type VolumeDto,
} from '@nyabase/common';
import { api } from '../../lib/api.js';
import { errorMessage } from '../../lib/api-error.js';
import { scopedPath } from '../../lib/scoped-paths.js';
import { toast } from '../../hooks/use-toast.js';
import { intentPending } from '../../lib/in-progress.js';
import { queryKeys } from '../../lib/query-keys.js';
import { refetchWhileInProgress } from '../../lib/query-lifecycle.js';
import {
  formatIntentAttempt,
  isRetryableIntent,
  retryIntent,
  statusBadgeVariant,
} from '../../lib/intent-visibility.js';
import {
  failureCodeLabel,
  intentKindLabel,
  intentResourceTypeLabel,
  intentStatusLabel,
} from '../../lib/status-labels.js';
import { useHasRole } from '../../lib/use-role.js';
import { ResourceRef } from '../refs/resource-ref.js';
import { StatusBadge } from '../layout/status-badge.js';
import { Button } from '../ui/button.js';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog.js';
import { Field } from '../layout/form-field.js';

function intentImageId(intent: IntentDto): string {
  const fromSummary = intent.requestSummary.imageId;
  return typeof fromSummary === 'string' && fromSummary.length > 0
    ? fromSummary
    : intent.resourceId;
}

function VolumeIntentRef({ id }: { id: string }) {
  const isAdmin = useHasRole(Role.Admin);
  const hasLocal = isAdmin;
  const hasShared = isAdmin;
  const local = useQuery({
    queryKey: queryKeys.volumes.admin,
    queryFn: () => api.get<VolumeDto[]>('/volumes?scope=all'),
    enabled: Boolean(id) && hasLocal,
  });
  const shared = useQuery({
    queryKey: queryKeys.sharedVolumes.admin,
    queryFn: () => api.get<SharedVolumeDto[]>('/shared-volumes?scope=all'),
    enabled: Boolean(id) && hasShared,
  });
  const localName = local.data?.find((row) => row.id === id)?.name;
  const sharedName = shared.data?.find((row) => row.id === id)?.name;
  if (sharedName && !localName) {
    return <ResourceRef kind="shared-volume" id={id} name={sharedName} />;
  }
  return <ResourceRef kind="volume" id={id} name={localName ?? sharedName} />;
}

export function IntentResourceName({ intent }: { intent: IntentDto }) {
  switch (intent.resourceType) {
    case IntentResourceType.Container:
      return <ResourceRef kind="container" id={intent.resourceId} />;
    case IntentResourceType.Volume:
      return <VolumeIntentRef id={intent.resourceId} />;
    case IntentResourceType.ImageAssignment:
      return <ResourceRef kind="image" id={intentImageId(intent)} />;
    case IntentResourceType.Server:
      return <ResourceRef kind="server" id={intent.resourceId} />;
    default:
      return '—';
  }
}

export function IntentServerRef({
  serverId,
  link,
}: {
  serverId: string | null;
  link?: boolean;
}) {
  if (!serverId) return '—';
  const ref = <ResourceRef kind="server" id={serverId} />;
  if (!link) return ref;
  return (
    <Link
      to="/servers/$id"
      params={{ id: serverId }}
      search={{ tab: 'overview' }}
      className="underline-offset-2 hover:underline"
      onClick={(event) => event.stopPropagation()}
    >
      {ref}
    </Link>
  );
}

function JsonBlock({ value }: { value: unknown }) {
  return (
    <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-sm bg-muted/50 p-2 text-xs">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

export function IntentDetailDialog({
  intent,
  open,
  onOpenChange,
  onRetried,
}: {
  intent: IntentDto | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRetried: () => void;
}) {
  const canManageServers = useHasRole(Role.Operator);
  const detailQuery = useQuery({
    queryKey: queryKeys.adminIntent(intent?.id ?? ''),
    queryFn: () => {
      if (!intent) throw new Error('intent required');
      return api.get<IntentDto>(scopedPath(`/intents/${intent.id}`, 'all'));
    },
    enabled: open && Boolean(intent?.id),
    refetchInterval: (query) => refetchWhileInProgress(query.state, {
      steadyIntervalMs: false,
      isSettled: (item) => !intentPending(item.status),
    }),
  });
  const view = detailQuery.data ?? intent;
  const retry = useMutation({
    mutationFn: (intentId: string) => retryIntent(intentId, 'all'),
    onSuccess: () => {
      toast({ title: '已提交重试' });
      onRetried();
    },
    onError: (error) => toast({
      title: '重试失败',
      description: errorMessage(error),
      variant: 'destructive',
    }),
  });

  return (
    <Dialog open={open && Boolean(view)} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl" data-testid="intent-detail">
        <DialogHeader>
          <DialogTitle>操作详情</DialogTitle>
          <DialogDescription>查看请求摘要、基线与失败详情。</DialogDescription>
        </DialogHeader>
        {view ? (
          <div className="space-y-5">
            {detailQuery.isFetching && !detailQuery.data && (
              <p className="text-xs text-muted-foreground">刷新中...</p>
            )}
            <section className="grid gap-3 sm:grid-cols-2">
              <Field label="类型" value={intentKindLabel(view.kind)} />
              <Field
                label="状态"
                value={(
                  <StatusBadge
                    label={intentStatusLabel(view.status)}
                    raw={view.status}
                    pending={detailQuery.data != null && intentPending(view.status)}
                    variant={statusBadgeVariant(view.status)}
                  />
                )}
              />
              <Field label="时间" value={new Date(view.createdAt).toLocaleString()} />
              <Field label="尝试" value={formatIntentAttempt(view)} />
              <Field
                label="下次尝试"
                value={view.nextAttemptAt ? new Date(view.nextAttemptAt).toLocaleString() : '—'}
              />
              <Field
                label="资源"
                value={(
                  <div title={view.resourceId}>
                    {intentResourceTypeLabel(view.resourceType)}
                    {' · '}
                    <IntentResourceName intent={view} />
                  </div>
                )}
              />
              <Field
                label="服务器"
                value={<IntentServerRef serverId={view.serverId} link={canManageServers} />}
              />
              <Field
                label="请求人"
                value={view.requestedBy
                  ? <ResourceRef kind="user" id={view.requestedBy} />
                  : '系统'}
              />
            </section>
            <section className="space-y-2">
              <h3 className="text-sm font-semibold">requestSummary</h3>
              <JsonBlock value={view.requestSummary} />
            </section>
            <section className="space-y-2">
              <h3 className="text-sm font-semibold">baseline</h3>
              <JsonBlock value={view.baseline} />
            </section>
            <section className="space-y-2">
              <h3 className="text-sm font-semibold">失败</h3>
              {view.failure || view.failureCode ? (
                <div className="space-y-2 text-sm">
                  <p>
                    {failureCodeLabel(view.failure?.code ?? view.failureCode) ?? '—'}
                    {view.failure?.code ? `（${view.failure.code}）` : null}
                  </p>
                  {view.failure?.message ? (
                    <p className="text-destructive">{view.failure.message}</p>
                  ) : null}
                  {view.failure?.details ? <JsonBlock value={view.failure.details} /> : null}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">—</p>
              )}
            </section>
          </div>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>关闭</Button>
          {view && isRetryableIntent(view) && (
            <Button
              disabled={retry.isPending}
              onClick={() => retry.mutate(view.id)}
            >
              {retry.isPending ? '提交中...' : '重试'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
