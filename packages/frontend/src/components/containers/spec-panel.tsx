import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type {
  ContainerDto,
  EffectiveAccessDto,
  IntentAcceptedDto,
  ListScope,
  PatchContainerLimitsRequest,
  PatchContainerRootSizeRequest,
  UserServerDto,
} from '@nyabase/common';
import { Button } from '../ui/button.js';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog.js';
import { Input } from '../ui/input.js';
import { FormField } from '../layout/form-field.js';
import { approxGibHint, formatGibInput, gibToBytes } from '../../lib/utils.js';
import { cpuCoresLabel, cpuSetLabel } from '../../lib/cpu-set.js';
import {
  classifySizeChange,
  observedRootUsedBytes,
  shrinkNeverTooltip,
  validateShrinkFloor,
} from '../../lib/storage-shrink.js';
import { ContainerSpecGpu } from '../gpu/gpu-sections.js';
import { toast } from '../../hooks/use-toast.js';
import { useActionMutation } from '../../hooks/use-action-mutation.js';
import { api } from '../../lib/api.js';
import { useInvalidateContainer } from '../../lib/container-queries.js';
import { queryKeys } from '../../lib/query-keys.js';
import { scopedPath } from '../../lib/scoped-paths.js';

export function LimitsDialog({
  container,
  scope,
  onOpenChange,
}: {
  container: ContainerDto;
  scope: ListScope;
  onOpenChange: (open: boolean) => void;
}) {
  const admin = scope === 'all';
  const base = `/containers/${container.id}`;
  const invalidate = useInvalidateContainer(scope, container.id);
  const serverQuery = useQuery({
    queryKey: queryKeys.servers.detail(container.serverId),
    queryFn: () => api.get<UserServerDto>(scopedPath(`/servers/${container.serverId}`, scope)),
    enabled: Boolean(container.serverId),
  });
  const accessQuery = useQuery({
    queryKey: queryKeys.meAccess,
    queryFn: () => api.get<EffectiveAccessDto>('/me/access'),
    enabled: !admin && Boolean(container.serverId),
  });
  const serverAccess = admin ? undefined : accessQuery.data?.servers.find((row) => row.serverId === container.serverId);
  const gpuPciAddresses = serverAccess?.gpuPciAddresses ?? null;
  const updateLimits = useActionMutation({
    mutationFn: (body: PatchContainerLimitsRequest) => api.patch<IntentAcceptedDto>(`${base}/limits`, body),
    successTitle: '已提交规格更新，正在生效',
    errorTitle: '规格更新失败',
    onSuccess: invalidate,
  });
  const updateGpus = useActionMutation({
    mutationFn: (pciAddresses: string[]) => api.patch<IntentAcceptedDto>(`${base}/gpus`, { pciAddresses }),
    successTitle: '已提交 GPU 更新，正在生效',
    errorTitle: 'GPU 更新失败',
    onSuccess: invalidate,
  });
  const [memGib, setMemGib] = useState(formatGibInput(container.memBytes));
  const [gpuSelection, setGpuSelection] = useState<string[]>(container.gpu?.pciAddresses ?? []);
  const memBytes = Number.isFinite(Number(memGib)) ? gibToBytes(Number(memGib)) : NaN;

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent data-testid="container-spec">
        <DialogHeader>
          <DialogTitle>编辑规格</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="rounded-md border bg-muted/20 p-3 text-sm" data-testid="container-spec-cpu">
            <p>
              CPU：<span className="font-mono">{cpuSetLabel(container.cpuSet)}</span>
              {serverAccess ? <span className="text-muted-foreground">（授权 {cpuCoresLabel(serverAccess.cpuCores)}）</span> : null}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              CPU 不能按容器调整：同一服务器上同一用户的所有容器共享一组按整核绑定的 CPU，核数由管理员在授权中设置。
            </p>
          </div>
          <UnitField
            id="limit-memory"
            label="内存 (GiB)"
            value={memGib}
            onChange={setMemGib}
            hint={Number.isFinite(memBytes)
              ? `${approxGibHint(memBytes)}；内存额度按你在这台服务器上所有容器的合计计算`
              : undefined}
          />
          <Button
            onClick={() => {
              if (!Number.isFinite(memBytes) || memBytes <= 0) {
                toast({ title: '请输入大于 0 的内存', variant: 'destructive' });
                return;
              }
              updateLimits.mutate({ memBytes });
            }}
            disabled={updateLimits.isPending}
          >
            {updateLimits.isPending ? '提交中...' : '应用内存'}
          </Button>
        </div>
        <ContainerSpecGpu
          serverId={container.serverId}
          gpuEnabled={serverQuery.data?.gpuEnabled ?? false}
          scope={scope}
          observedStatus={container.actual.status}
          grant={gpuPciAddresses ? { pciAddresses: gpuPciAddresses } : null}
          value={gpuSelection}
          onChange={setGpuSelection}
          onSubmit={(pciAddresses) => updateGpus.mutate(pciAddresses)}
          pending={updateGpus.isPending}
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
  scope,
  onRequiresStop,
  onOpenChange,
}: {
  container: ContainerDto;
  scope: ListScope;
  onRequiresStop: (sizeBytes: number) => void;
  onOpenChange: (open: boolean) => void;
}) {
  const rootCapability = container.rootCapability;
  const invalidate = useInvalidateContainer(scope, container.id);
  const resizeRoot = useActionMutation({
    mutationFn: (body: PatchContainerRootSizeRequest) =>
      api.patch<IntentAcceptedDto>(`/containers/${container.id}/root-size`, body),
    successTitle: '已提交系统盘调整，正在生效',
    errorTitle: '系统盘调整失败',
    onSuccess: invalidate,
  });
  const pending = resizeRoot.isPending;
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
              resizeRoot.mutate({ sizeBytes: rootSizeBytes }, { onSuccess: () => onOpenChange(false) });
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
