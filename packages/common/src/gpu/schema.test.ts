import { describe, expect, it } from 'vitest';
import { zGpuContainerState, zGpuPciAddresses } from './schema.js';

describe('zGpuContainerState', () => {
  it('accepts zero-card runtime-on state', () => {
    expect(zGpuContainerState.parse({
      nvidiaRuntime: true,
      pciAddresses: [],
    })).toEqual({ nvidiaRuntime: true, pciAddresses: [] });
  });

  it('canonicalizes PCI addresses', () => {
    expect(zGpuContainerState.parse({
      nvidiaRuntime: true,
      pciAddresses: ['0000:41:00.0'],
    }).pciAddresses).toEqual(['00000000:41:00.0']);
  });

  it('rejects duplicate PCI (including 4-hex / 8-hex aliases)', () => {
    expect(zGpuContainerState.safeParse({
      nvidiaRuntime: true,
      pciAddresses: ['0000:41:00.0', '00000000:41:00.0'],
    }).success).toBe(false);
  });

  it('rejects wildcard PCI', () => {
    const result = zGpuContainerState.safeParse({
      nvidiaRuntime: true,
      pciAddresses: ['0000:41:00.*'],
    });
    expect(result.success).toBe(false);
  });

  it('rejects unknown keys', () => {
    expect(zGpuContainerState.safeParse({
      nvidiaRuntime: true,
      pciAddresses: [],
      extra: true,
    }).success).toBe(false);
  });

  it('rejects PCI assignments without nvidiaRuntime', () => {
    expect(zGpuContainerState.safeParse({
      nvidiaRuntime: false,
      pciAddresses: ['0000:41:00.0'],
    }).success).toBe(false);
  });
});

describe('zGpuPciAddresses', () => {
  it('stores a PCI list, including an empty list', () => {
    expect(zGpuPciAddresses.parse([])).toEqual([]);
    expect(zGpuPciAddresses.parse(['0000:41:00.0'])).toEqual(['00000000:41:00.0']);
  });

  it('rejects duplicate addresses and wildcards', () => {
    expect(zGpuPciAddresses.safeParse(['0000:41:00.0', '0000:41:00.0']).success).toBe(false);
    expect(zGpuPciAddresses.safeParse(['0000:41:00.*']).success).toBe(false);
  });
});
