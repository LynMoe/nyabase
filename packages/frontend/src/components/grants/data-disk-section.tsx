import { useState } from 'react';
import { Plus } from 'lucide-react';
import type { LiveServerAccessDto, ServerGrantDto, StoragePoolGrantDto } from '@nyabase/common';
import { useActionMutation } from '../../hooks/use-action-mutation.js';
import { api } from '../../lib/api.js';
import { formatCompactBytes, formatGrantBytes } from '../../lib/grant-quota.js';
import { useServerPools } from '../../lib/server-queries.js';
import { SelectField } from '../layout/form-field.js';
import { ResourceRef } from '../refs/resource-ref.js';
import { truncateId } from '../refs/technical-id.js';
import { Button } from '../ui/button.js';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog.js';
import { Hint } from '../ui/hint.js';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../ui/table.js';
import { NumberField } from './grant-form-parts.js';
import {
  addablePools,
  gibHint,
  gibQuotaText,
  parseGibQuotaKeeping,
  poolLabel,
  useInvalidateGrants,
} from './use-grant-panel-data.js';

/** A data disk picked for deletion, with its display name. */
export interface DataDiskDeleteTarget {
  poolId: string;
  label: string;
}

/** The data-disk quotas (one per local pool) under one server grant. */
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
  const [dialog, setDialog] = useState<'add' | StoragePoolGrantDto | null>(null);
  const addable = addablePools(pools, grant);
  const blocked = poolsQuery.isSuccess && addable.length === 0 ? '该服务器上没有其他可授权的本地存储池。' : null;
  const nameOf = (poolId: string) => {
    const pool = pools.find((row) => row.id === poolId);
    return pool ? poolLabel(pool) : undefined;
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
      {grant.storagePools.length === 0 ? (
        <p className="text-sm text-muted-foreground">暂无数据盘额度，该用户在此服务器上不能创建数据卷。</p>
      ) : (
        <div className="overflow-x-auto rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>存储池</TableHead>
                <TableHead>额度</TableHead>
                <TableHead>已分配</TableHead>
                <TableHead className="text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {grant.storagePools.map((row) => {
                const used = access?.storagePools.find((item) => item.poolId === row.poolId)?.usedBytes;
                return (
                  <TableRow key={row.id}>
                    <TableCell className="whitespace-normal">
                      <ResourceRef kind="pool" id={row.poolId} name={nameOf(row.poolId)} />
                    </TableCell>
                    <TableCell>{formatGrantBytes(row.limitBytes)}</TableCell>
                    <TableCell>{used === undefined ? '—' : formatCompactBytes(used)}</TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-2">
                        <Button size="sm" variant="outline" onClick={() => setDialog(row)}>编辑</Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => onDelete({ poolId: row.poolId, label: nameOf(row.poolId) ?? truncateId(row.poolId) })}
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
        <DataDiskDialog
          userId={userId}
          grant={grant}
          disk={dialog === 'add' ? undefined : dialog}
          poolName={dialog === 'add' ? undefined : nameOf(dialog.poolId) ?? truncateId(dialog.poolId)}
          onClose={() => setDialog(null)}
        />
      ) : null}
    </div>
  );
}

/** Add (no `disk`) or change one data-disk quota under the grant. */
function DataDiskDialog({
  userId,
  grant,
  disk,
  poolName,
  onClose,
}: {
  userId: string;
  grant: ServerGrantDto;
  disk?: StoragePoolGrantDto;
  poolName?: string;
  onClose: () => void;
}) {
  const poolsQuery = useServerPools(grant.serverId);
  const invalidate = useInvalidateGrants(userId);
  const [poolId, setPoolId] = useState(disk?.poolId ?? '');
  const [limitGib, setLimitGib] = useState(() => gibQuotaText(disk?.limitBytes));
  const parsed = parseGibQuotaKeeping(limitGib, disk?.limitBytes);
  const save = useActionMutation({
    mutationFn: () => api.put<StoragePoolGrantDto>(`/users/${userId}/storage-pool-grants/${poolId}`, {
      limitBytes: parsed ?? null,
    }),
    successTitle: '数据盘额度已保存',
    errorTitle: '数据盘额度保存失败',
    onSuccess: () => { onClose(); invalidate(); },
  });
  const options = addablePools(poolsQuery.data ?? [], grant)
    .map((pool): [string, string] => [pool.id, poolLabel(pool)]);
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{disk ? `编辑「${poolName}」的数据盘额度` : '添加数据盘'}</DialogTitle>
          <DialogDescription>
            数据盘额度随这台服务器的授权生效、到期和删除，不单独设有效期。
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {disk ? null : (
            <SelectField
              id={`grant-pool-${grant.serverId}-target`}
              label="存储池"
              value={poolId}
              onChange={setPoolId}
              options={options}
              placeholder="选择本地存储池"
              loading={poolsQuery.isLoading}
              emptyText="没有可添加的存储池"
            />
          )}
          <NumberField
            id={`grant-pool-${grant.serverId}-limit`}
            label="额度（GiB，留空为不限）"
            value={limitGib}
            onChange={setLimitGib}
            hint={gibHint(limitGib)}
            error={parsed === undefined ? '请输入大于 0 的数值' : undefined}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>取消</Button>
          <Button onClick={() => save.mutate()} disabled={!poolId || parsed === undefined || save.isPending}>
            {save.isPending ? '保存中...' : '保存'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
