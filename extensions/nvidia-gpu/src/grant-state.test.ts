import { describe, expect, it } from 'vitest';
import { GpuGrantMode } from './schema.js';
import { reduceNvidiaGpuGrant, type NvidiaGpuGrant } from './grant-state.js';

const pciGrant: NvidiaGpuGrant = {
  mode: GpuGrantMode.Pci,
  pciAddresses: ['00000000:41:00.0'],
};

function apply(current: NvidiaGpuGrant, ...events: Parameters<typeof reduceNvidiaGpuGrant>[1][]): NvidiaGpuGrant {
  return events.reduce(reduceNvidiaGpuGrant, current);
}

describe('reduceNvidiaGpuGrant', () => {
  it('keeps none after GpuPicker onModeChange then onChange([])', () => {
    expect(apply(
      pciGrant,
      { type: 'mode', mode: 'none' },
      { type: 'pci', pciAddresses: [] },
    )).toEqual({ mode: GpuGrantMode.None, pciAddresses: [] });
  });

  it('keeps all and drops PCI after onModeChange then onChange(inventory)', () => {
    expect(apply(
      pciGrant,
      { type: 'mode', mode: 'all' },
      { type: 'pci', pciAddresses: ['00000000:41:00.0', '00000000:a1:00.0'] },
    )).toEqual({ mode: GpuGrantMode.All, pciAddresses: [] });
  });

  it('enters pci mode without inventing addresses when switching to specific', () => {
    expect(apply(
      { mode: GpuGrantMode.None, pciAddresses: [] },
      { type: 'mode', mode: 'specific' },
    )).toEqual({ mode: GpuGrantMode.Pci, pciAddresses: [] });
  });

  it('updates PCI only while mode is pci', () => {
    expect(apply(
      { mode: GpuGrantMode.Pci, pciAddresses: [] },
      { type: 'pci', pciAddresses: ['00000000:41:00.0'] },
    )).toEqual({
      mode: GpuGrantMode.Pci,
      pciAddresses: ['00000000:41:00.0'],
    });
    expect(apply(
      { mode: GpuGrantMode.All, pciAddresses: [] },
      { type: 'pci', pciAddresses: ['00000000:41:00.0'] },
    )).toEqual({ mode: GpuGrantMode.All, pciAddresses: [] });
  });
});
