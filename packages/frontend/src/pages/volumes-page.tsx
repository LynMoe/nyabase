import { useQuery } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import type { EffectiveAccessDto, UserServerDto, VolumeDto } from '@nyabase/common';
import { api } from '../lib/api.js';
import { Button } from '../components/ui/button.js';
import { EmptyState } from '../components/layout/empty-state.js';
import { Page, PageHeader } from '../components/layout/page-header.js';
import { QueryView } from '../components/layout/query-view.js';
import { SectionCard } from '../components/layout/section-card.js';
import { LocalVolumeDetailDialog, LocalVolumeTable } from '../components/storage/local-volume-table.js';
import { liveServerAccess } from '../lib/effective-access.js';
import { volumeInProgress } from '../lib/in-progress.js';
import { queryKeys } from '../lib/query-keys.js';
import { refetchWhileInProgress } from '../lib/query-lifecycle.js';
import { useNavigate, useSearch } from '@tanstack/react-router';
import type { VolumeDetailFocus } from '../components/storage/volume-detail-focus.js';
import { ServerDataDisks } from './volumes-page/server-data-disks.js';

function useVolumeFocus(): VolumeDetailFocus {
  const search = useSearch({ from: '/volumes/' });
  const navigate = useNavigate({ from: '/volumes/' });
  return {
    id: search.volume ?? null,
    onChange: (id) => { void navigate({ search: (prev) => ({ ...prev, volume: id ?? undefined }), replace: true }); },
  };
}

/**
 * The user's data disks, read-only: per server, each data-disk grant (disks
 * sharing one quota) with its disks; the platform creates, sizes and mounts
 * the volume on each. Volumes no grant covers any more are listed apart.
 */
export default function VolumesPage() {
  const accessQuery = useQuery({
    queryKey: queryKeys.meAccess,
    queryFn: () => api.get<EffectiveAccessDto>('/me/access'),
  });
  const volumesQuery = useQuery({
    queryKey: queryKeys.volumes.user,
    queryFn: () => api.get<VolumeDto[]>('/volumes'),
    refetchInterval: (query) => refetchWhileInProgress(query.state, {
      steadyIntervalMs: false,
      isSettled: (volumes) => volumes.every((volume) => !volumeInProgress(volume)),
    }),
  });
  const serversQuery = useQuery({
    queryKey: queryKeys.servers.user,
    queryFn: () => api.get<UserServerDto[]>('/servers'),
  });

  return (
    <Page testId="volumes">
      <PageHeader
        title="数据盘"
        description="管理员授权的数据盘由平台自动建卷、挂载到你在该服务器上的所有容器，容量随额度自动调整。"
        actions={
          <Button
            variant="outline"
            size="icon"
            onClick={() => {
              void accessQuery.refetch();
              void volumesQuery.refetch();
              void serversQuery.refetch();
            }}
            aria-label="刷新数据盘"
          >
            <RefreshCw className="h-4 w-4" />
          </Button>
        }
      />
      <QueryView
        queries={[accessQuery, volumesQuery, serversQuery]}
        resourceNames={['授权', '数据卷', '服务器']}
        loadingLabel="加载数据盘..."
      >
        {() => (
          <DataDiskList
            access={accessQuery.data}
            volumes={volumesQuery.data ?? []}
            servers={serversQuery.data ?? []}
          />
        )}
      </QueryView>
    </Page>
  );
}

function DataDiskList({
  access,
  volumes,
  servers,
}: {
  access: EffectiveAccessDto | undefined;
  volumes: VolumeDto[];
  servers: UserServerDto[];
}) {
  const detailFocus = useVolumeFocus();
  const live = liveServerAccess(access?.servers).filter((server) => server.dataDisks.length > 0);
  const covered = new Set(live.flatMap((server) => server.dataDisks.map((disk) => disk.poolId)));
  const uncovered = volumes.filter((volume) => !covered.has(volume.poolId));
  const coveredDetail = volumes.find((volume) => volume.id === detailFocus.id && covered.has(volume.poolId)) ?? null;
  const serverNameById = new Map(servers.map((server) => [server.id, server.name]));

  if (live.length === 0 && volumes.length === 0) {
    return (
      <EmptyState
        title="暂无数据盘。"
        description="数据盘由管理员授权；授权后平台自动建卷并挂载到你在该服务器上的所有容器。"
      />
    );
  }
  return (
    <div className="space-y-6" data-testid="volume-server-table">
      {live.map((server) => (
        <ServerDataDisks
          key={server.serverId}
          access={server}
          serverName={serverNameById.get(server.serverId)}
          volumes={volumes.filter((volume) => volume.serverId === server.serverId)}
          onOpenVolume={(volume) => detailFocus.onChange(volume.id)}
        />
      ))}
      {uncovered.length > 0 ? (
        <SectionCard
          title="不在授权内的数据卷"
          description="授权撤销或到期后，数据卷从容器卸载，宽限期满后删除。需要保留数据请联系管理员。"
          flush
          testId="volumes-uncovered"
        >
          <LocalVolumeTable
            volumes={uncovered}
            scope="mine"
            showPoolColumn
            showServerColumn
            serverNameById={serverNameById}
            testId="volumes-uncovered-table"
            detailFocus={detailFocus}
          />
        </SectionCard>
      ) : null}
      <LocalVolumeDetailDialog
        volume={coveredDetail}
        scope="mine"
        open={Boolean(coveredDetail)}
        onOpenChange={(open) => { if (!open) detailFocus.onChange(null); }}
      />
    </div>
  );
}
