import type { NodeMetricSample } from '@nyabase/common';
import { NVIDIA_GPU_SMI_INDEX_METRIC } from '../metrics.js';
import { canonicalPciAddress } from '../pci.js';
import { GpuGrantMode, type NvidiaGpuDeviceDto, type NvidiaGpuGrant } from '../schema.js';

export interface GpuInventoryCard {
  readonly pciAddress: string;
  readonly model: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Build NVIDIA GPU inventory from Incus `/1.0/resources`.
 * Only cards with `nvidia` metadata are included; PCI is canonicalized here.
 */
export function nvidiaGpuInventoryFromResources(resources: unknown): GpuInventoryCard[] {
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
): NvidiaGpuDeviceDto[] {
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
  items: readonly NvidiaGpuDeviceDto[],
  grant: Pick<NvidiaGpuGrant, 'mode' | 'pciAddresses'>,
): NvidiaGpuDeviceDto[] {
  if (grant.mode === GpuGrantMode.None) return [];
  if (grant.mode === GpuGrantMode.All) return [...items];
  const allowed = new Set(
    grant.pciAddresses
      .map((value) => canonicalPciAddress(value))
      .filter((value): value is string => Boolean(value)),
  );
  return items.filter((item) => allowed.has(item.pciAddress));
}

export function listNvidiaGpuDevices(input: {
  readonly resources: unknown;
  readonly metricSamples: readonly NodeMetricSample[];
  readonly grant: Pick<NvidiaGpuGrant, 'mode' | 'pciAddresses'> | null;
  readonly admin: boolean;
}): NvidiaGpuDeviceDto[] {
  const cards = nvidiaGpuInventoryFromResources(input.resources);
  const items = applyNvidiaSmiIndexes(cards, nvidiaSmiIndexByPciFromSamples(input.metricSamples));
  if (input.admin && !input.grant) return items;
  if (!input.grant) return [];
  return filterGpuInventoryByGrant(items, input.grant);
}
