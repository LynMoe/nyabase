import type { ContainerDto, OpaqueExtensionMap, StoragePoolCapabilityDto } from '@nyabase/common';
import { Button } from '../ui/button.js';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card.js';
import { Input } from '../ui/input.js';
import { Label } from '../ui/label.js';
import { approxGibHint } from '../../lib/utils.js';
import { classifySizeChange, shrinkNeverTooltip } from '../../lib/storage-shrink.js';
import { ExtensionSlots } from '../../extensions/slots.js';

export function SpecPanel({
  container,
  admin,
  rootCapability,
  cpuVcpus,
  memGib,
  rootSizeGib,
  memBytes,
  rootSizeBytes,
  enabledExtensions,
  extensions,
  onCpuVcpus,
  onMemGib,
  onRootSizeGib,
  onExtensions,
  onExtensionSubmit,
  onLimits,
  onRoot,
  limitsPending,
  rootPending,
  extensionPending,
}: {
  container: ContainerDto;
  admin: boolean;
  rootCapability: StoragePoolCapabilityDto;
  cpuVcpus: string;
  memGib: string;
  rootSizeGib: string;
  memBytes: number;
  rootSizeBytes: number;
  enabledExtensions: string[];
  extensions: OpaqueExtensionMap;
  onCpuVcpus: (value: string) => void;
  onMemGib: (value: string) => void;
  onRootSizeGib: (value: string) => void;
  onExtensions: (value: OpaqueExtensionMap) => void;
  onExtensionSubmit: (extensionId: string, payload: unknown) => void;
  onLimits: () => void;
  onRoot: () => void;
  limitsPending: boolean;
  rootPending: boolean;
  extensionPending: boolean;
}) {
  const path = Number.isFinite(rootSizeBytes)
    ? classifySizeChange(rootCapability, container.rootSizeBytes, rootSizeBytes)
    : 'unchanged';
  const shrinkBlocked = path === 'never';
  const rootDescription = path === 'never'
    ? shrinkNeverTooltip()
    : path === 'requires_stop'
      ? '缩容需要先停止容器；将引导停止 → 缩容 → 可选启动。'
      : path === 'online'
        ? '在线缩容：直接提交，无停机提示。'
        : '扩容在线执行；缩容路径由池能力决定。';

  return (
    <div className="grid items-start gap-4 lg:grid-cols-2" data-testid="container-spec">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">CPU / 内存</CardTitle>
          <CardDescription>这两个字段支持在线变更，提交后会开始生效。</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <UnitInput
              id="limit-cpu"
              label="CPU (核)"
              value={cpuVcpus}
              onChange={onCpuVcpus}
              step="0.1"
            />
            <UnitInput
              id="limit-memory"
              label="内存 (GiB)"
              value={memGib}
              onChange={onMemGib}
              hint={Number.isFinite(memBytes) ? approxGibHint(memBytes) : undefined}
            />
          </div>
          <Button onClick={onLimits} disabled={limitsPending}>{limitsPending ? '提交中...' : '在线应用规格'}</Button>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">系统盘容量</CardTitle>
          <CardDescription>{rootDescription}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <UnitInput
            id="root-size"
            label="目标容量 (GiB)"
            value={rootSizeGib}
            onChange={onRootSizeGib}
            hint={Number.isFinite(rootSizeBytes) ? approxGibHint(rootSizeBytes) : undefined}
          />
          {shrinkBlocked && <p className="text-xs text-muted-foreground">{shrinkNeverTooltip()}</p>}
          <Button
            onClick={onRoot}
            disabled={rootPending || shrinkBlocked}
            title={shrinkBlocked ? shrinkNeverTooltip() : undefined}
          >
            {rootPending ? '提交中...' : path === 'requires_stop' ? '继续缩容编排' : '应用系统盘容量'}
          </Button>
        </CardContent>
      </Card>
      <ExtensionSlots
        area="container.spec"
        ctx={{
          containerId: container.id,
          serverId: container.serverId,
          enabledExtensions,
          admin,
          observedStatus: container.actual.status,
          value: extensions,
          onChange: onExtensions,
          onSubmit: onExtensionSubmit,
          pending: extensionPending,
        }}
      />
    </div>
  );
}

function UnitInput({
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
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} type="number" min="0" step={step} value={value} onChange={(event) => onChange(event.target.value)} />
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}
