import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { RootPlacement, type ServerDto, type StoragePoolDto } from '@nyabase/common';
import { toast } from '../../hooks/use-toast.js';
import { api } from '../../lib/api.js';
import { errorMessage } from '../../lib/api-error.js';
import { poolDisplayName } from '../../lib/data-disks.js';
import { parsePercentInput, poolUsedPercent, systemDiskUnsupportedReason } from '../../lib/system-disks.js';
import { FormField } from '../layout/form-field.js';
import { Alert, AlertDescription } from '../ui/alert.js';
import { Button } from '../ui/button.js';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog.js';
import { Input } from '../ui/input.js';
import { Switch } from '../ui/switch.js';

/**
 * The system disk role of one pool and its parameters: the weight random
 * placement draws by and the high-water mark on observed usage. Under single
 * placement, turning it on moves the role here from the server's other pool.
 */
export function SystemDiskDialog({
  pool,
  server,
  onSaved,
  onClose,
}: {
  pool: StoragePoolDto;
  server: ServerDto;
  onSaved: () => void;
  onClose: () => void;
}) {
  const [enabled, setEnabled] = useState(pool.systemDisk !== null);
  const [weightText, setWeightText] = useState(String(pool.systemDisk?.weight ?? 1));
  const [markText, setMarkText] = useState(pool.systemDisk?.maxUsedPercent?.toString() ?? '');
  const weight = parsePercentInput(weightText, false);
  const mark = parsePercentInput(markText, true);
  const unsupported = systemDiskUnsupportedReason(pool);
  const single = server.rootPlacement === RootPlacement.Single;
  const replaced = single && enabled && pool.systemDisk === null
    ? server.systemPools.filter((other) => other.id !== pool.id)
    : [];
  const usedPercent = poolUsedPercent(pool);
  const invalid = enabled && (weight === undefined || mark === undefined);
  const unchanged = enabled
    ? pool.systemDisk !== null && pool.systemDisk.weight === weight && pool.systemDisk.maxUsedPercent === mark
    : pool.systemDisk === null;

  const save = useMutation({
    mutationFn: () => api.patch<StoragePoolDto>(`/servers/${pool.serverId}/storage-pools/${pool.id}`, {
      expectedRevision: pool.revision,
      systemDisk: enabled ? { weight: weight as number, maxUsedPercent: mark as number | null } : null,
    }),
    onSuccess: () => {
      toast({ title: '系统盘设置已保存' });
      onSaved();
      onClose();
    },
    onError: (error) => toast({ title: '系统盘设置失败', description: errorMessage(error), variant: 'destructive' }),
  });

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !save.isPending) onClose(); }}>
      <DialogContent data-testid="system-disk-dialog">
        <DialogHeader>
          <DialogTitle>系统盘设置：{poolDisplayName(pool)}</DialogTitle>
          <DialogDescription>
            开启后，新容器的系统盘可以放在这个池上。关闭只影响之后新建的容器：已有的系统盘照常运行，也能扩容。
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <FormField id="system-disk-enabled" label="作为系统盘" orientation="inline">
            <Switch
              id="system-disk-enabled"
              checked={enabled}
              onCheckedChange={setEnabled}
              disabled={unsupported !== null && pool.systemDisk === null}
            />
          </FormField>
          {unsupported !== null && pool.systemDisk === null ? (
            <Alert variant="warning"><AlertDescription>{unsupported}</AlertDescription></Alert>
          ) : null}
          {enabled ? (
            <>
              <FormField
                id="system-disk-weight"
                label="权重"
                hint={single
                  ? '「随机」分配时的相对概率（1–100）。当前服务器是「单一」分配，权重不起作用。'
                  : '「随机」分配时的相对概率（1–100），例如两个池权重 1 和 3，新容器约四分之三落在后者。'}
                error={weight === undefined ? '请输入 1–100 的整数' : null}
              >
                <Input id="system-disk-weight" inputMode="numeric" value={weightText} onChange={(event) => setWeightText(event.target.value)} />
              </FormField>
              <FormField
                id="system-disk-mark"
                label="水位（%）"
                hint={`池的实际用量达到这个百分比后，不再往这里放新容器的系统盘（已有容器不受影响）。留空为不限。${
                  usedPercent === null ? '' : `当前已用 ${usedPercent}%。`}`}
                error={mark === undefined ? '请输入 1–100 的整数，或留空' : null}
              >
                <Input id="system-disk-mark" inputMode="numeric" value={markText} placeholder="不限" onChange={(event) => setMarkText(event.target.value)} />
              </FormField>
            </>
          ) : null}
          {replaced.length > 0 ? (
            <Alert variant="warning" data-testid="system-disk-replaces">
              <AlertDescription>
                这台服务器是「单一」分配：保存后系统盘池从 {replaced.map((other) => other.name).join('、')} 换到这个池，新容器都放在这里。
              </AlertDescription>
            </Alert>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={save.isPending}>取消</Button>
          <Button
            onClick={() => save.mutate()}
            disabled={save.isPending || invalid || unchanged}
            data-testid="system-disk-save"
          >
            {save.isPending ? '保存中...' : '保存'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
