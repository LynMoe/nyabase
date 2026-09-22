import { parseGrant } from '../grant-state.js';
import { NVIDIA_GPU_EXTENSION_ID } from '../id.js';
import { canonicalPciAddress } from '../pci.js';
import type { NvidiaGpuDeviceDto } from '../schema.js';
import {
  formatGpuSelectionLabel,
  GpuPicker,
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
  return (
    <GpuPicker
      host={host}
      serverId={ctx.serverId}
      defaultAll
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
  const current = pciFromValue(ctx.value[NVIDIA_GPU_EXTENSION_ID]);
  if (!enabledOn(ctx.enabledExtensions)) return null;
  const runtime = runtimeFromValue(ctx.value[NVIDIA_GPU_EXTENSION_ID]);
  const canEdit = ctx.observedStatus === 'stopped';
  const grant = parseGrant(ctx.grant?.[NVIDIA_GPU_EXTENSION_ID]);
  const { Button } = host.ui;
  return (
    <div className="space-y-3 border-t pt-4">
      <GpuPicker
        host={host}
        serverId={ctx.serverId}
        admin={ctx.admin}
        grant={grant}
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
        title={canEdit ? undefined : '容器未停止'}
      >
        {ctx.pending ? '提交中...' : '应用 GPU'}
      </Button>
    </div>
  );
}

function OverviewSlot({
  host,
  ctx,
}: {
  host: FrontendExtensionHost;
  ctx: SlotContextMap['container.overview'];
}) {
  const state = ctx.value[NVIDIA_GPU_EXTENSION_ID];
  if (typeof state !== 'object' || state === null || Object.keys(state).length === 0) return null;
  const current = pciFromValue(state);
  const path = ctx.admin
    ? `/admin/servers/${ctx.serverId}/extensions/${NVIDIA_GPU_EXTENSION_ID}/devices`
    : `/servers/${ctx.serverId}/extensions/${NVIDIA_GPU_EXTENSION_ID}/devices`;
  const query = host.useQuery({
    queryKey: host.extensionDevicesKey(NVIDIA_GPU_EXTENSION_ID, ctx.serverId, ctx.admin),
    queryFn: () => host.api.get<{ items?: NvidiaGpuDeviceDto[] }>(path),
    enabled: Boolean(ctx.serverId) && current.length > 0,
  });
  const inventory = Array.isArray(query.data?.items) ? query.data.items : [];
  const { TechnicalId } = host.ui;
  const groups = query.data ? gpuModelGroups(current, inventory) : [];
  return (
    <div>
      <p className="text-xs text-muted-foreground">GPU</p>
      {current.length === 0 ? (
        <p className="text-sm">{formatGpuSelectionLabel(current, [])}</p>
      ) : groups.length === 0 ? (
        <p className="text-sm">
          <TechnicalId label="GPU" value={current.join(', ')} visible={`${current.length} 张`} />
        </p>
      ) : (
        <p className="flex flex-wrap gap-x-3 text-sm">
          {groups.map((group) => (
            <TechnicalId
              key={group.model}
              label="GPU"
              value={group.addresses.join(', ')}
              visible={group.label}
            />
          ))}
        </p>
      )}
    </div>
  );
}

function gpuModelGroups(
  addresses: readonly string[],
  inventory: readonly NvidiaGpuDeviceDto[],
): { model: string; label: string; addresses: string[] }[] {
  const models = new Map(inventory.map((device) => [pciKey(device.pciAddress), device.model.trim() || '未知型号']));
  const order: string[] = [];
  const grouped = new Map<string, string[]>();
  for (const address of addresses) {
    const model = models.get(pciKey(address)) ?? '未知型号';
    const list = grouped.get(model);
    if (list) list.push(address);
    else {
      grouped.set(model, [address]);
      order.push(model);
    }
  }
  return order.map((model) => {
    const group = grouped.get(model) ?? [];
    return {
      model,
      addresses: group,
      label: `${group.length} × ${model}`,
    };
  });
}

function pciKey(value: string): string {
  return canonicalPciAddress(value) ?? value.trim().toLowerCase();
}

function GrantSlot({
  host,
  ctx,
}: {
  host: FrontendExtensionHost;
  ctx: SlotContextMap['grant.server'];
}) {
  if (!enabledOn(ctx.enabledExtensions)) return null;
  const grant = parseGrant(ctx.value[NVIDIA_GPU_EXTENSION_ID]);
  return (
    <GpuPicker
      host={host}
      serverId={ctx.serverId}
      admin
      value={grant?.pciAddresses ?? []}
      onChange={(pciAddresses) => {
        ctx.onChange({ ...ctx.value, [NVIDIA_GPU_EXTENSION_ID]: { pciAddresses } });
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
