import type { CpuSetService } from '../cpu/cpu-sets.service.js';
import type { NyabaseConfigService } from '../platform/config/nyabase-config.service.js';
import type { ContainerSpecRuntime } from './container-instance-ops.js';

/** The owner's CPU pinning and the platform-wide container limits for one container's spec. */
export async function resolveContainerRuntime(
  cpuSets: Pick<CpuSetService, 'resolve' | 'preview'>,
  config: Pick<NyabaseConfigService, 'get'>,
  row: { readonly server_id: string; readonly owner_id: string },
  mode: 'apply' | 'preview' = 'apply',
): Promise<ContainerSpecRuntime> {
  return {
    cpus: mode === 'apply'
      ? await cpuSets.resolve(row.server_id, row.owner_id)
      : await cpuSets.preview(row.server_id, row.owner_id),
    limits: {
      processes: config.get<number>('containers.processLimit'),
      networkIngressMbit: config.get<number>('containers.networkIngressMbit'),
      networkEgressMbit: config.get<number>('containers.networkEgressMbit'),
      diskReadMBps: config.get<number>('containers.diskReadMBps'),
      diskWriteMBps: config.get<number>('containers.diskWriteMBps'),
    },
  };
}

export function sameCpus(left: readonly number[] | null, right: readonly number[]): boolean {
  if (!left || left.length !== right.length) return false;
  const sorted = [...left].sort((a, b) => a - b);
  return sorted.every((cpu, index) => cpu === right[index]);
}
