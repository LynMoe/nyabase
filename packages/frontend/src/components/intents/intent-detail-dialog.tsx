import type { ReactNode } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import {
  Capability,
  IntentResourceType,
  IntentStatus,
  type IntentDto,
  type SharedVolumeDto,
  type VolumeDto,
} from '@nyabase/common';
import { api } from '../../lib/api.js';
import { errorMessage } from '../../lib/api-error.js';
import { toast } from '../../hooks/use-toast.js';
import { queryKeys } from '../../lib/query-keys.js';
import {
  formatIntentAttempt,
  isRetryableIntent,
  retryIntent,
} from '../../lib/intent-visibility.js';
import {
  failureCodeLabel,
  intentKindLabel,
  intentResourceTypeLabel,
  intentStatusLabel,
} from '../../lib/status-labels.js';
import { useAuthStore } from '../../store/auth.js';
import { ResourceRef } from '../refs/resource-ref.js';
import { Badge } from '../ui/badge.js';
import { Button } from '../ui/button.js';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog.js';

function intentImageId(intent: IntentDto): string {
  const fromSummary = intent.requestSummary.imageId;
  return typeof fromSummary === 'string' && fromSummary.length > 0
    ? fromSummary
    : intent.resourceId;
}

function VolumeIntentRef({ id }: { id: string }) {
  const caps = useAuthStore((state) => state.user?.capabilities ?? []);
  const hasLocal = caps.includes(Capability.ManageVolumes);
  const hasShared = caps.includes(Capability.ManageSharedVolumes);
  const local = useQuery({
    queryKey: queryKeys.volumes.admin,
    queryFn: () => api.get<VolumeDto[]>('/admin/volumes'),
    enabled: Boolean(id) && hasLocal,
  });
  const shared = useQuery({
    queryKey: queryKeys.sharedVolumes.admin,
    queryFn: () => api.get<SharedVolumeDto[]>('/admin/shared-volumes'),
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
    case IntentResourceType.CertificateRotation:
      return intent.serverId
        ? <ResourceRef kind="server" id={intent.serverId} />
        : '—';
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
    <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded bg-muted/50 p-2 text-xs">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

function DetailItem({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="space-y-1">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-sm">{value}</div>
    </div>
  );
}

function statusBadgeVariant(status: string) {
  if (status === IntentStatus.Succeeded) return 'success' as const;
  if (status === IntentStatus.Failed) return 'destructive' as const;
  return 'warning' as const;
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
  const canManageServers = useAuthStore(
    (state) => state.user?.capabilities.includes(Capability.ManageServers) ?? false,
  );
  const detailQuery = useQuery({
    queryKey: queryKeys.adminIntent(intent?.id ?? ''),
    queryFn: () => {
      if (!intent) throw new Error('intent required');
      return api.get<IntentDto>(`/admin/intents/${intent.id}`);
    },
    enabled: open && Boolean(intent?.id),
  });
  const view = detailQuery.data ?? intent;
  const retry = useMutation({
    mutationFn: (intentId: string) => retryIntent(intentId, true),
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
          <DialogTitle>意图详情</DialogTitle>
          <DialogDescription>查看请求摘要、基线与失败详情。</DialogDescription>
        </DialogHeader>
        {view ? (
          <div className="space-y-5">
            {detailQuery.isFetching && !detailQuery.data && (
              <p className="text-xs text-muted-foreground">刷新中...</p>
            )}
            <section className="grid gap-3 sm:grid-cols-2">
              <DetailItem label="类型" value={intentKindLabel(view.kind)} />
              <DetailItem
                label="状态"
                value={(
                  <Badge title={view.status} variant={statusBadgeVariant(view.status)}>
                    {intentStatusLabel(view.status)}
                  </Badge>
                )}
              />
              <DetailItem label="时间" value={new Date(view.createdAt).toLocaleString()} />
              <DetailItem label="尝试" value={formatIntentAttempt(view)} />
              <DetailItem
                label="下次尝试"
                value={view.nextAttemptAt ? new Date(view.nextAttemptAt).toLocaleString() : '—'}
              />
              <DetailItem
                label="资源"
                value={(
                  <div title={view.resourceId}>
                    {intentResourceTypeLabel(view.resourceType)}
                    {' · '}
                    <IntentResourceName intent={view} />
                  </div>
                )}
              />
              <DetailItem
                label="服务器"
                value={<IntentServerRef serverId={view.serverId} link={canManageServers} />}
              />
              <DetailItem
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
