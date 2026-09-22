import { useEffect, useMemo, useRef } from 'react';
import { NVIDIA_GPU_EXTENSION_ID } from '../id.js';
import { canonicalPciAddress } from '../pci.js';
import {
  gpuDisplayLabel,
  nextDefaultGpuSelection,
  permittedGpus,
} from '../selection.js';
import type { NvidiaGpuDeviceDto, NvidiaGpuGrant } from '../schema.js';
import type { FrontendExtensionHost } from './types.js';

export { parseGrant } from '../grant-state.js';
export {
  formatGpuSelectionLabel,
  gpuDisplayLabel,
  permittedGpus,
} from '../selection.js';

function normalizePci(value: string): string {
  return canonicalPciAddress(value) ?? value.trim().toLowerCase();
}

export function GpuPicker({
  host,
  serverId,
  admin = false,
  value,
  onChange,
  grant,
  disabled = false,
  idPrefix = 'gpu',
  label = 'GPU',
  defaultAll = false,
}: {
  host: FrontendExtensionHost;
  serverId: string;
  admin?: boolean;
  value: string[];
  onChange: (pciAddresses: string[]) => void;
  grant?: NvidiaGpuGrant | null;
  disabled?: boolean;
  idPrefix?: string;
  label?: string;
  defaultAll?: boolean;
}) {
  const path = admin
    ? `/admin/servers/${serverId}/extensions/${NVIDIA_GPU_EXTENSION_ID}/devices`
    : `/servers/${serverId}/extensions/${NVIDIA_GPU_EXTENSION_ID}/devices`;
  const query = host.useQuery({
    queryKey: host.extensionDevicesKey(NVIDIA_GPU_EXTENSION_ID, serverId, admin),
    queryFn: () => host.api.get<{ items?: NvidiaGpuDeviceDto[] }>(path),
    enabled: Boolean(serverId),
  });
  const inventory = Array.isArray(query.data?.items) ? query.data.items : [];
  const loading = query.isPending;
  const error = query.isError;

  const available = useMemo(
    () => permittedGpus(inventory, grant),
    [grant, inventory],
  );
  const availableKey = available.map((gpu) => gpu.pciAddress).join('\n');
  const valueKey = value.join('\n');
  const seed = useRef<{ serverId: string; addresses: string[] } | null>(null);

  useEffect(() => {
    if (!defaultAll || !serverId || loading || error) return;
    const addresses = availableKey ? availableKey.split('\n') : [];
    const next = nextDefaultGpuSelection(
      serverId,
      addresses,
      valueKey ? valueKey.split('\n') : [],
      seed.current,
    );
    if (!next) return;
    seed.current = { serverId, addresses: next };
    onChange(next);
  }, [availableKey, defaultAll, error, loading, onChange, serverId, valueKey]);

  const { Checkbox } = host.ui;
  const emptyBecauseGrant = Boolean(grant && grant.pciAddresses.length === 0);

  return (
    <div className="space-y-2" data-testid="gpu-picker">
      <div className="flex items-center gap-2">
        <p className="text-sm font-medium">{label}</p>
        {value.length === 0 && available.length > 0 ? (
          <span className="text-xs text-muted-foreground">未选择</span>
        ) : null}
      </div>

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

      {serverId && !loading && !error && available.length === 0 && (
        <p className="text-xs text-muted-foreground">
          {emptyBecauseGrant ? '当前授权不含 GPU' : '此服务器暂无可用 GPU'}
        </p>
      )}

      {available.length > 0 && (
        <div className="rounded-md border px-3 py-2">
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
    </div>
  );
}
