import { useState } from 'react';
import { Pencil, RefreshCw, Server } from 'lucide-react';
import {
  Role,
  RootPlacement,
  formatBytes,
  type ServerDto,
  type StoragePoolDiscoverResult,
  type StoragePoolDto,
} from '@nyabase/common';
import { useMutation } from '@tanstack/react-query';
import { QueryErrorState } from '../query-state.js';
import { Button } from '../ui/button.js';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card.js';
import { storageOvercommitLabel } from '../../lib/display-labels.js';
import { api } from '../../lib/api.js';
import { errorMessage } from '../../lib/api-error.js';
import { TechnicalId } from '../refs/technical-id.js';
import { storagePoolSourceKind } from '../../lib/storage-shrink.js';
import { mountUnsupportedReason, poolDisplayName as poolLabel } from '../../lib/data-disks.js';
import { DiskMountDialog } from '../storage/disk-mount-dialog.js';
import { SystemDiskDialog } from './system-disk-dialog.js';
import { aboveSystemWatermark, rootPlacementLabel } from '../../lib/system-disks.js';
import { Checkbox } from '../ui/checkbox.js';
import { Badge } from '../ui/badge.js';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog.js';
import { Input } from '../ui/input.js';
import { FormField } from '../layout/form-field.js';
import { toast } from '../../hooks/use-toast.js';
import { useInvalidateServer, useServerPools, useUpdateServer } from '../../lib/server-queries.js';
import { useHasRole } from '../../lib/use-role.js';
import { usedTotalLabel } from '../../lib/utils.js';
import { Label } from '../ui/label.js';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select.js';

export function PoolsCard({ server }: { server: ServerDto }) {
  const canManageStoragePools = useHasRole(Role.Admin);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const poolsQuery = useServerPools(server.id);
  const pools = poolsQuery.data ?? [];
  const poolsError = poolsQuery.isError ? poolsQuery.error : null;
  const invalidate = useInvalidateServer(server.id);
  const discover = useMutation({
    mutationFn: () => api.post<StoragePoolDiscoverResult>(`/servers/${server.id}/storage-pools/discover`),
    onSuccess: (result) => {
      toast({ title: '存储池已刷新', description: `发现 ${result.pools.length} 个本地池。` });
      invalidate();
    },
    onError: (error) => toast({ title: '发现存储池失败', description: errorMessage(error), variant: 'destructive' }),
  });
  const discoverPending = discover.isPending;
  return (
    <Card data-testid="storage-pool-capabilities">
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2 text-base"><HardDriveIcon />存储池能力</CardTitle>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="outline" onClick={() => setSettingsOpen(true)}>
              <Pencil className="h-3.5 w-3.5" />编辑存储设置
            </Button>
            <Button variant="outline" size="sm" onClick={() => discover.mutate()} disabled={discoverPending}>
              <RefreshCw className={discoverPending ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />发现存储池
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <div data-testid="root-placement-summary">
            <p className="text-xs text-muted-foreground">系统盘分配</p>
            <p className="text-sm">{rootPlacementLabel(server)}</p>
            <p className="text-xs text-muted-foreground">
              系统盘池：{server.systemPools.length > 0 ? server.systemPools.map((pool) => pool.name).join('、') : '未指定'}
            </p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">存储超分比例</p>
            <p className="text-sm">{storageOvercommitLabel(server.storageOvercommitRatio)}</p>
          </div>
        </div>
        {settingsOpen ? (
          <StorageSettingsDialog server={server} onClose={() => setSettingsOpen(false)} />
        ) : null}
        {poolsError ? (
          <QueryErrorState error={poolsError} resourceName="存储池" onRetry={() => { void poolsQuery.refetch(); }} />
        ) : pools.length === 0 ? (
          <p className="text-sm text-muted-foreground">尚未发现本地存储池。</p>
        ) : (
          <div className="rounded-md border overflow-x-auto">
            <table className="w-full min-w-[980px] text-sm">
              <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
                <tr><th className="px-3 py-2">池</th><th className="px-3 py-2">位置</th><th className="px-3 py-2">容量</th><th className="px-3 py-2">能力</th><th className="px-3 py-2">系统盘</th><th className="px-3 py-2">数据盘</th><th className="px-3 py-2">登记</th><th className="px-3 py-2">操作</th></tr>
              </thead>
              <tbody>
                {pools.map((pool) => (
                  <StoragePoolRow
                    key={pool.id}
                    pool={pool}
                    server={server}
                    canManageStoragePools={canManageStoragePools}
                    onUpdated={invalidate}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
        {!canManageStoragePools && (
          <p className="text-xs text-muted-foreground" data-testid="storage-pool-register-gated">
            登记与编辑需要「管理存储池」权限
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function HardDriveIcon() {
  return <Server className="h-4 w-4" />;
}

export function StoragePoolRow({
  pool,
  server,
  canManageStoragePools,
  onUpdated,
}: {
  pool: StoragePoolDto;
  server: ServerDto;
  canManageStoragePools: boolean;
  onUpdated: () => void;
}) {
  const [confirmUnregister, setConfirmUnregister] = useState(false);
  const [remarkOpen, setRemarkOpen] = useState(false);
  const [mountOpen, setMountOpen] = useState(false);
  const [systemOpen, setSystemOpen] = useState(false);
  const patch = useMutation({
    mutationFn: (registered: boolean) => api.patch<StoragePoolDto>(`/servers/${pool.serverId}/storage-pools/${pool.id}`, {
      expectedRevision: pool.revision,
      registered,
    }),
    onSuccess: () => {
      setConfirmUnregister(false);
      onUpdated();
    },
    onError: (error) => toast({ title: '存储池更新失败', description: errorMessage(error), variant: 'destructive' }),
  });
  const capability = pool.capability;
  const sourceKind = storagePoolSourceKind(pool.driver);
  return (
    <tr className="border-t">
      <td className="px-3 py-2">
        <div className="flex items-center gap-1">
          <div className="font-medium">{pool.displayName ?? pool.incusName}</div>
          {canManageStoragePools ? (
            <Button
              size="sm"
              variant="ghost"
              aria-label="编辑备注"
              data-testid="storage-pool-edit-remark"
              onClick={() => setRemarkOpen(true)}
            >
              <Pencil className="h-3.5 w-3.5" />
            </Button>
          ) : null}
        </div>
        <div className="font-mono text-xs text-muted-foreground">{pool.driver} · {pool.resizeFamily}</div>
      </td>
      <td className="px-3 py-2">
        {pool.source ? (
          <div className="flex items-baseline gap-2">
            <span className="text-xs text-muted-foreground">{sourceKind}</span>
            <TechnicalId label={sourceKind} value={pool.source} kind="text" />
          </div>
        ) : '—'}
      </td>
      <td className="px-3 py-2">{usedTotalLabel(pool.usedBytes, pool.totalBytes)}<div className="text-xs text-muted-foreground">{pool.quotaEffective === null ? '配额未知' : pool.quotaEffective ? '配额生效' : '配额未生效'}</div></td>
      <td className="px-3 py-2"><div className="flex flex-wrap gap-1"><Badge variant={capability.growOnline ? 'success' : 'secondary'}>在线扩容</Badge><Badge variant={capability.shrinkOnline ? 'success' : capability.shrinkNever ? 'destructive' : 'warning'}>{capability.shrinkOnline ? '在线缩容' : capability.shrinkNever ? '不可缩容' : '需停机/卸载'}</Badge>{pool.rootDiskCapable && <Badge variant="outline">可作系统盘</Badge>}</div></td>
      <td className="px-3 py-2" data-testid="storage-pool-system">
        <SystemDiskCell pool={pool} server={server} />
      </td>
      <td className="px-3 py-2" data-testid="storage-pool-mount">
        {pool.mountPath ? <span className="font-mono text-xs">{pool.mountPath}</span> : <span className="text-muted-foreground">未启用</span>}
        {pool.maintenance ? <Badge variant="warning" className="ml-2">维护中</Badge> : null}
      </td>
      <td className="px-3 py-2">{pool.registered ? '已登记' : '未登记'}</td>
      <td className="space-x-2 whitespace-nowrap px-3 py-2">
        {canManageStoragePools && !pool.shareable ? (
          <Button size="sm" variant="outline" onClick={() => setSystemOpen(true)} data-testid="storage-pool-system-edit">
            系统盘
          </Button>
        ) : null}
        {canManageStoragePools && !pool.shareable ? (
          <Button size="sm" variant="outline" onClick={() => setMountOpen(true)} data-testid="storage-pool-mount-edit">
            数据盘
          </Button>
        ) : null}
        <Button
          size="sm"
          variant={pool.registered ? 'outline' : 'default'}
          onClick={() => { if (pool.registered) setConfirmUnregister(true); else patch.mutate(true); }}
          disabled={patch.isPending || !canManageStoragePools}
        >
          {patch.isPending ? '保存中...' : pool.registered ? '取消登记' : '登记'}
        </Button>
        <Dialog open={confirmUnregister} onOpenChange={(open) => { if (!open) setConfirmUnregister(false); }}>
          <DialogContent data-testid="storage-pool-unregister-confirm">
            <DialogHeader>
              <DialogTitle>取消登记存储池？</DialogTitle>
              <DialogDescription>
                {pool.systemDisk
                  ? '这个池仍是系统盘池：请先在「系统盘」里关闭，才能取消登记。'
                  : pool.mountPath
                    ? '取消登记会同时停用这块数据盘：平台不再为用户建卷或新增挂载，已有的数据卷保留。'
                    : '已有数据卷不受影响。'}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => setConfirmUnregister(false)} disabled={patch.isPending}>取消</Button>
              <Button variant="destructive" onClick={() => patch.mutate(false)} disabled={patch.isPending}>
                {patch.isPending ? '处理中...' : '确认取消登记'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
        {systemOpen ? (
          <SystemDiskDialog pool={pool} server={server} onSaved={onUpdated} onClose={() => setSystemOpen(false)} />
        ) : null}
        {mountOpen ? (
          <DiskMountDialog
            title={`数据盘设置：${poolLabel(pool)}`}
            reach="在这台服务器上"
            current={pool}
            unsupportedReason={mountUnsupportedReason(pool)}
            previewPath={`/servers/${pool.serverId}/storage-pools/${pool.id}/mount-preview`}
            save={(change) => api.patch<StoragePoolDto>(`/servers/${pool.serverId}/storage-pools/${pool.id}`, {
              expectedRevision: pool.revision,
              ...change,
            })}
            onSaved={onUpdated}
            onClose={() => setMountOpen(false)}
          />
        ) : null}
        {remarkOpen ? <PoolRemarkDialog pool={pool} onSaved={onUpdated} onClose={() => setRemarkOpen(false)} /> : null}
      </td>
    </tr>
  );
}

/** The pool's remark (display name); empty falls back to the Incus name. */
function PoolRemarkDialog({ pool, onSaved, onClose }: { pool: StoragePoolDto; onSaved: () => void; onClose: () => void }) {
  const [remark, setRemark] = useState(pool.displayName ?? '');
  const saveRemark = useMutation({
    mutationFn: () => api.patch<StoragePoolDto>(`/servers/${pool.serverId}/storage-pools/${pool.id}`, {
      expectedRevision: pool.revision,
      displayName: remark.trim() || null,
    }),
    onSuccess: () => {
      onClose();
      onSaved();
    },
    onError: (error) => toast({ title: '存储池更新失败', description: errorMessage(error), variant: 'destructive' }),
  });
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>编辑备注</DialogTitle>
        </DialogHeader>
        <FormField id={`storage-pool-remark-${pool.id}`} label="备注">
          <Input
            id={`storage-pool-remark-${pool.id}`}
            value={remark}
            placeholder={pool.incusName}
            onChange={(event) => setRemark(event.target.value)}
          />
        </FormField>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saveRemark.isPending}>取消</Button>
          <Button onClick={() => saveRemark.mutate()} disabled={saveRemark.isPending}>
            {saveRemark.isPending ? '保存中...' : '保存'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The pool's system disk role at a glance: weight (random placement), mark, and the root disks on it. */
function SystemDiskCell({ pool, server }: { pool: StoragePoolDto; server: ServerDto }) {
  const rootDisks = pool.rootDisks && pool.rootDisks.count > 0 ? (
    <div className="text-xs text-muted-foreground">
      {pool.rootDisks.count} 个系统盘 · 承诺 {formatBytes(pool.rootDisks.committedBytes)}
    </div>
  ) : null;
  if (!pool.systemDisk) {
    return <><span className="text-muted-foreground">未启用</span>{rootDisks}</>;
  }
  return (
    <>
      <div className="flex flex-wrap items-center gap-1">
        <Badge variant="success">系统盘</Badge>
        {server.rootPlacement === RootPlacement.Random ? <Badge variant="outline">权重 {pool.systemDisk.weight}</Badge> : null}
        {pool.systemDisk.maxUsedPercent !== null ? <Badge variant="outline">水位 {pool.systemDisk.maxUsedPercent}%</Badge> : null}
        {aboveSystemWatermark(pool) ? <Badge variant="warning">已达水位</Badge> : null}
      </div>
      {rootDisks}
    </>
  );
}

function StorageSettingsDialog({
  server,
  onClose,
}: {
  server: ServerDto;
  onClose: () => void;
}) {
  const [placement, setPlacement] = useState<RootPlacement>(server.rootPlacement);
  const [sticky, setSticky] = useState(server.rootPlacementSticky);
  const [overcommitRatio, setOvercommitRatio] = useState('');
  const update = useUpdateServer(server.id);
  const random = placement === RootPlacement.Random;
  const save = () => {
    update.mutate({
      expectedRevision: server.revision,
      rootPlacement: placement,
      rootPlacementSticky: random && sticky,
      storageOvercommitRatio: Number(overcommitRatio || server.storageOvercommitRatio),
    });
    onClose();
  };
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>编辑存储设置</DialogTitle>
        </DialogHeader>
        <FormField
          id="server-root-placement"
          label="系统盘分配"
          hint={random
            ? '新容器的系统盘按权重随机放到一个系统盘池（跳过配额未生效、已达水位或放不下的池）。'
            : '只有一个系统盘池，新容器都放在那里。服务器有多个系统盘池时，先在表格里关掉多余的再切回「单一」。'}
        >
          <Select value={placement} onValueChange={(value) => setPlacement(value as RootPlacement)}>
            <SelectTrigger id="server-root-placement">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={RootPlacement.Single}>单一</SelectItem>
              <SelectItem value={RootPlacement.Random}>随机</SelectItem>
            </SelectContent>
          </Select>
        </FormField>
        {random ? (
          <div className="flex items-start gap-2">
            <Checkbox
              id="server-root-placement-sticky"
              checked={sticky}
              onCheckedChange={(checked) => setSticky(checked === true)}
            />
            <div className="space-y-1">
              <Label htmlFor="server-root-placement-sticky">用户粘性</Label>
              <p className="text-xs text-muted-foreground">
                用户在这台服务器上已有容器时，新容器放到他系统盘最多的那个池；那个池放不下（或已关闭、已达水位）时仍随机挑选。
              </p>
            </div>
          </div>
        ) : null}
        <div className="space-y-1.5">
          <Label htmlFor="server-overcommit">存储超分比例</Label>
          <Input
            id="server-overcommit"
            type="number"
            min="1"
            step="0.1"
            value={overcommitRatio || String(server.storageOvercommitRatio)}
            onChange={(event) => setOvercommitRatio(event.target.value)}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>取消</Button>
          <Button
            onClick={save}
            disabled={update.isPending}
          >
            {update.isPending ? '保存中...' : '保存'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
