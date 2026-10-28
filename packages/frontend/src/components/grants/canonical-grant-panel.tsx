import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { GRANT_EXPIRY_GRACE_DAYS, type UserDto } from '@nyabase/common';
import { api } from '../../lib/api.js';
import { errorMessage } from '../../lib/api-error.js';
import { toast } from '../../hooks/use-toast.js';
import { ConfirmDialog } from '../layout/confirm-dialog.js';
import { isQueryLoading } from '../layout/query-view.js';
import { SectionCard } from '../layout/section-card.js';
import { QueryErrorState, QueryLoadingState } from '../query-state.js';
import { ResourceRef } from '../refs/resource-ref.js';
import { AssignBundleCard } from './assign-bundle-form.js';
import { BackendGrantsCard } from './backend-grants-card.js';
import { ServerGrantCard } from './server-grant-card.js';
import {
  expiryLabel,
  serverName,
  useBackendGrants,
  useGrantBundles,
  useGrantServers,
  useInvalidateGrants,
  useLapsedServers,
  useServerGrants,
} from './use-grant-panel-data.js';

/** A grant picked for deletion, awaiting confirmation. */
type DeleteTarget =
  | { kind: 'server'; id: string; label: string }
  | { kind: 'pool'; id: string; label: string }
  | { kind: 'backend'; id: string; label: string };

const DELETE_PATHS: Record<DeleteTarget['kind'], string> = {
  server: 'server-grants',
  pool: 'storage-pool-grants',
  backend: 'shared-backend-grants',
};

/** What a lapse does on each kind of grant: servers stop and purge, data disks and shared storage only lose volumes. */
export function deleteConsequence(target: DeleteTarget | null): string {
  if (!target) return '';
  if (target.kind === 'server') {
    return `其下的数据盘额度一并删除；该服务器上的容器立即停止，${GRANT_EXPIRY_GRACE_DAYS} 天后清除容器和数据卷。`;
  }
  if (target.kind === 'pool') {
    return `该池上的数据卷立即从容器强制卸载，${GRANT_EXPIRY_GRACE_DAYS} 天后删除。`;
  }
  return `该共享存储上的共享卷立即从容器强制卸载，${GRANT_EXPIRY_GRACE_DAYS} 天后删除。`;
}

/** Servers whose access lapsed: stopped now, purged when the grace ends. */
function GraceCard({ userId }: { userId: string }) {
  const lapsed = useLapsedServers(userId);
  const servers = useGrantServers().data ?? [];
  if (lapsed.length === 0) return null;
  return (
    <SectionCard title="宽限中的服务器" testId="grant-grace">
      <ul className="space-y-1 text-sm">
        {lapsed.map((lapse) => (
          <li key={lapse.serverId}>
            <ResourceRef kind="server" id={lapse.serverId} name={serverName(lapse.serverId, servers)} />
            {' '}宽限中 · {expiryLabel(lapse.purgeAt)} 清除
          </li>
        ))}
      </ul>
    </SectionCard>
  );
}

/** All grants of one user: assign a bundle, the bundle held on each server (with data disks), shared storage. */
export function CanonicalGrantPanel({ user }: { user: UserDto }) {
  const serverGrants = useServerGrants(user.id);
  const backendGrants = useBackendGrants(user.id);
  const bundles = useGrantBundles().data ?? [];
  const servers = useGrantServers().data ?? [];
  const invalidate = useInvalidateGrants(user.id);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);

  const remove = useMutation({
    mutationFn: ({ kind, id }: DeleteTarget) => api.delete<void>(`/users/${user.id}/${DELETE_PATHS[kind]}/${id}`),
    onSuccess: () => {
      toast({ title: '授权已删除' });
      setDeleteTarget(null);
      invalidate();
    },
    onError: (error) => toast({ title: '删除授权失败', description: errorMessage(error), variant: 'destructive' }),
  });

  const lists = [serverGrants, backendGrants];
  if (lists.some(isQueryLoading)) {
    return (
      <div data-testid="canonical-grants">
        <QueryLoadingState label="加载授权..." />
      </div>
    );
  }
  const failed = lists.find((query) => query.isError && query.data === undefined);
  if (failed) {
    return (
      <div data-testid="canonical-grants">
        <QueryErrorState error={failed.error} resourceName="授权" onRetry={() => { void failed.refetch(); }} />
      </div>
    );
  }

  const grants = [...(serverGrants.data ?? [])].sort((a, b) => (
    serverName(a.serverId, servers).localeCompare(serverName(b.serverId, servers), 'zh-CN')
  ));
  return (
    <div className="space-y-6" data-testid="canonical-grants">
      <GraceCard userId={user.id} />
      <AssignBundleCard userId={user.id} grants={grants} />
      <div className="space-y-4" data-testid="grant-servers">
        {grants.length === 0 ? (
          <p className="text-sm text-muted-foreground">暂无服务器授权。</p>
        ) : grants.map((grant) => (
          <ServerGrantCard
            key={grant.id}
            userId={user.id}
            grant={grant}
            bundle={bundles.find((row) => row.id === grant.bundleId)}
            onDelete={() => setDeleteTarget({
              kind: 'server',
              id: grant.serverId,
              label: `${grant.bundleName} · ${serverName(grant.serverId, servers)}`,
            })}
            onDeleteDisk={({ poolId, label }) => setDeleteTarget({ kind: 'pool', id: poolId, label: `数据盘 ${label}` })}
          />
        ))}
      </div>
      <BackendGrantsCard
        userId={user.id}
        onDelete={({ backendId, label }) => setDeleteTarget({ kind: 'backend', id: backendId, label })}
      />
      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title="删除授权？"
        description={`将删除「${deleteTarget?.label ?? ''}」。${deleteConsequence(deleteTarget)}`}
        confirmLabel="确认删除"
        pendingLabel="删除中..."
        pending={remove.isPending}
        onConfirm={() => { if (deleteTarget) remove.mutate(deleteTarget); }}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}
      />
    </div>
  );
}
