import { useQuery } from '@tanstack/react-query';
import type { LiveServerAccessDto, StoragePoolDto, VolumeDto } from '@nyabase/common';
import { SectionCard } from '../../components/layout/section-card.js';
import { StatusBadge } from '../../components/layout/status-badge.js';
import { ResourceRef } from '../../components/refs/resource-ref.js';
import { truncateId } from '../../components/refs/technical-id.js';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../components/ui/table.js';
import { api } from '../../lib/api.js';
import { poolDisplayName, userDiskState } from '../../lib/data-disks.js';
import { formatDiskCap } from '../../lib/grant-data-disks.js';
import { queryKeys } from '../../lib/query-keys.js';
import { formatBytes } from '../../lib/utils.js';

/** The user's live volume on a pool (one per user and pool; a deleting one only until it is gone). */
export function volumeOnPool(volumes: readonly VolumeDto[], poolId: string): VolumeDto | undefined {
  return volumes.find((volume) => volume.poolId === poolId && volume.lifecyclePhase !== 'deleting')
    ?? volumes.find((volume) => volume.poolId === poolId);
}

/**
 * One server's data disks. They share the server grant's disk total with the
 * user's system disks (系统盘 by allocated size, data disks by their data), so
 * any disk takes writes until the total, or that disk's own ceiling, is reached.
 */
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
  const data = access.dataDisks.reduce((sum, disk) => sum + disk.usedBytes, 0);
  const left = Math.max(0, access.diskBytes - access.rootDiskCommittedBytes - data);
  return (
    <SectionCard
      title={<ResourceRef kind="server" id={access.serverId} name={serverName} />}
      flush
      testId={`data-disks-${access.serverId}`}
    >
      <p className="px-4 pt-3 text-sm sm:px-6" data-testid={`data-disk-total-${access.serverId}`}>
        磁盘总额度 {formatBytes(access.diskBytes)}，与系统盘共用：系统盘已分配 {formatBytes(access.rootDiskCommittedBytes)}，
        数据盘数据 {formatBytes(data)}，剩余 {formatBytes(left)}。任一盘都可写，直到总额度或该盘的上限。
      </p>
      <Table className="min-w-[720px]">
        <TableHeader>
          <TableRow>
            <TableHead>盘</TableHead>
            <TableHead>挂载点</TableHead>
            <TableHead>已用数据</TableHead>
            <TableHead>上限</TableHead>
            <TableHead>状态</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {access.dataDisks.map((disk) => (
            <DataDiskRow
              key={disk.poolId}
              poolId={disk.poolId}
              capBytes={disk.capBytes}
              pool={pools.find((row) => row.id === disk.poolId)}
              volume={volumeOnPool(volumes, disk.poolId)}
              onOpenVolume={onOpenVolume}
            />
          ))}
        </TableBody>
      </Table>
    </SectionCard>
  );
}

function DataDiskRow({
  poolId,
  capBytes,
  pool,
  volume,
  onOpenVolume,
}: {
  poolId: string;
  capBytes: number | null;
  pool: StoragePoolDto | undefined;
  volume: VolumeDto | undefined;
  onOpenVolume: (volume: VolumeDto) => void;
}) {
  const state = userDiskState(pool, volume);
  const mountPath = pool?.mountPath ?? volume?.mountPath ?? null;
  return (
    <TableRow
      className={volume ? 'cursor-pointer' : undefined}
      onClick={volume ? () => onOpenVolume(volume) : undefined}
      data-testid={`data-disk-${poolId}`}
    >
      <TableCell className="font-medium">
        {pool ? poolDisplayName(pool) : volume?.poolName ?? truncateId(poolId)}
      </TableCell>
      <TableCell className="font-mono text-xs">{mountPath ?? '—'}</TableCell>
      <TableCell>{volume?.usedBytes == null ? '—' : formatBytes(volume.usedBytes)}</TableCell>
      <TableCell className="text-muted-foreground">{formatDiskCap(capBytes)}</TableCell>
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
}
