import type { NodeMetricSample } from '@nyabase/common';
import { nvidiaGpuInventoryFromResources } from './inventory.js';
import type { ExtensionHealthPort, PreflightContribution } from '../types.js';

export function nvidiaHealthFromResources(resources: unknown): {
  readonly runtimeReady: boolean | null;
  readonly nvidiaCardCount: number;
} {
  if (resources === undefined || resources === null) {
    return { runtimeReady: null, nvidiaCardCount: 0 };
  }
  const nvidiaCardCount = nvidiaGpuInventoryFromResources(resources).length;
  return {
    runtimeReady: nvidiaCardCount > 0,
    nvidiaCardCount,
  };
}

export async function refreshNvidiaGpuHealth(input: {
  readonly health: ExtensionHealthPort;
  readonly resources: unknown;
  readonly metricSamples: readonly NodeMetricSample[];
}): Promise<void> {
  const snapshot = nvidiaHealthFromResources(input.resources);
  await input.health.write({
    runtimeReady: snapshot.runtimeReady,
    nvidiaCardCount: snapshot.nvidiaCardCount,
    exporterGpuSamples: input.metricSamples.some((sample) => sample.name.startsWith('nyabase_node_gpu_')),
  });
}

export function contributeNvidiaGpuPreflight(input: {
  readonly serverId: string;
  readonly resources: unknown;
  readonly metricSamples: readonly NodeMetricSample[];
  readonly enabled: boolean;
}): PreflightContribution {
  const snapshot = nvidiaHealthFromResources(input.resources);
  const health = {
    runtimeReady: snapshot.runtimeReady,
    nvidiaCardCount: snapshot.nvidiaCardCount,
  };
  return {
    evidence: {
      serverId: input.serverId,
      enabled: input.enabled,
      ...health,
      exporterGpuSamples: input.metricSamples.some((sample) => sample.name.startsWith('nyabase_node_gpu_')),
    },
    health,
  };
}
