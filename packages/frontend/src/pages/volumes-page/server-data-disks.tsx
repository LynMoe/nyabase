import { useQuery } from '@tanstack/react-query';
import type { DataDiskUsageDto, LiveServerAccessDto, StoragePoolDto, VolumeDto } from '@nyabase/common';
import { SectionCard } from '../../components/layout/section-card.js';
import { StatusBadge } from '../../components/layout/status-badge.js';
import { ResourceRef } from '../../components/refs/resource-ref.js';
import { truncateId } from '../../components/refs/technical-id.js';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../components/ui/table.js';
import { api } from '../../lib/api.js';
import { poolDisplayName, userDiskState } from '../../lib/data-disks.js';
import { queryKeys } from '../../lib/query-keys.js';
import { formatBytes } from '../../lib/utils.js';

/** The user's live volume on a pool (one per user and pool; a deleting one only until it is gone). */
export function volumeOnPool(volumes: readonly VolumeDto[], poolId: string): VolumeDto | undefined {
  return volumes.find((volume) => volume.poolId === poolId && volume.lifecyclePhase !== 'deleting')
    ?? volumes.find((volume) => volume.poolId === poolId);
}

/** One server's data disks, one block per data-disk grant (disks sharing one quota). */
export function ServerDataDisks({
  access,
  serverName,
  volumes,
  onOpenVolume,
}: {
  access: LiveServerAccessDto;
  serverName: string | undefined;
  volumes: readonly VolumeDto[];
  onOpenVolume: (volume: VolumeDto) => void;
}) {
  const poolsQuery = useQuery({
    queryKey: queryKeys.servers.pools(access.serverId, 'mine'),
    queryFn: () => api.get<StoragePoolDto[]>(`/servers/${access.serverId}/storage-pools`),
  });
  const pools = poolsQuery.data ?? [];
  return (
    <SectionCard
      title={<ResourceRef kind="server" id={access.serverId} name={serverName} />}
      flush
      testId={`data-disks-${access.serverId}`}
    >
      <div className="divide-y">
        {access.dataDisks.map((group) => (
          <DataDiskGroup
            key={group.grantId}
            group={group}
            pools={pools}
            volumes={volumes}
            onOpenVolume={onOpenVolume}
          />
        ))}
      </div>
    </SectionCard>
  );
}

function DataDiskGroup({
  group,
  pools,
  volumes,
  onOpenVolume,
}: {
  group: DataDiskUsageDto;
  pools: readonly StoragePoolDto[];
  volumes: readonly VolumeDto[];
  onOpenVolume: (volume: VolumeDto) => void;
}) {
  const several = group.poolIds.length > 1;
  return (
    <div data-testid={`data-disk-group-${group.grantId}`}>
      <p className="px-4 pt-3 text-sm font-medium sm:px-6">
        数据盘（总额度 {formatBytes(group.limitBytes)}，剩余 {formatBytes(group.availableBytes)}
        {several ? '，任一盘都可写' : ''}）
      </p>
      <Table className="min-w-[640px]">
        <TableHeader>
          <TableRow>
            <TableHead>盘</TableHead>
            <TableHead>挂载点</TableHead>
            <TableHead>已用数据</TableHead>
            <TableHead>状态</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {group.poolIds.map((poolId) => {
            const pool = pools.find((row) => row.id === poolId);
            const volume = volumeOnPool(volumes, poolId);
            const state = userDiskState(pool, volume);
            const mountPath = pool?.mountPath ?? volume?.mountPath ?? null;
            return (
              <TableRow
                key={poolId}
                className={volume ? 'cursor-pointer' : undefined}
                onClick={volume ? () => onOpenVolume(volume) : undefined}
              >
                <TableCell className="font-medium">
                  {pool ? poolDisplayName(pool) : volume?.poolName ?? truncateId(poolId)}
                </TableCell>
                <TableCell className="font-mono text-xs">{mountPath ?? '—'}</TableCell>
                <TableCell>{volume?.usedBytes == null ? '—' : formatBytes(volume.usedBytes)}</TableCell>
                <TableCell className="whitespace-normal">
                  <StatusBadge label={state.label} pending={state.pending} variant={state.variant} />
                  {state.hint ? (
                    <p className={state.variant === 'destructive' ? 'mt-1 text-xs text-destructive' : 'mt-1 text-xs text-muted-foreground'}>
                      {state.hint}
                    </p>
                  ) : null}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
