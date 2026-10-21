import { useEffect, useMemo, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  canonicalPciAddress,
  gpuDisplayLabel,
  nextDefaultGpuSelection,
  permittedGpus,
  type GpuDevicesResponseDto,
  type GpuGrant,
  type ListScope,
} from '@nyabase/common';
import { api } from '../../lib/api.js';
import { queryKeys } from '../../lib/query-keys.js';
import { scopedPath } from '../../lib/scoped-paths.js';
import { Checkbox } from '../ui/checkbox.js';

/** `scope=all` is the full inventory; `scope=mine` is filtered by the caller's grant. */
export function gpuDevicesPath(serverId: string, scope: ListScope): string {
  return scopedPath(`/servers/${serverId}/gpus`, scope);
}

export function useGpuDevices(serverId: string, scope: ListScope, enabled = true) {
  return useQuery({
    queryKey: queryKeys.gpu.devices(serverId, scope),
    queryFn: () => api.get<GpuDevicesResponseDto>(gpuDevicesPath(serverId, scope)),
    enabled: Boolean(serverId) && enabled,
  });
}

function normalizePci(value: string): string {
  return canonicalPciAddress(value) ?? value.trim().toLowerCase();
}

export function GpuPicker({
  serverId,
  scope = 'mine',
  value,
  onChange,
  grant,
  disabled = false,
  idPrefix = 'gpu',
  label = 'GPU',
  defaultAll = false,
}: {
  serverId: string;
  scope?: ListScope;
  value: string[];
  onChange: (pciAddresses: string[]) => void;
  grant?: GpuGrant | null;
  disabled?: boolean;
  idPrefix?: string;
  label?: string;
  defaultAll?: boolean;
}) {
  const query = useGpuDevices(serverId, scope);
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
