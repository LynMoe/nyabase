import { useQuery } from '@tanstack/react-query';
import { Capability } from '@nyabase/common';
import { api } from '../../lib/api.js';
import { useAuthStore } from '../../store/auth.js';

interface GpuDevice {
  pciAddress: string;
  model: string;
}

export function useGpuNames(serverId: string | undefined, admin: boolean): ReadonlyMap<string, string> {
  const privileged = useAuthStore((state) => {
    const caps = state.user?.capabilities ?? [];
    return admin
      || caps.includes(Capability.ManageServers)
      || caps.includes(Capability.ManageGrants);
  });
  const query = useQuery({
    queryKey: ['gpu-devices', privileged ? 'admin' : 'user', serverId ?? ''],
    enabled: Boolean(serverId),
    staleTime: 60_000,
    queryFn: () => api.get<{ items: GpuDevice[] }>(
      `${privileged ? '/admin' : ''}/servers/${serverId}/extensions/nvidia-gpu/devices`,
    ),
  });
  const names = new Map<string, string>();
  for (const device of query.data?.items ?? []) {
    const pci = device.pciAddress.trim().toLowerCase();
    const model = device.model.trim();
    if (pci && model) names.set(pci, model);
  }
  return names;
}

export function gpuChartTitle(index: number | null, pci: string, names: ReadonlyMap<string, string>): string {
  const key = pci.trim().toLowerCase();
  const model = names.get(key);
  const head = index === null ? 'GPU' : `GPU ${index}`;
  return model ? `${head} ${model}` : head;
}
