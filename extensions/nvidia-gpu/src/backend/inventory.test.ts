import { describe, expect, it } from 'vitest';
import { NVIDIA_GPU_SMI_INDEX_METRIC } from '../metrics.js';
import { GpuGrantMode } from '../schema.js';
import {
  applyNvidiaSmiIndexes,
  filterGpuInventoryByGrant,
  nvidiaGpuInventoryFromResources,
  nvidiaSmiIndexByPciFromSamples,
} from './inventory.js';

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

  it('returns empty for unknown resources', () => {
    expect(nvidiaGpuInventoryFromResources(undefined)).toEqual([]);
    expect(nvidiaGpuInventoryFromResources('nope')).toEqual([]);
    expect(nvidiaGpuInventoryFromResources({})).toEqual([]);
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
        name: NVIDIA_GPU_SMI_INDEX_METRIC,
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
    expect(filterGpuInventoryByGrant(items, { mode: GpuGrantMode.None, pciAddresses: [] })).toEqual([]);
    expect(filterGpuInventoryByGrant(items, { mode: GpuGrantMode.All, pciAddresses: [] })).toEqual(items);
    expect(filterGpuInventoryByGrant(items, {
      mode: GpuGrantMode.Pci,
      pciAddresses: ['0000:a1:00.0'],
    })).toEqual([{ index: 0, pciAddress: '00000000:a1:00.0', model: 'B' }]);
  });
});
