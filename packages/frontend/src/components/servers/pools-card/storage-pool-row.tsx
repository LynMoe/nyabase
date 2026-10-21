import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Pencil } from 'lucide-react';
import type { StoragePoolDto } from '@nyabase/common';
import { api } from '../../../lib/api.js';
import { errorMessage } from '../../../lib/api-error.js';
import { TechnicalId } from '../../refs/technical-id.js';
import { storagePoolSourceKind } from '../../../lib/storage-pool-product.js';
import { Badge } from '../../ui/badge.js';
import { Button } from '../../ui/button.js';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../ui/dialog.js';
import { Input } from '../../ui/input.js';
import { FormField } from '../../layout/form-field.js';
import { toast } from '../../../hooks/use-toast.js';
import { usedTotalLabel } from '../../../lib/utils.js';

export function StoragePoolRow({
  pool,
  canManageStoragePools,
  onUpdated,
}: {
  pool: StoragePoolDto;
  canManageStoragePools: boolean;
  onUpdated: () => void;
}) {
  const [confirmUnregister, setConfirmUnregister] = useState(false);
  const [remarkOpen, setRemarkOpen] = useState(false);
  const [remark, setRemark] = useState(pool.displayName ?? '');
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
  const saveRemark = useMutation({
    mutationFn: () => api.patch<StoragePoolDto>(`/servers/${pool.serverId}/storage-pools/${pool.id}`, {
      expectedRevision: pool.revision,
      displayName: remark.trim() || null,
    }),
    onSuccess: () => {
      setRemarkOpen(false);
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
              onClick={() => {
                setRemark(pool.displayName ?? '');
                setRemarkOpen(true);
              }}
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
        <Dialog open={remarkOpen} onOpenChange={(open) => { if (!open) setRemarkOpen(false); }}>
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
              <Button variant="outline" onClick={() => setRemarkOpen(false)} disabled={saveRemark.isPending}>取消</Button>
              <Button onClick={() => saveRemark.mutate()} disabled={saveRemark.isPending}>
                {saveRemark.isPending ? '保存中...' : '保存'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </td>
    </tr>
  );
}
