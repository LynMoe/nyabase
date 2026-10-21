import type { StoragePoolDto } from '@nyabase/common';
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
import { Label } from '../../ui/label.js';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../ui/select.js';
import { FormField } from '../../layout/form-field.js';

function poolLabel(pool: StoragePoolDto): string {
  return pool.displayName ?? pool.incusName;
}

export function StorageSettingsDialog({
  pools,
  systemPoolId,
  currentSystemPool,
  overcommitRatio,
  storageOvercommitRatio,
  updatePending,
  onSystemPoolIdChange,
  onOvercommitRatioChange,
  onSave,
  onClose,
}: {
  pools: StoragePoolDto[];
  systemPoolId: string;
  currentSystemPool: string;
  overcommitRatio: string;
  storageOvercommitRatio: number;
  updatePending: boolean;
  onSystemPoolIdChange: (value: string) => void;
  onOvercommitRatioChange: (value: string) => void;
  onSave: () => void;
  onClose: () => void;
}) {
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
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
          <p className="text-xs text-muted-foreground">
            容器和数据卷可分配的总容量 = 物理容量 × 比例。1 表示不超分；大于 1 时分配总量可以超过磁盘实际大小。
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onClose()}>取消</Button>
          <Button
            onClick={onSave}
            disabled={updatePending}
          >
            {updatePending ? '保存中...' : '保存'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
