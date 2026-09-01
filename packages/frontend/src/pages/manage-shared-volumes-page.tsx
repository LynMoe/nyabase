import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Database, RefreshCw, UserRound } from 'lucide-react';
import type { SharedVolumeDto } from '@nyabase/common';
import { api } from '../lib/api.js';
import { Badge } from '../components/ui/badge.js';
import { Button } from '../components/ui/button.js';
import { Card, CardContent } from '../components/ui/card.js';
import { EmptyState } from '../components/layout/empty-state.js';
import { Page } from '../components/layout/page.js';
import { PageHeader } from '../components/layout/page-header.js';
import { QueryView } from '../components/layout/query-view.js';
import { SharedVolumeCatalogInspectDialog } from '../components/storage/shared-volume-catalog-inspect.js';
import { queryKeys } from '../lib/query-keys.js';
import { queryPollInterval } from '../lib/query-lifecycle.js';
import { approxGibHint, relativeTime } from '../lib/utils.js';
import {
  failureCodeLabel,
  volumeAttentionHint,
  volumeLifecycleLabel,
} from '../lib/status-labels.js';

export default function ManageSharedVolumesPage() {
  const [inspectTarget, setInspectTarget] = useState<SharedVolumeDto | null>(null);
  const volumesQuery = useQuery({
    queryKey: queryKeys.sharedVolumes.admin,
    queryFn: () => api.get<SharedVolumeDto[]>('/admin/shared-volumes'),
    refetchInterval: (query) => queryPollInterval(query.state, { activeIntervalMs: 5_000 }),
  });
  const groups = useMemo(() => {
    const map = new Map<string, SharedVolumeDto[]>();
    for (const volume of volumesQuery.data ?? []) {
      map.set(volume.ownerId, [...(map.get(volume.ownerId) ?? []), volume]);
    }
    return [...map.entries()];
  }, [volumesQuery.data]);

  return (
    <Page testId="admin-shared-volumes">
      <PageHeader
        title="共享卷管理"
        description="全部用户的共享卷（管理面）。Catalog 占用只读查看，无修复或强制删除。"
        actions={
          <Button variant="outline" size="icon" onClick={() => { void volumesQuery.refetch(); }} aria-label="刷新共享卷">
            <RefreshCw className="h-4 w-4" />
          </Button>
        }
      />
      <QueryView
        query={volumesQuery}
        resourceName="全局共享卷"
        loadingLabel="加载全局共享卷..."
        showEmpty={volumesQuery.data?.length === 0}
        empty={<EmptyState title="暂无共享卷。" />}
      >
        {(_volumes) => (
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
                      <AdminSharedVolumeRow
                        key={volume.id}
                        volume={volume}
                        onInspect={() => setInspectTarget(volume)}
                      />
                    ))}
                  </CardContent>
                </Card>
              </section>
            ))}
          </div>
        )}
      </QueryView>
      <SharedVolumeCatalogInspectDialog
        volume={inspectTarget}
        open={Boolean(inspectTarget)}
        onOpenChange={(open) => { if (!open) setInspectTarget(null); }}
      />
    </Page>
  );
}

function AdminSharedVolumeRow({
  volume,
  onInspect,
}: {
  volume: SharedVolumeDto;
  onInspect: () => void;
}) {
  const phaseLabel = volume.needsAttention
    ? '需要关注'
    : volumeLifecycleLabel(volume.lifecyclePhase);
  const codeLabel = failureCodeLabel(volume.failureCode);
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
          {volume.sharedBackendName} · {approxGibHint(volume.sizeBytes).replace(/^约 /, '')}
          {' · 已用 '}
          {volume.usedBytes === null ? '未知' : approxGibHint(volume.usedBytes).replace(/^约 /, '')}
          {volume.attachments.length > 0 ? ` · ${volume.attachments.length} 处挂载` : ' · 未挂载'}
          {volume.dirEnsured ? ' · 目录已落地' : ' · 尚未挂载过'}
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
      <Button size="sm" variant="outline" onClick={onInspect}>
        查看 catalog
      </Button>
    </div>
  );
}
