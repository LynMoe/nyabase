import type { NodeMetricSample } from '@nyabase/common';
import { gpuInventoryFromResources } from './inventory.js';
import type { GpuHealthPort } from './types.js';

export interface GpuPreflightEvidence extends Record<string, unknown> {
  readonly serverId: string;
  readonly enabled: boolean;
  readonly runtimeReady: boolean | null;
  readonly nvidiaCardCount: number;
  readonly exporterGpuSamples: boolean;
}

export function nvidiaHealthFromResources(resources: unknown): {
  readonly runtimeReady: boolean | null;
  readonly nvidiaCardCount: number;
} {
  if (resources === undefined || resources === null) {
    return { runtimeReady: null, nvidiaCardCount: 0 };
  }
  const nvidiaCardCount = gpuInventoryFromResources(resources).length;
  return {
    runtimeReady: nvidiaCardCount > 0,
    nvidiaCardCount,
  };
}

function hasExporterGpuSamples(samples: readonly NodeMetricSample[]): boolean {
  return samples.some((sample) => sample.name.startsWith('nyabase_node_gpu_'));
}

/**
 * Writes health only; never flips enablement. Unreachable Incus yields
 * `runtimeReady: null` so a transient outage never reads as "not ready".
 */
export async function refreshGpuHealth(input: {
  readonly health: GpuHealthPort;
  readonly resources: unknown;
  readonly metricSamples: readonly NodeMetricSample[];
}): Promise<void> {
  const snapshot = nvidiaHealthFromResources(input.resources);
  await input.health.write({
    runtimeReady: snapshot.runtimeReady,
    nvidiaCardCount: snapshot.nvidiaCardCount,
    exporterGpuSamples: hasExporterGpuSamples(input.metricSamples),
  });
}

export function gpuPreflight(input: {
  readonly serverId: string;
  readonly resources: unknown;
  readonly metricSamples: readonly NodeMetricSample[];
  readonly enabled: boolean;
}): { readonly evidence: GpuPreflightEvidence; readonly health: Record<string, unknown> } {
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
      exporterGpuSamples: hasExporterGpuSamples(input.metricSamples),
    },
    health,
  };
}
