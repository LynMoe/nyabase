import { useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Role, type VolumeDto } from '@nyabase/common';
import { api } from '../../lib/api.js';
import { SectionCard } from '../layout/section-card.js';
import { QueryErrorState, QueryLoadingState } from '../query-state.js';
import { DeleteVolumeDialog, type DeleteVolumeTarget } from '../storage/delete-volume-dialog.js';
import { LocalVolumeTable } from '../storage/local-volume-table.js';
import { volumeInProgress } from '../../lib/in-progress.js';
import { queryKeys } from '../../lib/query-keys.js';
import { refetchWhileInProgress } from '../../lib/query-lifecycle.js';
import { useHasRole } from '../../lib/use-role.js';

/** The server's storage pools (children) and every user's volumes on it, read-only but for deleting uncovered ones. */
export function ServerStorageTab({
  serverId,
  children,
}: {
  serverId: string;
  children: ReactNode;
}) {
  const canManageVolumes = useHasRole(Role.Admin);
  const [deleteTarget, setDeleteTarget] = useState<DeleteVolumeTarget | null>(null);

  const volumesQuery = useQuery({
    queryKey: queryKeys.volumes.adminByServer(serverId),
    queryFn: () => api.get<VolumeDto[]>(`/volumes?scope=all&serverId=${serverId}`),
    enabled: canManageVolumes,
    refetchInterval: (query) => refetchWhileInProgress(query.state, {
      steadyIntervalMs: 5_000,
      isSettled: (volumes) => volumes.every((volume) => !volumeInProgress(volume)),
    }),
  });

  return (
    <div className="space-y-6">
      {children}
      {!canManageVolumes ? (
        <SectionCard title="本机数据卷">
          <p className="text-sm text-muted-foreground">
            查看本机数据卷需要「管理本地数据卷」权限
          </p>
        </SectionCard>
      ) : volumesQuery.data === undefined && volumesQuery.isError ? (
        <QueryErrorState
          error={volumesQuery.error}
          resourceName="本机数据卷"
          onRetry={() => { void volumesQuery.refetch(); }}
        />
      ) : volumesQuery.data === undefined ? (
        <QueryLoadingState label="加载本机数据卷..." />
      ) : (
        <SectionCard title="本机数据卷" flush>
          <LocalVolumeTable
            volumes={volumesQuery.data}
            scope="all"
            showPoolColumn
            onDelete={(volume) => setDeleteTarget({ kind: 'local', volume })}
            testId="server-volume-table"
          />
        </SectionCard>
      )}
      <DeleteVolumeDialog target={deleteTarget} onClose={() => setDeleteTarget(null)} />
    </div>
  );
}
