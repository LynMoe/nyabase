import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api.js';
import { toast } from '../../hooks/use-toast.js';
import type { MountSourceGrantDto } from '@nyabase/common';
import {
  adminCatalogPaths,
  type GrantRemoteFsMountCatalogItem,
  type GrantServerCatalogItem,
} from '../../lib/admin-catalog.js';
import { QueryErrorState, QueryLoadingState } from '../query-state.js';
import { useState } from 'react';
import { notifyAccessChangedForSubject } from '../../lib/auth-session.js';
import { classifyOrphanedLocalGrants, exactLocalGrantKey } from '../../lib/mount-source-grant-state.js';

type Subject =
  | { type: 'user'; id: string }
  | { type: 'group'; id: string };

interface Props {
  subject: Subject;
  description?: string;
}

type DiskSummary = {
  diskId: string;
  serverId: string;
  mountPoint: string;
  sourceIdentity: string;
  label: string | null;
};

function subjectPaths(subject: Subject) {
  const base = subject.type === 'user'
    ? `/admin/users/${subject.id}`
    : `/admin/groups/${subject.id}`;
  return {
    grantQueryKey: [`${subject.type}-mount-source-grants`, subject.id],
    grantUrl: `${base}/mount-source-grants`,
    addUrl: `${base}/mount-source-grants`,
    removeUrl: (sourceKind: string, sourceId: string, serverId?: string) => {
      const suffix = sourceKind === 'local'
        ? `?serverId=${encodeURIComponent(serverId ?? '')}`
        : '';
      return `${base}/mount-source-grants/${sourceKind}/${sourceId}${suffix}`;
    },
  };
}

export function MountSourceGrantsPanel({ subject, description }: Props) {
  const qc = useQueryClient();
  const paths = subjectPaths(subject);
  const [pendingKeys, setPendingKeys] = useState<Set<string>>(() => new Set());

  const disksQuery = useQuery<DiskSummary[]>({
    queryKey: ['all-disks'],
    queryFn: () => api.get('/admin/servers/all-disks'),
  });
  const remoteMountsQuery = useQuery<GrantRemoteFsMountCatalogItem[]>({
    queryKey: ['admin-catalog', 'grant-remote-fs-mounts'],
    queryFn: () => api.get(adminCatalogPaths.grantRemoteFsMounts),
  });
  const grantsQuery = useQuery<MountSourceGrantDto[]>({
    queryKey: paths.grantQueryKey,
    queryFn: () => api.get(paths.grantUrl),
  });
  const serversQuery = useQuery<GrantServerCatalogItem[]>({
    queryKey: ['admin-catalog', 'grant-servers'],
    queryFn: () => api.get(adminCatalogPaths.grantServers),
  });

  const allDisks = disksQuery.data ?? [];
  const allRemoteMounts = remoteMountsQuery.data ?? [];
  const grants = grantsQuery.data ?? [];
  const servers = serversQuery.data ?? [];

  const grantedKeys = new Set(grants.map((grant) => grant.sourceKind === 'local'
    ? exactLocalGrantKey(grant.serverId ?? '', grant.sourceId, grant.sourceIdentity)
    : `remote:${grant.sourceId}`));
  const liveDiskByLogicalKey = new Map(allDisks.map((disk) => [`${disk.serverId}:${disk.diskId}`, disk]));
  const orphanedLocalGrants = classifyOrphanedLocalGrants(grants, allDisks);

  // Group local disks by server, preserving server list order
  const disksByServer = new Map<string, DiskSummary[]>();
  for (const d of allDisks) {
    const arr = disksByServer.get(d.serverId) ?? [];
    arr.push(d);
    disksByServer.set(d.serverId, arr);
  }
  const serversWithDisks = servers.filter((s) => disksByServer.has(s.id));

  const toggle = useMutation({
    mutationFn: ({
      sourceKind,
      sourceId,
      serverId,
      granted,
    }: {
      sourceKind: 'local' | 'remote';
      sourceId: string;
      serverId?: string;
      granted: boolean;
    }) =>
      granted
        ? api.delete(paths.removeUrl(sourceKind, sourceId, serverId))
        : api.post(paths.addUrl, {
            sourceKind,
            sourceId,
            ...(sourceKind === 'local' ? { serverId } : {}),
          }),
    onMutate: ({ sourceKind, sourceId, serverId }) => {
      const key = `${sourceKind}:${serverId ?? ''}:${sourceId}`;
      setPendingKeys((current) => new Set(current).add(key));
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: paths.grantQueryKey });
      notifyAccessChangedForSubject(subject);
    },
    onError: (e) => toast({ title: '操作失败', description: (e as Error).message, variant: 'destructive' }),
    onSettled: (_data, _error, { sourceKind, sourceId, serverId }) => {
      const key = `${sourceKind}:${serverId ?? ''}:${sourceId}`;
      setPendingKeys((current) => {
        const next = new Set(current);
        next.delete(key);
        return next;
      });
    },
  });

  const noSources = allDisks.length === 0 && allRemoteMounts.length === 0;

  if (disksQuery.isLoading || remoteMountsQuery.isLoading || grantsQuery.isLoading || serversQuery.isLoading) {
    return <QueryLoadingState label="加载数据源授权..." />;
  }
  const queryError = disksQuery.error ?? remoteMountsQuery.error ?? grantsQuery.error ?? serversQuery.error;
  if (queryError) return (
    <QueryErrorState
      error={queryError}
      resourceName="数据源授权"
      onRetry={() => {
        void Promise.all([
          disksQuery.refetch(),
          remoteMountsQuery.refetch(),
          grantsQuery.refetch(),
          serversQuery.refetch(),
        ]);
      }}
    />
  );

  return (
    <div className="space-y-4">
      {description && (
        <p className="text-xs text-muted-foreground">{description}</p>
      )}

      {serversWithDisks.map((server) => (
        <div key={server.id} className="space-y-1.5">
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">{server.name}</p>
          {(disksByServer.get(server.id) ?? []).map((d) => {
            const key = `local:${d.serverId}:${d.diskId}`;
            const granted = grantedKeys.has(exactLocalGrantKey(d.serverId, d.diskId, d.sourceIdentity));
            const replacedGrant = orphanedLocalGrants.some((grant) => (
              grant.serverId === d.serverId && grant.sourceId === d.diskId
            ));
            const pending = pendingKeys.has(key);
            const label = d.label ?? d.mountPoint.split('/').filter(Boolean).pop() ?? d.mountPoint;
            return (
              <div
                key={`${d.serverId}:${d.diskId}`}
                className={`flex items-center justify-between py-2.5 px-3 rounded-lg border ${granted ? 'border-primary/30 bg-primary/5' : 'border-border'}`}
              >
                <div>
                  <span className="text-xs px-1.5 py-0.5 rounded border font-mono mr-2 bg-muted/50 border-border text-muted-foreground">本地</span>
                  <span className="text-sm font-medium text-foreground">{label}</span>
                  <span className="text-xs text-muted-foreground ml-2">
                    · <code className="font-mono">{d.mountPoint}</code>
                  </span>
                </div>
                <button
                  onClick={() => toggle.mutate({
                    sourceKind: 'local',
                    sourceId: d.diskId,
                    serverId: d.serverId,
                    granted,
                  })}
                  disabled={pending || replacedGrant}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                    granted
                      ? 'bg-primary/10 border-primary/30 text-primary hover:bg-primary/20'
                      : 'bg-muted border-border text-muted-foreground hover:bg-muted/80'
                  }`}
                >
                  {pending ? '处理中...' : granted ? '已授权' : replacedGrant ? '需先移除旧授权' : '授权'}
                </button>
              </div>
            );
          })}
        </div>
      ))}

      {orphanedLocalGrants.length > 0 && (
        <div className="space-y-1.5 rounded-lg border border-amber-200 bg-amber-50/60 p-3">
          <p className="text-xs font-semibold text-amber-800">不可用或已更换身份的本地磁盘授权</p>
          <p className="text-xs text-amber-700">这些是仍然生效于数据库的授权记录；移除后才能重新授权同名的新磁盘。</p>
          {orphanedLocalGrants.map((grant) => {
            const live = grant.serverId
              ? liveDiskByLogicalKey.get(`${grant.serverId}:${grant.sourceId}`)
              : undefined;
            const server = servers.find((candidate) => candidate.id === grant.serverId);
            const pendingKey = `local:${grant.serverId ?? ''}:${grant.sourceId}`;
            return (
              <div key={grant.id} className="flex items-center justify-between gap-3 rounded-md border border-amber-200 bg-background px-3 py-2">
                <div className="min-w-0 text-xs">
                  <div className="font-medium text-foreground">{server?.name ?? grant.serverId ?? '未知服务器'} · {grant.sourceId}</div>
                  <div className="break-all text-amber-700">
                    {live ? '磁盘 ID 已被不同物理来源复用' : '磁盘当前不在在线清单中'}
                    {grant.sourceIdentity ? ` · 原身份 ${grant.sourceIdentity}` : ' · 旧授权缺少身份'}
                  </div>
                </div>
                <button
                  className="shrink-0 rounded-md border border-amber-300 px-2.5 py-1 text-xs text-amber-800 hover:bg-amber-100 disabled:opacity-50"
                  disabled={pendingKeys.has(pendingKey)}
                  onClick={() => toggle.mutate({
                    sourceKind: 'local',
                    sourceId: grant.sourceId,
                    serverId: grant.serverId ?? undefined,
                    granted: true,
                  })}
                >
                  {pendingKeys.has(pendingKey) ? '移除中...' : '移除旧授权'}
                </button>
              </div>
            );
          })}
        </div>
      )}

      {allRemoteMounts.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">远程文件系统</p>
          {allRemoteMounts.map((m) => {
            const key = `remote:${m.id}`;
            const granted = grantedKeys.has(key);
            const pending = pendingKeys.has(`remote::${m.id}`);
            return (
              <div
                key={m.id}
                className={`flex items-center justify-between py-2.5 px-3 rounded-lg border ${granted ? 'border-primary/30 bg-primary/5' : 'border-border'}`}
              >
                <div>
                  <span className="text-xs px-1.5 py-0.5 rounded border font-mono mr-2 bg-muted/50 border-border text-muted-foreground">远程</span>
                  <span className="text-sm font-medium text-foreground">{m.displayName || m.name}</span>
                </div>
                <button
                  onClick={() => toggle.mutate({ sourceKind: 'remote', sourceId: m.id, granted })}
                  disabled={pending}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                    granted
                      ? 'bg-primary/10 border-primary/30 text-primary hover:bg-primary/20'
                      : 'bg-muted border-border text-muted-foreground hover:bg-muted/80'
                  }`}
                >
                  {pending ? '处理中...' : granted ? '已授权' : '授权'}
                </button>
              </div>
            );
          })}
        </div>
      )}

      {noSources && (
        <div className="text-sm text-muted-foreground py-6 text-center border border-dashed border-border rounded-lg">
          暂无可用数据源
        </div>
      )}
    </div>
  );
}
