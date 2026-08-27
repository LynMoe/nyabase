import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Database, RefreshCw, UserRound } from 'lucide-react';
import type { VolumeDto } from '@nyabase/common';
import { api } from '../lib/api.js';
import { Badge } from '../components/ui/badge.js';
import { Button } from '../components/ui/button.js';
import { Card, CardContent } from '../components/ui/card.js';
import { QueryErrorState, QueryLoadingState } from '../components/query-state.js';
import { queryKeys } from '../lib/query-keys.js';
import { approxGibHint, relativeTime } from '../lib/utils.js';
import {
  failureCodeLabel,
  volumeAttentionHint,
  volumeLifecycleLabel,
} from '../lib/status-labels.js';

export default function ManageVolumesPage() {
  const volumesQuery = useQuery({
    queryKey: queryKeys.volumes.admin,
    queryFn: () => api.get<VolumeDto[]>('/admin/volumes'),
    refetchInterval: 5_000,
  });
  const groups = useMemo(() => {
    const map = new Map<string, VolumeDto[]>();
    for (const volume of volumesQuery.data ?? []) {
      map.set(volume.ownerId, [...(map.get(volume.ownerId) ?? []), volume]);
    }
    return [...map.entries()];
  }, [volumesQuery.data]);

  return (
    <div className="space-y-5 px-4 py-4 md:px-6" data-testid="admin-volumes">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">数据卷管理</h1>
          <p className="text-sm text-muted-foreground">
            全部用户的数据卷（管理面）。你自己的数据卷仍在「数据卷」。
          </p>
        </div>
        <Button variant="outline" size="icon" onClick={() => { void volumesQuery.refetch(); }} aria-label="刷新数据卷">
          <RefreshCw className="h-4 w-4" />
        </Button>
      </div>
      {volumesQuery.isLoading ? (
        <QueryLoadingState label="加载全局数据卷..." />
      ) : volumesQuery.isError ? (
        <QueryErrorState error={volumesQuery.error} resourceName="全局数据卷" onRetry={() => { void volumesQuery.refetch(); }} />
      ) : groups.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-sm text-muted-foreground">暂无数据卷。</CardContent>
        </Card>
      ) : (
        <div className="space-y-5">
          {groups.map(([ownerId, volumes]) => (
            <section key={ownerId} className="space-y-2">
              <div className="flex items-center gap-2 text-sm font-medium">
                <UserRound className="h-4 w-4 text-muted-foreground" />
                <span className="font-mono text-xs">{ownerId}</span>
                <span className="text-xs text-muted-foreground">{volumes.length} 个</span>
              </div>
              <Card>
                <CardContent className="divide-y p-0">
                  {volumes.map((volume) => (
                    <AdminVolumeRow key={volume.id} volume={volume} />
                  ))}
                </CardContent>
              </Card>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

function AdminVolumeRow({ volume }: { volume: VolumeDto }) {
  const phaseLabel = volume.needsAttention
    ? '需要关注'
    : volumeLifecycleLabel(volume.lifecyclePhase);
  const codeLabel = failureCodeLabel(volume.failureCode);
  const location = volume.scope.kind === 'shared'
    ? `共享 ${volume.sharedBackendId ?? volume.scope.sharedBackendId}`
    : `服务器 ${volume.serverId ?? volume.scope.serverId}`;
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 px-4 py-3">
      <div className="min-w-0 space-y-1">
        <div className="flex items-center gap-2">
          <Database className="h-4 w-4 shrink-0 text-muted-foreground" />
          <p className="truncate font-medium">{volume.name}</p>
          <Badge variant={volume.needsAttention ? 'destructive' : volume.lifecyclePhase === 'active' ? 'success' : 'secondary'}>
            {phaseLabel}
          </Badge>
        </div>
        <p className="text-xs text-muted-foreground">
          {location} · 池 {volume.poolName} · {approxGibHint(volume.sizeBytes).replace(/^约 /, '')}
          {' · 已用 '}
          {volume.usedBytes === null ? '未知' : approxGibHint(volume.usedBytes).replace(/^约 /, '')}
          {volume.attachments.length > 0 ? ` · ${volume.attachments.length} 处挂载` : ' · 未挂载'}
          {' · '}
          {relativeTime(volume.updatedAt)}
        </p>
        {volume.needsAttention && (
          <p className="text-xs text-destructive">{volumeAttentionHint(volume.failureCode)}</p>
        )}
        {!volume.needsAttention && volume.failureCode && (
          <p className="break-all text-xs text-destructive">
            {codeLabel}
            {codeLabel !== volume.failureCode ? `（${volume.failureCode}）` : null}
          </p>
        )}
      </div>
    </div>
  );
}
