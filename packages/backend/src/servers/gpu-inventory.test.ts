import { NodeMetricName } from '@nyabase/common';
import { describe, expect, it } from 'vitest';
import {
  applyNvidiaSmiIndexes,
  filterGpuInventoryByGrant,
  nvidiaGpuInventoryFromResources,
  nvidiaSmiIndexByPciFromSamples,
} from './gpu-inventory.js';

describe('nvidiaGpuInventoryFromResources', () => {
  it('lists only nvidia cards and normalizes PCI addresses without inventing an index', () => {
    expect(nvidiaGpuInventoryFromResources({
      gpu: {
        cards: [
          { pci_address: '0000:01:00.0', product: 'AST', vendor: 'ASPEED' },
          {
            pci_address: '00000000:41:00.0',
            product: 'GA102',
            nvidia: { model: 'NVIDIA RTX 3090' },
          },
          {
            pci_address: '0000:a1:00.0',
            product: 'GA104',
            nvidia: { brand: 'GeForce' },
          },
        ],
      },
    })).toEqual([
      { pciAddress: '00000000:41:00.0', model: 'NVIDIA RTX 3090' },
      { pciAddress: '00000000:a1:00.0', model: 'GA104' },
    ]);
  });
});

describe('nvidia-smi index join', () => {
  it('joins Incus PCI inventory to nvidia-smi indexes and leaves gaps as null', () => {
    const cards = nvidiaGpuInventoryFromResources({
      gpu: {
        cards: [
          { pci_address: '0000:41:00.0', nvidia: { model: 'A' } },
          { pci_address: '0000:a1:00.0', nvidia: { model: 'B' } },
        ],
      },
    });
    const samples = nvidiaSmiIndexByPciFromSamples([
      {
        name: NodeMetricName.GpuSmiIndex,
        labels: { gpu_pci: '0000:a1:00.0' },
        value: 0,
      },
    ]);
    expect(applyNvidiaSmiIndexes(cards, samples)).toEqual([
      { pciAddress: '00000000:41:00.0', model: 'A', index: null },
      { pciAddress: '00000000:a1:00.0', model: 'B', index: 0 },
    ]);
  });
});

describe('filterGpuInventoryByGrant', () => {
  const items = [
    { index: 3, pciAddress: '00000000:41:00.0', model: 'A' },
    { index: 0, pciAddress: '00000000:a1:00.0', model: 'B' },
  ];

  it('returns empty for none, all for all, and preserves nvidia-smi indices for pci', () => {
    expect(filterGpuInventoryByGrant(items, { mode: 'none', pciAddresses: [] })).toEqual([]);
    expect(filterGpuInventoryByGrant(items, { mode: 'all', pciAddresses: [] })).toEqual(items);
    expect(filterGpuInventoryByGrant(items, {
      mode: 'pci',
      pciAddresses: ['0000:a1:00.0'],
    })).toEqual([{ index: 0, pciAddress: '00000000:a1:00.0', model: 'B' }]);
  });
});
