import { useRef, useState } from 'react';
import {
  parseGrant,
  reduceNvidiaGpuGrant,
  type GpuPickerMode,
} from '../grant-state.js';
import { NVIDIA_GPU_EXTENSION_ID } from '../id.js';
import { GpuGrantMode } from '../schema.js';
import {
  formatGpuSelectionLabel,
  GpuPicker,
  gpuModeFromPciList,
} from './gpu-picker.js';
import type { FrontendExtensionHost, ServerCardWebExtension, SlotContextMap } from './types.js';

function enabledOn(enabledExtensions: readonly string[]): boolean {
  return enabledExtensions.includes(NVIDIA_GPU_EXTENSION_ID);
}

function pciFromValue(value: unknown): string[] {
  if (typeof value !== 'object' || value === null) return [];
  const pci = (value as { pciAddresses?: unknown }).pciAddresses;
  return Array.isArray(pci) ? pci.filter((item): item is string => typeof item === 'string') : [];
}

function runtimeFromValue(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  return (value as { nvidiaRuntime?: unknown }).nvidiaRuntime === true;
}

function CreateSlot({
  host,
  ctx,
}: {
  host: FrontendExtensionHost;
  ctx: SlotContextMap['container.create'];
}) {
  if (!enabledOn(ctx.enabledExtensions)) return null;
  const current = pciFromValue(ctx.value[NVIDIA_GPU_EXTENSION_ID]);
  const grant = parseGrant(ctx.grant?.[NVIDIA_GPU_EXTENSION_ID]);
  const mode = gpuModeFromPciList(current);
  return (
    <GpuPicker
      host={host}
      serverId={ctx.serverId}
      mode={mode}
      onModeChange={(next) => {
        if (next === 'none') {
          ctx.onChange({ ...ctx.value, [NVIDIA_GPU_EXTENSION_ID]: { pciAddresses: [] } });
        }
      }}
      value={current}
      onChange={(pciAddresses) => {
        ctx.onChange({ ...ctx.value, [NVIDIA_GPU_EXTENSION_ID]: { pciAddresses } });
      }}
      grant={grant}
      idPrefix="container-create-gpu"
    />
  );
}

function SpecSlot({
  host,
  ctx,
}: {
  host: FrontendExtensionHost;
  ctx: SlotContextMap['container.spec'];
}) {
  if (!enabledOn(ctx.enabledExtensions)) return null;
  const current = pciFromValue(ctx.value[NVIDIA_GPU_EXTENSION_ID]);
  const runtime = runtimeFromValue(ctx.value[NVIDIA_GPU_EXTENSION_ID]);
  const canEdit = ctx.observedStatus === 'stopped';
  const [mode, setMode] = useState<GpuPickerMode>(() => gpuModeFromPciList(current));
  const {
    Card,
    CardHeader,
    CardTitle,
    CardDescription,
    CardContent,
    Button,
  } = host.ui;
  return (
    <Card className="lg:col-span-2">
      <CardHeader>
        <CardTitle className="text-base">GPU</CardTitle>
        <CardDescription data-testid="gpu-runtime-rebuild">
          {canEdit ? '容器已停止，可以修改 GPU。' : 'GPU 修改要求容器停止。'}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <GpuPicker
          host={host}
          serverId={ctx.serverId}
          admin={ctx.admin}
          mode={mode}
          onModeChange={(next) => {
            setMode(next);
            if (next === 'none') {
              ctx.onChange({ ...ctx.value, [NVIDIA_GPU_EXTENSION_ID]: { nvidiaRuntime: runtime, pciAddresses: [] } });
            }
          }}
          value={current}
          onChange={(pciAddresses) => {
            ctx.onChange({
              ...ctx.value,
              [NVIDIA_GPU_EXTENSION_ID]: { nvidiaRuntime: runtime, pciAddresses },
            });
          }}
          disabled={!canEdit}
          idPrefix="container-detail-gpu"
        />
        <Button
          onClick={() => ctx.onSubmit(NVIDIA_GPU_EXTENSION_ID, { pciAddresses: current })}
          disabled={ctx.pending || !canEdit}
        >
          {ctx.pending ? '提交中...' : '应用 GPU'}
        </Button>
      </CardContent>
    </Card>
  );
}

function OverviewSlot({
  ctx,
}: {
  host: FrontendExtensionHost;
  ctx: SlotContextMap['container.overview'];
}) {
  const current = pciFromValue(ctx.value[NVIDIA_GPU_EXTENSION_ID]);
  return (
    <p className="text-sm">
      GPU：{formatGpuSelectionLabel(current, [])}
    </p>
  );
}

function GrantSlot({
  host,
  ctx,
}: {
  host: FrontendExtensionHost;
  ctx: SlotContextMap['grant.server'];
}) {
  if (!enabledOn(ctx.enabledExtensions)) return null;
  const grant = parseGrant(ctx.value[NVIDIA_GPU_EXTENSION_ID])
    ?? { mode: GpuGrantMode.None, pciAddresses: [] };
  const latestGrant = useRef(grant);
  latestGrant.current = grant;
  const pickerMode: GpuPickerMode = grant.mode === GpuGrantMode.None
    ? 'none'
    : grant.mode === GpuGrantMode.All
      ? 'all'
      : 'specific';
  return (
    <GpuPicker
      host={host}
      serverId={ctx.serverId}
      admin
      mode={pickerMode}
      onModeChange={(next) => {
        const nextGrant = reduceNvidiaGpuGrant(latestGrant.current, { type: 'mode', mode: next });
        latestGrant.current = nextGrant;
        ctx.onChange({ ...ctx.value, [NVIDIA_GPU_EXTENSION_ID]: nextGrant });
      }}
      value={grant.pciAddresses}
      onChange={(pciAddresses) => {
        const nextGrant = reduceNvidiaGpuGrant(latestGrant.current, { type: 'pci', pciAddresses });
        latestGrant.current = nextGrant;
        ctx.onChange({ ...ctx.value, [NVIDIA_GPU_EXTENSION_ID]: nextGrant });
      }}
      idPrefix="grant-gpu"
      label="NVIDIA GPU 授权"
    />
  );
}

function EnablementSlot({
  ctx,
}: {
  host: FrontendExtensionHost;
  ctx: SlotContextMap['server.detail.enablement'];
}) {
  if (ctx.item.extensionId !== NVIDIA_GPU_EXTENSION_ID) return null;
  return (
    <p className="text-xs text-muted-foreground">
      占用设备：{ctx.item.occupiedDeviceCount}
    </p>
  );
}

function HealthSlot({
  ctx,
}: {
  host: FrontendExtensionHost;
  ctx: SlotContextMap['server.detail.health'];
}) {
  if (ctx.item.extensionId !== NVIDIA_GPU_EXTENSION_ID) return null;
  const ready = ctx.item.health.runtimeReady;
  const label = ready === true ? '就绪' : ready === false ? '未就绪' : '未知';
  return (
    <p className="text-xs text-muted-foreground">NVIDIA runtime：{label}</p>
  );
}

function PreflightSlot({
  ctx,
}: {
  host: FrontendExtensionHost;
  ctx: SlotContextMap['server.preflight'];
}) {
  const evidence = ctx.evidence[NVIDIA_GPU_EXTENSION_ID];
  if (typeof evidence !== 'object' || evidence === null) return null;
  const record = evidence as Record<string, unknown>;
  return (
    <p className="text-xs text-muted-foreground">
      NVIDIA 卡：{String(record.nvidiaCardCount ?? 0)}
    </p>
  );
}

export function createNvidiaGpuWebSlots(): ServerCardWebExtension['slots'] {
  return {
    'container.create': CreateSlot,
    'container.spec': SpecSlot,
    'container.overview': OverviewSlot,
    'grant.server': GrantSlot,
    'server.detail.enablement': EnablementSlot,
    'server.detail.health': HealthSlot,
    'server.preflight': PreflightSlot,
  };
}
