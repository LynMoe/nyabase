import { useState } from 'react';
import { Plus } from 'lucide-react';
import type { DataDiskGrantDto, LiveServerAccessDto, ServerGrantDto } from '@nyabase/common';
import { dataDiskGroupLabel, grantablePools, poolDisplayName } from '../../lib/data-disks.js';
import { formatGrantBytes } from '../../lib/grant-quota.js';
import { formatBytes } from '../../lib/utils.js';
import { useServerPools } from '../../lib/server-queries.js';
import { ResourceRef } from '../refs/resource-ref.js';
import { truncateId } from '../refs/technical-id.js';
import { Badge } from '../ui/badge.js';
import { Button } from '../ui/button.js';
import { Hint } from '../ui/hint.js';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../ui/table.js';
import { DataDiskGrantDialog } from './data-disk-grant-dialog.js';

/** A data-disk grant picked for deletion, with its display label and its disks' names. */
export interface DataDiskDeleteTarget {
  grantId: string;
  label: string;
  poolNames: string[];
}

/** The data-disk grants under one server grant: each a group of disks sharing one quota. */
export function DataDiskSection({
  userId,
  grant,
  access,
  onDelete,
}: {
  userId: string;
  grant: ServerGrantDto;
  access: LiveServerAccessDto | undefined;
  onDelete: (target: DataDiskDeleteTarget) => void;
}) {
  const poolsQuery = useServerPools(grant.serverId);
  const pools = poolsQuery.data ?? [];
  const [dialog, setDialog] = useState<'add' | DataDiskGrantDto | null>(null);
  const blocked = poolsQuery.isSuccess && grantablePools(pools, grant.serverId).length === 0
    ? '该服务器上没有可授权的本地存储池。'
    : null;
  const nameOf = (poolId: string) => {
    const pool = pools.find((row) => row.id === poolId);
    return pool ? poolDisplayName(pool) : truncateId(poolId);
  };
  return (
    <div className="space-y-2" data-testid={`grant-pools-${grant.serverId}`}>
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium">数据盘</p>
        <Hint content={blocked} disabled={blocked !== null}>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setDialog('add')}
            disabled={blocked !== null}
            data-testid={`grant-add-pool-${grant.serverId}`}
          >
            <Plus className="h-4 w-4" />数据盘
          </Button>
        </Hint>
      </div>
      {grant.dataDisks.length === 0 ? (
        <p className="text-sm text-muted-foreground">暂无数据盘授权，该用户在此服务器上没有数据盘。</p>
      ) : (
        <div className="overflow-x-auto rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>盘</TableHead>
                <TableHead>共用额度</TableHead>
                <TableHead>已有数据</TableHead>
                <TableHead className="text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {grant.dataDisks.map((row) => {
                const usage = access?.dataDisks.find((item) => item.grantId === row.id);
                return (
                  <TableRow key={row.id} data-testid={`grant-disk-${row.id}`}>
                    <TableCell className="whitespace-normal">
                      <ul className="space-y-0.5">
                        {row.poolIds.map((poolId) => {
                          const pool = pools.find((item) => item.id === poolId);
                          return (
                            <li key={poolId} className="flex flex-wrap items-center gap-2">
                              <ResourceRef kind="pool" id={poolId} name={nameOf(poolId)} serverId={grant.serverId} />
                              <span className="font-mono text-xs text-muted-foreground">{pool ? (pool.mountPath ?? '未启用') : ''}</span>
                              {pool?.maintenance ? <Badge variant="warning">维护中</Badge> : null}
                            </li>
                          );
                        })}
                      </ul>
                    </TableCell>
                    <TableCell>{formatGrantBytes(row.limitBytes)}</TableCell>
                    <TableCell>{usage ? formatBytes(usage.usedBytes) : '—'}</TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-2">
                        <Button size="sm" variant="outline" onClick={() => setDialog(row)}>编辑</Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => onDelete({
                            grantId: row.id,
                            label: dataDiskGroupLabel(row, nameOf),
                            poolNames: row.poolIds.map(nameOf),
                          })}
                        >
                          删除
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
      {dialog ? (
        <DataDiskGrantDialog
          userId={userId}
          serverGrant={grant}
          editing={dialog === 'add' ? undefined : dialog}
          usage={dialog === 'add' ? undefined : access?.dataDisks.find((item) => item.grantId === dialog.id)}
          onClose={() => setDialog(null)}
        />
      ) : null}
    </div>
  );
}
