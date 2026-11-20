import { useQuery } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import type { EffectiveAccessDto, EffectiveSharedBackendAccessDto, SharedBackendDto, SharedVolumeDto } from '@nyabase/common';
import { api } from '../lib/api.js';
import { Button } from '../components/ui/button.js';
import { EmptyState } from '../components/layout/empty-state.js';
import { Page, PageHeader } from '../components/layout/page-header.js';
import { QueryView } from '../components/layout/query-view.js';
import { SectionCard } from '../components/layout/section-card.js';
import { StatusBadge } from '../components/layout/status-badge.js';
import { UsageMeter } from '../components/performance/usage-meter.js';
import { ResourceRef } from '../components/refs/resource-ref.js';
import { SharedVolumeDetailDialog, SharedVolumeTable } from '../components/storage/shared-volume-table.js';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table.js';
import { expiryLabel } from '../components/grants/use-grant-panel-data.js';
import { sharedUnitPair } from '../lib/container-usage.js';
import { userDiskState } from '../lib/data-disks.js';
import { volumeInProgress } from '../lib/in-progress.js';
import { queryKeys } from '../lib/query-keys.js';
import { refetchWhileInProgress } from '../lib/query-lifecycle.js';
import { formatBytes } from '../lib/utils.js';
import { useNavigate, useSearch } from '@tanstack/react-router';
import type { VolumeDetailFocus } from '../components/storage/volume-detail-focus.js';

function useVolumeFocus(): VolumeDetailFocus {
  const search = useSearch({ from: '/shared-volumes/' });
  const navigate = useNavigate({ from: '/shared-volumes/' });
  return {
    id: search.volume ?? null,
    onChange: (id) => { void navigate({ search: (prev) => ({ ...prev, volume: id ?? undefined }), replace: true }); },
  };
}

/** The user's live volume on a backend (one per user and backend). */
function volumeOnBackend(volumes: readonly SharedVolumeDto[], backendId: string): SharedVolumeDto | undefined {
  return volumes.find((volume) => volume.sharedBackendId === backendId && volume.lifecyclePhase !== 'deleting')
    ?? volumes.find((volume) => volume.sharedBackendId === backendId);
}

/**
 * The user's shared storage, read-only: per granted backend its one volume,
 * mounted at the backend's path in all of the user's containers, with the
 * data on it against the quota. Volumes no grant covers any more are listed apart.
 */
export default function SharedVolumesPage() {
  const accessQuery = useQuery({
    queryKey: queryKeys.meAccess,
    queryFn: () => api.get<EffectiveAccessDto>('/me/access'),
  });
  const volumesQuery = useQuery({
    queryKey: queryKeys.sharedVolumes.user,
    queryFn: () => api.get<SharedVolumeDto[]>('/shared-volumes'),
    refetchInterval: (query) => refetchWhileInProgress(query.state, {
      steadyIntervalMs: false,
      isSettled: (volumes) => volumes.every((volume) => !volumeInProgress(volume)),
    }),
  });
  const backendsQuery = useQuery({
    queryKey: queryKeys.sharedBackends.user,
    queryFn: () => api.get<SharedBackendDto[]>('/shared-backends'),
  });
  return (
    <Page testId="shared-volumes">
      <PageHeader
        title="共享卷"
        description="管理员授权的共享存储上，平台为你建一个共享卷，挂载到你在所有服务器上的容器，容量随额度自动调整。"
        actions={
          <Button
            variant="outline"
            size="icon"
            onClick={() => {
              void accessQuery.refetch();
              void volumesQuery.refetch();
              void backendsQuery.refetch();
            }}
            aria-label="刷新共享卷"
          >
            <RefreshCw className="h-4 w-4" />
          </Button>
        }
      />
      <QueryView
        queries={[accessQuery, volumesQuery, backendsQuery]}
        resourceNames={['授权', '共享卷', '共享存储']}
        loadingLabel="加载共享卷..."
      >
        {() => (
          <SharedStorageList
            grants={accessQuery.data?.sharedBackends ?? []}
            volumes={volumesQuery.data ?? []}
            backends={backendsQuery.data ?? []}
          />
        )}
      </QueryView>
    </Page>
  );
}

function SharedStorageList({
  grants,
  volumes,
  backends,
}: {
  grants: EffectiveSharedBackendAccessDto[];
  volumes: SharedVolumeDto[];
  backends: SharedBackendDto[];
}) {
  const detailFocus = useVolumeFocus();
  const granted = new Set(grants.map((grant) => grant.sharedBackendId));
  const uncovered = volumes.filter((volume) => !granted.has(volume.sharedBackendId));
  const coveredDetail = volumes.find((volume) => volume.id === detailFocus.id && granted.has(volume.sharedBackendId)) ?? null;
  if (grants.length === 0 && volumes.length === 0) {
    return (
      <EmptyState
        title="暂无共享卷。"
        description="共享存储由管理员授权；授权后平台自动建卷并挂载到你的所有容器。"
      />
    );
  }
  return (
    <div className="space-y-6">
      {grants.length > 0 ? (
        <SectionCard flush testId="shared-storage-granted">
          <Table className="min-w-[760px]">
            <TableHeader>
              <TableRow>
                <TableHead>共享存储</TableHead>
                <TableHead>挂载点</TableHead>
                <TableHead>已用 / 额度</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>到期</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {grants.map((grant) => (
                <SharedStorageRow
                  key={grant.sharedBackendId}
                  grant={grant}
                  backend={backends.find((row) => row.id === grant.sharedBackendId)}
                  volume={volumeOnBackend(volumes, grant.sharedBackendId)}
                  onOpen={(volume) => detailFocus.onChange(volume.id)}
                />
              ))}
            </TableBody>
          </Table>
        </SectionCard>
      ) : null}
      {uncovered.length > 0 ? (
        <SectionCard
          title="不在授权内的共享卷"
          description="授权撤销或到期后，共享卷从容器卸载，宽限期满后删除。需要保留数据请联系管理员。"
          flush
        >
          <SharedVolumeTable volumes={uncovered} scope="mine" showBackendColumn detailFocus={detailFocus} />
        </SectionCard>
      ) : null}
      <SharedVolumeDetailDialog
        volume={coveredDetail}
        scope="mine"
        open={Boolean(coveredDetail)}
        onOpenChange={(open) => { if (!open) detailFocus.onChange(null); }}
      />
    </div>
  );
}

function SharedStorageRow({
  grant,
  backend,
  volume,
  onOpen,
}: {
  grant: EffectiveSharedBackendAccessDto;
  backend: SharedBackendDto | undefined;
  volume: SharedVolumeDto | undefined;
  onOpen: (volume: SharedVolumeDto) => void;
}) {
  const state = userDiskState(backend, volume);
  const pair = sharedUnitPair(formatBytes(grant.usedBytes), formatBytes(grant.limitBytes));
  return (
    <TableRow className={volume ? 'cursor-pointer' : undefined} onClick={volume ? () => onOpen(volume) : undefined}>
      <TableCell className="whitespace-normal">
        <span className="font-medium">
          <ResourceRef kind="shared-backend" id={grant.sharedBackendId} name={backend?.displayName ?? backend?.name} />
        </span>
        {backend?.note ? <p className="mt-0.5 max-w-[22rem] text-xs text-muted-foreground">{backend.note}</p> : null}
      </TableCell>
      <TableCell className="font-mono text-xs">{backend?.mountPath ?? volume?.mountPath ?? '—'}</TableCell>
      <TableCell>
        <UsageMeter
          className="w-36"
          reading={{ used: pair.used, total: pair.total, ratio: grant.limitBytes > 0 ? grant.usedBytes / grant.limitBytes : null }}
          detail={`剩余 ${formatBytes(Math.max(0, grant.limitBytes - grant.usedBytes))}`}
        />
      </TableCell>
      <TableCell className="whitespace-normal">
        <StatusBadge label={state.label} pending={state.pending} variant={state.variant} />
        {state.hint ? (
          <p className={state.variant === 'destructive' ? 'mt-1 text-xs text-destructive' : 'mt-1 text-xs text-muted-foreground'}>
            {state.hint}
          </p>
        ) : null}
      </TableCell>
      <TableCell>{expiryLabel(grant.expiresAt)}</TableCell>
    </TableRow>
  );
}
