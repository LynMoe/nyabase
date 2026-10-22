import {
  NVIDIA_GPU_DRIVER_PRESENT_METRIC,
  NVIDIA_GPU_SMI_INDEX_METRIC,
  NVIDIA_GPU_TOOLKIT_PRESENT_METRIC,
  summarizeGpuSupport,
  type GpuSupportCheckDto,
  type GpuSupportDto,
  canonicalPciAddress,
  type GpuDeviceDto,
  type GpuGrant,
  type NodeMetricSample,
} from '@nyabase/common';
import type { GpuHealthPort } from './admit.js';
import { isRecord } from '../platform/domain-utils.js';

export interface GpuInventoryCard {
  readonly pciAddress: string;
  readonly model: string;
}

/**
 * Build NVIDIA GPU inventory from Incus `/1.0/resources`.
 * Only cards with `nvidia` metadata are included; PCI is canonicalized here.
 */
export function gpuInventoryFromResources(resources: unknown): GpuInventoryCard[] {
  if (!isRecord(resources)) return [];
  const gpu = resources.gpu;
  if (!isRecord(gpu) || !Array.isArray(gpu.cards)) return [];
  const items: GpuInventoryCard[] = [];
  for (const card of gpu.cards) {
    if (!isRecord(card) || card.nvidia === undefined) continue;
    if (typeof card.pci_address !== 'string') continue;
    const pciAddress = canonicalPciAddress(card.pci_address);
    if (!pciAddress) continue;
    const nvidia = isRecord(card.nvidia) ? card.nvidia : undefined;
    const nvidiaModel = typeof nvidia?.model === 'string' ? nvidia.model.trim() : '';
    const product = typeof card.product === 'string' ? card.product.trim() : '';
    const model = nvidiaModel || product || 'NVIDIA GPU';
    items.push({ pciAddress, model });
  }
  return items;
}

export function nvidiaSmiIndexByPciFromSamples(
  samples: readonly NodeMetricSample[],
): ReadonlyMap<string, number> {
  const indexes = new Map<string, number>();
  for (const sample of samples) {
    if (sample.name !== NVIDIA_GPU_SMI_INDEX_METRIC) continue;
    const pci = canonicalPciAddress(sample.labels.gpu_pci ?? '');
    if (!pci || !Number.isInteger(sample.value) || sample.value < 0) continue;
    indexes.set(pci, sample.value);
  }
  return indexes;
}

export function applyNvidiaSmiIndexes(
  cards: readonly GpuInventoryCard[],
  smiIndexByPci: ReadonlyMap<string, number>,
): GpuDeviceDto[] {
  return cards.map((card) => {
    const pci = canonicalPciAddress(card.pciAddress) ?? card.pciAddress;
    return {
      pciAddress: pci,
      model: card.model,
      index: smiIndexByPci.get(pci) ?? null,
    };
  });
}

export function filterGpuInventoryByGrant(
  items: readonly GpuDeviceDto[],
  grant: GpuGrant,
): GpuDeviceDto[] {
  if (grant.pciAddresses.length === 0) return [];
  const allowed = new Set(
    grant.pciAddresses
      .map((value) => canonicalPciAddress(value))
      .filter((value): value is string => Boolean(value)),
  );
  return items.filter((item) => allowed.has(item.pciAddress));
}

export function listGpuDevices(input: {
  readonly resources: unknown;
  readonly metricSamples: readonly NodeMetricSample[];
  readonly grant: GpuGrant | null;
  readonly admin: boolean;
}): GpuDeviceDto[] {
  const cards = gpuInventoryFromResources(input.resources);
  const items = applyNvidiaSmiIndexes(cards, nvidiaSmiIndexByPciFromSamples(input.metricSamples));
  if (input.admin && !input.grant) return items;
  if (!input.grant) return [];
  return filterGpuInventoryByGrant(items, input.grant);
}

function presenceValue(
  samples: readonly NodeMetricSample[],
  name: string,
): boolean | undefined {
  const sample = samples.find((item) => item.name === name);
  if (!sample) return undefined;
  return sample.value > 0;
}

function driverStatus(samples: readonly NodeMetricSample[]): GpuSupportCheckDto {
  const present = presenceValue(samples, NVIDIA_GPU_DRIVER_PRESENT_METRIC);
  if (present === true) {
    return { id: 'nvidia-driver', label: 'NVIDIA 驱动 (nvidia-smi)', status: 'pass' };
  }
  if (present === false) {
    return {
      id: 'nvidia-driver',
      label: 'NVIDIA 驱动 (nvidia-smi)',
      status: 'fail',
      detail: 'nvidia-smi 不可用',
    };
  }
  return {
    id: 'nvidia-driver',
    label: 'NVIDIA 驱动 (nvidia-smi)',
    status: 'unknown',
    detail: '未采集到主机 Agent 指标',
  };
}

function toolkitStatus(samples: readonly NodeMetricSample[]): GpuSupportCheckDto {
  const present = presenceValue(samples, NVIDIA_GPU_TOOLKIT_PRESENT_METRIC);
  if (present === true) {
    return {
      id: 'nvidia-container-toolkit',
      label: 'NVIDIA Container Toolkit',
      status: 'pass',
    };
  }
  if (present === false) {
    return {
      id: 'nvidia-container-toolkit',
      label: 'NVIDIA Container Toolkit',
      status: 'fail',
      detail: 'nvidia-container-cli / nvidia-container-runtime 不可用',
    };
  }
  return {
    id: 'nvidia-container-toolkit',
    label: 'NVIDIA Container Toolkit',
    status: 'unknown',
    detail: '未采集到主机 Agent 指标',
  };
}

/** Host prerequisite probe; independent of enablement and persisted health. */
export function probeGpuSupport(input: {
  readonly resources: unknown;
  readonly metricSamples: readonly NodeMetricSample[];
}): GpuSupportDto {
  const incusReachable = input.resources !== undefined && input.resources !== null;
  const cards = incusReachable ? gpuInventoryFromResources(input.resources) : [];
  const checks: GpuSupportCheckDto[] = [
    incusReachable
      ? { id: 'incus-resources', label: 'Incus 资源可达', status: 'pass' }
      : {
          id: 'incus-resources',
          label: 'Incus 资源可达',
          status: 'unknown',
          detail: '无法读取 Incus /1.0/resources',
        },
    !incusReachable
      ? {
          id: 'nvidia-cards',
          label: 'NVIDIA GPU 设备',
          status: 'unknown',
          detail: '无法读取 Incus 资源',
        }
      : cards.length > 0
        ? {
            id: 'nvidia-cards',
            label: 'NVIDIA GPU 设备',
            status: 'pass',
            detail: `发现 ${cards.length} 张卡`,
          }
        : {
            id: 'nvidia-cards',
            label: 'NVIDIA GPU 设备',
            status: 'fail',
            detail: '未发现 NVIDIA GPU',
          },
    driverStatus(input.metricSamples),
    toolkitStatus(input.metricSamples),
  ];
  return summarizeGpuSupport(checks);
}

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
