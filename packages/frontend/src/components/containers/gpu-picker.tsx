import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  GpuGrantMode,
  type EffectiveServerAccessDto,
  type ServerGpusResponseDto,
  type ServerGrantGpu,
} from '@nyabase/common';
import { api } from '../../lib/api.js';
import { Checkbox } from '../ui/checkbox.js';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select.js';
import { FormField } from '../layout/form-field.js';
import { queryKeys } from '../../lib/query-keys.js';

export type GpuPickerMode = 'none' | 'all' | 'specific';

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

/** Resolve PCI list for API from picker mode + selection. */
export function resolveGpuPciAddresses(
  mode: GpuPickerMode,
  selected: readonly string[],
  available: ReadonlyArray<{ pciAddress: string }>,
): string[] {
  if (mode === 'none') return [];
  if (mode === 'all') return available.map((gpu) => gpu.pciAddress);
  return [...selected];
}

/** Map selected PCI addresses to human nvidia-smi index labels using inventory. */
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
  inventory: ServerGpusResponseDto['items'],
  grant: ServerGrantGpu | null | undefined,
  admin = false,
): ServerGpusResponseDto['items'] {
  if (admin && !grant) return inventory;
  if (!grant || grant.mode === GpuGrantMode.None) return [];
  if (grant.mode === GpuGrantMode.All) return inventory;
  const allowed = new Set(grant.pciAddresses.map(normalizePci));
  return inventory.filter((gpu) => allowed.has(normalizePci(gpu.pciAddress)));
}

export function useServerGpus(serverId: string | undefined, admin: boolean, enabled = true) {
  return useQuery({
    queryKey: queryKeys.servers.gpus(serverId ?? '', admin),
    queryFn: () => api.get<ServerGpusResponseDto>(
      admin ? `/admin/servers/${serverId}/gpus` : `/servers/${serverId}/gpus`,
    ),
    enabled: enabled && Boolean(serverId),
    retry: false,
  });
}

export function GpuPicker({
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
  serverId: string;
  admin?: boolean;
  mode: GpuPickerMode;
  onModeChange: (mode: GpuPickerMode) => void;
  value: string[];
  onChange: (pciAddresses: string[]) => void;
  /** When set, 「全部」and checkboxes are limited to the grant. Admin may omit. */
  grant?: ServerGrantGpu | EffectiveServerAccessDto['gpu'] | null;
  disabled?: boolean;
  showModeSelect?: boolean;
  idPrefix?: string;
  label?: string;
}) {
  const gpusQuery = useServerGpus(serverId, admin, Boolean(serverId));
  const inventory = gpusQuery.data?.items ?? [];
  const available = useMemo(
    () => permittedGpus(inventory, grant, admin),
    [admin, grant, inventory],
  );

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
            onValueChange={(value) => {
              const next = value as GpuPickerMode;
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

      {serverId && gpusQuery.isLoading && (
        <p className="text-xs text-muted-foreground">加载 GPU 列表…</p>
      )}

      {serverId && gpusQuery.isError && (
        <p className="text-xs text-muted-foreground">
          GPU 列表暂不可用（后端可能尚未就绪）。可稍后重试或继续其他配置。
        </p>
      )}

      {serverId && !gpusQuery.isLoading && available.length === 0 && mode !== 'none' && (
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

function normalizePci(value: string): string {
  return value.trim().toLowerCase();
}
