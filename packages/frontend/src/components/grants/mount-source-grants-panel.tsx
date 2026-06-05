import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api.js';
import { toast } from '../../hooks/use-toast.js';
import type { MountSourceGrantDto } from '@nyabase/common';
import { queryKeys } from '../../lib/query-keys.js';

type Subject =
  | { type: 'user'; id: string }
  | { type: 'group'; id: string };

interface Props {
  subject: Subject;
  description?: string;
}

type DiskSummary = { diskId: string; serverId: string; mountPoint: string; label: string | null };
type RemoteMountSummary = { id: string; name: string; type: string };

function subjectPaths(subject: Subject) {
  const base = subject.type === 'user'
    ? `/admin/users/${subject.id}`
    : `/admin/groups/${subject.id}`;
  return {
    grantQueryKey: [`${subject.type}-mount-source-grants`, subject.id],
    grantUrl: `${base}/mount-source-grants`,
    addUrl: `${base}/mount-source-grants`,
    removeUrl: (sourceKind: string, sourceId: string) =>
      `${base}/mount-source-grants/${sourceKind}/${sourceId}`,
  };
}

export function MountSourceGrantsPanel({ subject, description }: Props) {
  const qc = useQueryClient();
  const paths = subjectPaths(subject);

  const { data: allDisks = [] } = useQuery<DiskSummary[]>({
    queryKey: ['all-disks'],
    queryFn: () => api.get('/admin/servers/all-disks'),
  });
  const { data: allRemoteMounts = [] } = useQuery<RemoteMountSummary[]>({
    queryKey: ['remote-fs-mounts'],
    queryFn: () => api.get('/admin/remote-fs-mounts'),
  });
  const { data: grants = [] } = useQuery<MountSourceGrantDto[]>({
    queryKey: paths.grantQueryKey,
    queryFn: () => api.get(paths.grantUrl),
  });
  const { data: servers = [] } = useQuery<{ id: string; name: string }[]>({
    queryKey: queryKeys.servers.admin,
    queryFn: () => api.get('/admin/servers'),
  });

  const grantedKeys = new Set(grants.map((g) => `${g.sourceKind}:${g.sourceId}`));

  // Group local disks by server, preserving server list order
  const disksByServer = new Map<string, DiskSummary[]>();
  for (const d of allDisks) {
    const arr = disksByServer.get(d.serverId) ?? [];
    arr.push(d);
    disksByServer.set(d.serverId, arr);
  }
  const serversWithDisks = servers.filter((s) => disksByServer.has(s.id));

  const toggle = useMutation({
    mutationFn: ({ sourceKind, sourceId, granted }: { sourceKind: string; sourceId: string; granted: boolean }) =>
      granted
        ? api.delete(paths.removeUrl(sourceKind, sourceId))
        : api.post(paths.addUrl, { sourceKind, sourceId }),
    onSuccess: () => qc.invalidateQueries({ queryKey: paths.grantQueryKey }),
    onError: (e) => toast({ title: '操作失败', description: (e as Error).message, variant: 'destructive' }),
  });

  const noSources = allDisks.length === 0 && allRemoteMounts.length === 0;

  return (
    <div className="space-y-4">
      {description && (
        <p className="text-xs text-muted-foreground">{description}</p>
      )}

      {serversWithDisks.map((server) => (
        <div key={server.id} className="space-y-1.5">
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">{server.name}</p>
          {(disksByServer.get(server.id) ?? []).map((d) => {
            const key = `local:${d.diskId}`;
            const granted = grantedKeys.has(key);
            const label = d.label ?? d.mountPoint.split('/').filter(Boolean).pop() ?? d.mountPoint;
            return (
              <div
                key={d.diskId}
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
                  onClick={() => toggle.mutate({ sourceKind: 'local', sourceId: d.diskId, granted })}
                  disabled={toggle.isPending}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                    granted
                      ? 'bg-primary/10 border-primary/30 text-primary hover:bg-primary/20'
                      : 'bg-muted border-border text-muted-foreground hover:bg-muted/80'
                  }`}
                >
                  {granted ? '已授权' : '授权'}
                </button>
              </div>
            );
          })}
        </div>
      ))}

      {allRemoteMounts.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">远程文件系统</p>
          {allRemoteMounts.map((m) => {
            const key = `remote:${m.id}`;
            const granted = grantedKeys.has(key);
            const typeLabel = m.type === 'nfs' ? 'NFS' : m.type === 'cephfs' ? 'CephFS' : m.type;
            return (
              <div
                key={m.id}
                className={`flex items-center justify-between py-2.5 px-3 rounded-lg border ${granted ? 'border-primary/30 bg-primary/5' : 'border-border'}`}
              >
                <div>
                  <span className="text-xs px-1.5 py-0.5 rounded border font-mono mr-2 bg-muted/50 border-border text-muted-foreground">{typeLabel}</span>
                  <span className="text-sm font-medium text-foreground">{m.name}</span>
                </div>
                <button
                  onClick={() => toggle.mutate({ sourceKind: 'remote', sourceId: m.id, granted })}
                  disabled={toggle.isPending}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                    granted
                      ? 'bg-primary/10 border-primary/30 text-primary hover:bg-primary/20'
                      : 'bg-muted border-border text-muted-foreground hover:bg-muted/80'
                  }`}
                >
                  {granted ? '已授权' : '授权'}
                </button>
              </div>
            );
          })}
        </div>
      )}

      {noSources && (
        <div className="text-sm text-muted-foreground py-6 text-center border border-dashed border-border rounded-xl">
          暂无可用数据源
        </div>
      )}
    </div>
  );
}
