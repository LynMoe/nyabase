import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Pencil, RefreshCw, Server } from 'lucide-react';
import type { StoragePoolDto } from '@nyabase/common';
import { api } from '../../lib/api.js';
import { errorMessage } from '../../lib/api-error.js';
import { QueryErrorState } from '../query-state.js';
import { Badge } from '../ui/badge.js';
import { Button } from '../ui/button.js';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card.js';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog.js';
import { Input } from '../ui/input.js';
import { Label } from '../ui/label.js';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select.js';
import { FormField } from '../layout/form-field.js';
import { toast } from '../../hooks/use-toast.js';
import { usedTotalLabel } from '../../lib/utils.js';

function poolLabel(pool: StoragePoolDto): string {
  return pool.displayName ?? pool.incusName;
}

export function PoolsCard({
  pools,
  poolsError,
  onRetryPools,
  canManageStoragePools,
  selectedPool,
  systemPoolId,
  currentSystemPool,
  overcommitRatio,
  storageOvercommitRatio,
  discoverPending,
  updatePending,
  onSystemPoolIdChange,
  onOvercommitRatioChange,
  onDiscover,
  onSaveStorage,
  onUpdated,
}: {
  pools: StoragePoolDto[];
  poolsError: unknown | null;
  onRetryPools: () => void;
  canManageStoragePools: boolean;
  selectedPool: StoragePoolDto | undefined;
  systemPoolId: string;
  currentSystemPool: string;
  overcommitRatio: string;
  storageOvercommitRatio: number;
  discoverPending: boolean;
  updatePending: boolean;
  onSystemPoolIdChange: (value: string) => void;
  onOvercommitRatioChange: (value: string) => void;
  onDiscover: () => void;
  onSaveStorage: () => void;
  onUpdated: () => void;
}) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const selectedSystemPool = pools.find((pool) => pool.id === (systemPoolId || currentSystemPool));
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
            <Button variant="outline" size="sm" onClick={onDiscover} disabled={discoverPending}>
              <RefreshCw className={discoverPending ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />发现存储池
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <p className="text-xs text-muted-foreground">系统盘池</p>
            <p className="text-sm">{selectedSystemPool ? poolLabel(selectedSystemPool) : '未指定'}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">存储超分比例</p>
            <p className="text-sm">{overcommitRatio || String(storageOvercommitRatio)}</p>
          </div>
        </div>
        {settingsOpen ? (
          <Dialog open onOpenChange={(open) => { if (!open) setSettingsOpen(false); }}>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>编辑存储设置</DialogTitle>
                <DialogDescription data-testid="system-pool-new-containers-hint">
                  更改系统盘池只影响之后新建的容器，不会改动已有容器。
                </DialogDescription>
              </DialogHeader>
              <FormField id="server-system-pool" label="系统盘池">
                <Select
                  value={(systemPoolId || currentSystemPool) || undefined}
                  onValueChange={onSystemPoolIdChange}
                >
                  <SelectTrigger id="server-system-pool">
                    <SelectValue placeholder="未指定" />
                  </SelectTrigger>
                  <SelectContent>
                    {pools.filter((pool) => pool.registered && pool.rootDiskCapable).map((pool) => (
                      <SelectItem key={pool.id} value={pool.id}>{poolLabel(pool)}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FormField>
              <div className="space-y-1.5">
                <Label htmlFor="server-overcommit">存储超分比例</Label>
                <Input
                  id="server-overcommit"
                  type="number"
                  min="1"
                  step="0.1"
                  value={overcommitRatio || String(storageOvercommitRatio)}
                  onChange={(event) => onOvercommitRatioChange(event.target.value)}
                />
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setSettingsOpen(false)}>取消</Button>
                <Button
                  onClick={() => {
                    onSaveStorage();
                    setSettingsOpen(false);
                  }}
                  disabled={updatePending}
                >
                  {updatePending ? '保存中...' : '保存'}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        ) : null}
        {poolsError ? (
          <QueryErrorState error={poolsError} resourceName="存储池" onRetry={onRetryPools} />
        ) : pools.length === 0 ? (
          <p className="text-sm text-muted-foreground">尚未发现本地存储池。</p>
        ) : (
          <div className="rounded-md border overflow-x-auto">
            <table className="w-full min-w-[760px] text-sm">
              <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
                <tr><th className="px-3 py-2">池</th><th className="px-3 py-2">容量</th><th className="px-3 py-2">能力</th><th className="px-3 py-2">登记</th><th className="px-3 py-2">操作</th></tr>
              </thead>
              <tbody>
                {pools.map((pool) => (
                  <StoragePoolRow
                    key={pool.id}
                    pool={pool}
                    canManageStoragePools={canManageStoragePools}
                    onUpdated={onUpdated}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
        {selectedPool && <p className="text-xs text-muted-foreground">探针池：{selectedPool.displayName ?? selectedPool.incusName}</p>}
        {!canManageStoragePools && (
          <p className="text-xs text-muted-foreground" data-testid="storage-pool-register-gated">
            可以查看存储池，但登记与取消登记需要「管理存储池」权限。
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function StoragePoolRow({
  pool,
  canManageStoragePools,
  onUpdated,
}: {
  pool: StoragePoolDto;
  canManageStoragePools: boolean;
  onUpdated: () => void;
}) {
  const [confirmUnregister, setConfirmUnregister] = useState(false);
  const patch = useMutation({
    mutationFn: (registered: boolean) => api.patch<StoragePoolDto>(`/admin/storage-pools/${pool.id}`, {
      expectedRevision: pool.revision,
      registered,
      displayName: pool.displayName,
    }),
    onSuccess: () => {
      setConfirmUnregister(false);
      onUpdated();
    },
    onError: (error) => toast({ title: '存储池更新失败', description: errorMessage(error), variant: 'destructive' }),
  });
  const capability = pool.capability;
  return (
    <tr className="border-t">
      <td className="px-3 py-2"><div className="font-medium">{pool.displayName ?? pool.incusName}</div><div className="font-mono text-xs text-muted-foreground">{pool.driver} · {pool.resizeFamily}</div></td>
      <td className="px-3 py-2">{usedTotalLabel(pool.usedBytes, pool.totalBytes)}<div className="text-xs text-muted-foreground">{pool.quotaEffective === null ? '配额未知' : pool.quotaEffective ? '配额生效' : '配额未生效'}</div></td>
      <td className="px-3 py-2"><div className="flex flex-wrap gap-1"><Badge variant={capability.growOnline ? 'success' : 'secondary'}>在线扩容</Badge><Badge variant={capability.shrinkOnline ? 'success' : capability.shrinkNever ? 'destructive' : 'warning'}>{capability.shrinkOnline ? '在线缩容' : capability.shrinkNever ? '不可缩容' : '需停机/卸载'}</Badge>{pool.rootDiskCapable && <Badge variant="outline">系统盘</Badge>}</div></td>
      <td className="px-3 py-2">{pool.registered ? '已登记' : '未登记'}</td>
      <td className="px-3 py-2">
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
                取消后，「{pool.displayName ?? pool.incusName}」将从可建卷集合中移除；已有数据卷不受影响，但新建卷时将无法再选择该池。
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
      </td>
    </tr>
  );
}

function HardDriveIcon() {
  return <Server className="h-4 w-4" />;
}
