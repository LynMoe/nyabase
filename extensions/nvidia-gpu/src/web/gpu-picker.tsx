import { useEffect, useMemo, useState } from 'react';
import type { GpuPickerMode } from '../grant-state.js';
import { NVIDIA_GPU_EXTENSION_ID } from '../id.js';
import { GpuGrantMode, type NvidiaGpuDeviceDto, type NvidiaGpuGrant } from '../schema.js';
import { canonicalPciAddress } from '../pci.js';
import type { FrontendExtensionHost } from './types.js';

export type { GpuPickerMode } from '../grant-state.js';
export { parseGrant } from '../grant-state.js';

export function gpuModeFromPciList(
  pciAddresses: readonly string[],
  availableCount?: number,
): GpuPickerMode {
  if (pciAddresses.length === 0) return 'none';
  if (availableCount !== undefined && availableCount > 0 && pciAddresses.length === availableCount) {
    return 'all';
  }
  return 'specific';
}

export function resolveGpuPciAddresses(
  mode: GpuPickerMode,
  selected: readonly string[],
  available: ReadonlyArray<{ pciAddress: string }>,
): string[] {
  if (mode === 'none') return [];
  if (mode === 'all') return available.map((gpu) => gpu.pciAddress);
  return [...selected];
}

export function gpuDisplayLabel(
  gpu: { index: number | null; pciAddress: string },
): string {
  return gpu.index === null ? gpu.pciAddress : `GPU ${gpu.index}`;
}

export function formatGpuSelectionLabel(
  pciAddresses: readonly string[],
  inventory: ReadonlyArray<{ index: number | null; pciAddress: string; model: string }>,
): string {
  if (pciAddresses.length === 0) return '无';
  const byPci = new Map(inventory.map((gpu) => [normalizePci(gpu.pciAddress), gpu]));
  const labels = pciAddresses.map((pci) => {
    const gpu = byPci.get(normalizePci(pci));
    return gpu ? gpuDisplayLabel(gpu) : pci;
  });
  return labels.join(', ');
}

export function permittedGpus(
  inventory: readonly NvidiaGpuDeviceDto[],
  grant: NvidiaGpuGrant | null | undefined,
  admin = false,
): NvidiaGpuDeviceDto[] {
  if (admin && !grant) return [...inventory];
  if (!grant || grant.mode === GpuGrantMode.None) return [];
  if (grant.mode === GpuGrantMode.All) return [...inventory];
  const allowed = new Set(grant.pciAddresses.map(normalizePci));
  return inventory.filter((gpu) => allowed.has(normalizePci(gpu.pciAddress)));
}

function normalizePci(value: string): string {
  return canonicalPciAddress(value) ?? value.trim().toLowerCase();
}

export function GpuPicker({
  host,
  serverId,
  admin = false,
  mode,
  onModeChange,
  value,
  onChange,
  grant,
  disabled = false,
  showModeSelect = true,
  idPrefix = 'gpu',
  label = 'GPU',
}: {
  host: FrontendExtensionHost;
  serverId: string;
  admin?: boolean;
  mode: GpuPickerMode;
  onModeChange: (mode: GpuPickerMode) => void;
  value: string[];
  onChange: (pciAddresses: string[]) => void;
  grant?: NvidiaGpuGrant | null;
  disabled?: boolean;
  showModeSelect?: boolean;
  idPrefix?: string;
  label?: string;
}) {
  const [inventory, setInventory] = useState<NvidiaGpuDeviceDto[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!serverId) return;
    let cancelled = false;
    setLoading(true);
    setError(false);
    void host.extensionDevicesKey(NVIDIA_GPU_EXTENSION_ID, serverId, admin);
    const path = admin
      ? `/admin/servers/${serverId}/extensions/${NVIDIA_GPU_EXTENSION_ID}/devices`
      : `/servers/${serverId}/extensions/${NVIDIA_GPU_EXTENSION_ID}/devices`;
    host.api.get<{ items?: NvidiaGpuDeviceDto[] }>(path).then(
      (data) => {
        if (cancelled) return;
        setInventory(Array.isArray(data.items) ? data.items : []);
        setLoading(false);
      },
      () => {
        if (cancelled) return;
        setInventory([]);
        setLoading(false);
        setError(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [admin, host, serverId]);

  const available = useMemo(
    () => permittedGpus(inventory, grant, admin),
    [admin, grant, inventory],
  );

  const {
    FormField,
    Checkbox,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
  } = host.ui;

  const modeOptions: Array<[GpuPickerMode, string]> = [
    ['none', '无'],
    ['all', '全部（有权限的全部）'],
    ['specific', '指定卡'],
  ];

  return (
    <div className="space-y-2" data-testid="gpu-picker">
      {showModeSelect && (
        <FormField id={`${idPrefix}-mode`} label={label}>
          <Select
            value={mode}
            disabled={disabled || !serverId}
            onValueChange={(nextValue) => {
              const next = nextValue as GpuPickerMode;
              onModeChange(next);
              if (next === 'none') onChange([]);
              else if (next === 'all') onChange(available.map((gpu) => gpu.pciAddress));
              else if (mode === 'all') onChange([]);
            }}
          >
            <SelectTrigger id={`${idPrefix}-mode`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {modeOptions.map(([optionValue, optionLabel]) => (
                <SelectItem key={optionValue} value={optionValue}>{optionLabel}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FormField>
      )}

      {!serverId && (
        <p className="text-xs text-muted-foreground">请先选择服务器</p>
      )}

      {serverId && loading && (
        <p className="text-xs text-muted-foreground">加载 GPU 列表…</p>
      )}

      {serverId && error && (
        <p className="text-xs text-muted-foreground">
          GPU 列表暂不可用（后端可能尚未就绪）。可稍后重试或继续其他配置。
        </p>
      )}

      {serverId && !loading && available.length === 0 && mode !== 'none' && (
        <p className="text-xs text-muted-foreground">
          {grant?.mode === GpuGrantMode.None ? '当前授权不含 GPU' : '此服务器暂无可用 GPU'}
        </p>
      )}

      {mode === 'specific' && available.length > 0 && (
        <div className="space-y-1.5 rounded-md border px-3 py-2">
          <p className="text-xs text-muted-foreground">选择 GPU 卡（nvidia-smi 序号；提交时使用 PCI）</p>
          <div className="grid gap-1.5 sm:grid-cols-2">
            {available.map((gpu) => {
              const checked = value.some((pci) => normalizePci(pci) === normalizePci(gpu.pciAddress));
              return (
                <label key={gpu.pciAddress} className="flex items-center gap-2 text-sm">
                  <Checkbox
                    id={`${idPrefix}-${gpu.pciAddress}`}
                    checked={checked}
                    disabled={disabled}
                    onCheckedChange={(nextChecked) => {
                      if (nextChecked === true) {
                        onChange([
                          ...value.filter((pci) => normalizePci(pci) !== normalizePci(gpu.pciAddress)),
                          gpu.pciAddress,
                        ]);
                      } else {
                        onChange(value.filter((pci) => normalizePci(pci) !== normalizePci(gpu.pciAddress)));
                      }
                    }}
                  />
                  <span>
                    <span className="font-medium">{gpuDisplayLabel(gpu)}</span>
                    {gpu.model ? <span className="text-muted-foreground"> · {gpu.model}</span> : null}
                  </span>
                </label>
              );
            })}
          </div>
        </div>
      )}

      {mode === 'all' && available.length > 0 && (
        <p className="text-xs text-muted-foreground">
          将使用：{available.map((gpu) => gpuDisplayLabel(gpu)).join(', ')}
        </p>
      )}
    </div>
  );
}
