import { useQuery } from '@tanstack/react-query';
import type { GrantDataDisk, StoragePoolDto, VolumeDto } from '@nyabase/common';
import { api } from '../../lib/api.js';
import { grantablePools, poolDisplayName } from '../../lib/data-disks.js';
import {
  type DataDiskDraft,
  capTextError,
  formatDiskCap,
  parseDataDiskDraft,
  setDataDiskCap,
  toggleDataDisk,
} from '../../lib/grant-data-disks.js';
import { queryKeys } from '../../lib/query-keys.js';
import { useServerPools } from '../../lib/server-queries.js';
import { approxSizeHint, formatBytes } from '../../lib/utils.js';
import { truncateId } from '../refs/technical-id.js';
import { Badge } from '../ui/badge.js';
import { Checkbox } from '../ui/checkbox.js';
import { Input } from '../ui/input.js';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../ui/table.js';

/** Data on one user's live volumes of a server, by pool (one volume per user and pool); undefined while loading. */
export function useUserPoolData(userId: string | undefined, serverId: string): Map<string, number> | undefined {
  const query = useQuery({
    queryKey: queryKeys.volumes.adminByServer(serverId),
    queryFn: () => api.get<VolumeDto[]>(`/volumes?scope=all&serverId=${serverId}`),
    enabled: Boolean(userId && serverId),
  });
  if (!query.data || !userId) return undefined;
  const result = new Map<string, number>();
  for (const volume of query.data) {
    if (volume.ownerId !== userId || volume.lifecyclePhase === 'deleting' || volume.lifecyclePhase === 'failed') continue;
    result.set(volume.poolId, (result.get(volume.poolId) ?? 0) + (volume.usedBytes ?? 0));
  }
  return result;
}

function poolLabel(pools: readonly StoragePoolDto[], poolId: string): string {
  const pool = pools.find((row) => row.id === poolId);
  return pool ? poolDisplayName(pool) : truncateId(poolId);
}

/** A pool's mount point as a data disk, or why it is not mounted yet. */
function MountCell({ pool }: { pool: StoragePoolDto | undefined }) {
  if (!pool) return <span className="text-muted-foreground">—</span>;
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      <span className={pool.mountPath ? 'font-mono text-xs' : 'text-xs text-muted-foreground'}>
        {pool.mountPath ?? '未启用'}
      </span>
      {pool.maintenance ? <Badge variant="warning">维护中</Badge> : null}
    </span>
  );
}

/**
 * The data disks of a bundle or grant: one row per local pool of the server,
 * ticked when listed, with an optional 上限 (GiB; empty = only the disk
 * total). Without `onChange` it shows a list read-only (what a grant follows).
 * `usedByPool` (a user's grant) adds the user's data and flags a ceiling below it.
 */
export function DataDiskEditor({
  id,
  serverId,
  draft,
  onChange,
  usedByPool,
  known = [],
}: {
  id: string;
  serverId: string;
  draft: DataDiskDraft;
  onChange?: (draft: DataDiskDraft) => void;
  usedByPool?: ReadonlyMap<string, number>;
  /** The lists the draft was filled from: an untouched 上限 keeps their exact bytes. */
  known?: Array<readonly GrantDataDisk[] | undefined>;
}) {
  const poolsQuery = useServerPools(serverId);
  const pools = poolsQuery.data ?? [];
  const editable = onChange !== undefined;
  const listed = draft.map((row) => row.poolId);
  const rows = editable ? grantablePools(pools, serverId, listed).map((pool) => pool.id) : listed;
  if (editable && poolsQuery.isLoading) return <p className="text-sm text-muted-foreground">加载存储池…</p>;
  if (rows.length === 0) {
    return (
      <p className="text-sm text-muted-foreground" data-testid={`${id}-empty`}>
        {editable ? '该服务器上没有可作为数据盘的本地存储池。' : '无数据盘'}
      </p>
    );
  }
  return (
    <div className="overflow-x-auto rounded-md border" data-testid={id}>
      <Table className="min-w-[520px]">
        <TableHeader>
          <TableRow>
            <TableHead>盘</TableHead>
            <TableHead>挂载点</TableHead>
            {usedByPool ? <TableHead>已有数据</TableHead> : null}
            <TableHead>上限（GiB，留空为只受总额限制）</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((poolId) => (
            <DataDiskRow
              key={poolId}
              id={`${id}-${poolId}`}
              poolId={poolId}
              pool={pools.find((row) => row.id === poolId)}
              name={poolLabel(pools, poolId)}
              draft={draft}
              onChange={onChange}
              used={usedByPool?.get(poolId)}
              showUsed={usedByPool !== undefined}
              known={known}
            />
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function DataDiskRow({
  id,
  poolId,
  pool,
  name,
  draft,
  onChange,
  used,
  showUsed,
  known,
}: {
  id: string;
  poolId: string;
  pool: StoragePoolDto | undefined;
  name: string;
  draft: DataDiskDraft;
  onChange?: (draft: DataDiskDraft) => void;
  used: number | undefined;
  showUsed: boolean;
  known: Array<readonly GrantDataDisk[] | undefined>;
}) {
  const row = draft.find((item) => item.poolId === poolId);
  const parsed = row ? parseDataDiskDraft([row], ...known)?.[0] : undefined;
  const capBytes = parsed?.capBytes ?? null;
  const error = row && onChange ? capTextError(row.capText) : null;
  const belowData = capBytes !== null && used !== undefined && capBytes < used;
  return (
    <TableRow data-testid={id}>
      <TableCell className="whitespace-normal">
        {onChange ? (
          <label className="flex items-center gap-2">
            <Checkbox
              checked={row !== undefined}
              onCheckedChange={(checked) => onChange(toggleDataDisk(draft, poolId, checked === true))}
              aria-label={`数据盘 ${name}`}
            />
            <span className="font-medium">{name}</span>
          </label>
        ) : <span className="font-medium">{name}</span>}
      </TableCell>
      <TableCell><MountCell pool={pool} /></TableCell>
      {showUsed ? <TableCell className="tabular-nums">{used === undefined ? '—' : formatBytes(used)}</TableCell> : null}
      <TableCell className="whitespace-normal">
        {onChange ? (
          <div className="space-y-1">
            <Input
              id={`${id}-cap`}
              type="number"
              min="0"
              step="any"
              className="w-32"
              value={row?.capText ?? ''}
              disabled={row === undefined}
              placeholder="只受总额限制"
              aria-invalid={error ? true : undefined}
              aria-label={`${name} 上限（GiB）`}
              onChange={(event) => onChange(setDataDiskCap(draft, poolId, event.target.value))}
            />
            {error ? <p className="text-xs text-destructive">{error}</p> : null}
            {!error && capBytes !== null ? <p className="text-xs text-muted-foreground">{approxSizeHint(capBytes)}</p> : null}
          </div>
        ) : <span className="tabular-nums">{formatDiskCap(capBytes)}</span>}
        {belowData ? (
          <p className="mt-1 text-xs text-destructive" data-testid={`${id}-below-data`}>
            低于已有数据 {formatBytes(used!)}：超出部分只能删除，不会停机或卸载。
          </p>
        ) : null}
      </TableCell>
    </TableRow>
  );
}
