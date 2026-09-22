import { useState } from 'react';
import type {
  ContainerDto,
  OpaqueExtensionMap,
  PatchContainerLimitsRequest,
  StoragePoolCapabilityDto,
} from '@nyabase/common';
import { Button } from '../ui/button.js';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog.js';
import { Input } from '../ui/input.js';
import { FormField } from '../layout/form-field.js';
import { approxGibHint, formatGibInput, formatVcpuInput, gibToBytes, vcpuToMillis } from '../../lib/utils.js';
import {
  classifySizeChange,
  observedRootUsedBytes,
  shrinkNeverTooltip,
  validateShrinkFloor,
} from '../../lib/storage-shrink.js';
import { ExtensionSlots } from '../../extensions/slots.js';
import { toast } from '../../hooks/use-toast.js';

export function LimitsDialog({
  container,
  admin,
  enabledExtensions,
  grant,
  pending,
  extensionPending,
  onLimits,
  onExtensionSubmit,
  onOpenChange,
}: {
  container: ContainerDto;
  admin: boolean;
  enabledExtensions: string[];
  grant: OpaqueExtensionMap | null;
  pending: boolean;
  extensionPending: boolean;
  onLimits: (body: PatchContainerLimitsRequest) => Promise<unknown>;
  onExtensionSubmit: (extensionId: string, payload: unknown) => Promise<unknown>;
  onOpenChange: (open: boolean) => void;
}) {
  const [cpuVcpus, setCpuVcpus] = useState(formatVcpuInput(container.cpuMillis));
  const [memGib, setMemGib] = useState(formatGibInput(container.memBytes));
  const [extensions, setExtensions] = useState<OpaqueExtensionMap>(container.extensions ?? {});
  const cpuMillis = Number.isFinite(Number(cpuVcpus)) ? vcpuToMillis(Number(cpuVcpus)) : NaN;
  const memBytes = Number.isFinite(Number(memGib)) ? gibToBytes(Number(memGib)) : NaN;

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent data-testid="container-spec">
        <DialogHeader>
          <DialogTitle>编辑规格</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <UnitField id="limit-cpu" label="CPU (核)" value={cpuVcpus} onChange={setCpuVcpus} step="0.1" />
            <UnitField
              id="limit-memory"
              label="内存 (GiB)"
              value={memGib}
              onChange={setMemGib}
              hint={Number.isFinite(memBytes) ? approxGibHint(memBytes) : undefined}
            />
          </div>
          <Button
            onClick={() => {
              if (!Number.isFinite(cpuMillis) || !Number.isFinite(memBytes)) {
                toast({ title: '请输入有效的 CPU / 内存', variant: 'destructive' });
                return;
              }
              void onLimits({ cpuMillis, memBytes });
            }}
            disabled={pending}
          >
            {pending ? '提交中...' : '应用 CPU / 内存'}
          </Button>
        </div>
        <ExtensionSlots
          area="container.spec"
          ctx={{
            containerId: container.id,
            serverId: container.serverId,
            enabledExtensions,
            admin,
            observedStatus: container.actual.status,
            grant,
            value: extensions,
            onChange: setExtensions,
            onSubmit: (extensionId, payload) => { void onExtensionSubmit(extensionId, payload); },
            pending: extensionPending,
          }}
        />
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>关闭</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function RootSizeDialog({
  container,
  rootCapability,
  pending,
  onApply,
  onRequiresStop,
  onOpenChange,
}: {
  container: ContainerDto;
  rootCapability: StoragePoolCapabilityDto;
  pending: boolean;
  onApply: (sizeBytes: number) => Promise<unknown>;
  onRequiresStop: (sizeBytes: number) => void;
  onOpenChange: (open: boolean) => void;
}) {
  const [rootSizeGib, setRootSizeGib] = useState(formatGibInput(container.rootSizeBytes));
  const rootSizeBytes = Number.isFinite(Number(rootSizeGib)) ? gibToBytes(Number(rootSizeGib)) : NaN;
  const path = Number.isFinite(rootSizeBytes)
    ? classifySizeChange(rootCapability, container.rootSizeBytes, rootSizeBytes)
    : 'unchanged';
  const shrinkBlocked = path === 'never';

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent data-testid="container-root-size">
        <DialogHeader>
          <DialogTitle>调整系统盘容量</DialogTitle>
          {path === 'never' ? <DialogDescription>{shrinkNeverTooltip()}</DialogDescription> : null}
        </DialogHeader>
        <UnitField
          id="root-size"
          label="目标容量 (GiB)"
          value={rootSizeGib}
          onChange={setRootSizeGib}
          hint={Number.isFinite(rootSizeBytes) ? approxGibHint(rootSizeBytes) : undefined}
        />
        {shrinkBlocked && <p className="text-xs text-muted-foreground">{shrinkNeverTooltip()}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
          <Button
            onClick={() => {
              if (!Number.isFinite(rootSizeBytes)) {
                toast({ title: '请输入有效的系统盘容量', variant: 'destructive' });
                return;
              }
              if (path === 'never') {
                toast({ title: '无法缩容', description: shrinkNeverTooltip(), variant: 'destructive' });
                return;
              }
              const floor = validateShrinkFloor(rootCapability, rootSizeBytes, observedRootUsedBytes(container));
              if (floor) {
                toast({ title: '容量不合法', description: floor, variant: 'destructive' });
                return;
              }
              if (path === 'requires_stop') {
                onRequiresStop(rootSizeBytes);
                onOpenChange(false);
                return;
              }
              void onApply(rootSizeBytes).then(
                () => onOpenChange(false),
                () => undefined,
              );
            }}
            disabled={pending || shrinkBlocked}
            title={shrinkBlocked ? shrinkNeverTooltip() : undefined}
          >
            {pending ? '提交中...' : path === 'requires_stop' ? '继续缩容编排' : '应用系统盘容量'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function UnitField({
  id,
  label,
  value,
  onChange,
  hint,
  step = '1',
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  hint?: string;
  step?: string;
}) {
  return (
    <FormField id={id} label={label} hint={hint}>
      <Input id={id} type="number" min="0" step={step} value={value} onChange={(event) => onChange(event.target.value)} />
    </FormField>
  );
}
