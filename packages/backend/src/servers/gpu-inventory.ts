import { canonicalPciAddress, NodeMetricName, type NodeMetricSample, type ServerGpuDto } from '@nyabase/common';
import type { IncusSchema } from '../incus/index.js';

type Resources = IncusSchema<'Resources'>;
type GpuCard = NonNullable<NonNullable<Resources['gpu']>['cards']>[number];

export interface GpuInventoryCard {
  readonly pciAddress: string;
  readonly model: string;
}

/**
 * Build NVIDIA GPU inventory from Incus `/1.0/resources`.
 * PCI and model come from Incus. Display index is applied later from nvidia-smi.
 */
export function nvidiaGpuInventoryFromResources(resources: Resources): GpuInventoryCard[] {
  const cards = (resources.gpu?.cards ?? []).filter((card): card is GpuCard => (
    card !== null
    && typeof card === 'object'
    && card.nvidia !== undefined
  ));
  const items: GpuInventoryCard[] = [];
  for (const card of cards) {
    if (typeof card.pci_address !== 'string') continue;
    const pciAddress = canonicalPciAddress(card.pci_address);
    if (!pciAddress) continue;
    const model = card.nvidia?.model?.trim()
      || card.product?.trim()
      || 'NVIDIA GPU';
    items.push({ pciAddress, model });
  }
  return items;
}

export function nvidiaSmiIndexByPciFromSamples(
  samples: readonly NodeMetricSample[],
): ReadonlyMap<string, number> {
  const indexes = new Map<string, number>();
  for (const sample of samples) {
    if (sample.name !== NodeMetricName.GpuSmiIndex) continue;
    const pci = canonicalPciAddress(sample.labels.gpu_pci ?? '');
    if (!pci || !Number.isInteger(sample.value) || sample.value < 0) continue;
    indexes.set(pci, sample.value);
  }
  return indexes;
}

export function applyNvidiaSmiIndexes(
  cards: readonly GpuInventoryCard[],
  smiIndexByPci: ReadonlyMap<string, number>,
): ServerGpuDto[] {
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
  items: readonly ServerGpuDto[],
  grant: { mode: 'none' | 'all' | 'pci'; pciAddresses: readonly string[] },
): ServerGpuDto[] {
  if (grant.mode === 'none') return [];
  if (grant.mode === 'all') return [...items];
  const allowed = new Set(
    grant.pciAddresses
      .map((value) => canonicalPciAddress(value))
      .filter((value): value is string => Boolean(value)),
  );
  return items.filter((item) => allowed.has(item.pciAddress));
}
