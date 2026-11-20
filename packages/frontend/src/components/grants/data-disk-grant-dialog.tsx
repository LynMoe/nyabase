import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import {
  FailureCode,
  GRANT_EXPIRY_GRACE_DAYS,
  type CreateDataDiskGrantRequest,
  type DataDiskGrantChangeDto,
  type DataDiskGrantDto,
  type DataDiskUsageDto,
  type ServerGrantDto,
  type StoragePoolDto,
  type VolumeDto,
} from '@nyabase/common';
import { toast } from '../../hooks/use-toast.js';
import { api } from '../../lib/api.js';
import { ApiError } from '../../lib/api-error.js';
import {
  type DataDiskChangePlan,
  dataDiskGroupLabel,
  dataDiskPatch,
  grantablePools,
  planDataDiskChange,
  poolDisplayName,
  storageErrorMessage,
} from '../../lib/data-disks.js';
import { queryKeys } from '../../lib/query-keys.js';
import { useServerPools } from '../../lib/server-queries.js';
import { formatBytes } from '../../lib/utils.js';
import { truncateId } from '../refs/technical-id.js';
import { Alert, AlertDescription } from '../ui/alert.js';
import { Badge } from '../ui/badge.js';
import { Button } from '../ui/button.js';
import { Checkbox } from '../ui/checkbox.js';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog.js';
import { NumberField } from './grant-form-parts.js';
import { gibHint, gibQuotaText, parseGibLimit, useInvalidateGrants } from './use-grant-panel-data.js';

/** Data on the user's live volumes, by pool (one volume per user and pool). */
function useUserPoolData(userId: string, serverId: string): Map<string, number> | undefined {
  const query = useQuery({
    queryKey: queryKeys.volumes.adminByServer(serverId),
    queryFn: () => api.get<VolumeDto[]>(`/volumes?scope=all&serverId=${serverId}`),
  });
  if (!query.data) return undefined;
  const result = new Map<string, number>();
  for (const volume of query.data) {
    if (volume.ownerId !== userId || volume.lifecyclePhase === 'deleting' || volume.lifecyclePhase === 'failed') continue;
    result.set(volume.poolId, (result.get(volume.poolId) ?? 0) + (volume.usedBytes ?? 0));
  }
  return result;
}

/**
 * Add (no `editing`) or change one data-disk grant: the disks (local pools of
 * the server) and the quota they share. Disks held by another grant of the
 * user move here after a confirmation; disks left out of an edit are revoked.
 */
export function DataDiskGrantDialog({
  userId,
  serverGrant,
  editing,
  usage,
  onClose,
}: {
  userId: string;
  serverGrant: ServerGrantDto;
  editing?: DataDiskGrantDto;
  usage?: DataDiskUsageDto;
  onClose: () => void;
}) {
  const serverId = serverGrant.serverId;
  const poolsQuery = useServerPools(serverId);
  const poolData = useUserPoolData(userId, serverId);
  const invalidate = useInvalidateGrants(userId);
  const [poolIds, setPoolIds] = useState<string[]>(() => editing?.poolIds ?? []);
  const [limitGib, setLimitGib] = useState(() => gibQuotaText(editing?.limitBytes));
  const [confirming, setConfirming] = useState(false);
  const limitBytes = parseGibLimit(limitGib, editing?.limitBytes);
  const allPools = poolsQuery.data ?? [];
  const pools = grantablePools(allPools, serverId, editing?.poolIds);
  const nameOf = (poolId: string) => {
    const pool = allPools.find((row) => row.id === poolId);
    return pool ? poolDisplayName(pool) : truncateId(poolId);
  };
  const plan = planDataDiskChange(serverGrant.dataDisks, poolIds, editing);
  const movePools = plan.moves.length > 0;
  const patch = editing && limitBytes !== undefined ? dataDiskPatch(editing, poolIds, limitBytes, movePools) : null;
  const groupData = poolData
    ? poolIds.reduce((sum, poolId) => sum + (poolData.get(poolId) ?? 0), 0)
    : editing && plan.revoked.length === 0 && poolIds.length === editing.poolIds.length ? usage?.usedBytes : undefined;
  const belowData = limitBytes !== undefined && groupData !== undefined && limitBytes < groupData;

  const save = useMutation({
    mutationFn: () => {
      if (editing) return api.patch<DataDiskGrantChangeDto>(`/users/${userId}/data-disk-grants/${editing.id}`, patch);
      const body: CreateDataDiskGrantRequest = { serverId, poolIds, limitBytes: limitBytes!, ...(movePools ? { movePools } : {}) };
      return api.post<DataDiskGrantChangeDto>(`/users/${userId}/data-disk-grants`, body);
    },
    onSuccess: (change) => {
      toast({
        title: '数据盘授权已保存',
        description: change.revokedPoolIds.length > 0
          ? `已撤销 ${change.revokedPoolIds.map(nameOf).join('、')}：该用户在这些盘上的数据卷已从容器卸载，${GRANT_EXPIRY_GRACE_DAYS} 天后删除。`
          : undefined,
      });
      onClose();
      invalidate();
    },
    onError: (error) => {
      toast({ title: '数据盘授权保存失败', description: storageErrorMessage(error), variant: 'destructive' });
      setConfirming(false);
      if (error instanceof ApiError && error.code === FailureCode.DataDiskPoolGranted) invalidate();
    },
  });
  const valid = poolIds.length > 0 && limitBytes !== undefined && (!editing || patch !== null);
  const submit = () => {
    if (plan.moves.length > 0 || plan.revoked.length > 0) setConfirming(true);
    else save.mutate();
  };
  const toggle = (poolId: string, checked: boolean) => setPoolIds((current) => (
    checked ? [...current, poolId] : current.filter((id) => id !== poolId)
  ));
  const groupNameOf = (grant: DataDiskGrantDto) => dataDiskGroupLabel(grant, nameOf);

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !save.isPending) onClose(); }}>
      <DialogContent className="sm:max-w-2xl" data-testid="data-disk-grant-dialog">
        <DialogHeader>
          <DialogTitle>{confirming ? '确认数据盘变更' : editing ? '编辑数据盘授权' : '添加数据盘授权'}</DialogTitle>
          {confirming ? null : (
            <DialogDescription>
              选中的盘共用一个额度：用户在其中任一盘上都能写，直到这组盘上的数据合计达到额度。
              每块已启用的盘上自动为用户建一个数据卷，挂载到他在这台服务器上的所有容器；授权随服务器授权生效、到期和删除。
            </DialogDescription>
          )}
        </DialogHeader>
        {confirming ? (
          <ChangeSummary plan={plan} nameOf={nameOf} groupNameOf={groupNameOf} />
        ) : (
          <div className="space-y-4">
            <PoolPicker
              serverId={serverId}
              pools={pools}
              loading={poolsQuery.isLoading}
              selected={poolIds}
              poolData={poolData}
              holderOf={(poolId) => serverGrant.dataDisks.find((grant) => grant.id !== editing?.id && grant.poolIds.includes(poolId))}
              groupNameOf={groupNameOf}
              onToggle={toggle}
            />
            <NumberField
              id={`grant-disk-${serverId}-limit`}
              label="共用额度（GiB）"
              value={limitGib}
              onChange={setLimitGib}
              hint={gibHint(limitGib)}
              error={limitGib.trim() && limitBytes === undefined ? '请输入大于 0 的数值' : undefined}
            />
            <ChangeWarnings plan={plan} nameOf={nameOf} groupNameOf={groupNameOf} />
            {belowData ? (
              <Alert variant="info" data-testid="data-disk-below-data">
                <AlertDescription>
                  新额度低于这组盘上已有的数据（{formatBytes(groupData!)}）。超出部分只能删除，不会停机或卸载。
                </AlertDescription>
              </Alert>
            ) : null}
          </div>
        )}
        <DialogFooter>
          {confirming ? (
            <>
              <Button variant="outline" onClick={() => setConfirming(false)} disabled={save.isPending}>返回修改</Button>
              <Button
                variant={plan.revoked.length > 0 ? 'destructive' : 'default'}
                onClick={() => save.mutate()}
                disabled={save.isPending}
                data-testid="data-disk-confirm"
              >
                {save.isPending ? '保存中...' : '确认保存'}
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" onClick={onClose}>取消</Button>
              <Button onClick={submit} disabled={!valid || save.isPending} data-testid="data-disk-save">
                {save.isPending ? '保存中...' : '保存'}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** One checkbox per local pool: its mount path, the user's data on it, the grant that holds it now. */
function PoolPicker({
  serverId,
  pools,
  loading,
  selected,
  poolData,
  holderOf,
  groupNameOf,
  onToggle,
}: {
  serverId: string;
  pools: StoragePoolDto[];
  loading: boolean;
  selected: readonly string[];
  poolData: ReadonlyMap<string, number> | undefined;
  holderOf: (poolId: string) => DataDiskGrantDto | undefined;
  groupNameOf: (grant: DataDiskGrantDto) => string;
  onToggle: (poolId: string, checked: boolean) => void;
}) {
  if (loading) return <p className="text-sm text-muted-foreground">加载存储池...</p>;
  if (pools.length === 0) return <p className="text-sm text-muted-foreground">该服务器上没有可授权的本地存储池。</p>;
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium">盘</legend>
      <div className="max-h-72 space-y-1.5 overflow-y-auto">
        {pools.map((pool) => {
          const id = `grant-disk-${serverId}-pool-${pool.id}`;
          const holder = holderOf(pool.id);
          const data = poolData?.get(pool.id);
          const notes = [
            data === undefined ? null : `已有数据 ${formatBytes(data)}`,
            holder ? `当前属于「${groupNameOf(holder)}」` : null,
          ].filter(Boolean);
          return (
            <label key={pool.id} htmlFor={id} className="flex cursor-pointer items-start gap-3 rounded-md border px-3 py-2 text-sm">
              <Checkbox
                id={id}
                className="mt-0.5"
                checked={selected.includes(pool.id)}
                onCheckedChange={(checked) => onToggle(pool.id, checked === true)}
              />
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{poolDisplayName(pool)}</span>
                  <span className="font-mono text-xs text-muted-foreground">{pool.mountPath ?? '未启用'}</span>
                  {pool.maintenance ? <Badge variant="warning">维护中</Badge> : null}
                  {pool.registered ? null : <Badge variant="secondary">未登记</Badge>}
                </span>
                {notes.length > 0 ? <span className="mt-0.5 block text-xs text-muted-foreground">{notes.join(' · ')}</span> : null}
              </span>
            </label>
          );
        })}
      </div>
      <p className="text-xs text-muted-foreground">未启用的盘在管理员设置挂载点之前不会建卷。</p>
    </fieldset>
  );
}

interface PlanText {
  plan: DataDiskChangePlan;
  nameOf: (poolId: string) => string;
  groupNameOf: (grant: DataDiskGrantDto) => string;
}

/** Moves (amber) and revocations (red) as the selection stands. */
function ChangeWarnings({ plan, nameOf, groupNameOf }: PlanText) {
  return (
    <>
      {plan.moves.length > 0 ? (
        <Alert variant="warning" data-testid="data-disk-moves">
          <AlertDescription className="space-y-1">
            <MoveLines plan={plan} nameOf={nameOf} groupNameOf={groupNameOf} />
          </AlertDescription>
        </Alert>
      ) : null}
      {plan.revoked.length > 0 ? (
        <Alert variant="destructive" data-testid="data-disk-revoked">
          <AlertDescription>
            <RevokeLine plan={plan} nameOf={nameOf} groupNameOf={groupNameOf} />
          </AlertDescription>
        </Alert>
      ) : null}
    </>
  );
}

/** The confirmation step: what the save does to the user's other grants and volumes. */
function ChangeSummary({ plan, nameOf, groupNameOf }: PlanText) {
  return (
    <div className="space-y-3 text-sm">
      {plan.moves.length > 0 ? (
        <div className="space-y-1">
          <MoveLines plan={plan} nameOf={nameOf} groupNameOf={groupNameOf} />
          <p className="text-muted-foreground">移动的盘上已有的数据卷保留，额度改按这组授权计算。</p>
        </div>
      ) : null}
      {plan.revoked.length > 0 ? (
        <p className="font-medium text-destructive">
          <RevokeLine plan={plan} nameOf={nameOf} groupNameOf={groupNameOf} />
        </p>
      ) : null}
    </div>
  );
}

function MoveLines({ plan, nameOf, groupNameOf }: PlanText) {
  return (
    <>
      {plan.moves.map((move) => (
        <p key={move.from.id}>
          {move.poolIds.map(nameOf).join('、')} 将从「{groupNameOf(move.from)}」中移出
          {move.emptied ? '；该组授权没有剩下的盘，将被删除。' : '。'}
        </p>
      ))}
    </>
  );
}

function RevokeLine({ plan, nameOf }: PlanText) {
  return (
    <>
      移出的盘：{plan.revoked.map(nameOf).join('、')}。该用户在这些盘上的数据卷会立即从所有容器卸载，
      {GRANT_EXPIRY_GRACE_DAYS} 天后删除（期间重新授权可保留）。
    </>
  );
}
